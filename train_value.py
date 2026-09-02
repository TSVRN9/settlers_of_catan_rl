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
    """Returns X, y, game, aux (n, 5) = [vp0..vp3 / 10, turns_left / 100] and
    has_aux (n,) -- shards written before the auxiliary targets existed load
    with has_aux False and contribute only to the win-probability loss."""
    X, y, g, aux, has = [], [], [], [], []
    rc, ro = [], []
    sx, sv, sn = [], [], []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "shard_*.npz"))):
            z = np.load(path)
            n = len(z["y"])
            X.append(z["X"]); y.append(z["y"]); g.append(z["game"])
            if "rank_c" in z and len(z["rank_c"]):
                rc.append(z["rank_c"]); ro.append(z["rank_o"])
            if "sib_n" in z and len(z["sib_n"]):
                sx.append(z["sib_x"]); sv.append(z["sib_v"]); sn.append(z["sib_n"])
            if "vp" in z:
                aux.append(np.concatenate([z["vp"].astype(np.float32) / 10.0, z["turns_left"].astype(np.float32)[:, None] / 100.0], axis=1))
                has.append(np.ones(n, dtype=bool))
            else:
                aux.append(np.zeros((n, 5), dtype=np.float32)); has.append(np.zeros(n, dtype=bool))
    assert X, f"no shard_*.npz under {dirs}"
    pairs = (np.concatenate(rc), np.concatenate(ro)) if rc else (np.zeros((0, X[0].shape[1]), np.float16),) * 2
    sibs = (np.concatenate(sx), np.concatenate(sv), np.concatenate(sn)) if sx else (np.zeros((0, 1, X[0].shape[1]), np.float16), np.zeros((0, 1)), np.zeros(0, np.int8))
    return np.concatenate(X), np.concatenate(y), np.concatenate(g), np.concatenate(aux), np.concatenate(has), pairs, sibs


def sibling_loss(net, sx, sv):
    """All-pairs ordering within each sibling set: for children i, j of one
    decision with base_fn(p0) values v_i > v_j, the net's win logit must
    satisfy V_i > V_j. sx: (B, K, F); sv: (B, K) with NaN padding."""
    B, K, F = sx.shape
    out = net(sx.reshape(B * K, F))[:, 0].reshape(B, K)
    diff = out[:, :, None] - out[:, None, :]              # V_i - V_j
    target = sv[:, :, None] - sv[:, None, :]             # v_i - v_j (NaN where padded)
    valid = torch.isfinite(target) & (target != 0)
    sign = torch.sign(target)
    loss = -F_logsigmoid(sign * diff)
    return loss[valid].mean() if valid.any() else out.sum() * 0.0


F_logsigmoid = F.logsigmoid


def loss_fn(net, x, y, aux, has, aux_weight, win_weight=1.0):
    out = net.heads(x)
    loss = win_weight * F.binary_cross_entropy_with_logits(out[:, 0], y)
    if aux_weight and has.any():
        loss = loss + aux_weight * F.mse_loss(out[has, 1:], aux[has])
    return loss


def rank_loss(net, xc, xo):
    """Pairwise: the child AlphaBeta chose must score above the other child.
    -log sigmoid(V(chosen) - V(other)) on the win logits."""
    return -F.logsigmoid(net(xc)[:, 0] - net(xo)[:, 0]).mean()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--init", default=None, help="warm-start state_dict")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--hidden", type=int, default=256, help="MLP width; 256 is 3x cheaper per leaf than 512 at equal held-out loss (FINDINGS)")
    parser.add_argument("--batch-size", type=int, default=2048)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--win-weight", type=float, default=1.0, help="weight of the win-probability BCE loss (0 disables)")
    parser.add_argument("--aux-weight", type=float, default=1.0, help="weight of the final-VPs / turns-left auxiliary heads (0 disables)")
    parser.add_argument("--rank-weight", type=float, default=1.0, help="weight of the AlphaBeta chosen-vs-other pair loss (0 disables)")
    parser.add_argument("--sib-weight", type=float, default=1.0, help="weight of the base_fn sibling-ordering loss (0 disables)")
    parser.add_argument("--eval-every", type=int, default=90, help="optimizer steps between held-out checks (early stopping keeps the best)")
    parser.add_argument("--device", default="xpu" if torch.xpu.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    torch.manual_seed(args.seed)

    X, y, g, aux, has, (rank_c, rank_o), (sib_x, sib_v, sib_n) = load(args.data)
    games = np.unique(g)
    rng = np.random.default_rng(args.seed)
    held = set(rng.choice(games, size=max(1, len(games) // 10), replace=False).tolist())
    is_held = np.isin(g, list(held))
    print(f"{len(y)} samples from {len(games)} games, base rate {y.mean():.3f}, held-out {is_held.sum()} samples / {len(held)} games, aux targets on {has.mean():.0%}, {len(rank_c)} rank pairs, {len(sib_n)} sibling sets")

    dev = torch.device(args.device)
    Xd = torch.from_numpy(X).to(dev)  # float16 on device; cast per batch
    yd = torch.from_numpy(y.astype(np.float32)).to(dev)
    auxd = torch.from_numpy(aux).to(dev)
    hasd = torch.from_numpy(has).to(dev)
    # rank pairs: last 10% held out (they are not tied to game ids)
    n_rank = len(rank_c)
    n_rank_tr = int(n_rank * 0.9)
    rcd = torch.from_numpy(rank_c).to(dev)
    rod = torch.from_numpy(rank_o).to(dev)
    use_rank = args.rank_weight > 0 and n_rank_tr > 0
    n_sib = len(sib_n)
    n_sib_tr = int(n_sib * 0.9)
    sxd = torch.from_numpy(sib_x).to(dev)
    svd = torch.from_numpy(sib_v).to(dev)
    use_sib = args.sib_weight > 0 and n_sib_tr > 0
    tr_idx = torch.from_numpy(np.flatnonzero(~is_held)).to(dev)
    ho_idx = torch.from_numpy(np.flatnonzero(is_held)).to(dev)

    net = ValueNet(hidden=args.hidden).to(dev)
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location=dev))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=args.weight_decay, foreach=False)  # foreach=True kills the XPU, see CLAUDE.md

    def heldout():
        net.eval()
        with torch.no_grad():
            if n_rank > n_rank_tr:
                d = net(rcd[n_rank_tr:].float())[:, 0] - net(rod[n_rank_tr:].float())[:, 0]
                rank_acc = (d > 0).float().mean().item()
            else:
                rank_acc = float("nan")
            if n_sib > n_sib_tr:
                hx, hv = sxd[n_sib_tr:], svd[n_sib_tr:]
                B, K, Fd = hx.shape
                o = net(hx.reshape(B * K, Fd).float())[:, 0].reshape(B, K)
                o = torch.where(torch.isfinite(hv), o, torch.full_like(o, -1e9))
                top1 = (o.argmax(1) == torch.nan_to_num(hv, nan=-1e300).argmax(1)).float().mean().item()
            else:
                top1 = float("nan")
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
        return loss, buckets, rank_acc, top1

    # Early stopping on held-out: the net memorizes games within an epoch
    # (docs/FINDINGS.md, M4 iteration 0), so the best checkpoint is usually
    # a fraction of an epoch in. Keep the best state seen.
    n = len(tr_idx)
    best, best_state, best_buckets, step = float("inf"), None, [], 0
    best_ho, best_rank, best_step = float("nan"), float("nan"), 0

    best_top1 = float("nan")

    def consider():
        nonlocal best, best_state, best_buckets, best_ho, best_rank, best_step, best_top1
        ho_loss, buckets, rank_acc, top1 = heldout()
        score = ho_loss  # nan-safe: only subtract the terms that exist
        if rank_acc == rank_acc:
            score -= args.rank_weight * rank_acc
        if top1 == top1:
            score -= args.sib_weight * top1
        if score < best:
            best, best_buckets, best_ho, best_rank, best_top1 = score, buckets, ho_loss, rank_acc, top1
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
            best_step = step
        return ho_loss, buckets, rank_acc, top1
    for epoch in range(args.epochs):
        t0 = time.time()
        perm = tr_idx[torch.randperm(n, device=dev)]
        total = 0.0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            loss = loss_fn(net, Xd[idx].float(), yd[idx], auxd[idx], hasd[idx], args.aux_weight, args.win_weight)
            if use_rank:
                ridx = torch.randint(0, n_rank_tr, (min(args.batch_size, n_rank_tr),), device=dev)
                loss = loss + args.rank_weight * rank_loss(net, rcd[ridx].float(), rod[ridx].float())
            if use_sib:
                sidx = torch.randint(0, n_sib_tr, (min(args.batch_size // 4, n_sib_tr),), device=dev)
                loss = loss + args.sib_weight * sibling_loss(net, sxd[sidx].float(), svd[sidx])
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * len(idx)
            step += 1
            if step % args.eval_every == 0:
                consider()
        ho_loss, _, rank_acc, top1 = consider()
        print(f"epoch {epoch}: train={total / n:.4f} heldout={ho_loss:.4f} rank_acc={rank_acc:.3f} sib_top1={top1:.3f} | best@step{best_step}: heldout={best_ho:.4f} rank_acc={best_rank:.3f} sib_top1={best_top1:.3f} ({time.time() - t0:.0f}s)", flush=True)
    for b in best_buckets:
        print("  calib", b)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    torch.save(best_state, args.out)
    print(f"saved: {args.out} (best held-out {best_ho:.4f}, rank_acc {best_rank:.3f}, sib_top1 {best_top1:.3f} at step {best_step})")


if __name__ == "__main__":
    main()
