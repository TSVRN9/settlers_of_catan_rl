"""M1 gate: fast encoder vs catanatron's create_sample_vector, and env step
rate. Measures the ratio interleaved in one process/run (not against a
recorded baseline number) so the result survives an unknown power profile --
see docs/FINDINGS.md, `powerprofilesctl` isn't available in this shell.

    uv run python bench_env.py
"""

import time

import numpy as np
from catanatron import Color, Game, RandomPlayer
from catanatron.features import create_sample_vector
from catanatron.gym.envs.catanatron_env import CatanatronEnv
from catanatron.players.weighted_random import WeightedRandomPlayer
from sb3_contrib.common.maskable.utils import get_action_masks
from sb3_contrib.common.wrappers import ActionMasker
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import SubprocVecEnv

from catan_env import FEATURES, CachedMaskVecEnv, Encoder, FastCatanatronEnv

N = 4000


def bench_encoder():
    game = Game([RandomPlayer(c) for c in [Color.RED, Color.BLUE, Color.WHITE, Color.ORANGE]], seed=1)
    for _ in range(150):
        if game.winning_color() is not None:
            break
        game.play_tick()

    encoder = Encoder()
    encoder.encode(game, Color.BLUE)  # warm the static template cache

    fast_total = 0.0
    ref_total = 0.0
    # interleave in small blocks so the two measurements share thermal/scheduling conditions
    block = 50
    for _ in range(N // block):
        t = time.perf_counter()
        for _ in range(block):
            encoder.encode(game, Color.BLUE)
        fast_total += time.perf_counter() - t

        t = time.perf_counter()
        for _ in range(block):
            create_sample_vector(game, Color.BLUE, FEATURES)
        ref_total += time.perf_counter() - t

    fast_us = fast_total / N * 1e6
    ref_us = ref_total / N * 1e6
    ratio = ref_total / fast_total
    print(f"create_sample_vector: {ref_us:.1f} us/call ({N/ref_total:.0f}/s)")
    print(f"Encoder.encode:       {fast_us:.1f} us/call ({N/fast_total:.0f}/s)")
    print(f"ratio (reference/fast): {ratio:.2f}x")
    return ratio, fast_us, ref_us


def bench_env_step_rate(env_cls, config, seconds=6.0):
    env = env_cls(config)
    _obs, info = env.reset(seed=0)
    steps, t0 = 0, time.perf_counter()
    while time.perf_counter() - t0 < seconds:
        va = info["valid_actions"]
        _obs, _r, term, trunc, info = env.step(int(np.random.choice(va)))
        steps += 1
        if term or trunc:
            _obs, info = env.reset()
    dt = time.perf_counter() - t0
    return steps / dt


def bench_step_rates():
    config = {
        "enemies": [
            RandomPlayer(Color.RED),
            RandomPlayer(Color.WHITE),
            RandomPlayer(Color.ORANGE),
        ]
    }
    # short warmup for each before the timed run, alternating to share conditions
    bench_env_step_rate(CatanatronEnv, config, seconds=1.0)
    bench_env_step_rate(FastCatanatronEnv, config, seconds=1.0)

    baseline_rate = bench_env_step_rate(CatanatronEnv, config, seconds=6.0)
    fast_rate = bench_env_step_rate(FastCatanatronEnv, config, seconds=6.0)
    print(f"CatanatronEnv (baseline) 4p step rate: {baseline_rate:.0f} steps/s/core")
    print(f"FastCatanatronEnv        4p step rate: {fast_rate:.0f} steps/s/core "
          f"(includes forced-decision skip, so steps here are real BLUE decisions)")
    return baseline_rate, fast_rate


def _mask_fn(env):
    return env.unwrapped.action_masks()


def _train_env_factory(seed):
    def _init():
        enemies = [
            WeightedRandomPlayer(Color.RED),
            WeightedRandomPlayer(Color.WHITE),
            WeightedRandomPlayer(Color.ORANGE),
        ]
        env = FastCatanatronEnv({"enemies": enemies})
        env = ActionMasker(env, _mask_fn)
        env = Monitor(env)
        env.reset(seed=seed)
        return env

    return _init


def bench_vecenv_ipc(n_envs=7, seconds=15.0):
    """train.py's actual rollout-collection shape: fetch masks, pick a valid
    action per env, step. Compares sb3_contrib's default (env_method("action_masks")
    + step(), 2 IPC round trips/step) against CachedMaskVecEnv (masks read from
    the info dict step() already returns, 1 IPC round trip/step)."""
    raw = SubprocVecEnv([_train_env_factory(seed=100 + i) for i in range(n_envs)])
    try:
        raw.reset()
        # warmup
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < 1.0:
            masks = get_action_masks(raw)
            actions = np.array([np.random.choice(np.flatnonzero(m)) for m in masks])
            raw.step(actions)

        steps, t0 = 0, time.perf_counter()
        while time.perf_counter() - t0 < seconds:
            masks = get_action_masks(raw)
            actions = np.array([np.random.choice(np.flatnonzero(m)) for m in masks])
            raw.step(actions)
            steps += n_envs
        old_rate = steps / (time.perf_counter() - t0)
    finally:
        raw.close()

    raw2 = SubprocVecEnv([_train_env_factory(seed=200 + i) for i in range(n_envs)])
    try:
        cached = CachedMaskVecEnv(raw2)
        cached.reset()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < 1.0:
            masks = get_action_masks(cached)
            actions = np.array([np.random.choice(np.flatnonzero(m)) for m in masks])
            cached.step(actions)

        steps, t0 = 0, time.perf_counter()
        while time.perf_counter() - t0 < seconds:
            masks = get_action_masks(cached)
            actions = np.array([np.random.choice(np.flatnonzero(m)) for m in masks])
            cached.step(actions)
            steps += n_envs
        new_rate = steps / (time.perf_counter() - t0)
    finally:
        raw2.close()

    print(f"SubprocVecEnv + sb3_contrib default (2 IPC round trips/step): {old_rate:.0f} steps/s")
    print(f"SubprocVecEnv + CachedMaskVecEnv     (1 IPC round trip/step): {new_rate:.0f} steps/s")
    print(f"speedup: {new_rate / old_rate:.2f}x")
    return old_rate, new_rate


if __name__ == "__main__":
    print("=== encoder ===")
    ratio, fast_us, ref_us = bench_encoder()
    print()
    print("=== env step rate (1 core) ===")
    baseline_rate, fast_rate = bench_step_rates()
    print()
    assert ratio >= 3.0, (
        f"M1 gate FAILED: encoder is only {ratio:.2f}x faster than create_sample_vector "
        f"(need >=3x). fast={fast_us:.1f}us ref={ref_us:.1f}us"
    )
    print(f"M1 gate PASSED: encoder is {ratio:.2f}x faster than create_sample_vector "
          f"({ref_us:.1f}us -> {fast_us:.1f}us)")
    print()
    print("=== SubprocVecEnv IPC: sb3_contrib default vs CachedMaskVecEnv ===")
    bench_vecenv_ipc()
