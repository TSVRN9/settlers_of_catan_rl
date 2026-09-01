"""M4: supervised win-probability regression on gen_games.py samples.

    uv run python train_value.py --data data/it0 --out checkpoints_value/v0.pt
    uv run python train_value.py --data data/it0 data/it1 --init checkpoints_value/v0.pt --out checkpoints_value/v1.pt

Held-out split is by game (10%), not by sample -- consecutive ticks of one
game are near-duplicates. Reports held-out log-loss and a 5-bucket
calibration table (base rate is ~25%, so accuracy at 0.5 means nothing).
"""

import argparse
import glob
import os
import time

import numpy as np
import torch
import torch.nn.functional as F

from value_net import ValueNet


def load(dirs):
    X, y, g = [], [], []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "shard_*.npz"))):
            z = np.load(path)
            X.append(z["X"]); y.append(z["y"]); g.append(z["game"])
    assert X, f"no shard_*.npz under {dirs}"
    return np.concatenate(X), np.concatenate(y), np.concatenate(g)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--init", default=None, help="warm-start state_dict")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=2048)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--device", default="xpu" if torch.xpu.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    torch.manual_seed(args.seed)

    X, y, g = load(args.data)
    games = np.unique(g)
    rng = np.random.default_rng(args.seed)
    held = set(rng.choice(games, size=max(1, len(games) // 10), replace=False).tolist())
    is_held = np.isin(g, list(held))
    print(f"{len(y)} samples from {len(games)} games, base rate {y.mean():.3f}, held-out {is_held.sum()} samples / {len(held)} games")

    dev = torch.device(args.device)
    Xd = torch.from_numpy(X).to(dev)  # float16 on device; cast per batch
    yd = torch.from_numpy(y.astype(np.float32)).to(dev)
    tr_idx = torch.from_numpy(np.flatnonzero(~is_held)).to(dev)
    ho_idx = torch.from_numpy(np.flatnonzero(is_held)).to(dev)

    net = ValueNet().to(dev)
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location=dev))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, foreach=False)  # foreach=True kills the XPU, see CLAUDE.md

    def heldout():
        net.eval()
        with torch.no_grad():
            logits = torch.cat([net(Xd[ho_idx[i:i + 8192]].float()).squeeze(1) for i in range(0, len(ho_idx), 8192)])
            yy = yd[ho_idx]
            loss = F.binary_cross_entropy_with_logits(logits, yy).item()
            p = torch.sigmoid(logits)
            buckets = []
            for lo in (0.0, 0.2, 0.4, 0.6, 0.8):
                m = (p >= lo) & (p < lo + 0.2 + (lo == 0.8))
                if m.any():
                    buckets.append(f"[{lo:.1f},{lo + 0.2:.1f}) n={int(m.sum())} pred={p[m].mean():.3f} actual={yy[m].mean():.3f}")
        net.train()
        return loss, buckets

    n = len(tr_idx)
    for epoch in range(args.epochs):
        t0 = time.time()
        perm = tr_idx[torch.randperm(n, device=dev)]
        total = 0.0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            loss = F.binary_cross_entropy_with_logits(net(Xd[idx].float()).squeeze(1), yd[idx])
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * len(idx)
        ho_loss, buckets = heldout()
        print(f"epoch {epoch}: train={total / n:.4f} heldout={ho_loss:.4f} ({time.time() - t0:.0f}s)", flush=True)
    for b in buckets:
        print("  calib", b)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    torch.save({k: v.cpu() for k, v in net.state_dict().items()}, args.out)
    print(f"saved: {args.out}")


if __name__ == "__main__":
    main()
