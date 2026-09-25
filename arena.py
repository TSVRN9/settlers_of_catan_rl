"""M4: Rust-driven game loop with cross-game batched value-net inference.

`catan_engine.Arena` advances many games in lockstep; every value-net decision
parks its depth-d leaves, all parked leaves are scored in ONE forward on the
XPU, and the games resume. Replaces the 7-process Python loop for lineups made
of `vnet:<path>` / `rab` seats (docs/FINDINGS.md: the forward pass was 68% of
generation, and per-decision CPU forwards ran 6-50 ms depending on which core
the worker landed on). Map generation, deck shuffle and seating stay in
Python: a fresh catanatron Game is built per seed and handed over once.
"""

import importlib.util
import os
import queue
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from catanatron import Color, Game, RandomPlayer

import catan_engine
import rust_bridge as rb
from value_net import load_value_net, rust_value_net

COLORS = (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)
# The leaf forward runs on the NPU when there is one (2026-09-24: gate mix -8% wall, generation -2.7%, 0.08% of v-net
# decisions flip vs the XPU's fp32, deterministic; docs/RESEARCH-HARDWARE.md). `uv sync --extra npu` installs OpenVINO.
_NPU_OK = os.path.exists("/dev/accel/accel0") and importlib.util.find_spec("openvino") is not None
DEVICE = os.environ.get("VNET_DEVICE") or ("npu" if _NPU_OK else "xpu" if torch.xpu.is_available() else "cpu")
ROW_BUCKET = int(os.environ.get("ROW_BUCKET", 4096))  # forwards are padded to a multiple of this many rows so the allocator sees a handful of sizes (16384 until 2026-09-23: 64% of the rows the iGPU computed were padding; 4096 is bitwise the same, ~7 shapes, docs/RESEARCH-HARDWARE.md)
MAX_LEAVES = int(os.environ.get("VNET_MAX_LEAVES", 20000))  # depth>2 decisions over this many leaves fall back one ply (search.rs); depth 2 is never capped


VNET = re.compile(r"^vnet(?P<depth>\d?)(?P<own>o?)(?:t(?P<tau>[0-9.]+))?(?:k(?P<k>\d+))?(?:m(?P<sims>\d+)(?:c(?P<c>[0-9.]+))?(?P<mb>b?)(?:r(?P<rr>\d+)(?P<rd1>h?)(?:l(?P<lam>[0-9.]+))?)?)?(?P<x>x{0,2}):(?P<path>.+)$")
# vnet:<path> depth 2; vnet3: depth 3; vnet3o: 3 own actions, opponents never min'ed (search.rs own_turn); t0.1: soft-min
# temperature at opponent nodes (search.rs backup); k3: 3 replies per opponent node, ordered on the CPU by $PRUNE_NET,
# default the spec's last member (search.rs expand_into); m500c0.1: the post-roll main phase by net-valued UCT, 500
# simulations, exploration 0.1, net = the spec's last member (mcts.rs search_net), m500b: max backup, m500r1l0.5: leaves mix 0.5 net + 0.5 a 1-round rollout-policy playout scored by the net, m500r1hl0.5: playouts by the depth-1 heuristic; x: the seat trades with the spec's
# last member, partners predicted with base_fn; xx: partners by the net too (trade.rs). Paths: a.pt or a.pt+b.pt.


POOL = re.compile(r"^(?:jsrobot|jsdroid|rab(\d)|uct(\d*)(?:c([0-9.]+))?(r?)|cvnet:(.+))$")  # arena pool seats (arena.rs Seat): the jSettler port (SMART / FAST), AlphaBeta at depth d, thesis UCT at N playouts (default 5000, the thesis') with exploration c (default 2.0) and r = dev-card buys re-drawn per visit, a CPU depth-2 net


def ov_model(net, rows, hidden=False, f16_in=None):
    """The value net as an OpenVINO graph for `rows` x features f32 (mask folded into W0, head row 0 only: win logits;
    an Ensemble averages its members' logits). hidden=True: only the layers after the first, on 256-wide rows. f16_in
    (default: hidden): the input is fp16, as the engine sends it (npu.rs), the precision the NPU computes in."""
    import openvino as ov
    from openvino import opset13 as op

    nets = net.nets if hasattr(net, "nets") else [net]
    lin = [[m for m in n.mlp if isinstance(m, torch.nn.Linear)] for n in nets]
    f16_in = hidden if f16_in is None else f16_in
    x = op.parameter([rows, lin[0][0].out_features if hidden else rb.N_FEATURES], np.float16 if f16_in else np.float32, name="x")
    x0 = op.convert(x, np.float32) if f16_in else x
    outs = []
    for n, ls in zip(nets, lin):
        h = x0
        for i, l in enumerate(ls):
            if hidden and i == 0:
                continue
            w, b = l.weight.detach().cpu().numpy(), l.bias.detach().cpu().numpy()  # the cached module may sit on the XPU
            if i == 0:
                w = w * n.mask.cpu().numpy()[None, :]
            if i == len(ls) - 1:
                w, b = w[:1], b[:1]
            h = op.add(op.matmul(h, op.constant(w), False, True), op.constant(b[None, :]))
            if i < len(ls) - 1:
                h = op.relu(h)
        outs.append(h)
    y = outs[0]
    for h in outs[1:]:  # Ensemble: mean of the members' logits
        y = op.add(y, h)
    return ov.Model([op.divide(y, op.constant(np.float32(len(outs))))], [x])


def ov_ir(path, hidden):
    """(libopenvino_c, IR .xml, rows, width) for the engine's own NPU calls (npu.rs), fp16 input, saved once per
    checkpoint under OV_CACHE_DIR: hidden=True the rollout net's layers after the first (ROLL_PARK=rust), False the
    whole net (pool seats' searches, PyArena pool_npu)."""
    import glob
    import hashlib
    import openvino as ov

    net = load_value_net(path)
    d = os.environ.get("OV_CACHE_DIR", "/tmp/ovcache")
    os.makedirs(d, exist_ok=True)
    kind = "roll" if hidden else "full"
    xml = os.path.join(d, f"{kind}_{hashlib.sha1(open(path, 'rb').read()).hexdigest()[:16]}_{ROW_BUCKET}_f16.xml")
    if not os.path.exists(xml):
        ov.save_model(ov_model(net, ROW_BUCKET, hidden=hidden, f16_in=True), xml, compress_to_fp16=False)
    lib = sorted(glob.glob(os.path.join(os.path.dirname(ov.__file__), "libs", "libopenvino_c.so*")))[0]
    return lib, xml, ROW_BUCKET, net.mlp[0].out_features if hidden else rb.N_FEATURES


_NPU = {}
NPU_PROF = [[0, 0, 0, 0.0]]  # leaf forwards: calls, rows, padded rows, seconds (ARENA_PROF prints them)


def npu_forward(net):
    """The leaf forward on the Lunar Lake NPU via OpenVINO (fp16 on the device, logits to the host). One static shape
    per ROW_BUCKET multiple, compiled on first use and kept per process (OV_CACHE_DIR caches the blobs). Returns
    f(x, n) -> P(win) (float64) of the first n rows. Not bitwise the CPU/XPU."""
    if id(net) in _NPU:
        return _NPU[id(net)]
    import openvino as ov

    core = ov.Core()
    core.set_property({"CACHE_DIR": os.environ.get("OV_CACHE_DIR", "/tmp/ovcache")})
    model = lambda rows: ov_model(net, rows)  # noqa: E731
    compiled, reqs, lock = {}, {}, threading.Lock()

    def infer(x):  # any thread: one infer request per (thread, shape), the compiled model shared
        key = (threading.get_ident(), len(x))
        if key not in reqs:
            with lock:
                if len(x) not in compiled:
                    compiled[len(x)] = core.compile_model(model(len(x)), "NPU")
                reqs[key] = compiled[len(x)].create_infer_request()
        return reqs[key].infer({0: x})[0][:, 0]

    def f(x, n):
        t = time.perf_counter()
        z = infer(x)[:n]
        NPU_PROF[0] = [a + b for a, b in zip(NPU_PROF[0], (1, n, len(x), time.perf_counter() - t))]
        return 1.0 / (1.0 + np.exp(-z.astype(np.float64)))

    _NPU[id(net)] = f
    return f


def supports(lineup):
    nets = {t for t in lineup if VNET.match(t)}
    return all(VNET.match(t) or t == "rab" or POOL.match(t) for t in lineup) and len(nets) <= 1


def targets(colors, turns, winner_seat, vps, num_turns):
    """gen_games.StateSampler.targets on the arena's seat-indexed records."""
    colors = np.frombuffer(colors, dtype=np.uint8).astype(np.int64)  # Vec<u8> crosses PyO3 as bytes
    n = len(vps)
    y = (colors == winner_seat).astype(np.uint8)
    vp = np.asarray(vps, dtype=np.float16)[(colors[:, None] + np.arange(n)[None, :]) % n]
    turns_left = (num_turns - np.asarray(turns)).astype(np.float16)
    return y, vp, turns_left


def play(lineup, seeds, *, sample_p=0.0, rank_p=0.0, sib_p=0.0, ts_p=0.0, roll_p=0.0, roll_m=4, roll_depth=2, roll_net="", batch=64, depth=2, keep_log=False):
    """Yields (seed, winner_color or None, part, extra) per game as they finish.
    `part` is the gen_games shard dict (float16) or None for a game without a
    winner; `extra` is (game, log, snapshot) when keep_log, else None.

    Two arenas ping-pong: while one's leaves are scored on the XPU, the other's
    games advance in Rust. The forward (and its wait) runs in a helper thread:
    torch releases the GIL inside ops and the Rust step releases it in
    allow_threads, so the two overlap on the host. Device-side overlap via
    streams/events does not work here -- measured: waiting on an event recorded
    after forward A blocks until a later-queued oneDNN matmul B also finishes.

    `lineup` is 4 tokens, or a function seed -> 4 tokens (gate.py's pool); every lineup shares one vnet spec."""
    seeds = list(seeds)
    lineup_of = lineup if callable(lineup) else (lambda seed: lineup)
    tokens = {t for seed in seeds for t in lineup_of(seed)}
    assert supports(sorted(tokens)), tokens
    nets = [VNET.match(t) for t in tokens if VNET.match(t)]
    cvnets = sorted({POOL.match(t).group(5) for t in tokens if POOL.match(t) and POOL.match(t).group(5)})
    g = nets[0].groupdict() if nets else {}
    net = load_value_net(g["path"]).to("cpu" if DEVICE == "npu" else DEVICE) if nets else None
    npu = npu_forward(net) if net is not None and DEVICE == "npu" else None
    if g.get("depth"):
        depth = int(g["depth"])
    own_turn = bool(g.get("own"))
    tau = float(g.get("tau") or 0.0)
    prune_k = int(g.get("k") or 0)
    trade_net = rust_value_net(g["path"]) if g.get("x") else None
    prune_net = rust_value_net(os.environ.get("PRUNE_NET", g["path"])) if prune_k else None
    mcts_net = rust_value_net(g["path"]) if g.get("sims") else None
    layout = rb.layout(rb.ctx_for(Game([RandomPlayer(c) for c in COLORS], seed=0)))
    cpu_seats = g.get("sims") or any(POOL.match(t) for t in tokens)  # searches that run inside the Rust step (MCTS, pool seats)
    roll_park = os.environ.get("ROLL_PARK", "") if roll_net else ""
    # > 2: each arena steps in its own thread (below); a step waits for its slowest game. 32 arenas of ~4 games: NPU
    # rollouts kept 7.7 of 8 cores busy where 16 left 1.6 idle (-11% wall), the gate mix -9% (2026-09-24)
    n_arenas = int(os.environ.get("ARENAS", 32 if roll_park == "rust" or cpu_seats else 2)) if net is not None else 1
    # ROLL_PARK=rust: net rollouts become tasks parked at each net decision; the engine runs their dense layers on the
    # NPU inside each arena step (npu.rs). =1: the same on the CPU, the exactness check (docs/RESEARCH-HARDWARE.md)
    rnet = rust_value_net(g["path"]) if roll_net else None  # rollouts play the lineup's net at one ply on the CPU (valuenet.rs): "all" seats or the decider's "own" moves
    arenas = [catan_engine.Arena(layout, depth, sample_p, rank_p, sib_p, keep_log, rab_depth=2, max_leaves=MAX_LEAVES, ts_p=ts_p, own_turn=own_turn, roll_p=roll_p, roll_m=roll_m, roll_depth=roll_depth, roll_net=rnet, roll_net_own=roll_net == "own", tau=tau, prune_net=prune_net, prune_k=prune_k, trade_net=trade_net, trade_net_partners=g.get("x") == "xx", mcts_net=mcts_net, mcts_sims=int(g.get("sims") or 0), mcts_c=float(g.get("c") or 0.1), mcts_max=bool(g.get("mb")), mcts_roll=int(g.get("rr") or 0), mcts_lambda=float(g.get("lam") or 0.5), mcts_roll_depth1=bool(g.get("rd1")), pool_nets=[rust_value_net(c) for c in cvnets], **({"roll_npu": ov_ir(g["path"].split("+")[-1], True)} if roll_park == "rust" else {"roll_park": True} if roll_park else {}), **({"pool_npu": [ov_ir(c, False) for c in cvnets]} if cvnets and DEVICE == "npu" and os.environ.get("POOL_NPU") else {})) for _ in range(n_arenas)]  # vnetN: deepens the net only
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

    seed_lock = threading.Lock()

    def seat_code(t):  # arena.rs PyArena.add
        m = POOL.match(t)
        if VNET.match(t):
            return 0
        if t == "rab":
            return 1
        if t in ("jsrobot", "jsdroid"):
            return 2 if t == "jsrobot" else 3
        if m.group(1):
            return 100 + int(m.group(1))
        if t.startswith("uct"):
            c100 = round(float(m.group(3)) * 100) if m.group(3) else 0
            return 1000 + int(m.group(2) or 5000) + 1_000_000 * c100 + (1 << 31 if m.group(4) else 0)
        return 10 + cvnets.index(m.group(5))

    def add(i):
        with seed_lock:
            seed = next(seeds, None)
        if seed is None:
            return False
        game = Game([RandomPlayer(c) for c in COLORS], seed=seed)
        rs, _ = rb.rust_state(game)
        colors = list(game.state.colors)
        lu = lineup_of(seed)
        seats = [seat_code(lu[COLORS.index(c)]) for c in colors]
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
        ms = arena.last_ms()
        prof["par"] += ms[0]; prof["fill"] += ms[1]; prof["npu"] = prof.get("npu", 0.0) + (ms[2] if len(ms) > 2 else 0.0)
        t = time.perf_counter()
        finished = []
        for seed, w, num_turns, vps, d, log, snap in arena.finished():
            game, colors = games[i].pop(seed)
            part = None
            if w >= 0:
                y, vp, turns_left = targets(d["color"], d["turn"], w, vps, num_turns)
                part = dict(
                    X=d["X"].astype(np.float16, copy=False), y=y, vp=vp, turns_left=turns_left,
                    rank_c=d["rank_c"].astype(np.float16, copy=False), rank_o=d["rank_o"].astype(np.float16, copy=False),
                    sib_x=d["sib_x"].astype(np.float16, copy=False), sib_v=d["sib_v"], sib_n=np.asarray(d["sib_n"], dtype=np.int8), sib_isp0=np.asarray(d["sib_isp0"], dtype=bool),
                    ts_x=d["ts_x"].astype(np.float16, copy=False), ts_v=np.asarray(d["ts_v"], dtype=np.float32),
                    ro_x=d["ro_x"].astype(np.float16, copy=False), ro_v=np.asarray(d["ro_v"], dtype=np.float32), ro_n=np.asarray(d["ro_n"], dtype=np.int8),
                )
            finished.append((seed, (None if w < 0 else colors[w]), part, ((game, log, snap) if keep_log else None)))
            add(i)
        prof["drain"] += time.perf_counter() - t
        return (pool.submit(forward, bufs[i][:rows], n_rows) if n_pending else None), finished

    def forward(x, n):  # helper thread; rows beyond n are padding (stale data), dropped
        if npu:
            return npu(x.numpy(), n)
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
    if n_arenas <= 2:  # ping-pong in this thread: finishing order is deterministic, which gen_games' shards rely on
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
        running = 0
    else:
        # One driver thread per arena. A step runs every game until it needs a forward, so it waits for its slowest
        # game -- with MCTS a whole turn of searches, seconds -- and 2 arenas left the cores ~half idle (158-420% of
        # 800); 16 arenas: 1.45x, game logs identical (docs/FINDINGS.md 2026-09-22). Finishing order is not
        # deterministic here, so gen_games' default lineups keep the ping-pong above.
        running = n_arenas
    done = queue.Queue()  # finished games from every driver; None = a driver ran out, an exception = it died

    def drive(i):
        """One arena's loop in its own thread: the step releases the GIL, the forwards share the one XPU worker.
        Game results depend only on the seed (each game has its own RNG), not on which arena plays it."""
        try:
            out, finished = run(i, None)
            while True:
                for f in finished:
                    done.put(f)
                if not games[i]:
                    break
                out, finished = run(i, sync(out))
        except BaseException as e:  # noqa: BLE001 -- re-raised in the consumer
            done.put(e)
        done.put(None)

    for i in range(running):
        threading.Thread(target=drive, args=(i,), daemon=True).start()
    while running:
        item = done.get()
        if item is None:
            running -= 1
        elif isinstance(item, BaseException):
            raise item
        else:
            yield item
    pool.shutdown()
    if DEVICE == "xpu":
        torch.xpu.empty_cache()
    if os.environ.get("ARENA_PROF"):
        el = time.perf_counter() - prof["t0"]
        n = max(prof["steps"], 1)
        print(f"  arena: {prof['steps']} steps, {prof['rows'] / n:.0f} rows/step; rust step {prof['step'] / el:.0%} waiting on forward {prof['fwd'] / el:.0%} "
              f"drain+new games {prof['drain'] / el:.0%}; per step: rust {prof['step'] / n * 1e3:.0f} ms (parallel {prof['par'] / n:.0f}, fill {prof['fill'] / n:.1f}) "
              f"forward wait {prof['fwd'] / n * 1e3:.1f} ms; wall/step {el / n * 1e3:.0f} ms; rollout NPU calls {prof.get('npu', 0) / 1e3 / el:.0%} (arena-threads blocked, summed)", flush=True)
        c, r, pr, sec = NPU_PROF[0]
        if c:
            print(f"  npu leaf forwards: {c} calls, {r / c:.0f} rows ({pr / c:.0f} padded) and {sec / c * 1e3:.1f} ms per call, {sec / el:.0%} of wall", flush=True)


if __name__ == "__main__":  # reply pruning with k above any reply count is plain depth 3, game for game
    net = "vnet3{}:checkpoints_value/v55.pt"
    run = lambda k: [(s, w) for s, w, _, _ in play([net.format(k), "rab", "rab", "rab"], range(8), batch=8)]  # noqa: E731
    assert sorted(run("")) == sorted(run("k999")), "k999 differs from unpruned depth 3"
    print("arena: k999 == depth 3 on 8 games")
