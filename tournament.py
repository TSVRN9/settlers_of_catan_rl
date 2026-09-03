"""Paper-protocol tournament (Xenou, Chalkiadakis & Afantenos, EUMAS 2018, Sect. 4.3): a pool of 5
agents, five 4-player tournaments each leaving one agent out (so every agent plays 4 of them), seats
randomly permuted per game, win ratio per agent as the metric (their Fig. 3a). Their pool was
DRRL / jSettler / UCT / BUCT / VPI at 20 games per tournament; the default pool here is our value-net
search vs catanatron's roster, at 100 games per tournament (docs/BENCHMARK.md).

    uv run python tournament.py --games 100 --out docs/benchmark/paper_protocol.json

Tokens are value_net.make_player's (ab, mcts[N], gp[N], vf, wr, vp, rand, vnet:<path>, ...).
"""

import os
import sys

if os.environ.get("PYTHONHASHSEED") != "0":  # reproducible action ordering, see evaluate.py
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import argparse
import json
import multiprocessing as mp
import random
import time
from pathlib import Path

from catanatron import Game
from catanatron.models.player import Color
from catanatron.state_functions import player_key

from evaluate import wilson_interval
from value_net import make_player

COLORS = [Color.RED, Color.BLUE, Color.ORANGE, Color.WHITE]


def short(token):
    return token.split(":")[0] + "(" + Path(token.split(":", 1)[1]).stem + ")" if ":" in token else token


def play(job):
    """(tournament index, lineup of 4 tokens, seed) -> one game record. The seat order is a
    seed-derived permutation of the lineup (the paper: agents 'in random order')."""
    t, lineup, seed = job
    order = list(range(4))
    random.Random(seed * 7919 + t).shuffle(order)
    players = [make_player(lineup[order[i]], COLORS[i]) for i in range(4)]
    game = Game(players, seed=seed)
    t0 = time.time()
    winner = game.play()
    vps = {}
    for i, color in enumerate(COLORS):
        vps[lineup[order[i]]] = game.state.player_state[f"{player_key(game.state, color)}_ACTUAL_VICTORY_POINTS"]
    winner_token = None if winner is None else lineup[order[COLORS.index(winner)]]
    return {"tournament": t, "seed": seed, "seats": [lineup[order[i]] for i in range(4)], "winner": winner_token,
            "vps": vps, "turns": game.state.num_turns, "secs": round(time.time() - t0, 2)}


def summarise(pool, games):
    out = {}
    for tok in pool:
        played = [g for g in games if tok in g["seats"]]
        wins = sum(g["winner"] == tok for g in played)
        lo, hi = wilson_interval(wins, len(played)) if played else (0.0, 0.0)
        out[tok] = {"games": len(played), "wins": wins, "ratio": wins / max(len(played), 1), "ci95": [lo, hi],
                    "mean_vp": sum(g["vps"][tok] for g in played) / max(len(played), 1)}
    return out


def table(pool, summary, per_tournament):
    lines = ["| agent | games | wins | win ratio | 95% CI | mean VP | " + " | ".join(f"T{k} (no {short(pool[k])})" for k in range(len(pool))) + " |",
             "|---|---|---|---|---|---|" + "---|" * len(pool)]
    for tok in pool:
        s = summary[tok]
        cells = [f"{per_tournament[k][tok]['wins']}/{per_tournament[k][tok]['games']}" if tok in per_tournament[k] and per_tournament[k][tok]["games"] else "–" for k in range(len(pool))]
        lines.append(f"| {short(tok)} | {s['games']} | {s['wins']} | {100 * s['ratio']:.1f}% | [{100 * s['ci95'][0]:.1f}, {100 * s['ci95'][1]:.1f}] | {s['mean_vp']:.2f} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default="vnet:checkpoints_value/v40.pt,ab,mcts,vf,wr", help="5 comma-separated tokens")
    ap.add_argument("--games", type=int, default=100, help="games per tournament")
    ap.add_argument("--seed", type=int, default=1_000_000)
    ap.add_argument("--jobs", type=int, default=7)
    ap.add_argument("--out", default="docs/benchmark/paper_protocol.json")
    args = ap.parse_args()
    pool = args.pool.split(",")
    assert len(pool) == 5, "the protocol wants a pool of exactly 5 agents"
    jobs = [(k, [tok for j, tok in enumerate(pool) if j != k], args.seed + k * args.games + i) for k in range(5) for i in range(args.games)]
    random.Random(args.seed).shuffle(jobs)  # interleave tournaments so partial results are balanced
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    games, t0 = [], time.time()
    ctx = mp.get_context("spawn")
    with ctx.Pool(args.jobs) as p:
        for g in p.imap_unordered(play, jobs, chunksize=1):
            games.append(g)
            n = len(games)
            print(f"[{n}/{len(jobs)}] T{g['tournament']} seed {g['seed']} winner {short(g['winner']) if g['winner'] else 'none'} "
                  f"turns {g['turns']} {g['secs']}s  elapsed {time.time() - t0:.0f}s", flush=True)
            if n % 10 == 0 or n == len(jobs):
                summary = summarise(pool, games)
                per_t = [summarise(pool, [x for x in games if x["tournament"] == k]) for k in range(5)]
                out.write_text(json.dumps({"protocol": "Xenou et al. 2018, five 4-player tournaments each leaving one agent out; seats permuted per game",
                                           "pool": pool, "games_per_tournament": args.games, "seed": args.seed, "done": n, "total": len(jobs),
                                           "elapsed_s": round(time.time() - t0), "summary": summary, "per_tournament": per_t, "games": games}, indent=1))
    summary = summarise(pool, games)
    per_t = [summarise(pool, [x for x in games if x["tournament"] == k]) for k in range(5)]
    print("\n" + table(pool, summary, per_t))
    print(f"\n{len(games)} games in {time.time() - t0:.0f}s -> {out}")


if __name__ == "__main__":
    main()
