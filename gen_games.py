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
turns_left float16, game int32 (the seed; train_value.py splits held-out by game).
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

from catan_env import Encoder
from value_net import encode_for_value, make_player

COLORS = (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)


class StateSampler(GameAccumulator):
    """Uses its own random.Random: Game seeds the *global* random module and
    the bots draw from it, so touching it here would change the game."""

    def __init__(self, sample_p, seed):
        self.sample_p = sample_p
        self.rng = random.Random(seed)
        self.encoder = Encoder()
        self.xs, self.colors, self.turns = [], [], []

    def step(self, game, action):
        if self.rng.random() < self.sample_p:
            color = self.rng.choice(COLORS)
            self.xs.append(encode_for_value(self.encoder, game, color))
            self.colors.append(color)
            self.turns.append(game.state.num_turns)

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


def _init_worker(lineup, sample_p):
    _W["lineup"], _W["sample_p"] = lineup, sample_p


def play_one(seed):
    players = [make_player(spec, c) for spec, c in zip(_W["lineup"], COLORS)]
    acc = StateSampler(_W["sample_p"], seed)
    game = Game(players, seed=seed)
    winner = game.play(accumulators=[acc])
    if winner is None or not acc.xs:
        return seed, None
    y, vp, turns_left = acc.targets(game)
    return seed, dict(X=np.array(acc.xs, dtype=np.float16), y=y, vp=vp, turns_left=turns_left)


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
    parser.add_argument("--shard", type=int, default=500, help="games per output file")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    lineup = args.lineup.split(",")
    assert len(lineup) == 4, "lineup needs exactly 4 seats"
    os.makedirs(args.out, exist_ok=True)

    seeds = range(args.seed, args.seed + args.games)
    t0 = time.time()
    parts, gs, shard, done, dropped, n_samples = [], [], 0, 0, 0, 0
    ctx = mp.get_context("spawn")
    with ctx.Pool(args.jobs, initializer=_init_worker, initargs=(lineup, args.sample_p)) as pool:
        for seed, part in pool.imap_unordered(play_one, seeds, chunksize=1):
            done += 1
            if part is None:
                dropped += 1
            else:
                parts.append(part); gs.extend([seed] * len(part["y"])); n_samples += len(part["y"])
            if parts and done % args.shard == 0:
                print(f"  {done}/{args.games} games, {n_samples} samples, {done / (time.time() - t0):.2f} games/s -> {_flush(args.out, shard, parts, gs)}", flush=True)
                parts, gs, shard = [], [], shard + 1
    if parts:
        print(f"  final -> {_flush(args.out, shard, parts, gs)}", flush=True)
    el = time.time() - t0
    print(f"{args.games} games in {el:.0f}s ({args.games / el:.2f} games/s), {dropped} dropped (no winner), "
          f"{n_samples} samples ({n_samples / max(args.games - dropped, 1):.0f}/game) -> {args.out}", flush=True)


if __name__ == "__main__":
    main()
