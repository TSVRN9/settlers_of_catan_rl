"""Paired sequential gate: candidate vs incumbent, each in seat BLUE vs 3x Rust AlphaBeta on the SAME seeds, decided by
an SPRT on the per-seed win difference (docs/RESEARCH-PLAYTIME.md §3, 2026-09-22).

    uv run python gate.py vnet:cand.pt vnet:inc.pt --seed 58000007          # exit 0 = accept the candidate

The old gate (two 4,000-game totals, strict >) has ~35% power at 1.5 points, the size of most real changes; it accepted
ties (+1, +27 games) and would miss a real +1.5. Here games are played in blocks on shared seeds, the paired mean
difference d and its sample sd feed the normal-approximation log-likelihood ratio between H0: mean d = --h0 (a slight
regression) and H1: mean d = --h1 (a real gain), and play stops at +-log(19) (alpha = beta = 0.05) or at --max games,
where the incumbent stays. Ponytail: win/loss only; a VP-margin statistic (~1.3-2x less variance) is the next step.

`--pool a,b,c,...` (2026-09-23, the strongest-agent goal): each seed's 3 opponents are drawn from the pool, the same for
both players; every block prints the paired difference per opponent token at the table, and an accept is vetoed when
any token shows a significant regression (z < -2).
"""
import argparse
import math
import os
import random
import sys

os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")
if os.environ.get("PYTHONHASHSEED") != "0":  # arena games must be reproducible across processes (evaluate.py)
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

from catanatron import Color

import arena


def opponents(pool, seed):
    """The 3 opponents at seed's table: drawn with replacement from the pool, the same for every player gated."""
    return random.Random(seed * 2654435761).choices(pool, k=3) if pool else ["rab"] * 3


def wins_by_seed(player, seeds, pool=None):
    return {seed: float(w == Color.BLUE) for seed, w, _, _ in arena.play(lambda s: [player] + opponents(pool, s), seeds, batch=128)}


def by_opponent(d, seeds, pool):
    """Per opponent token: (games with it at the table, mean paired diff, z)."""
    out = {}
    for tok in sorted(set(pool)):
        xs = [x for x, s in zip(d, seeds) if tok in opponents(pool, s)]
        if len(xs) > 1:
            m = sum(xs) / len(xs)
            sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) or 1e-9
            out[tok] = (len(xs), m, m / (sd / math.sqrt(len(xs))))
    return out


def llr(d, h0, h1):
    """Log-likelihood ratio H1:H0 for i.i.d. normal d with the sample variance (Fishtest-style normal approximation)."""
    n = len(d)
    mean = sum(d) / n
    var = sum((x - mean) ** 2 for x in d) / max(n - 1, 1)
    if var == 0:
        return 0.0
    return n * (h1 - h0) * (2 * mean - h0 - h1) / (2 * var)


def gate(cand, inc, seed, block, max_games, h0, h1, alpha=0.05, pool=None):
    bound = math.log((1 - alpha) / alpha)
    d, wa, wb, n = [], 0, 0, 0
    while n < max_games:
        seeds = range(seed + n, seed + n + block)
        a, b = wins_by_seed(cand, seeds, pool), wins_by_seed(inc, seeds, pool)
        d += [a[s] - b[s] for s in seeds]
        wa += int(sum(a.values())); wb += int(sum(b.values())); n += block
        L = llr(d, h0, h1)
        print(f"  {n} games: cand {wa} inc {wb}  mean diff {sum(d) / n:+.4f}  llr {L:+.2f} (bounds ±{bound:.2f})", flush=True)
        per = by_opponent(d, range(seed, seed + n), pool) if pool else {}
        if per:
            print("    per opponent: " + "  ".join(f"{t.split(':')[0][:12]}{'(' + t.split('/')[-1][:8] + ')' if ':' in t else ''} {m:+.3f} z{z:+.1f} n{k}" for t, (k, m, z) in per.items()), flush=True)
        if L >= bound:
            bad = [t for t, (k, m, z) in per.items() if z < -2]
            if bad:  # a pooled gain paid for by a regression against one opponent class is the overfitting to avoid
                print(f"  accept vetoed: significant regression vs {bad}", flush=True)
                return "reject", wa, wb, n
            return "accept", wa, wb, n
        if L <= -bound:
            return "reject", wa, wb, n
    return "cap", wa, wb, n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cand")
    ap.add_argument("inc")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--block", type=int, default=1000)
    ap.add_argument("--max", type=int, default=16000)
    ap.add_argument("--h0", type=float, default=-0.005, help="H0: candidate is this much worse (per-game win prob)")
    ap.add_argument("--h1", type=float, default=0.010, help="H1: candidate is this much better")
    ap.add_argument("--pool", default="", help="comma-separated opponent tokens; each seed's 3 opponents are drawn from it (default 3x rab)")
    a = ap.parse_args()
    verdict, wa, wb, n = gate(a.cand, a.inc, a.seed, a.block, a.max, a.h0, a.h1, pool=a.pool.split(",") if a.pool else None)
    print(f"GATE {verdict}: {a.cand} {wa}/{n} vs {a.inc} {wb}/{n} ({(wa - wb) / n:+.2%}) on seeds {a.seed}..{a.seed + n - 1}", flush=True)
    sys.exit(0 if verdict == "accept" else 1)
