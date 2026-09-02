"""Average the weights of value-net checkpoints that share a warm start and training data (a model soup).

    uv run python soup.py --out checkpoints_value/v28.pt checkpoints_value/v28_s0.pt checkpoints_value/v28_s1.pt ...

Measured (docs/FINDINGS.md 2026-09-02 evening): three seeds of one configuration scored 38.2 / 32.6 / 32.9% vs 3x rab;
their average scored 42.9% on the same seeds. Training-draw noise was the dominant error of a single net.
"""
import argparse

import torch


def soup(paths):
    sds = [torch.load(p, map_location="cpu") for p in paths]
    return {k: (sum(sd[k].float() for sd in sds) / len(sds)).to(sds[0][k].dtype) for k in sds[0]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("paths", nargs="+")
    a = ap.parse_args()
    torch.save(soup(a.paths), a.out)
    print(f"soup of {len(a.paths)} -> {a.out}")
