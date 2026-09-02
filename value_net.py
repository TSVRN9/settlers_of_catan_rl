"""M4: a learned win-probability net as the leaf evaluator inside
catanatron's own AlphaBetaPlayer search. See docs/HANDOFF.md (M4) and
docs/FINDINGS.md's 2026-09-01 M4 section for the measurements behind this:
AlphaBeta's edge over ValueFunctionPlayer is entirely its depth-2 expectimax
(same heuristic, 10% -> ~25% vs 3x AlphaBeta), and its hand heuristic costs
80us/leaf vs 37us for our encoder -- so swap the evaluator, keep the search.

`ValueNetPlayer` subclasses `AlphaBetaPlayer` and uses its existing
`use_value_function` / `value_function(game, p0_color)` hook. Nothing about
the search is reimplemented.

    from value_net import ValueNetPlayer
    ValueNetPlayer(Color.BLUE, "checkpoints_value/v0.pt")
"""

import math

import numpy as np
import torch
import torch.nn as nn
from catanatron.features import iter_players
from catanatron.models.enums import DEVELOPMENT_CARDS, Action, ActionRecord, ActionType
from catanatron.models.map import number_probability
from catanatron.models.player import Player
from catanatron.players.minimax import AlphaBetaPlayer
from catanatron.players.tree_search_utils import execute_spectrum
from catanatron.state_functions import get_dev_cards_in_hand, get_enemy_colors
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer

import fast_copy
from catan_env import FEATURES, Encoder

fast_copy.install()  # 1.3x on every Game.copy()-heavy player, AlphaBeta included; exact (test_env.py)

# Encoder has HAS_ROLLED / is_discarding / is_moving_robber but not whose turn
# it is; a leaf evaluator scoring arbitrary mid-turn states needs that.
# Appended here (not inside Encoder) so 1026-dim PPO/BC checkpoints stay loadable.
N_BASE = len(FEATURES)
EXTRA_BASE = N_BASE + 4  # after the 4 turn one-hots
# Heuristic summaries (AlphaBeta's base_fn terms), computed by catan_engine:
# per relative player: production score, reachable production at 0/1/2 roads,
# tiles touched (5 x 4), then p0's hand synergy. See docs/FINDINGS.md (v1
# diagnosis): without these the net could not see where a road leads.
N_EXTRA = 21
N_FEATURES = EXTRA_BASE + N_EXTRA

# Raw tile/port one-hots (206 features) uniquely fingerprint a map, and every
# sample from one game shares that map, so an MLP memorizes "this map -> this
# winner" within half an epoch (docs/FINDINGS.md, M4 iteration 0). They are
# zeroed at the net's input; the derived per-player production / buildable
# node features carry what the map means for the value.
STATIC_MASK = np.ones(N_FEATURES, dtype=np.float32)
for _i, _name in enumerate(FEATURES):
    if _name.startswith("TILE") or _name.startswith("PORT"):
        STATIC_MASK[_i] = 0.0

_NET_CACHE = {}
_threads_capped = False

try:
    import catan_engine  # noqa: F401  (build: uv run maturin develop --release -m catan_engine/Cargo.toml)

    USE_RUST = True
except ImportError:  # pragma: no cover
    USE_RUST = False


def encode_for_value(encoder, game, p0_color):
    """Full feature vector from p0's perspective. The heuristic-summary block
    comes from catan_engine (rust_bridge); the base block and turn one-hot
    are checked against this Python version in test_env.py."""
    import rust_bridge as rb

    rs, ctx = rb.rust_state(game)
    return rs.encode(rb.layout(ctx), list(game.state.colors).index(p0_color))


def encode_base_python(encoder, game, p0_color):
    """Base 1026 features + turn one-hot, pure Python (reference for tests)."""
    out = np.zeros(EXTRA_BASE, dtype=np.float32)
    out[:N_BASE] = encoder.encode(game, p0_color)
    current = game.state.current_color()
    for i, color in iter_players(game.state.colors, p0_color):
        if color == current:
            out[N_BASE + i] = 1.0
    return out


N_HEADS = 6  # [win logit, final VPs of the 4 seats / 10, turns remaining / 100]


# --- smooth stand-in for AlphaBeta's base_fn, as a fixed function of the
# features (mirrors catan_engine's smooth_base_fn; parity-tested). Same terms
# and priority order, weight ratios ~3-10 between levels instead of ~1e6, so
# the value net can carry it exactly and learn only a residual on top.
def _idx(name):
    from catan_env import FEATURE_INDEX

    return FEATURE_INDEX[name]


def smooth_heuristic(x):
    """x: (..., N_FEATURES) float tensor from perspective P0 -> (...,) score."""
    eb = EXTRA_BASE
    vp = x[..., _idx("P0_PUBLIC_VPS")]
    prod0, prod1 = x[..., eb + 0], x[..., eb + 5]
    reach1 = x[..., eb + 2]
    synergy = x[..., eb + 20]
    buildable = x[..., _idx("P0_BUILDABLE_NODES")]
    tiles = x[..., eb + 4]
    in_hand = x[..., _idx("P0_NUM_RESOURCES_IN_HAND")]
    lr_len = x[..., _idx("P0_LONGEST_ROAD_LENGTH")]
    devs = x[..., _idx("P0_NUM_DEVS_IN_HAND")]
    knights = x[..., _idx("P0_KNIGHT_PLAYED")]
    lr_factor = torch.where(buildable == 0, torch.ones_like(buildable), torch.full_like(buildable, 0.1))
    return (
        10.0 * vp + 3.0 * prod0 - 3.0 * prod1 + 1.0 * reach1 + 0.5 * synergy + 0.1 * buildable
        + 0.02 * tiles + 0.02 * in_hand - 0.1 * (in_hand > 7).to(x.dtype)
        + 0.1 * lr_factor * lr_len + 0.05 * devs + 0.05 * knights
    )


class ValueNet(nn.Module):
    """forward() -> win logit = alpha * smooth_heuristic(x) + residual; the
    residual MLP's last layer starts at zero, so a fresh net plays exactly
    like the smooth heuristic (AlphaBeta-class) and training only learns
    corrections from outcomes. heads() -> all N_HEADS (win logit first)."""

    def __init__(self, hidden=512, dropout=0.3):
        super().__init__()
        self.register_buffer("mask", torch.from_numpy(STATIC_MASK))
        self.alpha = nn.Parameter(torch.tensor(1.0))
        self.mlp = nn.Sequential(
            nn.Linear(N_FEATURES, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, N_HEADS),
        )
        nn.init.zeros_(self.mlp[-1].weight)
        nn.init.zeros_(self.mlp[-1].bias)

    def heads(self, x):
        out = self.mlp(x * self.mask)
        prior = (self.alpha * smooth_heuristic(x)).unsqueeze(-1)
        return torch.cat([out[..., :1] + prior, out[..., 1:]], dim=-1)

    def forward(self, x):
        return self.heads(x)[..., :1]


def load_value_net(path):
    """Per-process cache; also caps torch to one thread the first time (we run
    7 worker processes on 8 hardware threads doing batch-1 forwards -- same
    regime and same reasoning as self_play._load_model)."""
    global _threads_capped
    if not _threads_capped:
        torch.set_num_threads(1)
        _threads_capped = True
    if path not in _NET_CACHE:
        sd = torch.load(path, map_location="cpu")
        first = [k for k in sd if k.endswith(".weight")][0]
        net = ValueNet(hidden=sd[first].shape[0])
        last = [k for k in sd if k.endswith(".weight")][-1]
        if sd[last].shape[0] == 1:  # single-head checkpoint (v0.pt as evaluated), before the auxiliary heads
            w, b = torch.zeros(N_HEADS, sd[last].shape[1]), torch.zeros(N_HEADS)
            w[0], b[0] = sd[last][0], sd[last[:-6] + "bias"][0]
            sd[last], sd[last[:-6] + "bias"] = w, b
        net.load_state_dict(sd)
        net.eval()
        _NET_CACHE[path] = net
    return _NET_CACHE[path]


def _pinned(game, action, result):
    """game.copy() with `action` applied and its stochastic outcome pinned to
    `result` via action_record -- apply_roll / apply_buy_development_card
    read action_record.result, NOT action.value. Catanatron's own
    execute_spectrum sets action.value, so its ROLL "outcomes" re-roll the
    dice at random (measured: expanding the same state twice gives different
    leaves) and its BUY_DEVELOPMENT_CARD "options" all pop the true top card."""
    g = game.copy()
    try:
        g.execute(action, validate_action=False, action_record=ActionRecord(action=action, result=result))
    except Exception:
        pass  # imagined-impossible outcome (card not in deck): same flattening as catanatron
    return g


def expand_outcomes(game, actions):
    """action -> [(game, proba)], an exact expectation (see _pinned)."""
    out = {}
    for action in actions:
        t = action.action_type
        if t == ActionType.ROLL:
            out[action] = [
                (_pinned(game, action, (roll // 2, math.ceil(roll / 2))), number_probability(roll))
                for roll in range(2, 13)
            ]
        elif t == ActionType.BUY_DEVELOPMENT_CARD:
            # belief deck = face-down deck + enemies' unplayed cards, as catanatron does
            deck = list(game.state.development_listdeck)
            for color in get_enemy_colors(game.state.colors, action.color):
                for card in DEVELOPMENT_CARDS:
                    deck += [card] * get_dev_cards_in_hand(game.state, color, card)
            out[action] = [(_pinned(game, action, card), deck.count(card) / len(deck)) for card in sorted(set(deck))]
        else:
            out[action] = execute_spectrum(game, action)  # deterministic, or MOVE_ROBBER (already pinned upstream)
    return out


class ValueNetPlayer(AlphaBetaPlayer):
    """AlphaBetaPlayer whose leaves are scored by a ValueNet as P(p0 wins).

    Returns a probability, not a logit: the search averages leaf values over
    dice/dev-card/robber outcomes, and averaging logits is the wrong
    aggregation at chance nodes. Terminal states are scored exactly -- the
    search does evaluate won states, and gen_games.py never records a
    post-winning-move state, so the net would otherwise extrapolate its most
    important leaf.

    Construct one per game (the encoder's map template is per-map)."""

    def __init__(self, color, net_path, depth=2, prunning=False):
        super().__init__(color, depth=depth, prunning=prunning)
        self.use_value_function = True
        self.net_path = net_path
        self._encoder = Encoder()

    def value_function(self, game, p0_color):
        """Batch-1 path, kept for AlphaBetaPlayer.alphabeta (the recursive
        reference used by test_env.py) -- decide() below doesn't use it."""
        winner = game.winning_color()
        if winner is not None:
            return float(winner == p0_color)
        net = load_value_net(self.net_path)
        x = torch.from_numpy(encode_for_value(self._encoder, game, p0_color))
        with torch.no_grad():
            return torch.sigmoid(net(x)).item()

    def decide(self, game, playable_actions):
        if USE_RUST:
            return self.decide_rust(game, playable_actions)
        return self.decide_python(game, playable_actions)

    def decide_rust(self, game, playable_actions):
        """Same tree as decide_python, expanded and encoded by catan_engine
        (Rust); one Python forward over the leaf matrix; backup in Rust.
        Verified equal to the Python path in test_env.py."""
        actions = self.get_actions(game)
        if len(actions) == 1:
            return actions[0]
        import rust_bridge as rb

        rs, ctx = rb.rust_state(game)
        colors = list(game.state.colors)
        leaves, fixed = rs.expand(rb.layout(ctx), self.depth, colors.index(self.color))
        net = load_value_net(self.net_path)
        with torch.no_grad():
            values = torch.sigmoid(net(torch.from_numpy(leaves))).squeeze(1).double().numpy()
        for i, v in fixed:
            values[i] = v
        self._n_leaves = leaves.shape[0]
        best, _ = rs.backup(values)
        return playable_actions[0] if best is None else rb.uncanon(best, self.color, ctx, colors)

    def decide_python(self, game, playable_actions):
        """Same expectimax as AlphaBetaPlayer.alphabeta, but the whole depth-d
        tree is expanded first and every leaf is scored in one forward pass.
        Measured: the recursive hook costs 9.0 s/seat-game (torch per-op
        dispatch at batch 1), vs 1.8 s for AlphaBeta's own heuristic. No
        alpha-beta cutoffs -- the base class passes alpha/beta through chance
        nodes unadjusted, so its cutoffs were approximate anyway; this is the
        exact expectation. Chance outcomes are pinned (expand_outcomes), so
        the same state always expands to the same tree."""
        actions = self.get_actions(game)
        if len(actions) == 1:
            return actions[0]
        self._leaf_obs, self._leaf_fixed = [], {}
        tree = self._expand(game, self.depth)
        values = self._score_leaves()
        best_action, _ = self._backup(tree, values)
        return best_action if best_action is not None else playable_actions[0]

    def _expand(self, game, depth):
        winner = game.winning_color()
        if depth == 0 or winner is not None:
            idx = len(self._leaf_obs)
            if winner is not None:
                self._leaf_fixed[idx] = float(winner == self.color)
                self._leaf_obs.append(None)
            else:
                self._leaf_obs.append(encode_for_value(self._encoder, game, self.color))
            return idx
        maximizing = game.state.current_color() == self.color
        outcomes = expand_outcomes(game, self.get_actions(game))  # action -> [(game, proba)]
        return (maximizing, [(a, [(p, self._expand(g, depth - 1)) for g, p in outs]) for a, outs in outcomes.items()])

    def _score_leaves(self):
        values = np.zeros(len(self._leaf_obs), dtype=np.float64)
        live = [i for i, o in enumerate(self._leaf_obs) if o is not None]
        if live:
            net = load_value_net(self.net_path)
            with torch.no_grad():
                x = torch.from_numpy(np.stack([self._leaf_obs[i] for i in live]))
                values[live] = torch.sigmoid(net(x)).squeeze(1).numpy()
        for i, v in self._leaf_fixed.items():
            values[i] = v
        return values

    def _backup(self, node, values):
        if isinstance(node, int):
            return None, values[node]
        maximizing, children = node
        best_action, best_value = None, float("-inf") if maximizing else float("inf")
        for action, outs in children:
            ev = sum(p * self._backup(child, values)[1] for p, child in outs)
            if (ev > best_value) if maximizing else (ev < best_value):
                best_action, best_value = action, ev
        return best_action, best_value

    def __repr__(self):
        return f"ValueNetPlayer:{self.color.value}(depth={self.depth},net={self.net_path})"


class RustSmoothPlayer(Player):
    """Exact depth-d expectimax over the smooth base_fn stand-in, in Rust.
    Calibration player: how much does smoothing the lexicographic heuristic
    cost? (`--player rsab`)"""

    def __init__(self, color, depth=2):
        super().__init__(color)
        self.depth = depth

    def decide(self, game, playable_actions):
        if len(playable_actions) == 1:
            return playable_actions[0]
        import rust_bridge as rb

        rs, ctx = rb.rust_state(game)
        best = rs.decide_smooth(self.depth)
        return playable_actions[0] if best is None else rb.uncanon(best, self.color, ctx, list(game.state.colors))


class RustAlphaBetaPlayer(Player):
    """AlphaBetaPlayer's heuristic (base_fn) + depth-2 expectimax, run in
    catan_engine. For data generation only: exact chance nodes, so not
    bit-identical to the shipped AlphaBetaPlayer -- the gate keeps using
    the Python one. ~50x cheaper per decision (docs/FINDINGS.md)."""

    def __init__(self, color, depth=2):
        super().__init__(color)
        self.depth = depth

    def decide(self, game, playable_actions):
        if len(playable_actions) == 1:
            return playable_actions[0]
        import rust_bridge as rb

        rs, ctx = rb.rust_state(game)
        best = rs.decide_heuristic(self.depth)
        return playable_actions[0] if best is None else rb.uncanon(best, self.color, ctx, list(game.state.colors))


def make_player(spec, color):
    """Lineup/--player token -> catanatron Player. Shared by gen_games.py and evaluate.py."""
    if spec == "ab":
        return AlphaBetaPlayer(color)
    if spec.startswith("ab") and spec[2:].isdigit():  # ab3 = AlphaBetaPlayer(depth=3)
        return AlphaBetaPlayer(color, depth=int(spec[2:]))
    if spec == "rsab":
        return RustSmoothPlayer(color)
    if spec == "rab":
        return RustAlphaBetaPlayer(color)
    if spec.startswith("rab") and spec[3:].isdigit():
        return RustAlphaBetaPlayer(color, depth=int(spec[3:]))
    if spec == "vf":
        return ValueFunctionPlayer(color)
    if spec == "wr":
        return WeightedRandomPlayer(color)
    if spec.startswith("vnet:"):
        return ValueNetPlayer(color, spec[len("vnet:"):])
    raise ValueError(f"unknown player token {spec!r}")
