"""Batched-inference throughput harness (M1 gate #3).

Worker processes step many `FastCatanatronEnv` games each (CPU-only, no torch),
push `(worker_id, game_idx, obs, mask)` onto one shared request queue whenever
a game reaches a real decision. One server process (the only one touching
`torch.xpu`) gathers up to `MAX_BATCH` requests -- or flushes on a short
timeout as a safety valve for stragglers -- runs one batched forward pass, and
replies to each worker's own reply queue.

This measures pipeline throughput and mean achieved batch size with an
untrained net; it is not doing anything policy-quality-related. M2 wires a
real MaskablePPO policy through the same env; this file exists to answer one
question before that: can the batching design reach batch >=256 on this
machine, and if not, what does it actually reach.

    uv run python inference_server.py [--workers 7] [--games-per-worker 37] [--seconds 15]
"""

import argparse
import queue
import time

import numpy as np
import torch
import torch.multiprocessing as mp
from catanatron.models.player import Color, RandomPlayer
from torch import nn

from catan_env import FEATURES, FastCatanatronEnv

OBS_DIM = len(FEATURES)
MAX_BATCH = 256
BATCH_TIMEOUT_S = 0.004
POLL_TIMEOUT_S = 0.5


def _enemies():
    return [RandomPlayer(Color.RED), RandomPlayer(Color.WHITE), RandomPlayer(Color.ORANGE)]


def _action_dim():
    env = FastCatanatronEnv({"enemies": _enemies()})
    return env.action_space.n


class PolicyNet(nn.Module):
    def __init__(self, obs_dim, action_dim, hidden=512):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, action_dim),
        )

    def forward(self, x):
        return self.net(x)


def worker_loop(worker_id, num_games, request_queue, reply_queue, stop_event, stats_queue):
    envs = [FastCatanatronEnv({"enemies": _enemies()}) for _ in range(num_games)]
    for i, env in enumerate(envs):
        obs, _info = env.reset(seed=worker_id * 10_000 + i)
        request_queue.put((worker_id, i, obs, np.asarray(env.action_masks())))

    decisions_done = 0
    while not stop_event.is_set():
        try:
            game_idx, action = reply_queue.get(timeout=POLL_TIMEOUT_S)
        except queue.Empty:
            continue
        env = envs[game_idx]
        obs, _reward, terminated, truncated, _info = env.step(action)
        decisions_done += 1
        if terminated or truncated:
            obs, _info = env.reset()
        request_queue.put((worker_id, game_idx, obs, np.asarray(env.action_masks())))

    stats_queue.put((worker_id, decisions_done))
    # We may have just put a final request nobody will ever read (the server
    # already stopped) -- don't let this process's exit block flushing it.
    request_queue.cancel_join_thread()


def server_loop(num_workers, reply_queues, request_queue, action_dim, device, stop_event, duration_s, batch_stats_queue):
    net = PolicyNet(OBS_DIM, action_dim).to(device)
    net.eval()

    batch_sizes = []
    t_start = time.perf_counter()
    with torch.no_grad():
        while time.perf_counter() - t_start < duration_s:
            batch = []
            deadline = time.perf_counter() + BATCH_TIMEOUT_S
            while len(batch) < MAX_BATCH:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                try:
                    batch.append(request_queue.get(timeout=remaining))
                except queue.Empty:
                    break
            if not batch:
                continue

            obs_batch = np.stack([b[2] for b in batch])
            mask_batch = np.stack([b[3] for b in batch])
            x = torch.from_numpy(obs_batch).to(device)
            logits = net(x)
            logits[~torch.from_numpy(mask_batch).to(device)] = -1e9
            actions = torch.argmax(logits, dim=1).cpu().numpy()

            for (worker_id, game_idx, _, _), action in zip(batch, actions):
                reply_queues[worker_id].put((game_idx, int(action)))
            batch_sizes.append(len(batch))

    stop_event.set()
    batch_stats_queue.put(batch_sizes)
    # Last replies we sent may go to workers that already stopped reading.
    for q in reply_queues:
        q.cancel_join_thread()


def run_benchmark(num_workers, games_per_worker, duration_s, device):
    action_dim = _action_dim()

    request_queue = mp.Queue()
    reply_queues = [mp.Queue() for _ in range(num_workers)]
    stats_queue = mp.Queue()
    batch_stats_queue = mp.Queue()
    stop_event = mp.Event()

    server = mp.Process(
        target=server_loop,
        args=(num_workers, reply_queues, request_queue, action_dim, device, stop_event, duration_s, batch_stats_queue),
    )
    workers = [
        mp.Process(
            target=worker_loop,
            args=(wid, games_per_worker, request_queue, reply_queues[wid], stop_event, stats_queue),
        )
        for wid in range(num_workers)
    ]

    server.start()
    for w in workers:
        w.start()

    server.join(timeout=duration_s + 30)
    for w in workers:
        w.join(timeout=30)

    batch_sizes = batch_stats_queue.get()
    per_worker_decisions = [stats_queue.get() for _ in workers]

    # Workers/server may leave a handful of in-flight requests/replies
    # un-consumed at shutdown (stop_event can fire mid-loop-iteration). An
    # mp.Queue with unflushed items blocks interpreter exit waiting to join
    # its feeder thread -- tell it not to.
    for q in [request_queue, *reply_queues, stats_queue, batch_stats_queue]:
        q.cancel_join_thread()
        q.close()

    total_decisions = sum(d for _, d in per_worker_decisions)
    mean_batch = sum(batch_sizes) / len(batch_sizes) if batch_sizes else 0.0
    return {
        "total_decisions": total_decisions,
        "decisions_per_s": total_decisions / duration_s,
        "num_batches": len(batch_sizes),
        "mean_batch": mean_batch,
        "max_batch_seen": max(batch_sizes) if batch_sizes else 0,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=7)
    parser.add_argument("--games-per-worker", type=int, default=37)
    parser.add_argument("--seconds", type=float, default=15.0)
    parser.add_argument("--device", default="xpu" if torch.xpu.is_available() else "cpu")
    args = parser.parse_args()

    mp.set_start_method("spawn", force=True)

    print(
        f"workers={args.workers} games_per_worker={args.games_per_worker} "
        f"in_flight={args.workers * args.games_per_worker} device={args.device} "
        f"duration={args.seconds}s"
    )
    result = run_benchmark(args.workers, args.games_per_worker, args.seconds, args.device)
    print(result)
    print(
        f"decisions/s: {result['decisions_per_s']:.0f}  "
        f"mean achieved batch: {result['mean_batch']:.1f} (target >=256)"
    )
