"""Average the weights of value-net checkpoints that share a warm start and training data (a model soup).

    uv run python soup.py --out checkpoints_value/v28.pt checkpoints_value/v28_s0.pt checkpoints_value/v28_s1.pt ...
    uv run python soup.py --greedy --games 1000 --seed 5 --out ... <paths>   # greedy soup, selected by play

Measured (docs/FINDINGS.md 2026-09-02 evening): three seeds of one configuration scored 38.2 / 32.6 / 32.9% vs 3x rab;
their plain average scored 42.9% on the same seeds -- and the average of five scored 38.6% where the three scored
43.7%. Draws can land in different basins, so `--greedy` (Wortsman et al.'s greedy soup) ranks the checkpoints by
a short arena proxy vs 3x rab and keeps a checkpoint only if adding it does not lower the soup's proxy score.
"""
import argparse
import os
import sys

os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")
if os.environ.get("PYTHONHASHSEED") != "0":  # arena games must be reproducible across processes (evaluate.py)
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import torch


def mean(sds):
    return {k: (sum(sd[k].float() for sd in sds) / len(sds)).to(sds[0][k].dtype) for k in sds[0]}


def greedy(paths, games, seed, out, base=None):
    from catanatron import Color

    import arena

    tmp = out + ".trial.pt"

    def score(sd):
        torch.save(sd, tmp)
        arena.load_value_net.__globals__["_NET_CACHE"].pop(tmp, None)  # value_net caches by path; the file changed
        return sum(w == Color.BLUE for _, w, _, _ in arena.play([f"vnet:{tmp}", "rab", "rab", "rab"], range(seed, seed + games), batch=128))

    sds = {p: torch.load(p, map_location="cpu") for p in paths}
    single = {p: score(sds[p]) for p in paths}
    order = sorted(paths, key=lambda p: -single[p])
    for p in order:
        print(f"  {p}: {single[p]}/{games}")
    if base:  # the incumbent seeds the soup: draws are added only if they improve on it (monotone on these seeds)
        sds[base] = torch.load(base, map_location="cpu")
        single[base] = score(sds[base])
        print(f"  base {base}: {single[base]}/{games}")
        order = [base] + order
    kept = [order[0]]
    best = single[order[0]]
    for p in order[1:]:
        s = score(mean([sds[q] for q in kept + [p]]))
        print(f"  + {os.path.basename(p)} -> {s}/{games} ({'kept' if s >= best else 'dropped'})")
        if s >= best:
            kept.append(p)
            best = s
    os.remove(tmp)
    print(f"  greedy soup of {len(kept)}/{len(paths)}: {best}/{games} on seeds {seed}..{seed + games - 1}")
    return mean([sds[q] for q in kept])


def step(paths, games, seed, out, base, alphas):
    """base + alpha * (mean(draws) - base), the best alpha by the same proxy (2026-09-22, docs/FINDINGS.md): a full
    training pass lands 5-20 points below its warm start whatever the labels, but a step of 0.15-0.3 toward the
    mean draw scores at or above it on three rounds' draws where the greedy soup -- whose smallest step is 0.5 --
    kept nothing. Candidates are base and each alpha, so the selection is over len(alphas) + 1 nets."""
    from catanatron import Color
    import arena

    tmp = out + ".trial.pt"

    def score(sd):
        torch.save(sd, tmp)
        arena.load_value_net.__globals__["_NET_CACHE"].pop(tmp, None)
        return sum(w == Color.BLUE for _, w, _, _ in arena.play([f"vnet:{tmp}", "rab", "rab", "rab"], range(seed, seed + games), batch=128))

    b = torch.load(base, map_location="cpu")
    d = mean([torch.load(p, map_location="cpu") for p in paths])
    best, best_sd = score(b), b
    print(f"  base {base}: {best}/{games}")
    for alpha in alphas:
        sd = {k: (b[k].float() + alpha * (d[k].float() - b[k].float())).to(b[k].dtype) for k in b}
        s = score(sd)
        print(f"  alpha {alpha:.2f} -> {s}/{games} ({'best' if s > best else 'no'})")
        if s > best:
            best, best_sd = s, sd
    os.remove(tmp)
    print(f"  step soup: {best}/{games} on seeds {seed}..{seed + games - 1}")
    return best_sd


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--greedy", action="store_true")
    ap.add_argument("--games", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--base", default=None, help="greedy: start the soup from this checkpoint (the incumbent) instead of the best single draw")
    ap.add_argument("--alphas", default=None, help="step soup (needs --base): comma-separated steps from base toward the mean draw, e.g. 0.15,0.3")
    ap.add_argument("paths", nargs="+")
    a = ap.parse_args()
    if a.alphas:
        sd = step(a.paths, a.games, a.seed, a.out, a.base, [float(x) for x in a.alphas.split(",")])
    else:
        sd = greedy(a.paths, a.games, a.seed, a.out, a.base) if a.greedy else mean([torch.load(p, map_location="cpu") for p in a.paths])
    torch.save(sd, a.out)
    print(f"soup of {len(a.paths)} -> {a.out}")
