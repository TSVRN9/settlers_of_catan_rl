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

from value_net import N_FEATURES, ValueNet


def _shape(z, name):
    """Shape of an npz member from its .npy header, without loading the data."""
    if name not in z.files:
        return (0,)
    with z.zip.open(name + ".npy") as f:
        version = np.lib.format.read_magic(f)
        shape, _, _ = getattr(np.lib.format, f"read_array_header_{version[0]}_{version[1]}")(f)
    return shape


def _count(z, name):
    return _shape(z, name)[0]


def load(dirs, max_samples=None, max_pairs=None, max_sibs=None, seed=0, self_sibs=True, max_ts=None, ts_key="ts"):
    kx, kv = ts_key + "_x", ts_key + "_v"
    """Returns X, y, game, aux (n, 5) = [vp0..vp3 / 10, turns_left / 100] and
    has_aux (n,) -- shards written before the auxiliary targets existed load
    with has_aux False and contribute only to the win-probability loss.
    Budgets subsample *per shard* while loading, so peak RAM is bounded by
    the budgets rather than the corpus (4 iterations OOM-killed the box)."""
    rng = np.random.default_rng(seed)
    paths = [p for d in dirs for p in sorted(glob.glob(os.path.join(d, "shard_*.npz")))]
    zs = [np.load(p) for p in paths]
    ok = [_shape(z, "X")[1:] == (N_FEATURES,) for z in zs]
    for p, o in zip(paths, ok):
        if not o:
            print(f"skipping {p}: wrong feature width (encoder has {N_FEATURES})")
    zs = [z for z, o in zip(zs, ok) if o]
    tot_s = sum(_count(z, "y") for z in zs)
    tot_p = sum(_count(z, "rank_c") for z in zs)
    tot_b = sum(_count(z, "sib_n") for z in zs if "sib_isp0" in z)  # same condition as the load below
    tot_t = sum(_count(z, kv) for z in zs)
    ft = min(1.0, (max_ts or tot_t) / max(tot_t, 1))
    fs = min(1.0, (max_samples or tot_s) / max(tot_s, 1))
    fp = min(1.0, (max_pairs or tot_p) / max(tot_p, 1))
    fb = min(1.0, (max_sibs or tot_b) / max(tot_b, 1))

    def pick(n, frac):
        return np.sort(rng.choice(n, int(n * frac), replace=False)) if frac < 1.0 else slice(None)

    X, y, g, aux, has = [], [], [], [], []
    rc, ro = [], []
    sx, sv, sn, sp = [], [], [], []
    tx, tv, tn = [], [], []
    for z in zs:
        if True:
            yy = z["y"]
            k = pick(len(yy), fs)
            n = len(yy[k])
            X.append(z["X"][k]); y.append(yy[k]); g.append(z["game"][k])
            if "rank_c" in z and _count(z, "rank_c"):
                kp = pick(_count(z, "rank_c"), fp)
                rc.append(z["rank_c"][kp]); ro.append(z["rank_o"][kp])
            if "sib_isp0" in z and _count(z, "sib_n"):
                kb = pick(_count(z, "sib_n"), fb)
                v = z["sib_v"][kb]
                keep = slice(None) if self_sibs else ~((np.nanmax(v, 1) == 1.0) & (np.nanmin(v, 1) == 0.0))  # self-play sets are one-hot; base_fn values never are
                sx.append(z["sib_x"][kb][keep]); sv.append(v[keep]); sn.append(z["sib_n"][kb][keep]); sp.append(z["sib_isp0"][kb][keep])
            if kv in z and _count(z, kv):
                gk = kv[:-2] + "_n"  # children per decision, e.g. ro_n: subsample whole decisions so sibling pairs survive
                if gk in z:
                    gn = z[gk].astype(np.int64)
                    ends = np.cumsum(gn)
                    kg = np.flatnonzero(rng.random(len(gn)) < ft) if ft < 1.0 else np.arange(len(gn))
                    kt = np.concatenate([np.arange(e - n, e) for n, e in zip(gn[kg], ends[kg])]) if len(kg) else np.zeros(0, np.int64)
                    tn.append(gn[kg])
                else:
                    kt = pick(_count(z, kv), ft)
                tx.append(z[kx][kt]); tv.append(z[kv][kt].astype(np.float32))
                assert len(tx[-1]) == len(tv[-1])
            if "vp" in z:
                aux.append(np.concatenate([z["vp"][k].astype(np.float32) / 10.0, z["turns_left"][k].astype(np.float32)[:, None] / 100.0], axis=1))
                assert len(aux[-1]) == n  # v8 trained its aux heads on unsubsampled (misaligned) targets, docs/FINDINGS.md
                has.append(np.ones(n, dtype=bool))
            else:
                aux.append(np.zeros((n, 5), dtype=np.float32)); has.append(np.zeros(n, dtype=bool))
    assert X, f"no shard_*.npz under {dirs}"
    pairs = (np.concatenate(rc), np.concatenate(ro)) if rc else (np.zeros((0, X[0].shape[1]), np.float16),) * 2
    sibs = (np.concatenate(sx), np.concatenate(sv), np.concatenate(sn), np.concatenate(sp)) if sx else (np.zeros((0, 1, X[0].shape[1]), np.float16), np.zeros((0, 1)), np.zeros(0, np.int8), np.zeros(0, bool))
    trees = (np.concatenate(tx), np.concatenate(tv), np.concatenate(tn) if tn else None) if tx else (np.zeros((0, X[0].shape[1]), np.float16), np.zeros(0, np.float32), None)
    assert 0.0 <= trees[1].min(initial=0.0) and trees[1].max(initial=0.0) <= 1.0, "ts_v are win probabilities"
    return np.concatenate(X), np.concatenate(y), np.concatenate(g), np.concatenate(aux), np.concatenate(has), pairs, sibs, trees


def sibling_target(sv, isp0):
    """Index of the child a base_fn search would pick: argmax of base_fn(p0)
    when p0 decides, argmin (the opponent's worst-for-p0 reply) otherwise."""
    hi = torch.nan_to_num(sv, nan=-1e300).argmax(1)
    lo = torch.nan_to_num(sv, nan=1e300).argmin(1)
    return torch.where(isp0, hi, lo)


def sibling_loss(net, sx, sv, isp0):
    """Listwise top-1: softmax over the net's win logits of one decision's
    children must put base_fn's pick on top. Only the *choice* is asked for,
    not base_fn's million-to-one gaps between the others (docs/FINDINGS.md)."""
    B, K, Fd = sx.shape
    out = net(sx.reshape(B * K, Fd))[:, 0].reshape(B, K)
    out = torch.where(torch.isfinite(sv), out, torch.full_like(out, -1e9))
    return F.cross_entropy(out, sibling_target(sv, isp0))


def loss_fn(net, x, y, aux, has, aux_weight, win_weight=1.0):
    out = net.heads(x)
    loss = win_weight * F.binary_cross_entropy_with_logits(out[:, 0], y)
    if aux_weight and has.any():
        loss = loss + aux_weight * F.mse_loss(out[has, 1:], aux[has])
    return loss


def tree_loss(net, tx, tv):
    """Search-value distillation (TreeStrap-lite): the net's win logit on a
    searched root / child state must match that node's backed-up expectimax
    value -- a soft, chance-averaged target on states the trajectory never
    visits. Not v9's hard argmax labels (docs/FINDINGS.md)."""
    return F.binary_cross_entropy_with_logits(net(tx)[:, 0], tv)


def sibling_pairs(tn, tv):
    """(i, j) row pairs of one decision's rollout-labeled children with v[i] > v[j]: a measured
    ranking target for the choice the search makes among siblings (base_fn's version of this was
    what lifted v0 -> v5; this one owes nothing to AlphaBeta)."""
    pi, pj = [], []
    start = 0
    for n in tn:
        v = tv[start:start + n]
        for a in range(n):
            for b in range(n):
                if v[a] > v[b]:
                    pi.append(start + a); pj.append(start + b)
        start += n
    return np.asarray(pi, np.int64), np.asarray(pj, np.int64)


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
    parser.add_argument("--prior-scale", type=float, default=None, help="smooth-heuristic prior scale (ValueNet.PRIOR_SCALE default); 0.1 = one logit per VP")
    parser.add_argument("--max-samples", type=int, default=1_500_000, help="random subsample budgets (memory): outcome samples")
    parser.add_argument("--max-pairs", type=int, default=300_000, help="... chosen-vs-other pairs")
    parser.add_argument("--max-sibs", type=int, default=120_000, help="... sibling sets (each is K x F)")
    parser.add_argument("--max-ts", type=int, default=300_000, help="... search-value rows (ts_x / ts_v)")
    parser.add_argument("--hidden", type=int, default=256, help="MLP width; 256 is 3x cheaper per leaf than 512 at equal held-out loss (FINDINGS)")
    parser.add_argument("--batch-size", type=int, default=2048)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--win-weight", type=float, default=1.0, help="weight of the win-probability BCE loss (0 disables)")
    parser.add_argument("--aux-weight", type=float, default=1.0, help="weight of the final-VPs / turns-left auxiliary heads (0 disables)")
    parser.add_argument("--rank-weight", type=float, default=1.0, help="weight of the AlphaBeta chosen-vs-other pair loss (0 disables)")
    parser.add_argument("--sib-weight", type=float, default=1.0, help="weight of the base_fn sibling-ordering loss (0 disables)")
    parser.add_argument("--ts-weight", type=float, default=0.0, help="weight of the soft-value loss on <ts-key>_x / <ts-key>_v rows (0 disables)")
    parser.add_argument("--ts-key", default="ts", help="ts = search-value distillation rows, ro = rollout-labeled children")
    parser.add_argument("--ro-rank-weight", type=float, default=0.0, help="pairwise ranking loss between rollout-labeled siblings of one decision (needs ro_n in the shards; 0 disables)")
    parser.add_argument("--self-sibs", type=int, default=1, help="0 drops the sibling sets labeled by the value net's own search (gen_games self-play), keeping base_fn-labeled ones")
    parser.add_argument("--eval-every", type=int, default=90, help="optimizer steps between held-out checks (early stopping keeps the best)")
    parser.add_argument("--device", default="xpu" if torch.xpu.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    torch.manual_seed(args.seed)

    X, y, g, aux, has, (rank_c, rank_o), (sib_x, sib_v, sib_n, sib_isp0), (ts_x, ts_v, ts_n) = load(
        args.data, args.max_samples, args.max_pairs, args.max_sibs, args.seed, self_sibs=bool(args.self_sibs), max_ts=args.max_ts, ts_key=args.ts_key
    )
    rng = np.random.default_rng(args.seed)
    games = np.unique(g)
    held = set(rng.choice(games, size=max(1, len(games) // 10), replace=False).tolist())
    is_held = np.isin(g, list(held))
    print(f"{len(y)} samples from {len(games)} games, base rate {y.mean():.3f}, held-out {is_held.sum()} samples / {len(held)} games, aux targets on {has.mean():.0%}, {len(rank_c)} rank pairs, {len(sib_n)} sibling sets, {len(ts_v)} search-value rows")

    dev = torch.device(args.device)
    Xd = torch.from_numpy(X)  # float16, CPU-resident; batches are moved to the device
    yd = torch.from_numpy(y.astype(np.float32))
    auxd = torch.from_numpy(aux)
    hasd = torch.from_numpy(has)
    # rank pairs: last 10% held out (they are not tied to game ids)
    n_rank = len(rank_c)
    n_rank_tr = int(n_rank * 0.9)
    rcd = torch.from_numpy(rank_c)
    rod = torch.from_numpy(rank_o)
    use_rank = args.rank_weight > 0 and n_rank_tr > 0
    n_sib = len(sib_n)
    n_sib_tr = int(n_sib * 0.9)
    sxd = torch.from_numpy(sib_x)
    svd = torch.from_numpy(sib_v)
    spd = torch.from_numpy(sib_isp0)
    use_sib = args.sib_weight > 0 and n_sib_tr > 0
    n_ts = len(ts_v)
    n_ts_tr = int(n_ts * 0.9)
    txd = torch.from_numpy(ts_x)
    tvd = torch.from_numpy(ts_v)
    use_ts = args.ts_weight > 0 and n_ts_tr > 0
    # sibling pairs among rollout-labeled children; the last 10% of decisions are held out
    n_grp = len(ts_n) if ts_n is not None else 0
    n_grp_tr = int(n_grp * 0.9)
    if n_grp and args.ro_rank_weight > 0:
        cut = int(ts_n[:n_grp_tr].sum())
        pi_tr, pj_tr = sibling_pairs(ts_n[:n_grp_tr], ts_v)
        pi_ho, pj_ho = sibling_pairs(ts_n[n_grp_tr:], ts_v[cut:])
        pi_ho, pj_ho = pi_ho + cut, pj_ho + cut
        print(f"{len(pi_tr)} rollout sibling pairs (train), {len(pi_ho)} held out")
    else:
        pi_tr = pj_tr = pi_ho = pj_ho = np.zeros(0, np.int64)
    use_ro_rank = args.ro_rank_weight > 0 and len(pi_tr) > 0
    pi_trd, pj_trd = torch.from_numpy(pi_tr), torch.from_numpy(pj_tr)
    D = lambda t: t.to(dev, non_blocking=True)  # noqa: E731
    tr_idx = torch.from_numpy(np.flatnonzero(~is_held))
    ho_idx = torch.from_numpy(np.flatnonzero(is_held))

    net = ValueNet(hidden=args.hidden, prior_scale=args.prior_scale).to(dev)
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location=dev))
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=args.weight_decay, foreach=False)  # foreach=True kills the XPU, see CLAUDE.md

    def heldout():
        net.eval()
        with torch.no_grad():
            if n_rank > n_rank_tr:
                ds = []
                for i in range(n_rank_tr, n_rank, 8192):
                    ds.append(net(D(rcd[i:i + 8192]).float())[:, 0] - net(D(rod[i:i + 8192]).float())[:, 0])
                rank_acc = (torch.cat(ds) > 0).float().mean().item()
            else:
                rank_acc = float("nan")
            if n_sib > n_sib_tr:
                hits = []
                for i in range(n_sib_tr, n_sib, 2048):
                    hx, hv, hp = D(sxd[i:i + 2048]), D(svd[i:i + 2048]), D(spd[i:i + 2048])
                    B, K, Fd = hx.shape
                    o = net(hx.reshape(B * K, Fd).float())[:, 0].reshape(B, K)
                    o = torch.where(torch.isfinite(hv), o, torch.full_like(o, -1e9))
                    hits.append((o.argmax(1) == sibling_target(hv, hp)).float())
                top1 = torch.cat(hits).mean().item()
            else:
                top1 = float("nan")
            if n_ts > n_ts_tr:
                ts_bce = np.mean([tree_loss(net, D(txd[i:i + 8192]).float(), D(tvd[i:i + 8192])).item() for i in range(n_ts_tr, n_ts, 8192)])
            else:
                ts_bce = float("nan")
            if len(pi_ho):
                hits = []
                for i in range(0, len(pi_ho), 8192):
                    a, b = pi_ho[i:i + 8192], pj_ho[i:i + 8192]
                    hits.append((net(D(txd[a]).float())[:, 0] > net(D(txd[b]).float())[:, 0]).float())
                ro_rank_acc = torch.cat(hits).mean().item()
            else:
                ro_rank_acc = float("nan")
            logits = torch.cat([net(D(Xd[ho_idx[i:i + 8192]]).float()).squeeze(1) for i in range(0, len(ho_idx), 8192)])
            yy = D(yd[ho_idx])
            loss = F.binary_cross_entropy_with_logits(logits, yy).item()
            p = torch.sigmoid(logits)
            buckets = []
            for lo in (0.0, 0.2, 0.4, 0.6, 0.8):
                m = (p >= lo) & (p < lo + 0.2 + (lo == 0.8))
                if m.any():
                    buckets.append(f"[{lo:.1f},{lo + 0.2:.1f}) n={int(m.sum())} pred={p[m].mean():.3f} actual={yy[m].mean():.3f}")
        net.train()
        return loss, buckets, rank_acc, top1, ts_bce, ro_rank_acc

    # Early stopping on held-out: the net memorizes games within an epoch
    # (docs/FINDINGS.md, M4 iteration 0), so the best checkpoint is usually
    # a fraction of an epoch in. Keep the best state seen.
    n = len(tr_idx)
    best, best_state, best_buckets, step = float("inf"), None, [], 0
    best_ho, best_rank, best_step = float("nan"), float("nan"), 0

    best_top1, best_ts = float("nan"), float("nan")

    def consider():
        nonlocal best, best_state, best_buckets, best_ho, best_rank, best_step, best_top1, best_ts
        ho_loss, buckets, rank_acc, top1, ts_bce, ro_rank_acc = heldout()
        score = ho_loss  # nan-safe: only add the terms that exist
        if ro_rank_acc == ro_rank_acc:
            score -= args.ro_rank_weight * ro_rank_acc
        if rank_acc == rank_acc:
            score -= args.rank_weight * rank_acc
        if top1 == top1:
            score -= args.sib_weight * top1
        if ts_bce == ts_bce:
            score += args.ts_weight * ts_bce
        if score < best:
            best, best_buckets, best_ho, best_rank, best_top1, best_ts = score, buckets, ho_loss, rank_acc, top1, ts_bce
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
            best_step = step
        return ho_loss, buckets, rank_acc, top1, ts_bce, ro_rank_acc
    for epoch in range(args.epochs):
        t0 = time.time()
        perm = tr_idx[torch.randperm(n)]
        total = 0.0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            loss = loss_fn(net, D(Xd[idx]).float(), D(yd[idx]), D(auxd[idx]), D(hasd[idx]), args.aux_weight, args.win_weight)
            if use_rank:
                ridx = torch.randint(0, n_rank_tr, (min(args.batch_size, n_rank_tr),))
                loss = loss + args.rank_weight * rank_loss(net, D(rcd[ridx]).float(), D(rod[ridx]).float())
            if use_sib:
                sidx = torch.randint(0, n_sib_tr, (min(args.batch_size // 4, n_sib_tr),))
                loss = loss + args.sib_weight * sibling_loss(net, D(sxd[sidx]).float(), D(svd[sidx]), D(spd[sidx]))
            if use_ts:
                tidx = torch.randint(0, n_ts_tr, (min(args.batch_size, n_ts_tr),))
                loss = loss + args.ts_weight * tree_loss(net, D(txd[tidx]).float(), D(tvd[tidx]))
            if use_ro_rank:
                k = torch.randint(0, len(pi_trd), (min(args.batch_size, len(pi_trd)),))
                loss = loss + args.ro_rank_weight * rank_loss(net, D(txd[pi_trd[k]]).float(), D(txd[pj_trd[k]]).float())
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * len(idx)
            step += 1
            if step % args.eval_every == 0:
                consider()
        ho_loss, _, rank_acc, top1, ts_bce, ro_rank_acc = consider()
        print(f"epoch {epoch}: train={total / n:.4f} heldout={ho_loss:.4f} rank_acc={rank_acc:.3f} sib_top1={top1:.3f} ts_bce={ts_bce:.4f} ro_rank={ro_rank_acc:.3f} | best@step{best_step}: heldout={best_ho:.4f} rank_acc={best_rank:.3f} sib_top1={best_top1:.3f} ts_bce={best_ts:.4f} ({time.time() - t0:.0f}s)", flush=True)
    for b in best_buckets:
        print("  calib", b)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    torch.save(best_state, args.out)
    print(f"saved: {args.out} (best held-out {best_ho:.4f}, rank_acc {best_rank:.3f}, sib_top1 {best_top1:.3f} at step {best_step})")


if __name__ == "__main__":
    main()
