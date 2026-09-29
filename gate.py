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


def _hidden(token):
    """Hidden width of a player token's net (None for non-net tokens)."""
    m = arena.VNET.match(token)
    if not m:
        return None
    import torch

    return torch.load(m.group("path").split("+")[-1], map_location="cpu")["mlp.0.weight"].shape[0]


def wins_isolated(player, seeds, pool=None):
    """wins_by_seed in a fresh process: the NPU plugin fails (L0 "driver is not initialized") once models of two hidden
    widths have run in one process (docs/FINDINGS.md 2026-09-25), so a cross-width gate plays each side alone."""
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor

    with ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn")) as ex:
        return ex.submit(wins_by_seed, player, list(seeds), pool).result()


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


def _cache_file(player, pool):
    """$GATE_CACHE/<hash>.json for this player on this pool: every file a token names is keyed by its contents, so a
    checkpoint rewritten under the same name misses. The engine build is not in the key (speed-only builds keep play
    identical, docs/PLAN-gen-speed.md): point GATE_CACHE at a fresh directory after an engine change that alters play."""
    import hashlib

    h = hashlib.sha1()
    for t in [player] + (pool or []):
        for part in t.replace(":", "+").split("+"):
            h.update(hashlib.sha1(open(part, "rb").read()).digest() if os.path.isfile(part) else part.encode())
    return os.path.join(os.environ["GATE_CACHE"], h.hexdigest()[:16] + ".json")


def cached(play):
    """`play` that reuses per-seed results from $GATE_CACHE (unset: off). With a fixed --seed across rounds the
    incumbent, unchanged since it was last gated, costs nothing: about half of every gate (2026-09-27)."""
    if not os.environ.get("GATE_CACHE"):
        return play

    def run(player, seeds, pool=None):
        import json

        f = _cache_file(player, pool)
        have = {int(k): v for k, v in json.load(open(f)).items()} if os.path.exists(f) else {}
        todo = [s for s in seeds if s not in have]
        if todo:
            have.update(play(player, todo, pool))
            os.makedirs(os.path.dirname(f), exist_ok=True)
            json.dump(have, open(f + ".tmp", "w"))
            os.replace(f + ".tmp", f)
        print(f"    {player.split('/')[-1]}: {len(seeds) - len(todo)}/{len(seeds)} seeds cached", flush=True)
        return {s: have[s] for s in seeds}

    return run


def gate(cand, inc, seed, block, max_games, h0, h1, alpha=0.05, pool=None):
    bound = math.log((1 - alpha) / alpha)
    d, wa, wb, n = [], 0, 0, 0
    play = cached(wins_isolated if _hidden(cand) != _hidden(inc) else wins_by_seed)
    while n < max_games:
        seeds = range(seed + n, seed + n + block)
        a, b = play(cand, seeds, pool), play(inc, seeds, pool)
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
