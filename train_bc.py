"""Behavior-clone ValueFunctionPlayer into the same MaskablePPO net/obs/
action-head M2 uses. Diagnostic for the M2 ~79% win-rate ceiling (see
docs/FINDINGS.md, 2026-09-01 "M2 gate calibration"): VFP scores 98.2% vs
3x WeightedRandomPlayer, so the agent losing 21% of games to that opponent
is a real gap, not a miscalibrated gate. This checks whether the gap is
representational (BC caps near ~80% too) or an exploration/credit-assignment
problem in PPO (BC reaches ~95%+, meaning the net *can* represent VFP-quality
play).

The saved checkpoint is a standard MaskablePPO .zip -- loads and evaluates
with the existing evaluate.py unmodified:

    uv run python train_bc.py --games 1500 --epochs 5
    uv run python evaluate.py --model checkpoints_bc/bc_model.zip --opponent weighted_random --games 500
"""

import argparse
import multiprocessing as mp
import os
import sys

# Same reproducibility guard as evaluate.py: Python's per-process hash
# randomization reorders dict/set iteration inside the engine's action
# generation, which changes what WeightedRandomPlayer.random.choice picks
# even under a fixed seed (see docs/FINDINGS.md, "the evaluator was broken").
# Matters here too since the label dataset should be reproducible.
if os.environ.get("PYTHONHASHSEED") != "0":
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import numpy as np
import torch
from catanatron.gym.envs.action_space import to_action_space
from catanatron.models.player import Color
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer
from sb3_contrib import MaskablePPO
from stable_baselines3.common.vec_env import DummyVecEnv

from catan_env import FastCatanatronEnv
from train import _make_env


def _play_one(seed):
    enemies = [WeightedRandomPlayer(c) for c in (Color.RED, Color.WHITE, Color.ORANGE)]
    env = FastCatanatronEnv({"enemies": enemies})
    vfp = ValueFunctionPlayer(Color.BLUE)
    obs, _info = env.reset(seed=seed)
    terminated = truncated = False
    xs, ys, ms = [], [], []
    while not (terminated or truncated):
        mask = env.action_masks()
        action = vfp.decide(env.game, env.game.playable_actions)
        action_idx = to_action_space(action, env.player_colors, env.map_type)
        xs.append(obs)
        ys.append(action_idx)
        ms.append(mask)
        obs, _reward, terminated, truncated, _info = env.step(action_idx)
    return xs, ys, ms


def generate_dataset(n_games, seed0, n_jobs):
    with mp.Pool(n_jobs) as pool:
        results = pool.map(_play_one, range(seed0, seed0 + n_games))
    X = np.stack([x for r in results for x in r[0]]).astype(np.float32)
    y = np.array([a for r in results for a in r[1]], dtype=np.int64)
    M = np.stack([m for r in results for m in r[2]])
    assert M[np.arange(len(y)), y].all(), "VFP-labeled action fell outside its own mask"
    return X, y, M


def train_bc(X, y, M, epochs, batch_size, device, seed):
    dummy_env = DummyVecEnv([_make_env(seed=seed, opponent_mix="weighted_random")])
    model = MaskablePPO(
        "MlpPolicy",
        dummy_env,
        policy_kwargs={
            "net_arch": [512, 512, 512],
            "optimizer_class": torch.optim.Adam,
            "optimizer_kwargs": {"foreach": False},  # torch.xpu crashes on foreach=True, see CLAUDE.md
        },
        device=device,
        verbose=0,
        seed=seed,
    )
    policy = model.policy
    optimizer = policy.optimizer

    X_t = torch.as_tensor(X)
    y_t = torch.as_tensor(y)
    M_t = torch.as_tensor(M)
    n = len(y)

    for epoch in range(epochs):
        perm = torch.randperm(n)
        total_loss, correct = 0.0, 0
        for start in range(0, n, batch_size):
            idx = perm[start : start + batch_size]
            obs_b = X_t[idx].to(policy.device)
            actions_b = y_t[idx].to(policy.device)
            masks_b = M_t[idx].to(policy.device)

            values, log_prob, _entropy = policy.evaluate_actions(obs_b, actions_b, action_masks=masks_b)
            loss = -log_prob.mean()

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(idx)
            with torch.no_grad():
                pred_actions, _, _ = policy(obs_b, deterministic=True, action_masks=masks_b.cpu().numpy())
                correct += (pred_actions == actions_b).sum().item()
        print(f"epoch {epoch}: loss={total_loss / n:.4f} train_acc={correct / n:.4f}")

    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", type=int, default=1500, help="labeled games to generate (VFP is ~0.44s/game)")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=4096)
    parser.add_argument("--jobs", type=int, default=7)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--out", default="checkpoints_bc/bc_model")
    args = parser.parse_args()

    print(f"generating {args.games} VFP-labeled games ({args.jobs} workers)...")
    X, y, M = generate_dataset(args.games, seed0=args.seed, n_jobs=args.jobs)
    print(f"{len(y)} labeled decisions, obs shape {X.shape}")

    model = train_bc(X, y, M, args.epochs, args.batch_size, args.device, args.seed)

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    model.save(args.out)
    print(f"saved: {args.out}.zip")


if __name__ == "__main__":
    main()
