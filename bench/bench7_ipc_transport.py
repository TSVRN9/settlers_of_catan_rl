"""M3 Step 0 (docs/RUST-ENGINE.md trigger #2): is inference_server.py's
mean-batch plateau (~41-48, target >=256) actually explained by per-decision
pickling through multiprocessing.Queue, as FINDINGS.md guesses but never
measured? Isolates the round-trip transport from game simulation and the
forward pass entirely -- one dedicated worker process bounces an
obs+mask-sized payload back and forth as fast as possible -- then compares
against a shared-memory transport doing the same round trip.

    uv run python bench/bench7_ipc_transport.py
"""

import time

import numpy as np
import torch.multiprocessing as mp
from multiprocessing import shared_memory

OBS_DIM = 1026  # catan_env.py's FEATURES length (base 1002 + 24 extra); no env import needed for a transport-only bench
ACTION_DIM = 370  # matches train.py's 4p Discrete(370)
N_ROUNDTRIPS = 4000


def _queue_worker(q_req, q_rep, n, obs, mask):
    for i in range(n):
        q_req.put((0, i, obs, mask))
        q_rep.get()


def bench_queue_roundtrip(n=N_ROUNDTRIPS):
    obs = np.random.rand(OBS_DIM).astype(np.float32)
    mask = (np.random.rand(ACTION_DIM) > 0.5)
    q_req, q_rep = mp.Queue(), mp.Queue()
    p = mp.Process(target=_queue_worker, args=(q_req, q_rep, n, obs, mask))
    p.start()
    t0 = time.perf_counter()
    for _ in range(n):
        _wid, game_idx, _obs, _mask = q_req.get()
        q_rep.put((game_idx, 0))
    elapsed = time.perf_counter() - t0
    p.join()
    for q in (q_req, q_rep):
        q.cancel_join_thread()
        q.close()
    return elapsed, n


def _shm_worker(req_name, rep_name, req_ready, rep_ready, n, obs, mask_f32):
    req_shm = shared_memory.SharedMemory(name=req_name)
    rep_shm = shared_memory.SharedMemory(name=rep_name)
    req_buf = np.ndarray(OBS_DIM + ACTION_DIM, dtype=np.float32, buffer=req_shm.buf)
    rep_buf = np.ndarray(1, dtype=np.int32, buffer=rep_shm.buf)
    payload = np.concatenate([obs, mask_f32])
    for _ in range(n):
        req_buf[:] = payload
        req_ready.set()
        rep_ready.wait()
        rep_ready.clear()
        _ = rep_buf[0]
    req_shm.close()
    rep_shm.close()


def bench_shm_roundtrip(n=N_ROUNDTRIPS):
    obs = np.random.rand(OBS_DIM).astype(np.float32)
    mask_f32 = (np.random.rand(ACTION_DIM) > 0.5).astype(np.float32)

    req_shm = shared_memory.SharedMemory(create=True, size=(OBS_DIM + ACTION_DIM) * 4)
    rep_shm = shared_memory.SharedMemory(create=True, size=4)
    req_buf = np.ndarray(OBS_DIM + ACTION_DIM, dtype=np.float32, buffer=req_shm.buf)
    rep_buf = np.ndarray(1, dtype=np.int32, buffer=rep_shm.buf)
    req_ready, rep_ready = mp.Event(), mp.Event()

    p = mp.Process(
        target=_shm_worker,
        args=(req_shm.name, rep_shm.name, req_ready, rep_ready, n, obs, mask_f32),
    )
    p.start()
    t0 = time.perf_counter()
    for _ in range(n):
        req_ready.wait()
        req_ready.clear()
        _ = req_buf[:OBS_DIM]  # "read" the request, mirrors server touching obs/mask
        rep_buf[0] = 0
        rep_ready.set()
    elapsed = time.perf_counter() - t0
    p.join()
    req_shm.close()
    req_shm.unlink()
    rep_shm.close()
    rep_shm.unlink()
    return elapsed, n


def _queue_worker_n(wid, q_req, q_rep, n, obs, mask):
    for i in range(n):
        q_req.put((wid, i, obs, mask))
        q_rep.get()


def bench_queue_concurrent(n_workers=7, n_per_worker=2000):
    """Same topology as inference_server.py -- one shared request_queue, one
    reply_queue per worker -- with the game simulation and forward pass
    stripped out, isolating pure IPC contention under realistic concurrency
    (7 workers + 1 central process on an 8-thread machine, same as the real
    system)."""
    obs = np.random.rand(OBS_DIM).astype(np.float32)
    mask = (np.random.rand(ACTION_DIM) > 0.5)
    request_queue = mp.Queue()
    reply_queues = [mp.Queue() for _ in range(n_workers)]
    workers = [
        mp.Process(target=_queue_worker_n, args=(wid, request_queue, reply_queues[wid], n_per_worker, obs, mask))
        for wid in range(n_workers)
    ]
    for w in workers:
        w.start()

    total = n_workers * n_per_worker
    t0 = time.perf_counter()
    for _ in range(total):
        wid, game_idx, _obs, _mask = request_queue.get()
        reply_queues[wid].put((game_idx, 0))
    elapsed = time.perf_counter() - t0
    for w in workers:
        w.join()
    for q in [request_queue, *reply_queues]:
        q.cancel_join_thread()
        q.close()
    return elapsed, total


def _shm_worker_n(wid, req_shm_name, rep_shm_name, flags_shm_name, n_workers, n, obs, mask_f32):
    req_shm = shared_memory.SharedMemory(name=req_shm_name)
    rep_shm = shared_memory.SharedMemory(name=rep_shm_name)
    flags_shm = shared_memory.SharedMemory(name=flags_shm_name)
    req_buf = np.ndarray((n_workers, OBS_DIM + ACTION_DIM), dtype=np.float32, buffer=req_shm.buf)
    rep_buf = np.ndarray(n_workers, dtype=np.int32, buffer=rep_shm.buf)
    flags = np.ndarray((n_workers, 2), dtype=np.int8, buffer=flags_shm.buf)  # [:, 0]=req_ready, [:, 1]=rep_ready
    payload = np.concatenate([obs, mask_f32])
    for _ in range(n):
        req_buf[wid] = payload
        flags[wid, 0] = 1
        while flags[wid, 1] == 0:
            pass
        flags[wid, 1] = 0
        _ = rep_buf[wid]
    req_shm.close()
    rep_shm.close()
    flags_shm.close()


def bench_shm_concurrent(n_workers=7, n_per_worker=2000):
    """Same N-worker contention level as bench_queue_concurrent, but a
    lock-free polled-flag shared-memory mailbox per worker slot instead of
    mp.Queue -- no pickling, no pipe, no feeder thread. Busy-polling is
    deliberate (lowest-latency option the plan names) at this concurrency
    level (<=8 processes on an 8-thread machine)."""
    obs = np.random.rand(OBS_DIM).astype(np.float32)
    mask_f32 = (np.random.rand(ACTION_DIM) > 0.5).astype(np.float32)

    req_shm = shared_memory.SharedMemory(create=True, size=n_workers * (OBS_DIM + ACTION_DIM) * 4)
    rep_shm = shared_memory.SharedMemory(create=True, size=n_workers * 4)
    flags_shm = shared_memory.SharedMemory(create=True, size=n_workers * 2)
    req_buf = np.ndarray((n_workers, OBS_DIM + ACTION_DIM), dtype=np.float32, buffer=req_shm.buf)
    rep_buf = np.ndarray(n_workers, dtype=np.int32, buffer=rep_shm.buf)
    flags = np.ndarray((n_workers, 2), dtype=np.int8, buffer=flags_shm.buf)
    flags[:] = 0

    workers = [
        mp.Process(
            target=_shm_worker_n,
            args=(wid, req_shm.name, rep_shm.name, flags_shm.name, n_workers, n_per_worker, obs, mask_f32),
        )
        for wid in range(n_workers)
    ]
    for w in workers:
        w.start()

    total = n_workers * n_per_worker
    done = 0
    t0 = time.perf_counter()
    while done < total:
        for wid in range(n_workers):
            if flags[wid, 0]:
                flags[wid, 0] = 0
                rep_buf[wid] = 0
                flags[wid, 1] = 1
                done += 1
    elapsed = time.perf_counter() - t0
    for w in workers:
        w.join()
    req_shm.close(); req_shm.unlink()
    rep_shm.close(); rep_shm.unlink()
    flags_shm.close(); flags_shm.unlink()
    return elapsed, total


if __name__ == "__main__":
    mp.set_start_method("spawn", force=True)

    print(f"=== Queue transport, single pair, {N_ROUNDTRIPS} round trips ===")
    elapsed, n = bench_queue_roundtrip()
    print(f"{elapsed:.3f}s total, {elapsed / n * 1e6:.1f} us/roundtrip, {n / elapsed:.0f}/s")
    print("(FINDINGS.md's recorded worker rate under the real inference_server.py: ~1,000-1,100/s/worker)")

    print(f"\n=== Shared-memory transport, single pair, {N_ROUNDTRIPS} round trips ===")
    elapsed, n = bench_shm_roundtrip()
    print(f"{elapsed:.3f}s total, {elapsed / n * 1e6:.1f} us/roundtrip, {n / elapsed:.0f}/s")

    print("\n=== Queue transport, 7 workers (real system's topology + contention) ===")
    elapsed, n = bench_queue_concurrent()
    print(f"{elapsed:.3f}s total, {elapsed / n * 1e6:.1f} us/roundtrip, {n / elapsed:.0f}/s aggregate, {n / elapsed / 7:.0f}/s/worker")

    print("\n=== Shared-memory transport, 7 workers ===")
    elapsed, n = bench_shm_concurrent()
    print(f"{elapsed:.3f}s total, {elapsed / n * 1e6:.1f} us/roundtrip, {n / elapsed:.0f}/s aggregate, {n / elapsed / 7:.0f}/s/worker")
