"""M4: play games in parallel and record (state, perspective, won) samples
for train_value.py. Every tick, with probability --sample-p, one uniformly
random perspective color is encoded (value_net.encode_for_value) and later
labeled 1.0 iff that color won. Games with no winner (TURNS_LIMIT) are dropped.

    uv run python gen_games.py --lineup ab,ab,ab,ab --games 5000 --out data/it0
    uv run python gen_games.py --lineup vnet:checkpoints_value/v0.pt,vnet:checkpoints_value/v0.pt,vnet:checkpoints_value/v0.pt,ab --games 5000 --out data/it1

Lineup tokens: ab (AlphaBetaPlayer), vf (ValueFunctionPlayer),
wr (WeightedRandomPlayer), vnet:<path> (ValueNetPlayer). Seating is shuffled
by the engine. Output: data/<name>/shard_NNNN.npz with X float16 (n, 1030),
y uint8 (perspective won), vp float16 (n, 4: final VPs, perspective order),
turns_left float16, game int32 (the seed; train_value.py splits held-out by game),
and with --rank-p: rank_c / rank_o float16 (m, 1030), AlphaBeta's chosen child
state vs one other legal child, from the decider's perspective.
"""

import os
import sys

# Same reproducibility guard as evaluate.py (see docs/FINDINGS.md, "the evaluator was broken").
if os.environ.get("PYTHONHASHSEED") != "0":
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import argparse
import multiprocessing as mp
import random
import time

import numpy as np
from catanatron import Color, Game
from catanatron.game import GameAccumulator
from catanatron.features import iter_players
from catanatron.state_functions import get_actual_victory_points

from catanatron.models.enums import ActionType
from catanatron.players.minimax import AlphaBetaPlayer

import rust_bridge as rb
from catan_env import Encoder
from value_net import N_FEATURES, encode_for_value, make_player

COLORS = (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)
# Actions whose child state is fully determined (no dice / draw / steal), so a
# single child encoding is the whole story.
DETERMINISTIC = {
    ActionType.END_TURN, ActionType.BUILD_SETTLEMENT, ActionType.BUILD_ROAD, ActionType.BUILD_CITY,
    ActionType.PLAY_KNIGHT_CARD, ActionType.PLAY_YEAR_OF_PLENTY, ActionType.PLAY_ROAD_BUILDING,
    ActionType.PLAY_MONOPOLY, ActionType.MARITIME_TRADE, ActionType.DISCARD_RESOURCE,
}


def _deterministic(a):
    return a.action_type in DETERMINISTIC or (a.action_type == ActionType.MOVE_ROBBER and a.value[1] is None)


class StateSampler(GameAccumulator):
    """Uses its own random.Random: Game seeds the *global* random module and
    the bots draw from it, so touching it here would change the game."""

    def __init__(self, sample_p, seed, rank_p=0.0):
        self.sample_p = sample_p
        self.rank_p = rank_p
        self.rng = random.Random(seed)
        self.encoder = Encoder()
        self.xs, self.colors, self.turns = [], [], []
        self.rank_c, self.rank_o = [], []  # (chosen child, other child) encodings, decider's perspective

    def step(self, game, action):
        if self.rng.random() < self.sample_p:
            color = self.rng.choice(COLORS)
            self.xs.append(encode_for_value(self.encoder, game, color))
            self.colors.append(color)
            self.turns.append(game.state.num_turns)
        if self.rank_p and self.rng.random() < self.rank_p and isinstance(game.state.current_player(), AlphaBetaPlayer):
            self.record_pair(game, action)

    def record_pair(self, game, action):
        """AlphaBeta's chosen child vs one random other deterministic legal
        child, both encoded from the decider's perspective (see FINDINGS.md,
        iteration-0 gate: an outcome-regressed net never sees the losing
        siblings a search compares, so it can't rank them)."""
        if not _deterministic(action):
            return
        others = [a for a in game.playable_actions if a != action and _deterministic(a)]
        if not others:
            return
        other = self.rng.choice(others)
        rs, ctx = rb.rust_state(game)
        colors = list(game.state.colors)
        p0 = colors.index(action.color)
        layout = rb.layout(ctx)
        xc = rs.child_encoding(layout, rb.canon(action, ctx, colors), p0)
        xo = rs.child_encoding(layout, rb.canon(other, ctx, colors), p0)
        if xc is not None and xo is not None:
            self.rank_c.append(xc)
            self.rank_o.append(xo)

    def targets(self, game):
        """Per sample: won (uint8), final VPs of the 4 seats in perspective
        order (float16, 4), turns remaining (float16). The outcome alone is one
        bit per game shared by every sample; the final scoreboard and the
        clock add signal per game at zero generation cost."""
        winner = game.winning_color()
        final_vps = {c: get_actual_victory_points(game.state, c) for c in game.state.colors}
        y = np.array([c == winner for c in self.colors], dtype=np.uint8)
        vp = np.array([[final_vps[c] for _, c in iter_players(game.state.colors, p0)] for p0 in self.colors], dtype=np.float16)
        turns_left = np.array([game.state.num_turns - t for t in self.turns], dtype=np.float16)
        return y, vp, turns_left


_W = {}


def _init_worker(lineup, sample_p, rank_p=0.0):
    _W["lineup"], _W["sample_p"], _W["rank_p"] = lineup, sample_p, rank_p


def play_one(seed):
    players = [make_player(spec, c) for spec, c in zip(_W["lineup"], COLORS)]
    acc = StateSampler(_W["sample_p"], seed, _W["rank_p"])
    game = Game(players, seed=seed)
    winner = game.play(accumulators=[acc])
    if winner is None or not acc.xs:
        return seed, None
    y, vp, turns_left = acc.targets(game)
    n_rank = len(acc.rank_c)
    return seed, dict(
        X=np.array(acc.xs, dtype=np.float16), y=y, vp=vp, turns_left=turns_left,
        rank_c=np.array(acc.rank_c, dtype=np.float16).reshape(n_rank, N_FEATURES),
        rank_o=np.array(acc.rank_o, dtype=np.float16).reshape(n_rank, N_FEATURES),
    )


def _flush(out, shard, parts, gs):
    path = os.path.join(out, f"shard_{shard:04d}.npz")
    np.savez(path, game=np.array(gs, dtype=np.int32), **{k: np.concatenate([p[k] for p in parts]) for k in parts[0]})
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lineup", required=True, help="4 comma-separated tokens: ab|vf|wr|vnet:<path>")
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--jobs", type=int, default=7)
    parser.add_argument("--sample-p", type=float, default=0.5)
    parser.add_argument("--rank-p", type=float, default=0.0, help="per AlphaBeta decision: probability of recording a (chosen, other) child pair")
    parser.add_argument("--shard", type=int, default=500, help="games per output file")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    lineup = args.lineup.split(",")
    assert len(lineup) == 4, "lineup needs exactly 4 seats"
    os.makedirs(args.out, exist_ok=True)

    seeds = range(args.seed, args.seed + args.games)
    t0 = time.time()
    parts, gs, shard, done, dropped, n_samples, n_pairs = [], [], 0, 0, 0, 0, 0
    ctx = mp.get_context("spawn")
    with ctx.Pool(args.jobs, initializer=_init_worker, initargs=(lineup, args.sample_p, args.rank_p)) as pool:
        for seed, part in pool.imap_unordered(play_one, seeds, chunksize=1):
            done += 1
            if part is None:
                dropped += 1
            else:
                parts.append(part); gs.extend([seed] * len(part["y"])); n_samples += len(part["y"]); n_pairs += len(part["rank_c"])
            if parts and done % args.shard == 0:
                print(f"  {done}/{args.games} games, {n_samples} samples, {n_pairs} pairs, {done / (time.time() - t0):.2f} games/s -> {_flush(args.out, shard, parts, gs)}", flush=True)
                parts, gs, shard = [], [], shard + 1
    if parts:
        print(f"  final -> {_flush(args.out, shard, parts, gs)}", flush=True)
    el = time.time() - t0
    print(f"{args.games} games in {el:.0f}s ({args.games / el:.2f} games/s), {dropped} dropped (no winner), "
          f"{n_samples} samples ({n_samples / max(args.games - dropped, 1):.0f}/game), {n_pairs} rank pairs -> {args.out}", flush=True)


if __name__ == "__main__":
    main()
