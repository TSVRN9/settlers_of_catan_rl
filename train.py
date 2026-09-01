"""M2: MaskablePPO vs 3x WeightedRandomPlayer.

Net stays small (3x512 MLP) and device defaults to CPU: FINDINGS.md's
conclusion is we're simulation-bound, and PPO rollout collection here batches
at n_envs (~7), which is below where XPU beats CPU. `Adam(foreach=False)`
always, per CLAUDE.md, regardless of device.

    uv run python train.py --timesteps 2_000_000 --n-envs 7
"""

import argparse
from pathlib import Path

import torch
from catanatron.models.player import Color
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer
from sb3_contrib import MaskablePPO
from sb3_contrib.common.wrappers import ActionMasker
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import SubprocVecEnv

from catan_env import CachedMaskVecEnv, FastCatanatronEnv

# Opponent mixes for the M2 plateau. See docs/FINDINGS.md, 2026-09-01:
# 3x WeightedRandomPlayer plateaus at ~79% (gate is >90%); ValueFunctionPlayer
# beats WeightedRandomPlayer 99.3%, so swapping one enemy in is a curriculum
# step -- harder training opponent, still evaluated against the unchanged
# M2 gate (3x weighted_random).
OPPONENT_MIXES = {
    "weighted_random": [WeightedRandomPlayer, WeightedRandomPlayer, WeightedRandomPlayer],
    "mixed_1vf": [ValueFunctionPlayer, WeightedRandomPlayer, WeightedRandomPlayer],
    "value_function": [ValueFunctionPlayer, ValueFunctionPlayer, ValueFunctionPlayer],
}


def _mask_fn(env):
    return env.unwrapped.action_masks()


def _make_env(seed, opponent_mix):
    def _init():
        enemies = [
            cls(color)
            for cls, color in zip(OPPONENT_MIXES[opponent_mix], (Color.RED, Color.WHITE, Color.ORANGE))
        ]
        env = FastCatanatronEnv({"enemies": enemies})
        env = ActionMasker(env, _mask_fn)
        env = Monitor(env)
        env.reset(seed=seed)
        return env

    return _init


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timesteps", type=int, default=2_000_000)
    parser.add_argument("--n-envs", type=int, default=7)
    parser.add_argument("--opponent", choices=sorted(OPPONENT_MIXES), default="weighted_random")
    parser.add_argument("--checkpoint-freq", type=int, default=100_000)
    parser.add_argument("--out-dir", default="checkpoints")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--resume-from", default=None, help="checkpoint .zip to continue training from")
    parser.add_argument(
        "--target-kl",
        type=float,
        default=None,
        help="early-stop an epoch's updates once approx_kl exceeds 1.5x this (see FINDINGS.md's approx_kl anomaly)",
    )
    parser.add_argument(
        "--ent-coef",
        type=float,
        default=0.0,
        help="entropy bonus coefficient; SB3 default is 0.0 (no exploration pressure) -- see FINDINGS.md's win-rate-plateau investigation",
    )
    parser.add_argument(
        "--separate-pi-vf",
        action="store_true",
        help="give the policy and value heads independent 3x512 trunks instead of one shared trunk",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    env = CachedMaskVecEnv(
        SubprocVecEnv(
            [_make_env(seed=args.seed + i, opponent_mix=args.opponent) for i in range(args.n_envs)]
        )
    )

    if args.resume_from:
        load_kwargs = {} if args.target_kl is None else {"target_kl": args.target_kl}
        model = MaskablePPO.load(args.resume_from, env=env, device=args.device, **load_kwargs)
    else:
        net_arch = (
            {"pi": [512, 512, 512], "vf": [512, 512, 512]}
            if args.separate_pi_vf
            else [512, 512, 512]
        )
        model = MaskablePPO(
            "MlpPolicy",
            env,
            policy_kwargs={
                "net_arch": net_arch,
                "optimizer_class": torch.optim.Adam,
                "optimizer_kwargs": {"foreach": False},
            },
            target_kl=args.target_kl,
            ent_coef=args.ent_coef,
            device=args.device,
            verbose=1,
            seed=args.seed,
        )

    checkpoint_callback = CheckpointCallback(
        save_freq=max(args.checkpoint_freq // args.n_envs, 1),
        save_path=str(out_dir),
        name_prefix="ppo_catan",
    )

    model.learn(
        total_timesteps=args.timesteps,
        callback=checkpoint_callback,
        progress_bar=False,
        reset_num_timesteps=args.resume_from is None,
    )
    model.save(str(out_dir / "final_model"))
    print(f"saved: {out_dir / 'final_model.zip'}")


if __name__ == "__main__":
    main()
