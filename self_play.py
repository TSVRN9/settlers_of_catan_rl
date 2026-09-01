"""M3: self-play opponent pool. See docs/HANDOFF.md (M3 gate: >50% vs
3x ValueFunctionPlayer) and the M3 plan's Context in docs/FINDINGS.md.

`PPOPlayer` wraps a loaded `MaskablePPO` checkpoint as a `catanatron.Player`,
so past/current training snapshots can serve as enemies. `OpponentPool`
samples 3 such players per episode from a checkpoint directory (reusing
`CheckpointCallback`'s own naming -- no separate snapshot mechanism).
`SelfPlayCatanEnv` resamples enemies on every `reset()`.

Per docs/FINDINGS.md's 2026-09-01 "IPC bottleneck: contention, not pickling"
finding, `PPOPlayer.decide()` calls `model.predict()` locally (batch-1,
in-process) rather than through any shared inference server -- there's no
transport-level win available at this concurrency level, and self-play's
heterogeneous per-seat checkpoints would need multi-model batched serving
on top of that anyway.
"""

import glob
import os

import numpy as np
from catanatron.gym.envs.action_space import from_action_space, to_action_space
from catanatron.models.player import Player
from sb3_contrib import MaskablePPO

from catan_env import Encoder, FastCatanatronEnv

_MODEL_CACHE = {}
_MODEL_CACHE_MAXSIZE = 8


def _load_model(path):
    """Module-level cache shared by every PPOPlayer in this process --
    avoids reloading an ~18MB checkpoint from disk on every episode reset."""
    if path not in _MODEL_CACHE:
        if len(_MODEL_CACHE) >= _MODEL_CACHE_MAXSIZE:
            _MODEL_CACHE.pop(next(iter(_MODEL_CACHE)))
        _MODEL_CACHE[path] = MaskablePPO.load(path, device="cpu")
    return _MODEL_CACHE[path]


class PPOPlayer(Player):
    """A Player backed by a loaded MaskablePPO checkpoint. Plays stochastically
    (deterministic=False) -- a self-play opponent should behave like the
    on-policy rollout it was trained as, not a fixed pattern the ego agent
    can learn to exploit."""

    def __init__(self, color, checkpoint_path, map_type="BASE"):
        super().__init__(color)
        self.checkpoint_path = checkpoint_path
        self.map_type = map_type
        self._encoder = Encoder()

    def decide(self, game, playable_actions):
        if len(playable_actions) == 1:
            return playable_actions[0]

        model = _load_model(self.checkpoint_path)
        # get_action_array's output is invariant to player_colors tuple order
        # (verified: it depends only on the set of 4 colors present, not their
        # order), so the actual seating order in `game.state.colors` is safe
        # to use here even though it differs episode-to-episode.
        player_colors = tuple(game.state.colors)

        obs = self._encoder.encode(game, self.color)
        mask = np.zeros(model.action_space.n, dtype=bool)
        valid_indices = [to_action_space(a, player_colors, self.map_type) for a in playable_actions]
        mask[valid_indices] = True

        action_int, _ = model.predict(obs, action_masks=mask, deterministic=False)
        return from_action_space(int(action_int), self.color, player_colors, self.map_type)


class OpponentPool:
    """Samples 3 enemy PPOPlayers per episode from a checkpoint directory.
    Globs CheckpointCallback's own naming (`ppo_catan_*_steps.zip`) -- the
    periodic checkpoints training already produces *are* the pool, no
    separate snapshot mechanism. `seed_checkpoints` are always included
    (e.g. checkpoints_bc/bc_model.zip) so the pool has >=1 member before the
    first CheckpointCallback save fires."""

    def __init__(self, pool_dir, seed_checkpoints=(), colors=(), map_type="BASE", rng=None):
        self.pool_dir = pool_dir
        self.seed_checkpoints = list(seed_checkpoints)
        self.colors = list(colors)
        self.map_type = map_type
        self.rng = rng or np.random.default_rng()

    def _candidates(self):
        pattern = os.path.join(self.pool_dir, "ppo_catan_*_steps.zip")
        return sorted(glob.glob(pattern)) + [p for p in self.seed_checkpoints if os.path.exists(p)]

    def sample(self, n):
        candidates = self._candidates()
        assert candidates, f"opponent pool empty: no checkpoints in {self.pool_dir!r} and no existing seed_checkpoints {self.seed_checkpoints!r}"
        chosen = self.rng.choice(candidates, size=n, replace=True)
        return [
            PPOPlayer(color, path, map_type=self.map_type)
            for color, path in zip(self.colors, chosen)
        ]


class SelfPlayCatanEnv(FastCatanatronEnv):
    """Resamples the 3 enemies from an OpponentPool on every reset(), instead
    of the static enemies list FastCatanatronEnv normally takes."""

    def __init__(self, config=None):
        config = dict(config or {})
        self.pool = config.pop("pool")  # set before super().__init__(), which calls self.reset()
        super().__init__({**config, "enemies": self.pool.sample(3)})

    def reset(self, seed=None, options=None):
        self.enemies = self.pool.sample(3)
        self.players = [self.p0] + self.enemies
        return super().reset(seed=seed, options=options)
