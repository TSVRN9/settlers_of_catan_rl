"""M4: Rust-driven game loop with cross-game batched value-net inference.

`catan_engine.Arena` advances many games in lockstep; every value-net decision
parks its depth-d leaves, all parked leaves are scored in ONE forward on the
XPU, and the games resume. Replaces the 7-process Python loop for lineups made
of `vnet:<path>` / `rab` seats (docs/FINDINGS.md: the forward pass was 68% of
generation, and per-decision CPU forwards ran 6-50 ms depending on which core
the worker landed on). Map generation, deck shuffle and seating stay in
Python: a fresh catanatron Game is built per seed and handed over once.
"""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from catanatron import Color, Game, RandomPlayer

import catan_engine
import rust_bridge as rb
from value_net import load_value_net

COLORS = (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)
DEVICE = os.environ.get("VNET_DEVICE", "xpu" if torch.xpu.is_available() else "cpu")
ROW_BUCKET = 16384  # forwards are padded to a multiple of this many rows so the allocator sees a handful of sizes
MAX_LEAVES = int(os.environ.get("VNET_MAX_LEAVES", 20000))  # depth>2 decisions over this many leaves fall back one ply (search.rs); depth 2 is never capped


VNET = re.compile(r"^vnet(\d?):(.+)$")  # vnet:<path> (depth 2) or vnet3:<path> (depth 3)


def supports(lineup):
    nets = {t for t in lineup if VNET.match(t)}
    return all(VNET.match(t) or t == "rab" for t in lineup) and len(nets) <= 1


def targets(colors, turns, winner_seat, vps, num_turns):
    """gen_games.StateSampler.targets on the arena's seat-indexed records."""
    colors = np.frombuffer(colors, dtype=np.uint8).astype(np.int64)  # Vec<u8> crosses PyO3 as bytes
    n = len(vps)
    y = (colors == winner_seat).astype(np.uint8)
    vp = np.asarray(vps, dtype=np.float16)[(colors[:, None] + np.arange(n)[None, :]) % n]
    turns_left = (num_turns - np.asarray(turns)).astype(np.float16)
    return y, vp, turns_left


def play(lineup, seeds, *, sample_p=0.0, rank_p=0.0, sib_p=0.0, batch=64, depth=2, keep_log=False):
    """Yields (seed, winner_color or None, part, extra) per game as they finish.
    `part` is the gen_games shard dict (float16) or None for a game without a
    winner; `extra` is (game, log, snapshot) when keep_log, else None.

    Two arenas ping-pong: while one's leaves are scored on the XPU, the other's
    games advance in Rust. The forward (and its wait) runs in a helper thread:
    torch releases the GIL inside ops and the Rust step releases it in
    allow_threads, so the two overlap on the host. Device-side overlap via
    streams/events does not work here -- measured: waiting on an event recorded
    after forward A blocks until a later-queued oneDNN matmul B also finishes."""
    assert supports(lineup), lineup
    nets = [VNET.match(t) for t in lineup if VNET.match(t)]
    net = load_value_net(nets[0].group(2)).to(DEVICE) if nets else None
    if nets and nets[0].group(1):
        depth = int(nets[0].group(1))
    layout = rb.layout(rb.ctx_for(Game([RandomPlayer(c) for c in COLORS], seed=0)))
    n_arenas = 2 if net is not None else 1
    arenas = [catan_engine.Arena(layout, depth, sample_p, rank_p, sib_p, keep_log, rab_depth=2, max_leaves=MAX_LEAVES) for _ in range(n_arenas)]  # vnetN: deepens the net only
    pool = ThreadPoolExecutor(max_workers=1)
    seeds = iter(seeds)
    games = [{} for _ in arenas]  # per arena: seed -> (game, colors) while in flight
    nf = rb.N_FEATURES
    # Persistent leaf buffers, filled by Rust in parallel. Pinned: a pageable
    # host->device copy of 32k rows blocks the host for 8 ms, a pinned
    # non_blocking one for 0 ms (2.5 ms on the device, overlapped).
    new_buf = lambda rows: torch.empty((rows, nf), dtype=torch.float32, pin_memory=DEVICE == "xpu")  # noqa: E731
    bufs = [new_buf(0) for _ in arenas]
    prof = {"step": 0.0, "fwd": 0.0, "drain": 0.0, "rows": 0, "steps": 0, "par": 0.0, "fill": 0.0, "t0": time.perf_counter()}  # ARENA_PROF=1

    def add(i):
        seed = next(seeds, None)
        if seed is None:
            return False
        game = Game([RandomPlayer(c) for c in COLORS], seed=seed)
        rs, _ = rb.rust_state(game)
        colors = list(game.state.colors)
        seats = [0 if VNET.match(lineup[COLORS.index(c)]) else 1 for c in colors]
        arenas[i].add(rs, seats, seed, seed)
        games[i][seed] = (game, colors)
        return True

    def run(i, vals):
        """Advance arena i from its scored leaves, drain finished games, queue the next forward."""
        arena = arenas[i]
        t = time.perf_counter()
        n_rows, n_pending = arena.step(vals)
        rows = -(-max(n_rows, 1) // ROW_BUCKET) * ROW_BUCKET
        if rows > len(bufs[i]):
            bufs[i] = new_buf(rows)
        arena.fill(bufs[i].numpy())
        prof["step"] += time.perf_counter() - t; prof["rows"] += n_rows; prof["steps"] += 1
        prof["par"] += arena.last_ms()[0]; prof["fill"] += arena.last_ms()[1]
        t = time.perf_counter()
        finished = []
        for seed, w, num_turns, vps, d, log, snap in arena.finished():
            game, colors = games[i].pop(seed)
            part = None
            if w >= 0:
                y, vp, turns_left = targets(d["color"], d["turn"], w, vps, num_turns)
                part = dict(
                    X=d["X"].astype(np.float16), y=y, vp=vp, turns_left=turns_left,
                    rank_c=d["rank_c"].astype(np.float16), rank_o=d["rank_o"].astype(np.float16),
                    sib_x=d["sib_x"].astype(np.float16), sib_v=d["sib_v"], sib_n=np.asarray(d["sib_n"], dtype=np.int8), sib_isp0=np.asarray(d["sib_isp0"], dtype=bool),
                )
            finished.append((seed, (None if w < 0 else colors[w]), part, ((game, log, snap) if keep_log else None)))
            add(i)
        prof["drain"] += time.perf_counter() - t
        return (pool.submit(forward, bufs[i][:rows], n_rows) if n_pending else None), finished

    def forward(x, n):  # helper thread; rows beyond n are padding (stale data), dropped
        with torch.no_grad():
            return torch.sigmoid(net(x.to(DEVICE, non_blocking=True))).squeeze(1).double()[:n].cpu().numpy()

    def sync(fut):
        if fut is None:
            return None
        t = time.perf_counter()
        v = fut.result()
        prof["fwd"] += time.perf_counter() - t  # time the main thread actually waited
        return v

    per = -(-batch // n_arenas)
    for i in range(n_arenas):
        while len(games[i]) < per and add(i):
            pass
    outs = [None] * n_arenas
    for i in range(n_arenas):
        outs[i], finished = run(i, None)
        yield from finished
    while any(games):
        for i in range(n_arenas):
            if not games[i]:
                continue
            outs[i], finished = run(i, sync(outs[i]))
            yield from finished
    pool.shutdown()
    if DEVICE == "xpu":
        torch.xpu.empty_cache()
    if os.environ.get("ARENA_PROF"):
        el = time.perf_counter() - prof["t0"]
        n = max(prof["steps"], 1)
        print(f"  arena: {prof['steps']} steps, {prof['rows'] / n:.0f} rows/step; rust step {prof['step'] / el:.0%} waiting on forward {prof['fwd'] / el:.0%} "
              f"drain+new games {prof['drain'] / el:.0%}; per step: rust {prof['step'] / n * 1e3:.0f} ms (parallel {prof['par'] / n:.0f}, fill {prof['fill'] / n:.1f}) "
              f"forward wait {prof['fwd'] / n * 1e3:.1f} ms; wall/step {el / n * 1e3:.0f} ms", flush=True)
