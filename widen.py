"""Net2Net-style widening of a value net: every hidden layer grows to --hidden units, the new units' incoming weights
drawn small and their outgoing weights zero, so the widened net computes exactly the checkpoint's function and training
continues its lineage (the 2026-09-02 width test trained 512 from scratch and lost the lineage, AUDIT-killed-levers #7).
Usage: widen.py IN.pt OUT.pt --hidden 512"""
import argparse

import torch

from value_net import ValueNet


def widen(sd, hidden, seed=0):
    g = torch.Generator().manual_seed(seed)
    lin = sorted({k.rsplit(".", 1)[0] for k in sd if k.startswith("mlp.") and k.endswith(".weight")}, key=lambda k: int(k.split(".")[1]))
    out = dict(sd)
    for li, name in enumerate(lin):
        w, b = sd[name + ".weight"], sd[name + ".bias"]
        n_out = w.shape[0] if li == len(lin) - 1 else hidden
        n_in = w.shape[1] if li == 0 else hidden
        nw = torch.zeros(n_out, n_in)
        nw[: w.shape[0], : w.shape[1]] = w
        if li != len(lin) - 1:  # new units: small random incoming weights (their outgoing weights stay zero below)
            nw[w.shape[0]:, : w.shape[1]] = torch.randn(n_out - w.shape[0], w.shape[1], generator=g) * w.std()
        nb = torch.zeros(n_out)
        nb[: b.shape[0]] = b
        out[name + ".weight"], out[name + ".bias"] = nw, nb
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--hidden", type=int, default=512)
    a = ap.parse_args()
    sd = torch.load(a.src, map_location="cpu")
    wide = widen(sd, a.hidden)
    small = ValueNet(hidden=sd["mlp.0.weight"].shape[0]).eval()
    small.load_state_dict(sd)
    big = ValueNet(hidden=a.hidden).eval()
    big.load_state_dict(wide)
    x = torch.rand(256, sd["mask"].shape[0])
    with torch.no_grad():
        d = (small.heads(x) - big.heads(x)).abs().max().item()
    assert d < 1e-4, f"widened net differs by {d}"  # same function up to float summation order
    torch.save(wide, a.out)
    print(f"{a.src} ({sd['mlp.0.weight'].shape[0]}) -> {a.out} ({a.hidden}), max |diff| {d:.2e} on random inputs")
