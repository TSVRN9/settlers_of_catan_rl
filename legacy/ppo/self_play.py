"""M3: self-play opponent pool. See docs/HANDOFF.md (M3 gate: >50% vs
3x ValueFunctionPlayer) and the M3 plan's Context in docs/FINDINGS.md.

`PPOPlayer` wraps a loaded `MaskablePPO` checkpoint as a `catanatron.Player`,
so past/current training snapshots can serve as enemies. `OpponentPool`
samples 3 such players per episode from a checkpoint directory (reusing
`CheckpointCallback`'s own naming -- no separate snapshot mechanism).
`SelfPlayCatanEnv` resamples enemies on every `reset()`.

Per docs/FINDINGS.md's 2026-09-01 "IPC bottleneck: contention, not pickling"
finding, `PPOPlayer.decide()` runs inference locally (batch-1, in-process)
rather than through any shared inference server -- there's no
transport-level win available at this concurrency level, and self-play's
heterogeneous per-seat checkpoints would need multi-model batched serving
on top of that anyway.

Local batch-1 inference still needs to be cheap, though: profiling found
`MaskablePPO.predict()`'s high-level API (obs_to_tensor's vectorized-input
checks, `MaskableCategoricalDistribution` object construction, etc.) costs
~2555us/call, ~23x FINDINGS.md's recorded raw batch-1 forward-pass cost
(45.5us) -- multiplied by 3 enemies per env and run inside SubprocVecEnv
workers that are themselves competing for CPU (see the IPC finding), this
alone collapsed a real training run's fps from M2's 2048 baseline to ~10.
`decide()` below instead calls the policy's forward path directly
(`extract_features` -> `mlp_extractor.forward_actor` -> `action_net`,
masked and sampled by hand) -- measured at ~151us/call, ~17x faster,
same loaded weights, same distribution (categorical over masked logits),
just without SB3's per-call API overhead. `torch.set_num_threads(1)` is
also set once per worker process: FINDINGS.md found this a net *regression*
for the main process's large-batch backprop, but that finding doesn't
transfer here -- many small batch-1 forward passes inside a process that's
one of 7 already competing for 8 hardware threads is a different regime,
where per-call thread-pool spin-up is pure overhead.
"""

import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))  # legacy/: import the flat root modules
import glob
import os

import numpy as np
import torch
from catanatron.gym.envs.action_space import from_action_space, to_action_space
from catanatron.models.player import Player
from sb3_contrib import MaskablePPO

from catan_env import Encoder, FastCatanatronEnv

_MODEL_CACHE = {}
_MODEL_CACHE_MAXSIZE = 8
_threads_capped = False


def _load_model(path):
    """Module-level cache shared by every PPOPlayer in this process --
    avoids reloading an ~18MB checkpoint from disk on every episode reset."""
    global _threads_capped
    if not _threads_capped:
        torch.set_num_threads(1)  # see module docstring: worker-process batch-1 inference, not backprop
        _threads_capped = True
    if path not in _MODEL_CACHE:
        if len(_MODEL_CACHE) >= _MODEL_CACHE_MAXSIZE:
            _MODEL_CACHE.pop(next(iter(_MODEL_CACHE)))
        _MODEL_CACHE[path] = MaskablePPO.load(path, device="cpu")
    return _MODEL_CACHE[path]


def _lean_predict(model, obs, mask, rng):
    """Same distribution as model.predict(obs, action_masks=mask,
    deterministic=False) -- masked categorical over the policy's logits --
    computed via the policy's forward submodules directly instead of SB3's
    predict()/get_distribution() API. See module docstring for why."""
    with torch.no_grad():
        obs_t = torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0)
        features = model.policy.extract_features(obs_t)
        pi_features = features[0] if isinstance(features, tuple) else features
        latent_pi = model.policy.mlp_extractor.forward_actor(pi_features)
        logits = model.policy.action_net(latent_pi)
        logits = logits.masked_fill(~torch.as_tensor(mask).unsqueeze(0), -1e9)
        probs = torch.softmax(logits, dim=1).numpy()[0]
    return int(rng.choice(len(probs), p=probs))


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
        self._rng = np.random.default_rng()

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

        action_int = _lean_predict(model, obs, mask, self._rng)
        return from_action_space(action_int, self.color, player_colors, self.map_type)


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
