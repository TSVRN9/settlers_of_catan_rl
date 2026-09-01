"""Win rate vs a named bot, with a Wilson interval on the binomial proportion.

    uv run python evaluate.py --model checkpoints/final_model.zip --opponent weighted_random --games 200

Catanatron seeds everything through the global `random` module, so a seeded
game *should* be bit-reproducible -- it isn't. Python's per-process hash
randomization changes set/dict iteration order inside the engine's action
generation, so `game.playable_actions` comes back in a different order each
process and the opponents' `random.choice` over that list picks different
moves. Same seed, different game. Measured: the same checkpoint scored 46, 43,
44 and 38 out of 50 across four runs of this command, and 46/50 twice in a row
once PYTHONHASHSEED was pinned. The re-exec below pins it.
"""

import os
import sys

if os.environ.get("PYTHONHASHSEED") != "0":
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import argparse
import math
import multiprocessing as mp

import numpy as np
import torch
from catanatron.gym.envs.action_space import to_action_space
from catanatron.models.player import Color
from catanatron.players.minimax import AlphaBetaPlayer
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer
from sb3_contrib import MaskablePPO

from catan_env import FastCatanatronEnv, advance_until_decision

OPPONENTS = {
    "weighted_random": WeightedRandomPlayer,
    "value_function": ValueFunctionPlayer,
    "alpha_beta": AlphaBetaPlayer,
}


def wilson_interval(wins, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = wins / n
    denom = 1 + z**2 / n
    center = p + z**2 / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2))
    return ((center - margin) / denom, (center + margin) / denom)


def play_one(model, opponent_cls, seed):
    enemies = [opponent_cls(Color.RED), opponent_cls(Color.WHITE), opponent_cls(Color.ORANGE)]
    env = FastCatanatronEnv({"enemies": enemies})
    obs, _info = env.reset(seed=seed)
    terminated = truncated = False
    info = {}
    while not (terminated or truncated):
        mask = env.action_masks()
        action, _ = model.predict(obs, action_masks=mask, deterministic=True)
        obs, _reward, terminated, truncated, info = env.step(int(action))
    return bool(info.get("is_success", False))


def greedy_search_action(model, encoder, game, p0_color, playable_actions):
    """HANDOFF.md M5: 1-ply greedy search, inference-time only. For each
    legal action, game.copy() + execute + score the resulting state with the
    trained policy's own value head, pick the best -- same shape as
    ValueFunctionPlayer.decide() (see docs/FINDINGS.md's "search, not
    representation" finding), but scored with our learned value function
    instead of a hand-crafted heuristic. Advances each copy to the next real
    p0 decision boundary before scoring -- the value head was trained only
    on post-skip states (FastCatanatronEnv.step() always advances before
    encoding), so scoring a raw post-execute state would ask it about a
    state class it never saw."""
    if len(playable_actions) == 1:
        return playable_actions[0]
    obs_batch = []
    for action in playable_actions:
        game_copy = game.copy()
        game_copy.execute(action)
        advance_until_decision(game_copy, p0_color)
        obs_batch.append(encoder.encode(game_copy, p0_color))
    obs_tensor = model.policy.obs_to_tensor(np.array(obs_batch))[0]
    with torch.no_grad():
        values = model.policy.predict_values(obs_tensor)
    return playable_actions[int(torch.argmax(values))]


def play_one_with_search(model, opponent_cls, seed):
    enemies = [opponent_cls(Color.RED), opponent_cls(Color.WHITE), opponent_cls(Color.ORANGE)]
    env = FastCatanatronEnv({"enemies": enemies})
    env.reset(seed=seed)
    terminated = truncated = False
    info = {}
    while not (terminated or truncated):
        game = env.game
        action = greedy_search_action(
            model, env._encoder, game, env.p0.color, game.playable_actions
        )
        action_int = to_action_space(action, env.player_colors, env.map_type)
        _obs, _reward, terminated, truncated, info = env.step(action_int)
    return bool(info.get("is_success", False))


_WORKER = {}


def _init_worker(model_path, opponent, search):
    _WORKER["model"] = MaskablePPO.load(model_path)
    _WORKER["opponent_cls"] = OPPONENTS[opponent]
    _WORKER["search"] = search


def _play_seed(seed):
    play_fn = play_one_with_search if _WORKER["search"] else play_one
    return play_fn(_WORKER["model"], _WORKER["opponent_cls"], seed)


def evaluate(model_path, opponent, games, seed, jobs, search=False):
    seeds = range(seed, seed + games)
    if jobs == 1:
        _init_worker(model_path, opponent, search)
        return sum(_play_seed(s) for s in seeds)
    ctx = mp.get_context("spawn")
    with ctx.Pool(
        jobs, initializer=_init_worker, initargs=(model_path, opponent, search)
    ) as pool:
        return sum(pool.map(_play_seed, seeds, chunksize=1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, nargs="+", help="one or more checkpoint .zip paths")
    parser.add_argument("--opponent", choices=sorted(OPPONENTS), required=True)
    parser.add_argument("--games", type=int, default=200)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--jobs", type=int, default=7, help="parallel game workers; 1 runs serially")
    parser.add_argument(
        "--search",
        action="store_true",
        help="wrap the policy in 1-ply greedy search (HANDOFF.md M5) instead of calling it reactively",
    )
    args = parser.parse_args()

    for model_path in args.model:
        wins = evaluate(model_path, args.opponent, args.games, args.seed, args.jobs, args.search)
        lo, hi = wilson_interval(wins, args.games)
        print(
            f"{model_path}: {wins}/{args.games} wins = {wins / args.games:.1%}  "
            f"Wilson 95% CI [{lo:.1%}, {hi:.1%}]  vs {args.opponent}",
            flush=True,
        )


if __name__ == "__main__":
    main()
