"""Python side of the catan_engine (Rust) boundary.

The Rust engine mirrors catanatron's rules; map generation, players, and the
game loop stay in Python. Conversions here:
  map_spec / rust_map(game)      -> catan_engine.Map (cached per map object)
  state_spec(game)               -> dict for State.from_spec / to compare with State.snapshot()
  canon(action, ctx) / uncanon   -> (type, a, b, c) int tuples both ways
  layout()                       -> catan_engine.Layout from catan_env.LAYOUT
Conformance: test_env.py::test_rust_engine_replays_python_games replays
Python-played games step by step and compares legal-action sets and full
state snapshots.
"""

import catan_engine
import numpy as np
from catanatron.models.enums import DEVELOPMENT_CARDS, RESOURCES, ActionType, Action
from catanatron.models.enums import CITY, ROAD, SETTLEMENT

from catan_env import (
    LAYOUT,
    PLAYABLE_DEV_CARDS,
    PLAYER_SCALAR_STATE_SUFFIX,
    Encoder,
)
from value_net import EXTRA_BASE, N_BASE, N_FEATURES

RES_IDX = {r: i for i, r in enumerate(RESOURCES)}
DEV_IDX = {c: i for i, c in enumerate(DEVELOPMENT_CARDS)}
_MAP = (None, None)  # (catan_map, Ctx) of the last map seen; one entry, compared with `is` (a dict keyed by
# id(map) that held every map grew gen_games workers by 15 MB/game and OOM-killed the box, docs/FINDINGS.md)


class Ctx:
    """Per-map conversion tables."""

    def __init__(self, catan_map):
        self.catan_map = catan_map
        tiles = [catan_map.tiles_by_id[t] for t in range(len(catan_map.tiles_by_id))]
        from catanatron.models.enums import NodeRef

        order = [NodeRef.NORTH, NodeRef.NORTHEAST, NodeRef.SOUTHEAST, NodeRef.SOUTH, NodeRef.SOUTHWEST, NodeRef.NORTHWEST]
        tile_spec = [
            (-1 if t.resource is None else RES_IDX[t.resource], 0 if t.number is None else t.number, [t.nodes[k] for k in order])
            for t in tiles
        ]
        port_spec = []
        from catanatron.models.map import PORT_DIRECTION_TO_NODEREFS

        for p in catan_map.ports_by_id.values():
            a_ref, b_ref = PORT_DIRECTION_TO_NODEREFS[p.direction]
            port_spec.append((-1 if p.resource is None else RES_IDX[p.resource], p.nodes[a_ref], p.nodes[b_ref]))
        enc = Encoder()
        enc._refresh_static_template(catan_map)
        template = np.zeros(N_FEATURES, dtype=np.float32)
        template[:N_BASE] = enc._static_template
        from catanatron.models.board import STATIC_GRAPH

        neighbors = [[v for v in STATIC_GRAPH.neighbors(n) if v < 54] for n in range(54)]
        self.map = catan_engine.Map(tile_spec, port_spec, template.tolist(), neighbors)
        self.edge_idx = {e: i for i, e in enumerate(self.map.edges())}
        self.edges = self.map.edges()
        self.tile_id = {coord: t.id for coord, t in catan_map.land_tiles.items()}
        self.coord_of = {t.id: coord for coord, t in catan_map.land_tiles.items()}


def ctx_for(game):
    global _MAP
    catan_map = game.state.board.map
    if _MAP[0] is not catan_map:
        _MAP = (catan_map, Ctx(catan_map))
    return _MAP[1]


def canon(action, ctx, colors):
    t, v = action.action_type, action.value
    if t == ActionType.ROLL:
        return ("ROLL", -1, -1, -1)
    if t == ActionType.MOVE_ROBBER:
        coord, victim = v
        return ("MOVE_ROBBER", ctx.tile_id[coord], -1 if victim is None else colors.index(victim), -1)
    if t == ActionType.DISCARD_RESOURCE:
        return ("DISCARD_RESOURCE", RES_IDX[v], -1, -1)
    if t == ActionType.BUILD_ROAD:
        return ("BUILD_ROAD", ctx.edge_idx[tuple(sorted(v))], -1, -1)
    if t == ActionType.BUILD_SETTLEMENT:
        return ("BUILD_SETTLEMENT", v, -1, -1)
    if t == ActionType.BUILD_CITY:
        return ("BUILD_CITY", v, -1, -1)
    if t == ActionType.BUY_DEVELOPMENT_CARD:
        return ("BUY_DEVELOPMENT_CARD", -1, -1, -1)
    if t == ActionType.PLAY_KNIGHT_CARD:
        return ("PLAY_KNIGHT_CARD", -1, -1, -1)
    if t == ActionType.PLAY_YEAR_OF_PLENTY:
        return ("PLAY_YEAR_OF_PLENTY", RES_IDX[v[0]], RES_IDX[v[1]] if len(v) > 1 else -1, -1)
    if t == ActionType.PLAY_MONOPOLY:
        return ("PLAY_MONOPOLY", RES_IDX[v], -1, -1)
    if t == ActionType.PLAY_ROAD_BUILDING:
        return ("PLAY_ROAD_BUILDING", -1, -1, -1)
    if t == ActionType.MARITIME_TRADE:
        give = [r for r in v[:4] if r is not None]
        return ("MARITIME_TRADE", RES_IDX[give[0]], len(give), RES_IDX[v[4]])
    if t == ActionType.END_TURN:
        return ("END_TURN", -1, -1, -1)
    raise ValueError(f"unsupported action {action}")


def uncanon(c, color, ctx, colors):
    t, a, b, d = c
    if t == "ROLL":
        return Action(color, ActionType.ROLL, None)
    if t == "MOVE_ROBBER":
        return Action(color, ActionType.MOVE_ROBBER, (ctx.coord_of[a], None if b < 0 else colors[b]))
    if t == "DISCARD_RESOURCE":
        return Action(color, ActionType.DISCARD_RESOURCE, RESOURCES[a])
    if t == "BUILD_ROAD":
        return Action(color, ActionType.BUILD_ROAD, ctx.edges[a])
    if t == "BUILD_SETTLEMENT":
        return Action(color, ActionType.BUILD_SETTLEMENT, a)
    if t == "BUILD_CITY":
        return Action(color, ActionType.BUILD_CITY, a)
    if t == "BUY_DEVELOPMENT_CARD":
        return Action(color, ActionType.BUY_DEVELOPMENT_CARD, None)
    if t == "PLAY_KNIGHT_CARD":
        return Action(color, ActionType.PLAY_KNIGHT_CARD, None)
    if t == "PLAY_YEAR_OF_PLENTY":
        return Action(color, ActionType.PLAY_YEAR_OF_PLENTY, (RESOURCES[a],) if b < 0 else (RESOURCES[a], RESOURCES[b]))
    if t == "PLAY_MONOPOLY":
        return Action(color, ActionType.PLAY_MONOPOLY, RESOURCES[a])
    if t == "PLAY_ROAD_BUILDING":
        return Action(color, ActionType.PLAY_ROAD_BUILDING, None)
    if t == "MARITIME_TRADE":
        return Action(color, ActionType.MARITIME_TRADE, tuple([RESOURCES[a]] * b + [None] * (4 - b) + [RESOURCES[d]]))
    if t == "END_TURN":
        return Action(color, ActionType.END_TURN, None)
    raise ValueError(c)


def result_of(record):
    """ActionRecord.result -> (a, b) for State.apply."""
    t, r = record.action.action_type, record.result
    if t == ActionType.ROLL:
        return (int(r[0]), int(r[1]))
    if t == ActionType.BUY_DEVELOPMENT_CARD:
        return (DEV_IDX[r], -1)
    if t == ActionType.MOVE_ROBBER:
        return (-1 if r is None else RES_IDX[r], -1)
    if t == ActionType.DISCARD_RESOURCE:
        return (RES_IDX[r], -1)
    return None


def state_spec(game, ctx=None):
    ctx = ctx or ctx_for(game)
    s = game.state
    colors = list(s.colors)
    n = len(colors)
    ps = s.player_state

    def P(i, k):
        return ps[f"P{i}_{k}"]

    seat = {c: i for i, c in enumerate(colors)}
    owner = [-1] * 54
    is_city = [False] * 54
    for node, (color, kind) in s.board.buildings.items():
        owner[node] = seat[color]
        is_city[node] = kind == CITY
    road_owner = [-1] * 72
    for edge, color in s.board.roads.items():
        road_owner[ctx.edge_idx[tuple(sorted(edge))]] = seat[color]
    comps = s.board.connected_components
    return {
        "n": n,
        "hand": [[P(i, f"{r}_IN_HAND") for r in RESOURCES] for i in range(n)],
        "devs": [[P(i, f"{c}_IN_HAND") for c in DEVELOPMENT_CARDS] for i in range(n)],
        "played": [[P(i, f"PLAYED_{c}") for c in DEVELOPMENT_CARDS] for i in range(n)],
        "owned_at_start": [[bool(P(i, f"{c}_OWNED_AT_START")) for c in DEVELOPMENT_CARDS[:4]] + [False] for i in range(n)],
        "vp": [P(i, "VICTORY_POINTS") for i in range(n)],
        "actual_vp": [P(i, "ACTUAL_VICTORY_POINTS") for i in range(n)],
        "roads_available": [P(i, "ROADS_AVAILABLE") for i in range(n)],
        "settlements_available": [P(i, "SETTLEMENTS_AVAILABLE") for i in range(n)],
        "cities_available": [P(i, "CITIES_AVAILABLE") for i in range(n)],
        "has_road": [bool(P(i, "HAS_ROAD")) for i in range(n)],
        "has_army": [bool(P(i, "HAS_ARMY")) for i in range(n)],
        "has_rolled": [bool(P(i, "HAS_ROLLED")) for i in range(n)],
        "has_played_dev": [bool(P(i, "HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN")) for i in range(n)],
        "longest_road_length": [P(i, "LONGEST_ROAD_LENGTH") for i in range(n)],
        "settlements": [list(s.buildings_by_color[c][SETTLEMENT]) for c in colors],
        "cities": [list(s.buildings_by_color[c][CITY]) for c in colors],
        "roads": [[ctx.edge_idx[tuple(sorted(e))] for e in s.buildings_by_color[c][ROAD]] for c in colors],
        "bank": list(s.resource_freqdeck),
        "dev_deck": [DEV_IDX[c] for c in s.development_listdeck],
        "owner": owner,
        "is_city": is_city,
        "road_owner": road_owner,
        "components": [[sorted(comp) for comp in comps[c]] if c in comps else [] for c in colors],
        "buildable": sorted(s.board.board_buildable_ids),
        "road_lengths": [s.board.road_lengths.get(c, 0) for c in colors],
        "road_color": -1 if s.board.road_color is None else seat[s.board.road_color],
        "road_length": s.board.road_length,
        "robber": ctx.tile_id[s.board.robber_coordinate],
        "current_player": s.current_player_index,
        "current_turn": s.current_turn_index,
        "prompt": s.current_prompt.value,
        "initial_phase": s.is_initial_build_phase,
        "is_discarding": s.is_discarding,
        "discard_counts": list(s.discard_counts),
        "is_moving_knight": s.is_moving_knight,
        "is_road_building": s.is_road_building,
        "free_roads": s.free_roads_available,
        "num_turns": s.num_turns,
        "discard_limit": s.discard_limit,
        "vps_to_win": game.vps_to_win,
        "friendly_robber": s.friendly_robber,
    }


def rust_state(game, ctx=None):
    ctx = ctx or ctx_for(game)
    return catan_engine.State.from_spec(ctx.map, state_spec(game, ctx)), ctx


_LAYOUT = None


def layout_spec(ctx):
    """The index tables catan_engine.Layout needs, from catan_env.LAYOUT (edge numbering from ctx; same for every BASE map)."""
    L = LAYOUT
    node_idx = [L.node_idx[(i, n, kind)] for i in range(4) for n in range(54) for kind in (SETTLEMENT, CITY)]
    edge_idx = [L.edge_idx[(i, e)] for i in range(4) for e in ctx.edges]
    tile_proba_idx, tile_is_idx, port_is_idx = [-1] * 19, [-1] * (19 * 6), [-1] * (9 * 6)
    static_names = list(RESOURCES) + ["DESERT"]
    for idx, kind, arg in L.tile_static_idx:
        if kind == "PROBA":
            tile_proba_idx[arg] = idx
        else:
            tile_is_idx[arg[0] * 6 + static_names.index(arg[1])] = idx
    port_names = list(RESOURCES) + ["THREE_TO_ONE"]
    for idx, port_id, name in L.port_static_idx:
        port_is_idx[port_id * 6 + port_names.index(name)] = idx
    return {
        "n_features": N_FEATURES,
        "robber_idx": [L.robber_idx[t] for t in range(19)],
        "node_idx": node_idx,
        "edge_idx": edge_idx,
        "player_scalar_idx": [L.player_scalar_idx[(suffix, i)] for i in range(4) for suffix in PLAYER_SCALAR_STATE_SUFFIX],
        "dev_played_idx": [L.dev_played_idx[(card, i)] for i in range(4) for card in PLAYABLE_DEV_CARDS],
        "num_resources_idx": [L.num_resources_idx[i] for i in range(4)],
        "num_devs_idx": [L.num_devs_idx[i] for i in range(4)],
        "production_idx": [L.production_idx[(i, r)] for i in range(4) for r in RESOURCES],
        "buildable_nodes_idx": [L.buildable_nodes_idx[i] for i in range(4)],
        "p0_actual_vps_idx": L.p0_actual_vps_idx,
        "p0_resource_in_hand_idx": [L.p0_resource_in_hand_idx[r] for r in RESOURCES],
        "p0_dev_in_hand_idx": [L.p0_dev_in_hand_idx[c] for c in DEVELOPMENT_CARDS],
        "p0_has_played_dev_idx": L.p0_has_played_dev_idx,
        "bank_resource_idx": [L.bank_resource_idx[r] for r in RESOURCES],
        "bank_dev_cards_idx": L.bank_dev_cards_idx,
        "is_discarding_idx": L.is_discarding_idx,
        "is_moving_robber_idx": L.is_moving_robber_idx,
        "turn_base": N_BASE,
        "extra_base": EXTRA_BASE,
        "tile_proba_idx": tile_proba_idx,
        "tile_is_idx": tile_is_idx,
        "port_is_idx": port_is_idx,
    }


def layout(ctx):
    """catan_engine.Layout built from catan_env.LAYOUT (cached; same for every BASE map)."""
    global _LAYOUT
    if _LAYOUT is None:
        spec = layout_spec(ctx)
        _LAYOUT = catan_engine.Layout(spec)
    return _LAYOUT
