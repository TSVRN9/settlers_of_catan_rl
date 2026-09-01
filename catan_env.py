"""Gym env for the learning agent (always Color.BLUE).

`FastCatanatronEnv` subclasses catanatron's own `CatanatronEnv` and overrides
three things:

1. `_get_observation` — a fast encoder (`Encoder.encode`) instead of
   `create_sample`. It produces the *same* 1002-length vector, in the same
   `get_feature_ordering(4)` order, as catanatron's own encoder — verified by
   the differential test in `test_env.py`. This matters for the hidden-info
   rule for free: catanatron's own `feature_extractors` already only expose
   opponent hand/dev-card *counts* (`P{i}_NUM_RESOURCES_IN_HAND`, not
   `P{i}_WOOD_IN_HAND`), so matching their output means we inherit that
   property rather than re-deriving it.
2. `_advance_until_p0_decision` — also skips BLUE's own forced (single
   legal action) decisions, executing them directly instead of calling
   `game.play_tick()` (which would invoke `Player.decide`, unimplemented on
   the base `Player`). This is the forced-decision skip from HANDOFF.md.
3. `step` — tracks VP before/after the whole skip span (not just the one
   policy-chosen action) so dense VP-gain shaping accumulates correctly
   across skipped forced ticks instead of dropping them.
"""

import re

import numpy as np
from catanatron.features import get_feature_ordering, get_node_production, iter_players
from catanatron.game import TURNS_LIMIT, Game
from catanatron.gym.envs.action_space import from_action_space
from catanatron.gym.envs.catanatron_env import HIGH, CatanatronEnv
from catanatron.models.decks import RESOURCE_FREQDECK_INDEXES
from catanatron.models.enums import (
    CITY,
    DEVELOPMENT_CARDS,
    RESOURCES,
    ROAD,
    SETTLEMENT,
    ActionType,
)
from catanatron.models.map import number_probability
from catanatron.models.tiles import LandTile
from catanatron.state_functions import get_actual_victory_points, player_key
from gymnasium import spaces
from stable_baselines3.common.vec_env import VecEnv, VecEnvWrapper

# catanatron's own `feature_extractors` list (features.py) has
# `build_production_features` and `reachability_features` commented out, so
# `get_feature_ordering` -- and therefore the observation below -- carries no
# per-player production or expansion signal. `ValueFunctionPlayer`
# (catanatron/players/value.py) weighs `production`/`enemy_production` as its
# 2nd/3rd heaviest terms (after victory points) and `buildable_nodes` as its
# 5th; our trained policy could not see any of that. Both are public
# board-derived quantities (settlement/city positions and tile numbers are
# public knowledge), so adding them carries no hidden-info risk. Appended
# after the base 1002 rather than folded into `get_feature_ordering`'s own
# sort order, so the base block stays a byte-identical match to
# `create_sample_vector` (see `test_encoder_matches_reference`).
PRODUCTION_FEATURES = [
    f"EFFECTIVE_P{i}_{r}_PRODUCTION" for i in range(4) for r in RESOURCES
]
BUILDABLE_NODES_FEATURES = [f"P{i}_BUILDABLE_NODES" for i in range(4)]
EXTRA_FEATURES = PRODUCTION_FEATURES + BUILDABLE_NODES_FEATURES

BASE_FEATURES = get_feature_ordering(4, "BASE")
FEATURES = BASE_FEATURES + EXTRA_FEATURES
FEATURE_INDEX = {name: i for i, name in enumerate(FEATURES)}

PLAYER_SCALAR_STATE_SUFFIX = {
    "PUBLIC_VPS": "VICTORY_POINTS",
    "HAS_ARMY": "HAS_ARMY",
    "HAS_ROAD": "HAS_ROAD",
    "ROADS_LEFT": "ROADS_AVAILABLE",
    "SETTLEMENTS_LEFT": "SETTLEMENTS_AVAILABLE",
    "CITIES_LEFT": "CITIES_AVAILABLE",
    "HAS_ROLLED": "HAS_ROLLED",
    "LONGEST_ROAD_LENGTH": "LONGEST_ROAD_LENGTH",
}
PLAYABLE_DEV_CARDS = [c for c in DEVELOPMENT_CARDS if c != "VICTORY_POINT"]


class _Layout:
    """One-time regex parse of FEATURES into index tables (map-topology is
    fixed for the BASE map, so node/edge/tile/port indices never change
    across games; only values do)."""

    def __init__(self):
        self.tile_static_idx = []  # (feature_idx, is_desert_or_resource_or_proba)
        self.robber_idx = {}  # tile_id -> feature_idx
        self.port_static_idx = []
        self.node_idx = {}  # (i, node_id, "SETTLEMENT"|"CITY") -> feature_idx
        self.edge_idx = {}  # (i, sorted_edge_tuple) -> feature_idx
        self.player_scalar_idx = {}  # (suffix, i) -> feature_idx
        self.dev_played_idx = {}  # (card, i) -> feature_idx
        self.num_devs_idx = {}  # i -> feature_idx
        self.num_resources_idx = {}  # i -> feature_idx
        self.p0_actual_vps_idx = FEATURE_INDEX["P0_ACTUAL_VPS"]
        self.p0_resource_in_hand_idx = {
            r: FEATURE_INDEX[f"P0_{r}_IN_HAND"] for r in RESOURCES
        }
        self.p0_dev_in_hand_idx = {
            c: FEATURE_INDEX[f"P0_{c}_IN_HAND"] for c in DEVELOPMENT_CARDS
        }
        self.p0_has_played_dev_idx = FEATURE_INDEX[
            "P0_HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN"
        ]
        self.bank_resource_idx = {r: FEATURE_INDEX[f"BANK_{r}"] for r in RESOURCES}
        self.bank_dev_cards_idx = FEATURE_INDEX["BANK_DEV_CARDS"]
        self.is_discarding_idx = FEATURE_INDEX["IS_DISCARDING"]
        self.is_moving_robber_idx = FEATURE_INDEX["IS_MOVING_ROBBER"]

        node_re = re.compile(r"^NODE(\d+)_P(\d)_(SETTLEMENT|CITY)$")
        edge_re = re.compile(r"^EDGE\((\d+), (\d+)\)_P(\d)_ROAD$")
        tile_robber_re = re.compile(r"^TILE(\d+)_HAS_ROBBER$")
        tile_is_re = re.compile(r"^TILE(\d+)_IS_(\w+)$")
        tile_proba_re = re.compile(r"^TILE(\d+)_PROBA$")
        port_re = re.compile(r"^PORT(\d+)_IS_(\w+)$")
        player_scalar_re = re.compile(
            "^P(\\d)_(" + "|".join(PLAYER_SCALAR_STATE_SUFFIX) + ")$"
        )
        dev_played_re = re.compile(
            "^P(\\d)_(" + "|".join(PLAYABLE_DEV_CARDS) + ")_PLAYED$"
        )

        for name, idx in FEATURE_INDEX.items():
            m = node_re.match(name)
            if m:
                node_id, i, kind = int(m.group(1)), int(m.group(2)), m.group(3)
                self.node_idx[(i, node_id, kind)] = idx
                continue
            m = edge_re.match(name)
            if m:
                a, b, i = int(m.group(1)), int(m.group(2)), int(m.group(3))
                self.edge_idx[(i, (a, b))] = idx
                continue
            m = tile_robber_re.match(name)
            if m:
                self.robber_idx[int(m.group(1))] = idx
                continue
            m = tile_proba_re.match(name)
            if m:
                self.tile_static_idx.append((idx, "PROBA", int(m.group(1))))
                continue
            m = tile_is_re.match(name)
            if m:
                self.tile_static_idx.append((idx, "IS", (int(m.group(1)), m.group(2))))
                continue
            m = port_re.match(name)
            if m:
                self.port_static_idx.append((idx, int(m.group(1)), m.group(2)))
                continue
            m = player_scalar_re.match(name)
            if m:
                i, suffix = int(m.group(1)), m.group(2)
                self.player_scalar_idx[(suffix, i)] = idx
                continue
            m = dev_played_re.match(name)
            if m:
                i, card = int(m.group(1)), m.group(2)
                self.dev_played_idx[(card, i)] = idx
                continue
            if name.startswith("P") and name.endswith("_NUM_DEVS_IN_HAND"):
                self.num_devs_idx[int(name[1])] = idx
            elif name.startswith("P") and name.endswith("_NUM_RESOURCES_IN_HAND"):
                self.num_resources_idx[int(name[1])] = idx

        self.production_idx = {
            (i, r): FEATURE_INDEX[f"EFFECTIVE_P{i}_{r}_PRODUCTION"]
            for i in range(4)
            for r in RESOURCES
        }
        self.buildable_nodes_idx = {
            i: FEATURE_INDEX[f"P{i}_BUILDABLE_NODES"] for i in range(4)
        }

        assert len(self.node_idx) == 216 + 216
        assert len(self.edge_idx) == 288
        assert len(self.robber_idx) == 19
        assert len(self.player_scalar_idx) == 4 * len(PLAYER_SCALAR_STATE_SUFFIX)
        assert len(self.dev_played_idx) == 4 * len(PLAYABLE_DEV_CARDS)
        assert len(self.num_devs_idx) == 4 and len(self.num_resources_idx) == 4
        assert len(self.production_idx) == 20 and len(self.buildable_nodes_idx) == 4


LAYOUT = _Layout()


class Encoder:
    """Preallocated-buffer replacement for `create_sample_vector` at 4p BASE.
    Always returns a fresh array (each call starts from `_static_template.copy()`)
    so callers never alias a shared internal buffer. `_static_template` is
    owned per-instance, not shared via LAYOUT: a process may hold several
    Encoders alive at once (see inference_server.py, one per concurrent
    game), each on a different randomly-generated map, interleaved -- a
    shared template would let one game's tile/port refresh clobber another's."""

    def __init__(self):
        self._map_id = None
        self._static_template = np.zeros(len(FEATURES), dtype=np.float32)

    def _refresh_static_template(self, catan_map):
        tmpl = self._static_template
        tmpl.fill(0.0)
        for idx, kind, arg in LAYOUT.tile_static_idx:
            if kind == "PROBA":
                tile = catan_map.tiles_by_id[arg]
                tmpl[idx] = (
                    0.0 if tile.resource is None else number_probability(tile.number)
                )
            else:
                tile_id, resource_or_desert = arg
                tile = catan_map.tiles_by_id[tile_id]
                if resource_or_desert == "DESERT":
                    tmpl[idx] = float(tile.resource is None)
                else:
                    tmpl[idx] = float(tile.resource == resource_or_desert)
        for idx, port_id, resource_or_3to1 in LAYOUT.port_static_idx:
            port = catan_map.ports_by_id[port_id]
            if resource_or_3to1 == "THREE_TO_ONE":
                tmpl[idx] = float(port.resource is None)
            else:
                tmpl[idx] = float(port.resource == resource_or_3to1)
        self._map_id = id(catan_map)

    def encode(self, game: Game, p0_color) -> np.ndarray:
        state = game.state
        catan_map = state.board.map
        if id(catan_map) != self._map_id:
            self._refresh_static_template(catan_map)

        buf = self._static_template.copy()

        robber_tile_id = _tile_id_at(catan_map, state.board.robber_coordinate)
        if robber_tile_id is not None:
            buf[LAYOUT.robber_idx[robber_tile_id]] = 1.0

        for i, color in iter_players(state.colors, p0_color):
            key = player_key(state, color)
            ps = state.player_state

            for suffix, state_suffix in PLAYER_SCALAR_STATE_SUFFIX.items():
                buf[LAYOUT.player_scalar_idx[(suffix, i)]] = float(
                    ps[f"{key}_{state_suffix}"]
                )
            for card in PLAYABLE_DEV_CARDS:
                buf[LAYOUT.dev_played_idx[(card, i)]] = float(
                    ps[f"{key}_PLAYED_{card}"]
                )
            buf[LAYOUT.num_resources_idx[i]] = float(
                ps[f"{key}_WOOD_IN_HAND"]
                + ps[f"{key}_BRICK_IN_HAND"]
                + ps[f"{key}_SHEEP_IN_HAND"]
                + ps[f"{key}_WHEAT_IN_HAND"]
                + ps[f"{key}_ORE_IN_HAND"]
            )
            buf[LAYOUT.num_devs_idx[i]] = float(
                ps[f"{key}_YEAR_OF_PLENTY_IN_HAND"]
                + ps[f"{key}_MONOPOLY_IN_HAND"]
                + ps[f"{key}_VICTORY_POINT_IN_HAND"]
                + ps[f"{key}_KNIGHT_IN_HAND"]
                + ps[f"{key}_ROAD_BUILDING_IN_HAND"]
            )

            settlement_nodes = state.buildings_by_color[color][SETTLEMENT]
            city_nodes = state.buildings_by_color[color][CITY]
            for node_id in settlement_nodes:
                buf[LAYOUT.node_idx[(i, node_id, "SETTLEMENT")]] = 1.0
            for node_id in city_nodes:
                buf[LAYOUT.node_idx[(i, node_id, "CITY")]] = 1.0
            for edge in state.buildings_by_color[color][ROAD]:
                buf[LAYOUT.edge_idx[(i, tuple(sorted(edge)))]] = 1.0

            robber_coordinate = state.board.robber_coordinate
            for r in RESOURCES:
                production = sum(
                    get_node_production(catan_map, n, r, robber_coordinate)
                    for n in settlement_nodes
                ) + sum(
                    2 * get_node_production(catan_map, n, r, robber_coordinate)
                    for n in city_nodes
                )
                buf[LAYOUT.production_idx[(i, r)]] = production
            buf[LAYOUT.buildable_nodes_idx[i]] = float(
                len(state.board.buildable_node_ids(color))
            )

            if color == p0_color:
                buf[LAYOUT.p0_actual_vps_idx] = float(
                    ps[f"{key}_ACTUAL_VICTORY_POINTS"]
                )
                for r in RESOURCES:
                    buf[LAYOUT.p0_resource_in_hand_idx[r]] = float(
                        ps[f"{key}_{r}_IN_HAND"]
                    )
                for c in DEVELOPMENT_CARDS:
                    buf[LAYOUT.p0_dev_in_hand_idx[c]] = float(ps[f"{key}_{c}_IN_HAND"])
                buf[LAYOUT.p0_has_played_dev_idx] = float(
                    ps[f"{key}_HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN"]
                )

        for r in RESOURCES:
            buf[LAYOUT.bank_resource_idx[r]] = float(
                state.resource_freqdeck[RESOURCE_FREQDECK_INDEXES[r]]
            )
        buf[LAYOUT.bank_dev_cards_idx] = float(len(state.development_listdeck))

        possibilities = {a.action_type for a in game.playable_actions}
        buf[LAYOUT.is_discarding_idx] = float(
            ActionType.DISCARD_RESOURCE in possibilities
        )
        buf[LAYOUT.is_moving_robber_idx] = float(ActionType.MOVE_ROBBER in possibilities)

        return buf


def _tile_id_at(catan_map, coordinate):
    """The robber only ever sits on a land tile, but stay defensive about it."""
    tile = catan_map.tiles.get(coordinate)
    if not isinstance(tile, LandTile):
        return None
    return tile.id


def vp_shaped_reward(vp_weight=0.1):
    """win=+1, loss=0, ongoing=0, plus vp_weight * (actual VP gained this
    step). Computed across the whole forced-decision skip span so shaping
    from skipped ticks is never dropped."""

    def reward_fn(game, p0_color, vp_before):
        winning_color = game.winning_color()
        vp_after = get_actual_victory_points(game.state, p0_color)
        shaping = vp_weight * (vp_after - vp_before)
        if winning_color == p0_color:
            return 1.0 + shaping
        return shaping

    return reward_fn


def advance_until_decision(game, p0_color):
    """Skip forced (single legal action) decisions for p0_color, executing
    them directly, and skip other players' turns via play_tick(). Shared by
    FastCatanatronEnv.step()/reset() and evaluate.py's search wrapper -- a
    search that scores states reached by game.copy()+execute() without this
    would score mid-turn/forced-decision states the value head never saw
    during training, a distribution shift distinct from (and easy to
    conflate with) any argmax-over-off-policy-states effect."""
    while game.winning_color() is None and game.state.num_turns < TURNS_LIMIT:
        if game.state.current_color() != p0_color:
            game.play_tick()
            continue
        if len(game.playable_actions) == 1:
            game.execute(game.playable_actions[0])
            continue
        break


class FastCatanatronEnv(CatanatronEnv):
    def __init__(self, config=None):
        self._encoder = Encoder()
        config = dict(config or {})
        self._step_reward_fn = config.pop("step_reward_function", vp_shaped_reward())
        super().__init__(config)
        # base __init__ sizes observation_space from catanatron's own
        # get_feature_ordering (1002); ours is 1002 + EXTRA_FEATURES (see
        # FEATURES above).
        self.features = FEATURES
        self.observation_space = spaces.Box(
            low=0, high=HIGH, shape=(len(FEATURES),), dtype=self.dtype
        )

    def _get_observation(self):
        return self._encoder.encode(self.game, self.p0.color)

    def _advance_until_p0_decision(self):
        advance_until_decision(self.game, self.p0.color)

    def step(self, action):
        try:
            catan_action = self._decode_action(action)
        except AssertionError:
            return super().step(action)

        vp_before = get_actual_victory_points(self.game.state, self.p0.color)
        self.game.execute(catan_action)
        self._advance_until_p0_decision()

        observation = self._get_observation()
        info = {"valid_actions": self.get_valid_actions()}

        winning_color = self.game.winning_color()
        terminated = winning_color is not None
        truncated = self.game.state.num_turns >= TURNS_LIMIT
        reward = self._step_reward_fn(self.game, self.p0.color, vp_before)

        if terminated or truncated:
            info["is_success"] = winning_color == self.p0.color

        return observation, reward, terminated, truncated, info

    def _decode_action(self, action):
        catan_action = from_action_space(
            action, self.p0.color, self.player_colors, self.map_type
        )
        assert catan_action in self.game.playable_actions
        return catan_action


class CachedMaskVecEnv(VecEnvWrapper):
    """`sb3_contrib.get_action_masks` always calls
    `venv.env_method("action_masks")` for a VecEnv -- a second full
    IPC round trip through every SubprocVecEnv worker on every rollout
    step, on top of the step() round trip itself. `action_masks()` is cheap
    local state (just `valid_actions` reshaped into a bool array) that
    `step()`/`reset()` already ship back for free as `info["valid_actions"]`,
    so this wrapper answers the `action_masks` env_method from that cached
    info instead of forwarding it -- halving the per-step IPC round trips
    under SubprocVecEnv without touching sb3_contrib."""

    def __init__(self, venv: VecEnv):
        super().__init__(venv)
        self._n = self.action_space.n  # type: ignore[attr-defined]
        self._last_masks = np.zeros((venv.num_envs, self._n), dtype=bool)

    def _masks_from_infos(self, infos) -> np.ndarray:
        masks = np.zeros((self.num_envs, self._n), dtype=bool)
        for i, info in enumerate(infos):
            masks[i, info["valid_actions"]] = True
        return masks

    def reset(self):
        obs = self.venv.reset()
        self._last_masks = self._masks_from_infos(self.venv.reset_infos)
        return obs

    def step_wait(self):
        obs, rewards, dones, infos = self.venv.step_wait()
        # SubprocVecEnv auto-resets a worker whose episode just ended (see
        # SB3's _worker()): it calls env.reset() and overwrites `obs` with
        # the fresh episode's observation, but `infos[i]` is left as the
        # terminal step's own info -- info["valid_actions"] there reflects
        # the state the just-finished game ended in, not the new episode
        # `obs[i]` now shows. Caching that would hand the policy a mask for
        # a dead game on the very next decision. The correct mask for a
        # reset env is in `reset_info`, which SubprocVecEnv exposes
        # separately as `self.venv.reset_infos` (same source `reset()`
        # below already uses). Found via test_env.py's
        # test_cached_mask_matches_env_method intermittently failing --
        # intermittent because it only reproduces when an episode boundary
        # falls inside the sampled rollout window.
        effective_infos = [
            self.venv.reset_infos[i] if dones[i] else info
            for i, info in enumerate(infos)
        ]
        self._last_masks = self._masks_from_infos(effective_infos)
        return obs, rewards, dones, infos

    def env_method(self, method_name, *method_args, indices=None, **method_kwargs):
        if method_name != "action_masks":
            return self.venv.env_method(
                method_name, *method_args, indices=indices, **method_kwargs
            )
        if indices is None:
            return list(self._last_masks)
        if isinstance(indices, int):
            indices = [indices]
        return [self._last_masks[i] for i in indices]
