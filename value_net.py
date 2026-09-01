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

import numpy as np
import torch
import torch.nn as nn
from catanatron.features import iter_players
from catanatron.players.minimax import AlphaBetaPlayer
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer

from catan_env import FEATURES, Encoder

# Encoder has HAS_ROLLED / is_discarding / is_moving_robber but not whose turn
# it is; a leaf evaluator scoring arbitrary mid-turn states needs that.
# Appended here (not inside Encoder) so 1026-dim PPO/BC checkpoints stay loadable.
N_BASE = len(FEATURES)
N_FEATURES = N_BASE + 4

_NET_CACHE = {}
_threads_capped = False


def encode_for_value(encoder, game, p0_color):
    out = np.zeros(N_FEATURES, dtype=np.float32)
    out[:N_BASE] = encoder.encode(game, p0_color)
    current = game.state.current_color()
    for i, color in iter_players(game.state.colors, p0_color):
        if color == current:
            out[N_BASE + i] = 1.0
    return out


class ValueNet(nn.Sequential):
    def __init__(self, hidden=512):
        super().__init__(
            nn.Linear(N_FEATURES, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, 1),
        )


def load_value_net(path):
    """Per-process cache; also caps torch to one thread the first time (we run
    7 worker processes on 8 hardware threads doing batch-1 forwards -- same
    regime and same reasoning as self_play._load_model)."""
    global _threads_capped
    if not _threads_capped:
        torch.set_num_threads(1)
        _threads_capped = True
    if path not in _NET_CACHE:
        net = ValueNet()
        net.load_state_dict(torch.load(path, map_location="cpu"))
        net.eval()
        _NET_CACHE[path] = net
    return _NET_CACHE[path]


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

    # ponytail: batch-1 forward per leaf (~100us vs base_fn's 80us). Upgrade =
    # expand the depth-2 tree fully, encode all leaves, one forward -- only
    # if generation throughput, not model quality, becomes the limiter.
    def value_function(self, game, p0_color):
        winner = game.winning_color()
        if winner is not None:
            return float(winner == p0_color)
        net = load_value_net(self.net_path)
        x = torch.from_numpy(encode_for_value(self._encoder, game, p0_color))
        with torch.no_grad():
            return torch.sigmoid(net(x)).item()

    def __repr__(self):
        return f"ValueNetPlayer:{self.color.value}(depth={self.depth},net={self.net_path})"


def make_player(spec, color):
    """Lineup/--player token -> catanatron Player. Shared by gen_games.py and evaluate.py."""
    if spec == "ab":
        return AlphaBetaPlayer(color)
    if spec == "vf":
        return ValueFunctionPlayer(color)
    if spec == "wr":
        return WeightedRandomPlayer(color)
    if spec.startswith("vnet:"):
        return ValueNetPlayer(color, spec[len("vnet:"):])
    raise ValueError(f"unknown player token {spec!r}")
