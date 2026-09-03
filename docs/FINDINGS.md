# Measured findings — 2026-08-31 (updated same day, performance power profile)

> **Every M2 win rate below (71.5% / 76.0% / 75.5% / 65.0%) was measured with a
> non-reproducible evaluator and is superseded.** See
> [2026-09-01 — the evaluator was broken](#2026-09-01--the-evaluator-was-broken-the-m2-numbers-above-are-unreliable)
> at the end of this file for the root cause, the fix, and the real
> 1000-games-per-point learning curve. Performance numbers are unaffected.

Everything here was **measured on this machine**. Do not re-derive it; re-run
`bench/` only if you change hardware, driver, Catanatron version, **or power profile**.

Hardware: Intel Core Ultra 7 258V (Lunar Lake), 8 cores / 8 threads, 2.2 GHz base,
Arc 140V iGPU (Xe2), 30 GB LPDDR5X shared. Kernel driver `xe`. Fedora 44.
Software: Python 3.12.14, torch 2.13.0+xpu, catanatron from git @ main, gymnasium 0.29.1.

**Power profile matters.** All CPU-side numbers below were re-measured after switching
`powerprofilesctl` from `power-saver` to `performance` — a broad **~3x** speedup across
the board (engine step, obs encoder, AlphaBeta, CPU inference). The original `power-saver`
numbers are kept alongside as `(was: ...)` since the ±3x thermal-noise caveat already
covered CPU figures; this is that same axis, just identified. Train/deploy under
`performance` profile — `powerprofilesctl set performance` — or these numbers don't hold.

## Performance baseline

| What | Measured | Implication |
|---|---|---|
| Rules engine step, 4p | **17 µs** (58,672 decisions/s/core) (was: 52 µs / 19,092/s) | engine is fast enough |
| `create_sample_vector`, 4p (1002 feats) | **77 µs** (12,947/s) (was: 239 µs / 4,190/s) | **still ~80% of step cost — THE bottleneck** |
| `catanatron_gym` 4p, end to end | not re-measured this run (bench2 only covers 2p) — was 1,753 agent-steps/s/core | obs `(1002,)`, `Discrete(370)` |
| `catanatron_gym` 2p, end to end | **10,239** agent-steps/s/core (was: 3,425) | obs `(614,)`, `Discrete(332)` — **not our config** |
| `Game.copy()` | 26 µs (was: 81 µs, and 27 µs on a second power-saver run) | test-time MCTS is affordable |
| Branching factor, all decisions | mean 4.1, **median 1**, max 54 | most decisions are forced |
| Non-forced decisions | **43%** (17,386 / 40,401 over 40 games) | 57% need no policy call |
| Decisions per game | 1,010 raw → **435 policy calls** | encode+query only when >1 action |
| Turns per game | ~340 | |

### Neural net (614→512→512→512→332 MLP, samples/s)

**Caveat:** measured at *2-player* dims. The real net is 1002→512³→370, ~24% more FLOPs,
so expect somewhat below these figures. Compare real throughput against that, not this table.

| Batch | CPU inference | XPU inference | CPU train | XPU train |
|---|---|---|---|---|
| 1 | **21,994** (45 µs) | 10,964 (91 µs) | — | — |
| 32 | 114,721 | 330,799 | — | — |
| 256 | 192,493 | 952,452 | 38,520 | 242,446 |
| 2048 | 230,132 | **1,615,413** | 72,282 | **496,420** |
| 8192 | — | — | 78,518 | 489,858 |

(was, under power-saver: batch1 cpu=2,416/414µs xpu=4,089/245µs; batch32 cpu=18,342
xpu=147,827; batch256 cpu=23,019 xpu=1,124,810 train-cpu=14,731 train-xpu=48,418; batch2048
cpu=68,438 xpu=1,292,048 train-cpu=30,626 train-xpu=431,719.)

**CPU figures are thermally noisy on this laptop** — batch-1 CPU inference has now measured
2,416/s, 7,279/s, and 21,994/s across three runs (power-saver x2, performance x1). Treat CPU
numbers as ±3x *within* a power profile, and expect roughly another 3x on top of that from
`power-saver` → `performance`. XPU also moved (245µs → 91µs at batch 1), so the power profile
affects the iGPU path too, not just CPU — don't assume XPU is profile-independent.
**CPU batch-1 (21,994/s) again beats XPU batch-1 (10,964/s)** — under both profiles now, so
treat that as the rule, not a fluke: never call the policy at batch 1.

XPU is **7x** on inference and **6.9x** on training at batch 2048 under `performance` — down
from 19x/14x under `power-saver`, because CPU improved much more than XPU did when switching
profiles. **Still only at large batch.** SGD on XPU hit 534,032/s @ 2048 under power-saver if
Adam ever proves unstable (not re-measured this run).

**New this run — single-thread CPU inference** (the per-worker-process realistic number,
`OMP_NUM_THREADS=1`): batch 1 = 10,235/s (98 µs), batch 32 = 54,182/s, batch 256 = 63,222/s.
Relevant for `inference_server.py` sizing: a worker process doing its own CPU fallback
inference is far below the multi-threaded numbers above.

### Baseline bots (4-player, seconds per game)

| Bot | s/game | Use |
|---|---|---|
| `RandomPlayer` x4 | 0.017 (58 games/s) (was: 0.06) | throughput baseline |
| `WeightedRandomPlayer` x4 | 0.014 (72 games/s) (was: 0.04 / 24 games/s) | M2 target |
| `ValueFunctionPlayer` x4 | 0.44 (was: 1.26) | **frequent regression check** |
| `AlphaBetaPlayer` x4 | 9.83 (was: 31.9) | **M4 gate only** — ~18 min per 1000 games on 7 cores now |
| 1x AlphaBeta vs 3x Random | 1.40 (was: 4.16) | not a valid proxy for the real eval |

All ~3x faster under `performance`. The M4 gate estimate in `docs/HANDOFF.md` (~1h/1000
games) is now stale — closer to ~20 min/1000 games on 7 cores.

## Conclusions that shaped the design

**Re-measured under `performance` profile: both conclusions still hold.** CPU-side
throughput and XPU throughput both moved by roughly the same factor, so the
simulation-bound verdict and the obs-encoder priority are unchanged — only the absolute
numbers moved.

1. **We are simulation-bound.** The iGPU supplies ~45x more inference than the env can
   consume. Effort belongs in CPU-side observation encoding, not model scale.
2. **The obs encoder is the single highest-value optimization.** Still ~80% of the step
   cost (77 µs of ~94 µs step+encode under `performance`, was 239 of ~292 µs). `cProfile`
   shows the same shape: flat Python list-building in `create_sample_vector`'s own body,
   plus `enum.__hash__` and `Counter.update` calls. A numpy/incremental rewrite has real
   headroom — but treat the speedup as a gate to measure, not a number to predict.
3. **Forced-decision skipping is free throughput.** 57% of decisions have exactly one
   legal action. Skip the encode and policy call on those — but the engine still advances
   them, and they must not enter the PPO buffer as transitions.
4. **Batching is load-bearing and must be built early.** See the batch-1 row above.

## M1 measurements — 2026-08-31

Measured by `bench_env.py`, encoder ratio and env step rates interleaved in the
same run/process (not compared against the numbers above) — `powerprofilesctl`
isn't on PATH in this shell, so the absolute baseline numbers above can't be
confirmed as still being under `performance`. Ratios survive that; absolute
µs don't, so treat the ones below as consistent with each other, not
necessarily with the table above.

| What | Measured |
|---|---|
| `create_sample_vector` (interleaved baseline) | 77.8 µs/call |
| `Encoder.encode` (`catan_env.py`) | 17.8 µs/call |
| Ratio | **4.38x** — clears the ≥3x gate |
| `CatanatronEnv` (stock) step rate, 4p, 1 core | 5,774 steps/s (every decision, incl. forced) |
| `FastCatanatronEnv` step rate, 4p, 1 core | 4,524 steps/s (**real decisions only** — forced ones are skipped inside `step()`, never returned as a transition) |

**The step-rate row is not an apples-to-apples regression** despite being a
smaller number: each `FastCatanatronEnv.step()` call internally advances
through however many forced engine ticks separate two real BLUE decisions
(HANDOFF.md's ~1010→435 raw-to-real ratio), so it does more underlying engine
work per call. Converting to games/s using that same 1010/435 ratio: stock
env ≈ 5774/1010 ≈ 5.7 games/s; fast env ≈ 4524/435 ≈ 10.4 games/s — **~1.8x
more real (policy-requiring) decisions per core-second**, which is the number
that actually matters for inference-server load and RL sample throughput.

`test_env.py` passes all four invariants: encoder matches `create_sample_vector`
feature-for-feature on 144 sampled states across 6 random games; encoder never
returns an aliased array; opponent hand identity is provably not leaked (a
count-preserving resource swap moves neither encoder's output; an actual card
loss moves only the aggregate `NUM_RESOURCES_IN_HAND` feature, in both the
fast encoder and the reference — the positive control that the field is live);
mask matches `playable_actions` by set and by count across 451 real decisions,
and every one of those decisions had >1 legal action (forced-decision skip
never surfaces a 1-option decision to the policy).

### Inference server (`inference_server.py`) — batch target not reached, and why it doesn't matter

Measured with an untrained net (this is a pipeline-throughput measurement, not
a training run), `--device xpu`, tuning `games-per-worker` upward at 7 workers:

| workers × games/worker | in-flight | decisions/s (aggregate) | mean batch | max batch seen |
|---|---|---|---|---|
| 7 × 37 | 259 | 6,503 | 41.0 | 256 |
| 7 × 80 | 560 | **7,519 (best)** | **47.9 (best)** | 256 |
| 7 × 150 | 1,050 | 7,126 | 46.9 | 256 |

**Mean batch plateaus around ~41–48 and does not reach 256** — HANDOFF.md's
pre-authorized outcome ("report the number rather than proceeding"), so this
is that report, not a blocker. Scaling in-flight games 4x (259→1,050) barely
moved mean batch (41→47) and 150 games/worker is slightly *worse* than 80 —
ruling out "not enough concurrent games" as the cause.

**Root cause: per-decision IPC, not concurrency.** A worker's main loop is
one blocking `reply_queue.get()` → step one game → `request_queue.put()` →
loop; each of those queue calls pickles a 1002-float obs + a 370-bool mask
across a process boundary. Per-worker achieved rate is ~1,000-1,100
decisions/s here, vs. **4,524 steps/s single-process** in `bench_env.py`
(no IPC) — roughly a 4-5x tax from queue serialization, which is what
actually caps how many requests are simultaneously in flight, not the
games-per-worker knob.

**This does not bottleneck training.** XPU inference at batch 32 alone
measures 330,799/s (see table above) — far above the ~7,500 decisions/s this
pipeline generates even at its best measured config. The engine/env remains
the bottleneck (consistent with "we are simulation-bound"); the batching
design just doesn't need to hit 256 to keep up. **M2+ budget: ~7,500
decisions/s aggregate on 7 workers, XPU batch 256 unreached (~40-48
achieved).**

**Caught and fixed during this work:** `Encoder` originally cached its
per-game static tile/port template on a module-level singleton (`LAYOUT`).
That's wrong the moment a process holds more than one `Encoder` on different
random maps at once -- exactly `inference_server.py`'s worker pattern
(several games per worker, interleaved) -- one game's map refresh silently
overwrote another's tile/port features. Fixed by moving the template to be
per-`Encoder`-instance; `test_env.py`'s
`test_interleaved_encoders_do_not_cross_contaminate` reproduces it (confirmed
it fails on the old code, passes on the fix) and guards the regression.
`train.py`'s `SubprocVecEnv` (one env per process) was never exposed to this,
so the numbers already in this file are unaffected.

This is RUST-ENGINE.md's trigger #2 ("M1's inference server can't reach
batch ≥256"), now empirically confirmed rather than hypothetical — re-read
that memo before deciding whether to act on it; a from-scratch Rust rewrite
is out of scope for this session. If reopened, replacing the pickled
queue-per-decision protocol with shared-memory numpy buffers (workers write
obs/mask into a preallocated slot, server reads slices directly) would
attack the actual measured cause here without a rewrite.

> **2026-09-01 correction**: measured directly (see "IPC bottleneck:
> contention, not pickling" below) — the shared-memory fix proposed here
> does **not** help. The bottleneck isn't serialization cost, it's process/
> CPU contention across 8 concurrent processes on this 8-thread machine.
> Don't build the shared-memory version on the strength of this paragraph.

## M2 measurements — 2026-08-31

`train.py` (`MaskablePPO`, 3x512 MLP, `Adam(foreach=False)`, CPU device,
`SubprocVecEnv` with `n_envs=7`) vs 3x `WeightedRandomPlayer`. **Note the
architecture split from M1: `train.py` uses SB3's own `SubprocVecEnv`
(1 game per subprocess, synchronous, batch=n_envs≈7 at each policy call),
not `inference_server.py`'s async many-games-per-worker pipeline.**
HANDOFF.md specifies MaskablePPO + ActionMasker for M2 and never says M2 must
consume the M1 server, so this is a defensible scope reading, but the two
paths are not wired together — anyone routing training through the batched
server for throughput still has that integration to do.

**Gate result: 71.5% win rate (143/200), Wilson 95% CI [64.9%, 77.3%], at
500K timesteps — gate is >90%, not met.**

```
uv run python evaluate.py --model checkpoints_500k/model_500k_gate_71pct.zip --opponent weighted_random --games 200
143/200 wins = 71.5%  Wilson 95% CI [64.9%, 77.3%]  vs weighted_random
```

This is a **reported gate failure per HANDOFF.md's own ground rule 6** ("if a
gate fails twice, stop and report with the numbers"), not an abandoned task.
The rolling training success rate climbed 0.09 → ~0.75 over the 500K steps
and was **still rising, not plateaued**, at cutoff — the signal is that more
training helps, not that the approach is wrong. A continuation run was
attempted (`--resume-from checkpoints_500k/model_500k_gate_71pct.zip`, wired
and tested — `MaskablePPO.load(..., env=env)` +
`learn(reset_num_timesteps=False)`) but was killed by the host three times in
a row (once after 10s, once after 38s, once with zero output) while system
memory was at 22/30Gi used and **swap fully exhausted (8.0/8.0Gi)** — this
machine also runs a QEMU VM, another Claude session, and a full browser
session outside this project. This is a host resource limit at the time of
this session, not a training-loop or hyperparameter failure. **Next step is
simply to resume training with more timesteps on a quieter machine/session**;
the checkpoint and the `--resume-from` flag are in place for that.

**One number worth flagging for whoever resumes:** `approx_kl` climbed
0.09 → 0.42 over the run (SB3 default `target_kl=None`, so no early
stopping), with `clip_fraction` sitting around ~0.46-0.6 throughout. Win rate
kept rising anyway, so this wasn't fatal here — but it's abnormally high for
PPO (typical healthy range is closer to 0.01-0.03) and is the first thing to
check if a resumed run plateaus or the win rate collapses rather than
climbing further. Not speculatively retuned in this session since the metric
that matters (win rate) was still moving in the right direction.

**M3 (self-play pool) and M4 (beat AlphaBeta) were not attempted.** Per this
file's own numbers they are multi-day training outcomes (settlers-rl: ~1
month on 32 cores + an RTX 3090 for a stronger setup), not session-scoped
work.

### CPU thread-pool investigation — 2026-08-31, no throughput win

While a continuation run was in progress, `htop`/`ps` showed the main
`train.py` process alone consuming ~753% CPU (7-8 cores) while all 7
`SubprocVecEnv` worker subprocesses sat at ~3% each — backwards from what
"simulation-bound" would predict. Cause: torch's CPU backend defaults to an
intra-op thread pool spanning every core (no `OMP_NUM_THREADS` or
`torch.set_num_threads()` set anywhere), so even the tiny batch-7 policy
forward pass and small-MLP gradient updates were fanning out across all 8
cores.

**Fix applied:** `torch.set_num_threads(1)` added to `train.py`'s `main()`.
Tested by killing the run and resuming from the latest autosave
(`ppo_catan_1101730_steps.zip`) with the fix in place.

**Result: CPU waste went away, but throughput did not improve.** Main
process dropped from ~753% to ~93% of one core; fps went from ~512-515 to
~459 — flat to slightly worse, not faster. So the thread-pool contention,
while real and now fixed, **was not the actual training bottleneck** — the
workers were never CPU-starved, they were idle waiting on the pipe back from
the main process either way. The true limiter is the main process's own
single-threaded per-step work in `SubprocVecEnv.step_wait()` (sequential
send/recv + unpickle across 7 pipes, policy forward pass, mask application,
rollout-buffer writes, all serial Python on one core) — the same category of
IPC/serialization tax already measured and documented above for
`inference_server.py`'s queue-based pipeline, just showing up here in a
different transport (pipes, not `multiprocessing.Queue`).

**Correction, same session:** `torch.set_num_threads(1)` was reverted after
further measurement showed it was a net *regression*, not neutral. Comparing
true instantaneous per-iteration fps (not SB3's logged `fps`, which is a
cumulative average since `learn()` start and stays inflated by the first
iteration's burst for a while) across three configurations:

| Config | Steady-state fps |
|---|---|
| Original, no fixes | ~512-515 |
| + `torch.set_num_threads(1)` | ~250-276 |
| + `torch.set_num_threads(1)` + `CachedMaskVecEnv` (below) | ~250-281 |

Both thread-limited runs sat at roughly **half** the untouched baseline. An
isolated micro-benchmark of just the PPO gradient-update phase (dummy
14,336-sample buffer, 10 epochs, batch 64) had suggested 1 thread was ~5x
*faster* for that phase — but that benchmark ran concurrently with the live
training job, so its 8-thread arm was itself contended for cores against an
already-busy process, making 1-thread look artificially better. In the real
uncontended pipeline, the backprop phase is genuine matrix-multiply work
that benefits from spreading across the cores the simulation workers barely
touch (they sit at ~3-5% CPU each); forcing the whole process to one thread
denies it that the entire run, and that loss outweighed the earlier
rollout-inference thread-contention win. **Net: reverted.** `train.py` no
longer calls `torch.set_num_threads(1)`.

**Confirmed after reverting:** resumed again from `ppo_catan_1701700_steps.zip`
with the thread-limit removed and `CachedMaskVecEnv` kept. True instantaneous
per-iteration fps over the next 15 iterations averaged **~528 fps** (range
478-551) — back at, and modestly above, the untouched-baseline ~512-515, and
roughly 2x the ~250-280 both thread-limited configs sat at. `CachedMaskVecEnv`'s
contribution to the full pipeline is real but small (a few percent) rather
than its isolated 1.41x, because the IPC round trip it removes is a small
slice of total iteration time once the PPO gradient-update phase (which
dominates wall time) is included — that phase is untouched by the mask-fetch
fix either way.

### `SubprocVecEnv` IPC fix — `CachedMaskVecEnv`, measured 1.41x — 2026-08-31

Root cause of the actual bottleneck: `sb3_contrib.get_action_masks(env)`
unconditionally calls `env.env_method("action_masks")` for a `VecEnv` every
rollout step (`sb3_contrib/common/maskable/utils.py`), *in addition to* the
`step()` call — two full sequential IPC round trips per timestep through
`SubprocVecEnv`'s pipes, not one. `action_masks()` itself is cheap local
state (`CatanatronEnv.action_masks()` just reshapes `get_valid_actions()`
into a bool array) — the cost is entirely the pipe round trip, and
`step()`/`reset()` already ship `info["valid_actions"]` back for free, so the
second round trip is pure waste.

**Fix:** `CachedMaskVecEnv` (`catan_env.py`), a thin `VecEnvWrapper` that
answers `env_method("action_masks")` from the mask it derives out of the
`info["valid_actions"]` already returned by the last `step()`/`reset()`,
instead of forwarding the call to the subprocess workers. No change to
`sb3_contrib` itself. `train.py` now wraps `SubprocVecEnv` in it.

Verified two ways before touching the live training run:
- **Correctness:** `test_env.py::test_cached_mask_matches_env_method` — masks
  from `CachedMaskVecEnv` compared byte-for-byte against ground-truth
  `env_method("action_masks")` on the raw `SubprocVecEnv`, across 3 envs x 25
  steps plus immediately after reset. Passes.
- **Throughput:** `bench_env.py::bench_vecenv_ipc` — old path (env_method +
  step, matching `train.py`'s actual rollout shape) vs new path
  (`CachedMaskVecEnv`, step only), both at `n_envs=7`, run concurrently with
  a live training job on this 8-core box (i.e. under realistic contention,
  not a clean isolated measurement):
  ```
  SubprocVecEnv + sb3_contrib default (2 IPC round trips/step): 3548 steps/s
  SubprocVecEnv + CachedMaskVecEnv     (1 IPC round trip/step): 5006 steps/s
  speedup: 1.41x
  ```

Applied to the live continuation run afterward (killed and resumed from
`ppo_catan_1301720_steps.zip`, 1,301,720 cumulative steps, with the fix in
place) — see the training log for the resulting in-training fps once it
stabilizes past warmup.

**Unlike the thread-pool attempt, this is a training-speed fix**, targeted
at the actual measured cause (2x IPC round trips) and validated empirically
before being applied to a live run, not from an untested hypothesis.

### M2 gate re-check at 2M timesteps — 2026-08-31

Training (resumed across the checkpoints above, ending with the
`torch.set_num_threads(1)` revert + `CachedMaskVecEnv` config) ran to
2,002,756 cumulative timesteps and `final_model.zip` was saved.

**Gate result: 76.0% win rate (152/200), Wilson 95% CI [69.6%, 81.4%], at
~2M timesteps — gate is >90%, still not met.**

```
uv run python evaluate.py --model checkpoints/final_model.zip --opponent weighted_random --games 200
152/200 wins = 76.0%  Wilson 95% CI [69.6%, 81.4%]  vs weighted_random
```

This is a **second reported gate failure per HANDOFF.md's ground rule 6**
("if a gate fails twice, stop and report with the numbers, don't keep tuning
blindly") — 71.5% at 500K → 76.0% at ~2M is only +4.5 points over roughly 3x
the training, a much shallower climb than the 0.09→0.75 rise seen over the
first 500K. Rollout `success_rate` in the logs also plateaued in the
0.75-0.83 band across the last ~1.5M steps rather than continuing upward.

**The `approx_kl`/`clip_fraction` anomaly flagged earlier never resolved and
is the leading suspect.** It sat at 0.39-0.46 (`clip_fraction` ~0.37-0.42)
across every logged iteration this entire session, start to finish, with SB3's
default `target_kl=None` (no early stopping within an epoch). Healthy PPO
is usually ≤0.03. Sustained values this high mean the policy is being pushed
well past PPO's intended trust region on every single gradient update — a
plausible mechanism for exactly this symptom (fast initial improvement, then
a plateau despite continued training): the policy may be oscillating/
overshooting rather than making steady monotonic progress once it's past
the easy early gains. **Not retuned this session** (per the same
don't-tune-blindly rule, and because doing so now would mean a 4th restart
chasing another hypothesis without independent verification first) — the
concrete next step for whoever continues this is to set `target_kl`
(e.g. 0.03-0.05) and/or lower the learning rate or `n_epochs`, watch whether
`approx_kl` actually comes down, and only then judge whether win rate
resumes climbing.

**M3 (self-play) and M4 (beat AlphaBeta) remain not attempted**, per the
existing multi-day-training-outcome framing above.

### `target_kl` fix — confirmed working — 2026-08-31

`--target-kl` wired into `train.py` (passed to `MaskablePPO`'s native
`target_kl` param, which early-stops an epoch's minibatch updates once
`approx_kl > 1.5 * target_kl`). Resumed from `final_model.zip` (2,002,756
steps) with `--target-kl 0.03`.

**Confirmed by the log within the first ~35 iterations:**

| Metric | Every prior run this session | With `target_kl=0.03` |
|---|---|---|
| `approx_kl` | 0.39-0.46 | 0.009-0.014 |
| `clip_fraction` | 0.37-0.42 | 0.065-0.083 |
| fps | ~250-530 | ~2050 |

Every iteration now logs `Early stopping at step 0 due to reaching max kl:
0.05` — PPO is correctly cutting an epoch short instead of grinding through
all `n_epochs=10` well past its trust region, which is exactly the mechanism
suspected earlier. The fps jump is a direct consequence: far fewer gradient
epochs per iteration means much less wall-clock in the training phase per
rollout, independent of the `CachedMaskVecEnv`/thread-limit work above.
`success_rate` was still ~0.74-0.83 at this point, too early in the resumed
run to show a trend — win-rate gate re-check pending completion.

**Gate re-check after completion (3,006,276 cumulative timesteps):**

```
uv run python evaluate.py --model checkpoints/final_model.zip --opponent weighted_random --games 200
151/200 wins = 75.5%  Wilson 95% CI [69.1%, 80.9%]  vs weighted_random
```

**75.5% vs the pre-fix 76.0% — no improvement, well within noise (the two
Wilson CIs almost fully overlap).** `success_rate` across the full 1M-step
run stayed noisy in the 0.71-0.88 band with no visible upward trend, same as
before the fix.

**Conclusion: the `approx_kl` anomaly was real and worth fixing (healthy PPO
hygiene, and it could bite harder on a future run or a different opponent
mix), but it was not the cause of the win-rate plateau.** The plateau
around ~75-76% looks like a genuine ceiling for the current setup — net
architecture, reward shaping, or exploration (`entropy_loss` sat around
-0.25 to -0.4 during the fixed run, i.e. the policy is already fairly close
to deterministic, leaving little room for further on-policy exploration) —
rather than an optimization pathology. **Third reported gate miss at >90%
in a row** (71.5% → 76.0% → 75.5%); per HANDOFF.md's ground rule, further
blind tuning is not warranted without a different lever than "train longer"
or "fix the optimizer." Candidates for whoever picks this up next: richer
reward shaping, a bigger/different net (contradicts the "simulation-bound"
framing for training speed but may matter for representational capacity
at this plateau), or an entropy bonus increase to counter the low-entropy
policy. Not attempted this session.

## Environment gotchas

- **`intel-compute-runtime` is required** for `torch.xpu` to see the iGPU. Without it
  `torch.xpu.is_available()` is `False` and you get `XPU device count is zero!`, even
  though `oneapi-level-zero` and `/dev/dri/renderD128` are present — the level-zero
  *loader* and the *NPU* backend (`libze_intel_npu.so`) install separately from the GPU
  compute driver. Fix: `sudo dnf install intel-compute-runtime intel-level-zero`.
- **`torch.optim.Adam` with default `foreach=True` crashes XPU** —
  `UR_RESULT_ERROR_DEVICE_LOST` (a GPU reset; subsequent calls then report
  `OUT_OF_DEVICE_MEMORY` because the device is already dead). Reproduced at batch 256 and
  2048. `Adam(foreach=False)` and `SGD` are both fine. Isolated in `bench/bench5.py`.
- XPU stability over long runs is **unproven** (50 iterations ≠ 10 hours). Checkpoint
  frequently, keep a `--device cpu` fallback. Not a project risk: CPU training already
  does 30k samples/s and we only need ~6k.
- Catanatron's **PyPI release is stale** (3.2.1, Jul 2022, `requires_python >=3.6`).
  The live project is on GitHub (Python ≥3.11). Install from git.
- **Python 3.14 (system default here) does not resolve `torch+xpu`.** Pin 3.12.
- **`uv`'s `[tool.uv.sources]` index override does not reach transitive deps that aren't
  also listed in `[project.dependencies]`.** `torch==2.13.0+xpu` depends on
  `triton-xpu==3.7.2`; pointing `torch` at the `pytorch-xpu` index (via `explicit = true`
  + `tool.uv.sources`) is not enough — uv still resolves `triton-xpu` against PyPI (where
  it doesn't exist as that name) unless `triton-xpu` is *also* a direct dependency with its
  own `tool.uv.sources` entry. Fix: add both `torch==2.13.0+xpu` and `triton-xpu==3.7.2` as
  explicit pinned dependencies, each mapped to the `pytorch-xpu` index.
- **CPU-side numbers depend heavily on `powerprofilesctl` power profile**, not just thermal
  noise within a profile. `power-saver` → `performance` was a further ~3x on top of the
  already-documented ±3x within-profile thermal spread. Always train/benchmark under
  `performance` (`powerprofilesctl set performance`) and check `powerprofilesctl get`
  before trusting a number.

## Catanatron API notes (saves rediscovery)

```python
from catanatron import Game, RandomPlayer, Color        # Color.RED/BLUE/WHITE/ORANGE
from catanatron.players.weighted_random import WeightedRandomPlayer
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.minimax import AlphaBetaPlayer
from catanatron.features import create_sample_vector, get_feature_ordering
import catanatron.gym          # REQUIRED to register the gymnasium namespace
```

- `game.playable_actions` — on **`Game`**, not `State`. Cached per tick (~14M/s on a hit),
  so don't use it to time enumeration.
- `game.state.action_records` — the action log. There is **no** `state.actions`.
- `game.state.num_turns`, `game.winning_color()`, `game.play()`, `game.play_tick()`,
  `game.copy()`, `game.execute(action)`.
- Useful `State` attrs: `board`, `player_state`, `buildings_by_color`, `current_color`,
  `current_prompt`, `resource_freqdeck`, `development_listdeck`, `is_initial_build_phase`,
  `is_discarding`, `is_moving_knight`, `is_road_building`, `is_resolving_trade`.
- `gymnasium.make("catanatron/Catanatron-v0", config={"enemies": [...], "map_type": ...,
  "vps_to_win": ..., "reward_function": ..., "representation": ...})`
- The env **asserts enemies do not use `Color.BLUE`** — BLUE is the learning agent.
  A 4-player config passes three enemies coloured RED/WHITE/ORANGE.
- `info["valid_actions"]` is the list of legal action indices for masking.
- `get_feature_ordering(4)` → 1002 features; `get_feature_ordering(2)` → 614.

## Engine internals (measured 2026-08-31, for the Rust question)

`cProfile` over 25 full 4-player random games, sorted by `tottime`:

| Function | Share | Note |
|---|---|---|
| `generate_playable_actions` | ~47% cumulative | the bulk of a step |
| `longest_acyclic_path` (board.py:355) | ~18% cumulative | largest single entry |
| `player_key` | 518,215 calls / 25 games (was: 501,950) | ~21 per decision |
| `enum.__hash__` | 713,351 calls / 25 games (was: 693,493) | ~29 per decision |

Call counts are unchanged (same algorithm, same games) — only wall-clock moved with the
power profile. Re-measured under `performance`, the engine step is 17 µs, was 52 µs.

**There is no single hot spot to optimize.** The engine is diffuse Python
interpreter overhead — enum hashing and string-keyed dict lookups — not one slow
algorithm. `longest_acyclic_path` uses `path_thus_far + [edge]` and `edge not in
path_thus_far` (list allocation + O(n) scan per DFS branch); an `int`-bitset rewrite over
72 edges would help modestly but does not change the picture.

### Engine size (port surface)

| File | LOC |
|---|---|
| `apply_action.py` | 604 |
| `models/map.py` | 542 |
| `models/board.py` | 385 |
| `state_functions.py` | 354 |
| `models/actions.py` | 340 |
| `game.py` | 228 |
| `state.py` | 197 |
| `models/` others | ~433 |
| **rules total** | **~3,300** |
| `features.py` (encoder — replaced anyway) | 543 |
| `players/` (baselines — stay in Python) | 966 |

`networkx` use in the engine is shallow: a static board graph, `floyd_warshall` over a
constant, and connected-components. `NUM_NODES=54`, `NUM_EDGES=72`, 19 tiles — the whole
topology is fixed and precomputable.

### The replay oracle — verified

**`ActionRecord.result` records every stochastic outcome.** Confirmed by inspection:

| Action | `result` |
|---|---|
| `ROLL` | `(3, 5)` — the dice |
| `BUY_DEVELOPMENT_CARD` | `'KNIGHT'` — the drawn card |
| `DISCARD_RESOURCE` | `'BRICK'` |
| `MOVE_ROBBER` (with victim) | `'BRICK'` / `'WHEAT'` — **the stolen resource** |

`MOVE_ROBBER` with no victim has `result=None`, which is correct — nothing was drawn.
896 of 1,920 records in one game carried a non-`None` result.

**Consequence:** any reimplementation can replay a Python-generated game deterministically
**without matching Python's RNG**. Generate N random games in Python, replay in the new
engine, assert `playable_actions` and player state match after every action. Unlimited
free conformance tests. This is the single fact that makes a port tractable.

### Search cost (why AlphaZero-style training is gated on this)

Measured across three runs (A, B under `power-saver`; C under `performance`). **These are
subject to the same thermal/power-profile noise as the CPU figures above** — the spread
below is real, not a regression. The verdict is unchanged across the range.

| What | Run A | Run B | Run C (`performance`) |
|---|---|---|---|
| Single `run_playout` | 31.9 ms | 11.2 ms (~613 engine steps) | 9.6 ms |
| `MCTSPlayer(10 sims)` vs 3 random | 40.1 s/game | 20.2 s/game | 13.5 s/game |
| `MCTSPlayer(50 sims)` vs 3 random | 51.2 s/game | 58.4 s/game | 41.4 s/game |
| `Game.copy()` | 81 µs | 27 µs | 26 µs |

Rollout-based MCTS is dead in Python at any useful simulation count — even 10 simulations
costs 13–40 s/game against a ~0.02 s/game random baseline (was 0.06 s/game under
power-saver).

For **AlphaZero** specifically the relevant number is not the rollout but `Game.copy()`:
Catanatron has no make/unmake, so every node expansion needs a full clone. Run C's
projection: 800 sims/move × 26 µs ≈ 21 ms/move × 435 moves ≈ **9 s/game** →
~0.8 games/s on 7 cores → 1M self-play games ≈ **~15 days** — the fast end of the old
9–28 day range, not a new regime. That is the constraint a compiled engine would lift
(a compact Rust state clones in tens of nanoseconds).

### Toolchain / prior art

- `cargo` and `rustc` **1.92.0** already installed. Binding would be PyO3 + maturin.
- **No mature Rust Catan crate exists** — a port would be from scratch.
- Catanatron ships **14 test files + 4 subdirectories** of tests, usable as a spec.

See `docs/RUST-ENGINE.md` for the verdict and the triggers that would change it.

## M2 v2 — entropy bonus + separate pi/vf heads — 2026-08-31

Three consecutive attempts (500K, ~2M, ~3M cumulative timesteps) plateaued at
71.5-76.0% vs `weighted_random`, gate >90%. The `approx_kl` fix confirmed
that wasn't an optimizer-hygiene problem — win rate was flat before and
after fixing it. Two new, evidence-motivated levers, tried together in one
fresh run (architecture changes can't resume from the old checkpoints, so
this isn't separable from a from-scratch cost regardless):

- **`--ent-coef 0.01`**: SB3's PPO default is `ent_coef=0.0` — every prior
  run this session had *zero* entropy bonus. `entropy_loss` sat around
  -0.25 to -0.4 through the ~3M-step run (fairly low relative to the
  max-entropy ceiling for the masked action space), consistent with the
  policy prematurely collapsing toward determinism with nothing pushing back
  against it.
- **`--separate-pi-vf`**: `train.py` previously used one shared
  `net_arch=[512, 512, 512]` trunk for both the policy and value heads (SB3's
  interpretation of a flat list). Actor and critic objectives can conflict
  when forced through the same features; giving each an independent 3x512
  trunk is standard PPO practice for exactly this failure mode. This does
  double network size — flagged against CLAUDE.md's "don't reach for a
  bigger net" rule, but that rule was scoped to *inference throughput*
  (batch-1 cost, simulation-bound argument), not capacity for this plateau,
  and the `target_kl` fix already cut backprop's iteration-time share
  substantially (fewer epochs before early-stopping), leaving headroom.

New run: `checkpoints_v2/` (kept separate from `checkpoints/` so old and new
architectures' checkpoint files never collide), fresh start (no
`--resume-from` — architecture changed, can't load old weights),
`--timesteps 1500000 --target-kl 0.03 --ent-coef 0.01 --separate-pi-vf`,
otherwise identical config (`CachedMaskVecEnv`, no thread limit, `n_envs=7`).
Smoke-tested first (5K steps, 3 envs) to confirm the dict `net_arch` actually
constructs and trains before committing to the full run.

**Progress check at 1,247,232/1,500,000 timesteps:** `success_rate` climbed
0.13 → ~0.6-0.69 and was still rising, not yet plateaued (contrast: the old
shared-trunk/no-entropy-bonus runs had already flattened out by a comparable
point). Climb is slower per-timestep than the original run's 0.09→0.75 in
its first 500K, but still trending up rather than stalled.
`entropy_loss` ≈ -0.56 (vs -0.25 to -0.4 in every prior run), confirming the
entropy bonus is measurably preserving more exploration. `approx_kl` stayed
near the 0.03 target (~0.008-0.02), confirming `target_kl` still works with
the new architecture.

**Final result at 1,505,280 timesteps:** `success_rate` in the rollout logs
climbed 0.13 → ~0.6-0.69 through most of training, then flattened/oscillated
in the 0.57-0.69 band for the last ~25 logged iterations rather than
continuing to rise.

```
uv run python evaluate.py --model checkpoints_v2/final_model.zip --opponent weighted_random --games 200
130/200 wins = 65.0%  Wilson 95% CI [58.2%, 71.3%]  vs weighted_random
```

| Run | Steps | Win rate | Wilson 95% CI |
|---|---|---|---|
| Shared trunk, no ent bonus | 500K | 71.5% | [64.9%, 77.3%] |
| Shared trunk, no ent bonus, unhealthy KL | ~2M | 76.0% | [69.6%, 81.4%] |
| Shared trunk, no ent bonus, `target_kl` fixed | ~3M | 75.5% | [69.1%, 80.9%] |
| **Separate pi/vf, `ent_coef=0.01`** | **1.5M** | **65.0%** | **[58.2%, 71.3%]** |

**Net negative, not a breakthrough.** 65.0% is measurably below every prior
attempt — the CIs barely overlap. This isn't a clean apples-to-apples
comparison (half the step budget of the best prior run, and `success_rate`
was still rising through most of training before flattening near the end,
so more steps might close the gap or surpass it), but as measured, doubling
net capacity + adding exploration pressure made things worse at equal
effort, not better. Plausible reads: the extra entropy is still costing
exploitation efficiency at this step budget (hasn't "paid off" yet), the
separate value head needs more samples to fit well before its extra
capacity helps rather than hurts (higher `value_loss` throughout this run,
0.03-0.04 vs ~0.003 in the original healthy run, is consistent with this),
or the combination is simply the wrong lever for this plateau. **Not
resolved this session** — fourth consecutive gate miss in a row (71.5% →
76.0% → 75.5% → 65.0%), and per HANDOFF.md's rule this is a place to stop
and report, not launch a fifth speculative attempt unchecked. Whoever
continues this should either give this exact config substantially more
steps to see if it catches up, or revert to the shared-trunk architecture
(which has the better track record so far) and try a single isolated lever
at a time (e.g. `ent_coef` alone, without the architecture change) to get a
clean read on what actually helps.

## 2026-09-01 — the evaluator was broken; the M2 numbers above are unreliable

**Read this before trusting any win rate recorded earlier in this file.**

### Root cause: `evaluate.py` was not reproducible

Catanatron seeds everything through the global `random` module (`Game.__init__`
calls `random.seed(self.seed)`; `WeightedRandomPlayer.decide` calls
`random.choice`), so a seeded game *should* be bit-identical across processes.
It was not. Same checkpoint (`checkpoints/final_model.zip`), same command, same
seeds:

| Run | Result |
|---|---|
| `--games 200` — the exact command recorded above as 151/200 = 75.5% | **165/200 = 82.5%** |
| `--games 50` x2, default threads | 46/50, 43/50 |
| `--games 50` x2, `OMP_NUM_THREADS=1` | 44/50, **38/50** |
| `--games 50` x2, **`PYTHONHASHSEED=0`** | **46/50, 46/50 — identical** |

Forcing torch to one thread does *not* fix it, which rules out float
non-determinism. Pinning `PYTHONHASHSEED` does. **Cause: Python's per-process
hash randomization changes set/dict iteration order inside the engine's action
generation, so `game.playable_actions` comes back in a different order each
process, and the opponents' `random.choice` over that list picks different
moves. Same seed, different game.**

**Fix applied** (`evaluate.py`): a re-exec guard at the top of the file sets
`PYTHONHASHSEED=0` and `os.execv`s back into the same interpreter before doing
any work. Also parallelised across `multiprocessing.Pool` (`--jobs`, default 7,
model loaded once per worker) and `--model` now takes several paths so a
checkpoint series evaluates in one invocation. Verified: serial (`--jobs 1`),
parallel, and repeat runs all return **46/50** identically on the same seeds.
8,000 games (8 checkpoints x 1000) now takes **3m31s** — 1000 games is ~26 s.
Report 1000 games *in addition to* HANDOFF.md's 200-game gate figure, not
instead of it — the gate stays defined at 200; the wider run is just a
tighter interval on the same question.

Do **not** add `torch.set_num_threads(1)` to `evaluate.py` as part of this — it
was tested here and is not the cause, and this file already measures it as a 2x
regression inside `train.py`.

### The real M2 learning curve (1000 games/point, reproducible)

```
uv run python evaluate.py --opponent weighted_random --games 1000 --model <each>
```

| Checkpoint | Steps | Win rate | Wilson 95% CI |
|---|---|---|---|
| `ppo_catan_601755_steps` | 0.60M | 69.8% | [66.9%, 72.6%] |
| `ppo_catan_1001735_steps` | 1.00M | **79.3%** | [76.7%, 81.7%] |
| `ppo_catan_1501710_steps` | 1.50M | 77.6% | [74.9%, 80.1%] |
| `ppo_catan_2001685_steps` | 2.00M | 79.0% | [76.4%, 81.4%] |
| `ppo_catan_2502731_steps` | 2.50M | 78.8% | [76.2%, 81.2%] |
| `ppo_catan_3002706_steps` | 3.00M | 79.3% | [76.7%, 81.7%] |
| `checkpoints/final_model` | 3.01M | 78.6% | [76.0%, 81.0%] |
| `checkpoints_v2/final_model` (separate pi/vf, `ent_coef=0.01`) | 1.51M | **62.6%** | [59.6%, 65.5%] |

All rows above share `--seed 0` (games 0-999), so they're a paired comparison
valid for ranking checkpoints against each other, not an unbiased absolute
estimate — the same trap as the retracted 85.6% figure below. Re-run at
`--seed 5000` (a disjoint 1000-game slice) to check the plateau level holds
off-slice: `final_model` 77.9% [75.2%, 80.4%], `checkpoints_v2/final_model`
63.1% [60.1%, 66.0%] — both match their seed-0 numbers within noise, so the
~79% plateau and the v2 regression are real, not a slice artifact.

**What this corrects:**

1. **The shared-trunk plateau is real, but it sits at ~79%, not ~75.5%, and it
   is reached by 1.0M steps.** Everything from 1.0M to 3.0M bought nothing
   (79.3 → 79.3, every CI overlapping). Training past 1M steps on this config is
   wasted compute.
2. **The "71.5% → 76.0% → 75.5%" progression recorded above is not a
   progression.** Those are three 200-game draws off a non-reproducible
   evaluator, two of them measuring the *same* plateaued model. There was never
   a +4.5-point climb from 500K to 2M to explain, and the `target_kl` fix
   neither helped nor hurt the win rate — the "no improvement, within noise"
   reading was right, for a reason not identified at the time.
3. **The v2 arm is genuinely worse at matched budget, not under-measured.**
   `checkpoints_v2/final_model` (1.51M steps) scores 62.6% [59.6%, 65.5%]
   against the shared-trunk run's *own* 1.50M-step checkpoint at 77.6%
   [74.9%, 80.1%] — same step count, non-overlapping CIs. This file's earlier
   hedge (that more steps might close the gap) doesn't survive that
   comparison, and is further undercut by the training log:
   `success_rate` climbed 0.13 → ~0.68 by mid-run then oscillated 0.58-0.68
   through the final third with a slight *downward* drift (last 12 logged
   iterations: 0.68 → 0.58). Do not extend this run. If either lever is
   retried, try `ent_coef` alone on the shared trunk.
4. **The >90% gate is legitimate — do not renegotiate it.** Calibration measured
   this session, 150 games each vs 3x `WeightedRandomPlayer`:
   `ValueFunctionPlayer` **99.3%** (149/150); `WeightedRandomPlayer` against
   three of itself **28.0%** (42/150, ~chance, the sanity control). A hand-coded
   heuristic clears the gate comfortably.

### Hypotheses killed this session (don't spend a run on these)

| Hypothesis | Verdict |
|---|---|
| `gamma=0.99` hides the win reward over a long episode | **Dead.** `ep_len_mean` ≈ **70** BLUE decisions/episode (from `checkpoints/*.log`), not the 435 quoted earlier in this file — that 435 counts *all four players* over full random games. `0.99^70 ≈ 0.50`, and the effective horizon (100) already exceeds the episode. |
| Games lost mechanically to `TURNS_LIMIT` truncation | **Dead.** 0 truncations in 50 games. |
| `FastCatanatronEnv.step()`'s silent `super().step()` fallback on a decode `AssertionError` is firing and bypassing the reward fn | **Dead.** 0 hits in 50 games; the mask is sound. (Still worth a counter if that path is ever touched.) |
| `vp_shaped_reward` isn't telescoping across the forced-decision skip span | **Dead.** Mean episode return on wins = 1.96 ≈ `1.0 + 0.1 x 10 VP`, as designed. |
| Multi-threaded torch non-determinism explains the eval spread | **Dead.** `OMP_NUM_THREADS=1` reproduced the spread (44/50 then 38/50). |

### Next lever

Per the curve, more steps and more capacity are both exhausted on this config —
the remaining lever is **opponent strength**. Swap one or two of the three
`WeightedRandomPlayer` enemies in `train.py`'s `_make_env` for
`ValueFunctionPlayer` (99.3% against weighted-random, so a far denser signal),
resuming from `checkpoints/final_model.zip` with the shared trunk and
`--target-kl 0.03`. Budget a 3-5x slower rollout (~0.44 s/game vs ~0.014) and
size the step count accordingly. This is also the natural bridge to M3's own
gate (>50% vs 3x `ValueFunctionPlayer`).

## 2026-09-01 (continued) — opponent-strength lever tried, ruled out; the flat `Discrete(370)` head is the limit

Acted on the "next lever" above the same session. `train.py` now takes
`--opponent {weighted_random,mixed_1vf,value_function}` (`OPPONENT_MIXES` in
`train.py`) — `mixed_1vf` swaps one of the three enemies for
`ValueFunctionPlayer`, keeping the other two as `WeightedRandomPlayer`.

**Rollout cost, measured before committing to a step budget** (single
process, random-valid-action BLUE, `bench`-style loop, not `bench_env.py`):

| Opponent mix | decision-steps/s | s/game |
|---|---|---|
| 3x `weighted_random` | 4021 | 0.023 |
| 1x `value_function` + 2x `weighted_random` | 200 (20x slower) | 0.124 |
| 3x `value_function` | 80 (50x slower) | 0.342 |

Chose `mixed_1vf`: a curriculum step (one seat contests real strategy) rather
than jumping straight to M3's own gate condition, at 20x rather than 50x the
per-step cost.

**A 100K-step probe** (resumed from `checkpoints/final_model.zip`) measured
real steady-state fps at ~200-320 (not the ~2050 the old cheap-opponent config
hit — the FINDINGS conclusion that backprop dominates rollout time does
**not** hold once an opponent runs real per-decision computation; rollout
collection becomes the bottleneck again). Sized the real run at 1M timesteps
from that measurement rather than reusing the old fps figure.

**`ep_rew_mean` went negative early in the probe** (-0.18, -0.38) — checked
before trusting anything else. Not a bug: `vp_shaped_reward` scores off
`get_actual_victory_points`, which includes Longest Road / Largest Army, and
those awards can transfer *away* from BLUE, so per-step shaping can be
legitimately negative when a stronger opponent contests them. A control
(uniform-random valid actions instead of the trained policy) confirmed mean
episode reward stays positive under the same opponent mix (0.67 → 0.27 as
`weighted_random`-only shifts to `mixed_1vf`), so the negative reads in the
real run are the resumed policy's value head recalibrating to a harder
opponent early on, not an environment defect.

**`success_rate` in the training log sat flat at 0.06-0.19 for the entire 1M
steps** (final iterations: 0.14, 0.06, 0.12, 0.17, 0.17, 0.14) — looked like a
stall. It wasn't: evaluated `checkpoints/final_model.zip` (the pre-curriculum
starting policy) in the exact `mixed_1vf` field and got **12.7%**; a
~230K-step-in checkpoint scored **15.3%** in the same field. The flat band is
the metric saturated near its floor in a hard field, not the policy failing
to learn — confirmed *before* letting the run finish, so the 40 remaining
minutes weren't spent on a run already known to be broken.

**Gate result — 1000 games/checkpoint vs the unchanged M2 gate (3x
`WeightedRandomPlayer`), same protocol as the curve above:**

| `checkpoints_mixed/` checkpoint | Win rate | Wilson 95% CI |
|---|---|---|
| `ppo_catan_3206273_steps` | 81.7% | [79.2%, 84.0%] |
| `ppo_catan_3406270_steps` | 79.7% | [77.1%, 82.1%] |
| `ppo_catan_3606267_steps` | 78.0% | [75.3%, 80.5%] |
| `ppo_catan_3806264_steps` | 81.1% | [78.6%, 83.4%] |
| `ppo_catan_4006261_steps` | 79.7% | [77.1%, 82.1%] |
| `final_model` | 80.3% | [77.7%, 82.6%] |

Mean ~80.1% vs the shared-trunk baseline's 78.6-79.3% — **inside the noise
band, not a plateau break.** Every CI overlaps the baseline's. Report this as
no meaningful effect, not as an improvement: the training-field diagnostic
above already established the run wasn't degrading the policy, so this null
result is about transfer (curriculum difficulty didn't carry over to the easy
field), not about the run misbehaving.

**M3 bridge (300 games vs 3x `ValueFunctionPlayer`) — the more informative
number:**

| Checkpoint | Win rate vs 3x `value_function` |
|---|---|
| `checkpoints/final_model` (pre-curriculum baseline) | 1.7% [0.7%, 3.8%] |
| `checkpoints_mixed/final_model` (`mixed_1vf`, 1M steps) | 2.0% [0.9%, 4.3%] |

Statistically identical. One VFP training seat did not transfer to a 3-VFP
field either — unsurprising in hindsight (a 1-in-3 curriculum is a much
easier field than the M3 gate itself), but it means this lever produced no
measurable improvement on **either** gate.

**Calibration that reframes M4:** `ValueFunctionPlayer` vs 3x
`AlphaBetaPlayer`, 30 games — **10.0%, below the 25% chance baseline in a
4-player game.** AlphaBeta is meaningfully stronger than ValueFunctionPlayer.
Our PPO agent loses to ValueFunctionPlayer 98% of the time. **M4 (>50% vs 3x
AlphaBetaPlayer) is not a tuning distance from where this agent sits — it is
a different scale of gap entirely.**

### Five levers tried this session and last, all null, at matched rigor

| Lever | Result |
|---|---|
| `target_kl` (optimizer hygiene) | No effect on win rate (75.5% vs 76.0% pre-fix, CIs overlap) |
| `ent_coef=0.01` + separate pi/vf trunks (capacity + exploration) | Worse at matched budget (62.6% vs 77.6% at 1.5M steps) |
| More steps, same config (1.0M → 3.0M) | Flat (79.3% → 79.3%) |
| `mixed_1vf` opponent curriculum | No effect (80.1% mean vs 78.6-79.3% baseline, inside noise) |
| (implicit) `gamma=0.99` | Ruled out analytically before spending a run — `ep_len_mean` ≈ 70 makes the horizon argument moot |

**Conclusion at this point in the session (superseded below): the plateau is
not an optimizer, capacity, entropy, or curriculum-strength problem — all
four have been tested with a reproducible evaluator and none moved the
gate.** The remaining candidate looked like the policy representation
itself: a flat `Discrete(370)` head over a 1002-float MLP trunk learns each
of ~370 actions as an independent output with no shared structure ("build
settlement at node 12" carries no information about node 13). That
mechanism predicts exactly the observed signature — fast early gains against
opponents that punish nothing, then a hard ceiling against anything that
plays positionally. **This reasoning had an untested premise — see the next
section, which closes it and revises the recommendation.**

## 2026-09-01 (continued, 2) — observation-gap lever tried, also ruled out; the real gap is search, not features or the action head

Before recommending the factored-head rewrite above, checked its premise:
does the policy's *observation* even contain what a positional opponent
needs? It didn't. `catanatron/players/value.py`'s `ValueFunctionPlayer`
weighs `production`/`enemy_production` as its 2nd/3rd heaviest terms (1e8,
-1e8) right after victory points (3e14), and `buildable_nodes` 5th (1e3) —
but `build_production_features` and `reachability_features` are **commented
out** of catanatron's `feature_extractors` list (`features.py`), so
`get_feature_ordering(4)` — and therefore every observation this project has
ever trained on — carries no per-player production or expansion signal at
all. The policy could not see the inputs the opponent that beats it 98:2
relies on most.

**Fix (`catan_env.py`):** `Encoder` now appends 24 features after the base
1002 — `EFFECTIVE_P{i}_{resource}_PRODUCTION` (4 players x 5 resources,
reusing catanatron's own cached `get_node_production`) and
`P{i}_BUILDABLE_NODES` (`board.buildable_node_ids`, same call `value.py`
itself makes). Both are public board-derived quantities (settlement/city
positions and tile numbers are public), so no hidden-info risk.
`observation_space` grows to `(1026,)` accordingly — this makes old
checkpoints incompatible with the current env (a 1002-dim policy raises
`ValueError: Unexpected observation shape (1026,)` against it), so this was
a from-scratch training run, not a resume. **Every pre-2026-09-01 checkpoint
(`checkpoints/`, `checkpoints_v2/`, `checkpoints_mixed/`) is now unloadable
against `FastCatanatronEnv`/`evaluate.py`** — hit this twice more later in
this session (once trying to batch-evaluate an old and new checkpoint
together, once in the search-wrapper work below); if a future session needs
one of those old checkpoints' numbers again, use a `git` history of this file
or re-run against a `catan_env.py` checked out before this change, not the
live encoder. New differential test
(`test_extra_features_match_catanatron_reference`) checks the 24 new values
against catanatron's own `build_production_features`/`buildable_node_ids`
directly, same spirit as the existing base-feature differential test.

**Cost, measured before committing to a run:** encoder alone 33.2 µs/call vs
`create_sample_vector`'s 76.9 µs (2.31x, same-run comparison — down from the
historical ≥3x gate because the extra 24 features are real added work, not
overhead); full env step throughput 3169 vs 4020 decision-steps/s
single-process (~21% slower end to end). Accepted without further
optimization — the question was whether the feature helps at all, and
premature-optimizing an unproven feature is exactly the trap CLAUDE.md warns
against.

**Trained from scratch, 3M steps, `--opponent weighted_random` (same M2
setup as the original baseline), 1000 games/checkpoint:**

| Steps | Win rate |
|---|---|
| 0.3M | 32.8% |
| 0.6M | 57.5% |
| 0.9M | 72.3% |
| 1.2M | 76.2% |
| 1.5M | 74.0% |
| 1.8M | 71.4% |
| 2.1M | 73.5% |
| 2.4M | 74.8% |
| 2.7M | 78.2% |
| 3.0M | 66.9% |
| final (3.0M) | 67.4% |

Peaks at 78.2%, matching the original baseline's plateau, but the curve is
visibly noisier than the baseline's tight 78.6-81.7% band and **ends at its
low point (67.4%)**, not its peak. Checked whether this is the added
features destabilizing training (a real regression) or just a harder
optimization problem that needed more steps: `explained_variance`
(0.637-0.68) and `value_loss` (0.031-0.041) across the run's tail are
in the same range as the original baseline's tail (0.612-0.692,
0.033-0.044) — the value function fit is fine. Reading: **no effect,
noisier, possibly undertrained** — not a regression from the added
features.

**M3 bridge — the decisive number, 300 games vs 3x `value_function`:**

| Checkpoint | Win rate vs 3x `value_function` |
|---|---|
| `checkpoints/final_model` (pre-augmentation baseline) | 1.7% [0.7%, 3.8%] |
| `checkpoints_augobs/ppo_catan_2699991_steps` (peak M2 checkpoint, 78.2%) | 2.3% [1.1%, 4.7%] |
| `checkpoints_augobs/final_model` (3.0M) | 1.7% [0.7%, 3.8%] |

**Identical to baseline, both checkpoints.** Giving the policy VFP's
most heavily-weighted inputs changed nothing against VFP itself.

### Six levers now null; the mechanism gap is search, not representation

| Lever | Result |
|---|---|
| `target_kl` (optimizer hygiene) | No effect on win rate (75.5% vs 76.0% pre-fix, CIs overlap) |
| `ent_coef=0.01` + separate pi/vf trunks (capacity + exploration) | Worse at matched budget (62.6% vs 77.6% at 1.5M steps) |
| More steps, same config (1.0M → 3.0M) | Flat (79.3% → 79.3%) |
| `mixed_1vf` opponent curriculum | No effect (80.1% mean vs 78.6-79.3% baseline, inside noise) |
| Production/buildable-node observation augmentation | No effect on M2 (noisier, same peak); no effect on M3 (2.3%/1.7% vs 1.7% baseline) |
| (implicit) `gamma=0.99` | Ruled out analytically — `ep_len_mean` ≈ 70 makes the horizon argument moot |

**Revised conclusion — this supersedes the factored-action-head
recommendation above.** That recommendation assumed the observation was
sufficient and blamed the action head by elimination. It wasn't sufficient
(VFP's top-weighted features were absent), and fixing that changed nothing
either. What's left, and what actually explains a 98:2 loss to a ~13-scalar
hand-coded heuristic even after matching its inputs: **`ValueFunctionPlayer`
does not emit a reactive policy over the current state — `decide()` calls
`game.copy()`, executes every legal action, and scores the *resulting*
state.** That is a structurally different computation from anything a
feed-forward policy (flat or factored) does in one forward pass. It also
explains a detail from the action-space breakdown above without needing the
action head to be the culprit: `MOVE_ROBBER` (95 of 370 actions) and
`MARITIME_TRADE` (60) are both action types whose value is almost entirely
in the *resulting* state (who gets robbed of what; what a trade leaves you
holding) and almost nothing in the action identity — exactly what 1-ply
search reads off directly and a reactive policy has to memorize per action
index.

**The factored action head is now a secondary candidate, not the
recommendation.** The cheaper, more directly targeted next step was
HANDOFF.md's M5 (test-time search): a 1-ply greedy wrapper around the
trained policy — for each legal action, `game.copy()`, execute, score the
resulting state, pick the best. Attempted this session — see the next
section.

## 2026-09-01 (continued, 3) — 1-ply greedy search over the trained value head: implemented, debugged, null result

`evaluate.py --search` (`greedy_search_action`): for each legal action,
`game.copy()`, execute, advance to the next real decision boundary
(`advance_until_decision`, factored out of `FastCatanatronEnv` so both share
one implementation), encode, batch through `model.policy.predict_values`,
pick the argmax. Same shape as `ValueFunctionPlayer.decide()` but scored
with the trained policy's own learned value function instead of a
hand-crafted heuristic — the direct test of whether *our* policy just needs
search, not whether VFP's specific heuristic is good.

**First attempt scored 32.0%** (48/150) vs `weighted_random`, on
`checkpoints_augobs/final_model.zip` — a checkpoint that scores 61.3%
reactively on the same opponent, same eval harness. A search that makes
things *worse* than not searching is a signal to debug, not a finding, so it
was debugged before being written up: `greedy_search_action` was encoding
`game_copy` immediately after `execute(action)`, **before** the
forced-decision skip. `FastCatanatronEnv.step()` always advances through
`_advance_until_p0_decision()` before encoding, so the value head was
trained exclusively on post-skip states at real decision boundaries — the
search was asking it to score mid-turn states (sometimes not even BLUE's
turn, sometimes with `is_discarding`/`is_moving_robber` set) that it never
saw during training. **Fix:** call the same advancement logic
(`advance_until_decision`) on each candidate copy before encoding.

**After the fix, re-measured at increasing sample size:**

| Sample | Search win rate | Reactive win rate (same checkpoint) |
|---|---|---|
| 150 games vs `weighted_random` | 56.0% [48.0%, 63.7%] | 61.3% [53.3%, 68.8%] |
| 300 games vs `weighted_random` | **59.3% [53.7%, 64.7%]** | 61.3% [53.3%, 68.8%] |
| 150 games vs `value_function` | 3.3% [1.4%, 7.6%] | 0.7% [0.1%, 3.7%] |

**Both comparisons: search is statistically indistinguishable from reactive
play.** Not catastrophic (the boundary bug explained essentially all of the
32.0% collapse), but not an improvement either — against `weighted_random`
the CIs nearly coincide; against `value_function` both numbers are near-zero
with overlapping CIs, so search does not close the gap that motivated this
whole investigation.

**Why a properly-implemented version is still null, not just "search
didn't help this time":** PPO's critic and its policy are trained from the
same on-policy data under the same objective — the policy's action
distribution is already (approximately) the softmax the critic's advantage
estimates would favor, so greedily maximizing that same critic over legal
actions is close to a redundant computation, not new information. This is
the mechanistic reason to expect a null result here specifically, and it is
also exactly the gap between this approach and what actually works in
AlphaZero-style methods: there, the value function is trained on
search-bootstrapped targets (MCTS visit-count outcomes), independent of the
policy's own rollout distribution, so it genuinely carries information the
reactive policy doesn't already encode. **A vanilla actor-critic value head
reused for greedy search is not that.**

**Revised recommendation.** Neither the factored action head nor naive
greedy search over the existing critic is well-supported anymore — both
were plausible mechanisms that didn't survive being tested. What remains
untested and has real precedent: (1) a value function trained *for* search
(expert-iteration / AlphaZero-style bootstrapping from search outcomes,
not from on-policy rollouts) rather than search bolted onto PPO's
incidental critic; or (2) more simulation budget on the current setup
combined with self-play (M3, never attempted this session — the opponent
pool machinery doesn't exist yet), since `AlphaBetaPlayer` is a
depth-limited search over a hand-tuned heuristic and nothing this session
tried gives the current policy either search or a comparably strong
static evaluator. Either is a multi-session undertaking; do not start
either from a session that is mostly spent. `Game.copy()` at ~26 µs
(measured in the Search cost section below) is what makes both tractable at
all — that number is the reason this stays on the table rather than being
ruled out by throughput.

## 2026-09-01 (continued, 4) — `CachedMaskVecEnv` staleness bug: found, measured, fixed

Found while hardening the search-wrapper regression test (previous section):
`test_cached_mask_matches_env_method` started failing intermittently (~2 of
8 runs in isolation, no other load on the machine — not the thermal/power
noise this file usually flags). Root-caused, not dismissed as flaky.

**Bug:** `CachedMaskVecEnv.step_wait()` cached `infos[i]["valid_actions"]`
unconditionally. SB3's `SubprocVecEnv` worker auto-resets any env whose
episode just ended — `env.reset()` is called and `obs[i]` is overwritten
with the *new* episode's observation, but `infos[i]` is left as the
terminal step's own info (`SubprocVecEnv`'s `_worker()`: `if done:
info["terminal_observation"] = observation; observation, reset_info =
env.reset()` — `info` itself is never touched). The mask for a freshly
reset env is in `reset_info`, exposed separately as `self.venv.reset_infos`
— the same source `CachedMaskVecEnv.reset()` already correctly used, just
not `step_wait()`. So on every episode boundary, the cached mask for that
env was the *previous, now-finished* game's valid actions, not the new
game's.

**Fix (`catan_env.py`):** `step_wait()` now uses `self.venv.reset_infos[i]`
in place of `infos[i]` for any index where `dones[i]` is true.

**Measured blast radius**, not estimated: patched `FastCatanatronEnv` with
counters (per-worker closure state, read back via `env_method` — the same
IPC path `action_masks()` already uses; a shared `multiprocessing.Value`
isn't cloudpickle-safe through SB3's env-factory wrapping and was tried
first) and ran one real rollout under the *buggy* `step_wait`, train.py's
actual settings (`n_steps=2048`, `n_envs=7`, 14,336 transitions) — **with a
randomly-initialized policy**, not a trained checkpoint:

```
episode boundaries (dones): 185
invalid-action fallback hits: 185
fallback fraction of total transitions: 1.29%
fallback fraction of boundary events: 100.00%
```

**Every single episode boundary corrupted its transition — no exceptions,
no partial overlap.** A stale mask drawn from an unrelated (just-finished)
game essentially never contains a valid action for the new game's initial
decision, so `MaskablePPO` sampling from that stale mask reliably picks an
action outside `game.playable_actions`. This is the disjoint-action-set
mechanism, not an artifact of the untrained policy specifically — it
predicts the same ~100% rate under a trained checkpoint too, though that
wasn't separately measured (no need to re-run this for a qualifier).
**The failure mode is bounded, not
silent corruption of game state**: `FastCatanatronEnv.step()`'s
`except AssertionError: return super().step(action)` fallback catches
exactly this, and the base `CatanatronEnv.step()` returns
`invalid_action_reward = -1` rather than executing an illegal move — so
**~1.3% of transitions in every SubprocVecEnv-based training run on this
project got a spurious -1 reward and a wasted step, not a broken game or a
corrupted rollout buffer beyond that one transition.**

**What this does and does not invalidate.** All prior comparisons in this
file (target_kl, ent_coef/separate-trunk, more-steps, `mixed_1vf`,
observation augmentation) trained under this same bug — it is common-mode
across every arm, so those A/B comparisons remain valid relative to each
other. **Do not re-run anything on this basis alone.** It also revises,
rather than replaces, the earlier explanation for the `mixed_1vf` run's
negative `ep_rew_mean` (-0.18, -0.38): that section attributed it entirely
to Longest Road/Largest Army award transfers, backed by a random-policy
control showing mean reward stays positive under the same opponent mix.
That control still stands as a real, independent contributor — this bug is
a *second* contributor neither identified nor separated out at the time.
With ~1.3% of transitions taking a flat -1 independent of play quality, it
plausibly accounts for some, not all, of the observed negative mean.

**New regression coverage (`test_env.py`):**
`test_cached_mask_survives_episode_boundary` forces episode boundaries
deterministically (`vps_to_win=3`) instead of relying on the ~25% chance a
25-step random window happens to catch one (which is what made the original
`test_cached_mask_matches_env_method` merely intermittent instead of
reliably red) — verified to fail against the pre-fix code and pass against
the fix before being kept.

## 2026-09-01 — M2 gate calibration: the ~79% ceiling is real, not a miscalibrated gate

Before committing to either of the two remaining M2/M3 candidates (self-play,
search-bootstrapped value function — both multi-session), checked whether
M2's `>90%` gate was itself attainable, or a Catan-variance wall no
feed-forward policy could clear. Measured `ValueFunctionPlayer` — not any
PPO checkpoint — against the same 3×`WeightedRandomPlayer` opponent config
used throughout M2, via `Game(players).play()` directly (bypasses the gym
env entirely; no `--model` flag needed since evaluate.py can only put a PPO
checkpoint in seat 0). 500 seeded games, `PYTHONHASHSEED=0`,
`multiprocessing.Pool(7)`, reused `evaluate.py`'s `wilson_interval`:

```
ValueFunctionPlayer vs 3x WeightedRandomPlayer: 491/500 = 98.2%
95% CI: [96.6%, 99.1%]
```

**Conclusion: the gate is attainable and the trained agent's ~79% plateau is
a real deficiency, not a miscalibrated target.** This closes the "maybe M2
was never a fair bar" branch permanently — don't re-open it.

Reframing that follows from this number: the agent isn't 19 points behind
VFP on some smooth strategic-depth axis — it is **losing 21% of games to
three weighted-random bots**, which VFP beats 49 times out of 50.
Weighted-random is trivially exploitable, so a large share of that 21% is
plausibly a concentrated behavioral defect rather than diffuse missing
strategic depth. Both standing candidates (self-play, expert-iteration) are
built on the assumption that the fix requires search-quality play; neither
was checked against the cheaper hypothesis first.

**Recommended next step (not yet started): behavior-clone the policy from
VFP.** Label states with VFP's chosen action (VFP is 0.44s/game, 435 policy
calls/game per the perf baseline above → 20k games ≈ 21 min on 7 cores ≈
8.7M labeled decisions), supervised-train the same encoder/net/action-head
shape PPO uses. This is a diagnostic + warm start, not a destination — BC
can't exceed its teacher, and VFP itself only gets 10% vs 3×AlphaBeta (see
M4 calibration above). It discriminates the next real decision:
- BC reaches ~95%+ vs weighted_random → the 1026-dim obs and flat
  `Discrete(370)` head *can* represent VFP-quality play; PPO's exploration/
  credit assignment is the bottleneck, not representation. Points at
  expert-iteration (with a warm start well above 79%) as the next milestone.
- BC caps near ~80% → the representation or flat action space is the wall
  regardless of training algorithm. Different repair; would have ruled out
  self-play/expert-iteration as fixes before building either.

Note: BC's `Game.copy()` cost is in **offline label generation at VFP
speed**, not a per-move training-time search budget — this does **not**
fire RUST-ENGINE.md's trigger #1 (search-based training). That trigger
still applies if expert-iteration is chosen after BC's result.

## 2026-09-01 — BC-from-VFP result: representation is not the bottleneck

Ran the BC diagnostic proposed above. `train_bc.py`: 20,000 games labeled
with `ValueFunctionPlayer`'s chosen action (`PYTHONHASHSEED=0`,
`multiprocessing.Pool(7)`, ~1.25M labeled decisions), supervised-trained
into the same `MaskablePPO` net/obs/action-head shape M2 uses (masked
cross-entropy via `policy.evaluate_actions`, `Adam(foreach=False)`,
`checkpoints_bc/bc_model.zip` — loads and evaluates with `evaluate.py`
unmodified). 8 epochs, training-set accuracy (same 20k games, **not**
held-out — no train/val split was done, so this number characterizes fit
during training, not generalization) climbed 63.3% → 82.7% and was still
rising at epoch 7.

The number that matters is held-out win rate, measured on 500 fresh seeded
games through the existing evaluator:

```
bc_model.zip vs 3x WeightedRandomPlayer:  481/500 = 96.2%  [94.1%, 97.6%]
bc_model.zip vs 3x ValueFunctionPlayer:     39/500 =  7.8%  [ 5.8%, 10.5%]
```

**Conclusion: the 1026-dim observation and flat `Discrete(370)` action head
can represent VFP-quality play — 96.2% vs weighted_random, in the same
range as VFP's own 98.2%, decisively above PPO's 79% ceiling.** This is
what was measured; it rules out representation as the bottleneck (kills the
"factored conditional action heads" and "observation is incomplete"
candidates for good — both already had null evidence from the M2
investigation above, now positive counter-evidence). It does **not**
establish that PPO's exploration/credit-assignment is fixable, only that a
supervised signal on this net reaches 96% where PPO's RL signal reached
79% — an exploration/credit-assignment diagnosis by elimination, sound but
still to be tested by actually building the fix.

**BC does not transfer to M3-strength play.** 7.8% vs 3×ValueFunctionPlayer
is ~4.6x PPO's 1.7% on the same gate, but nowhere near M3's `>50%` bar.
Cloning VFP's *moves* does not reproduce VFP's *strength* against a peer
opponent — expected, since BC only ever sees VFP's own on-policy states
against weak opponents, never learns to recover from mistakes a stronger
opponent forces. Also note: **BC does not clear M4 either** — VFP itself
scores only 10% vs 3×AlphaBeta, and BC is below VFP overall, so this result
unlocks an M2/M3-shaped ceiling, not an M4-shaped one.

**Standing next step**: `checkpoints_bc/bc_model.zip` is a warm start
(96.2% vs weighted_random, well above cold-start PPO) for whichever of
self-play (M3) or expert-iteration is attempted next — still real,
still to be built, still could fail for reasons BC didn't test.

## 2026-09-01 — IPC bottleneck: contention, not pickling (M3 Step 0)

M3's self-play design makes enemy players neural nets too, which reopens
the M1 inference-server batching question this time for real (self-play
needs *some* answer for how enemy `decide()` calls get inference-served).
Before building anything, checked the claim two sections up — that
per-decision `Queue` pickling is the batch-plateau's cause, and that
shared-memory buffers would fix it — since it was a guess, never measured
directly. `bench/bench7_ipc_transport.py` isolates the transport from game
simulation and the forward pass entirely, at two concurrency levels:

```
single pair, no contention (2 processes on 8 threads):
  Queue:          251.6 us/roundtrip,  3,975/s
  shared memory:  205.8 us/roundtrip,  4,858/s   (~18% faster)

7 workers + 1 server, matching inference_server.py's real topology
(8 processes on 8 hardware threads -- zero spare threads):
  Queue:          109.0 us/roundtrip,  9,174/s aggregate, 1,311/s/worker
  shared memory:  115.2 us/roundtrip,  8,680/s aggregate, 1,240/s/worker
```

**Shared memory is not faster under the contention level that actually
matters — it's marginally slower.** At 8 processes on 8 threads there is no
spare core for anything, and busy-polling (the shared-memory design) spends
CPU cycles spinning instead of yielding them back to the scheduler the way
`Queue`'s blocking `.get()` does — a real, if small, regression under full
contention, not an improvement.

The more important number: this no-simulation, no-forward-pass IPC-only
benchmark already reproduces **1,240-1,311 decisions/s/worker**, matching
the real `inference_server.py`'s recorded **~1,000-1,100 decisions/s/worker**
(with real game simulation and a real forward pass added on top) almost
exactly. **The bottleneck is process/CPU contention among 8 concurrent
processes on this 8-thread machine — not serialization cost.** Pickling a
1026-float + 370-bool payload is cheap in isolation (the single-pair numbers
above); it only looks expensive because 8 processes are fighting over 8
threads with zero slack, and *any* synchronization primitive pays that tax,
pickled or not.

**Correction to the "This does not bottleneck training" framing two
sections up, and to RUST-ENGINE.md trigger #2's proposed fix**: the
shared-memory alternative named there does not attack the actual cause.
Trigger #2's own text already had the right instinct for what *would* work
("Rust doesn't optimize that problem, it dissolves it... single-process, no
IPC, no GIL") — a single-process design removes the 8-way process
contention entirely rather than trying to make the contended path faster.
Nothing here changes M2's conclusion that this doesn't currently bottleneck
training (XPU batch-32 still dwarfs the ~7,500 decisions/s this pipeline
produces) — it only closes out the "swap in shared memory" fix as
something to actually attempt.

**Implication for M3**: self-play's `PPOPlayer` enemies should call
`model.predict()` locally (batch-1, in-process) rather than routing through
any kind of shared inference server — there's no transport-level win
available at this concurrency level to justify the added complexity,
and per §"Honest scope note" in the M3 plan, self-play's opponent-pool
heterogeneity (different checkpoints per seat) would need multi-model
batched serving on top of any working transport anyway. If self-play's
throughput smoke test (M3 Step 4) shows a problem, the lever most likely to
help is reducing total CPU work per decision (fewer worker processes, or
the encoder optimization flagged as a deferred M3 optimization) — not
inference batching.

## 2026-09-01 — M3 Step 4: self-play throughput, after fixing a 200x regression

First real self-play training run (`--opponent self_play --n-envs 7`)
measured **fps=10** against M2's 2048 baseline — a ~200x regression, far
beyond the ~4x expected from self-play's extra encode+policy volume (BLUE +
3 now-neural enemies vs. BLUE alone). Profiling `PPOPlayer.decide()`
(`cProfile`, 200 calls) found the cost concentrated in
`MaskablePPO.predict()`'s high-level API — `obs_to_tensor`'s
vectorized-input checks, `MaskableCategoricalDistribution` object
construction, etc. — at **~2555us/call**, ~23x FINDINGS.md's own recorded
raw batch-1 forward-pass cost (45.5us). Multiplied by 3 enemies/env inside
7 worker processes already competing for 8 hardware threads (this
session's earlier IPC contention finding), this alone explains the
collapse.

**Fix, in `self_play.py`:**
1. `torch.set_num_threads(1)` once per worker process. This is the
   opposite of what an earlier session found for the *main* process's
   backprop (net regression there, reverted) — but that's large-batch
   matmuls benefiting from multi-core; this is many small batch-1 calls
   inside a process that's one of 7 already fighting for 8 threads, where
   per-call thread-pool spin-up is pure overhead. Different regime,
   different answer — confirmed empirically, not assumed from the earlier
   finding.
2. A lean inference path bypassing SB3's `predict()` entirely:
   `extract_features` → `mlp_extractor.forward_actor` → `action_net`,
   masked by hand (`masked_fill(~mask, -1e9)`) and sampled via
   `np.random.Generator.choice` on the softmax — same loaded weights, same
   masked-categorical distribution `model.predict(deterministic=False)`
   computes, just without the per-call API overhead. Isolated: 150.8us/call
   (vs 2555us) — ~17x. Verified correctness after the swap: 19/20 wins as
   a lone strong seat vs 3 weak bots (was 20/20 with `model.predict()`,
   same ballpark — stochastic sampling, not a regression), and
   `test_ppo_player_decodes_valid_actions_for_any_color` still passes.

**Re-measured, 50k timesteps, 7 envs (the real Step 4 gate):**

```
iteration 1 (cold start): fps 437  (32s,  14336 steps)
iteration 2:               fps 197  (cumulative; ~128 fps iteration-own)
iteration 3:               fps 189  (cumulative)
iteration 4 (final):       fps 201  (cumulative, 285s total, 57344 steps)
```

Steady state (iterations 2-4, excluding the artificially-fast cold-start
iteration 1) settles around **~190-200 fps** — roughly **10x slower than
M2's 2048 baseline**, worse than the naively-estimated ~4x but not close to
the original 200x bug. Plausible contributors beyond the base ~4x: episode
length grew during the run (`ep_len_mean` 34.3 → 64 as the policy started
actually updating against self-play opponents instead of playing near-
randomly), and periodic new-pool-checkpoint loads (`CheckpointCallback`
saved 3 snapshots during this run, each triggering one one-time
`MaskablePPO.load()` per worker on first sample). Neither fully separated
out from base self-play overhead — not worth the rigor for a smoke-test
gate.

**Verdict: mild-to-moderate regression, not severe — proceed to the full
run (M3 Step 5).** ~190-200 fps is a real, workable training rate; a
1-3M-timestep run costs roughly 1.5-4.5 hours at this rate, not the
days a genuinely severe regression would have implied.

## 2026-09-01 — M3 Step 5: full self-play run, gate not met

1M timesteps, `--opponent self_play --resume-from checkpoints_bc/bc_model.zip
--n-envs 7`, pool seeded with `bc_model.zip` and growing via
`CheckpointCallback`'s own periodic saves (10 snapshots produced over the
run, steps 99995 through 999950). Ran in 56 minutes (~297 fps average --
faster than Step 4's ~190-200 fps steady-state reading, plausibly because
games got more decisive as the pool filled with real trained snapshots
instead of 3 clones of the same seed checkpoint).

**Gotcha, not a blocker**: `train.log` captured only the final `saved:`
line -- none of SB3's per-iteration rollout/train diagnostics
(`approx_kl`, `ep_rew_mean`, etc.) made it to the redirected file, likely
stdout buffering under `nohup`/`uv run` that isn't flushed until process
exit. Lost the mid-run health check M2's `approx_kl` anomaly makes
routine to want; for a future run, redirect through `stdbuf -oL` or set
`PYTHONUNBUFFERED=1`.

**Gate result (the actual M3 criterion, `evaluate.py`, 1000 games):**

```
final_model.zip vs 3x ValueFunctionPlayer:      90/1000 =  9.0%  [ 7.4%, 10.9%]   <- gate is >50%, NOT MET
final_model.zip vs 3x WeightedRandomPlayer:     410/500 = 82.0%  [78.4%, 85.1%]
```

**Progression vs value_function across everything tried this session**:
cold-start PPO 1.7% → BC clone 7.8% [5.8%, 10.5%] → this self-play run
9.0% [7.4%, 10.9%]. The self-play number's CI overlaps BC's almost
entirely -- **1M steps of self-play warm-started from BC did not clearly
improve on BC alone** against this gate. It did clear M2's weighted_random
plateau (82.0% vs the 79% ceiling), so the pipeline is doing *something*,
but the M3 gate remains a different scale of gap, matching FINDINGS.md's
standing framing of self-play as a "multi-session undertaking" rather than
a single-run fix.

**Read cautiously, not as failure**: this is one 1M-step run against one
specific pool-growth trajectory (uniform sampling, seeded with a single BC
checkpoint, no recency weighting). Candidate reasons 1M steps wasn't
enough, none tested here: (1) early in the run the pool is mostly clones
of the same seed checkpoint or its near-immediate descendants -- little
real opponent diversity/pressure until several snapshots accumulate; (2)
uniform-over-history sampling means a already-improving policy still faces
early-weak snapshots at the same rate as recent-strong ones, diluting
pressure; (3) simply more steps, matching M2's own 1M-3M-flat pattern
suggesting a plateau check at 3M+ would be the natural next data point
before concluding self-play (at this configuration) is exhausted.

**Standing next steps, unstarted**: extend this same run further (more
timesteps from the same warm start, same pool) to see if the gap closes
with budget alone; try recency-weighted pool sampling instead of uniform;
or revisit expert-iteration (search-bootstrapped value function) as a
structurally different approach, per the standing recommendation from the
BC section above -- still unstarted, still the RUST-ENGINE.md trigger #1
consideration if attempted.

## 2026-09-01 — M4 reframed: keep AlphaBeta's search, replace its evaluator

**Why.** Every agent built so far is a reactive policy. The table below is the
whole story: `ValueFunctionPlayer` and `AlphaBetaPlayer` share one hand
heuristic (`base_fn`); AB adds depth-2 expectimax and goes from 10% to
~25%+ against 3x AB. Search is the missing mechanism, not representation
(BC proved the net can represent VFP-quality play) and not the optimizer.

| Agent | vs 3x WR | vs 3x VFP | vs 3x AB |
|---|---|---|---|
| PPO best (3M steps) | 79% | 1.7% | — |
| BC of VFP | 96% | 7.8% | — |
| Self-play PPO from BC (1M) | 82% | 9.0% | — |
| VFP (1-ply, `base_fn`) | 98% | 25% (symmetry) | 10% |
| AB (depth-2 expectimax, same `base_fn`) | — | — | 25% (symmetry) |

**Design.** `ValueNetPlayer(AlphaBetaPlayer)` (`value_net.py`) uses the base
class's own `use_value_function` / `value_function(game, p0_color)` hook. The
evaluator is an MLP (1026 encoder features + a 4-one-hot of whose turn it is,
relative to the perspective) trained by BCE on (state, perspective, won)
samples from played games (`gen_games.py`, `train_value.py`). Expert
iteration: generate games with the current player, retrain, repeat.

**Measured before building** (one AB seat vs 3x WR, seed 1, `PYTHONHASHSEED=0`):

| What | Value |
|---|---|
| Leaf evaluations per real AB decision | mean **279**, median 23, max 2,208 — 26,507 per game-seat |
| `base_fn` per leaf | **80 µs** (51% of AB's wall time) |
| `Encoder.encode` on the same states | 37 µs |
| `Board.copy()` | shares the map object → the encoder's per-map template cache holds across all `game.copy()` leaves |
| Seating | `State.__init__` shuffles players → seat BLUE has no order bias |

Depth-2 expectimax is 2–3 orders of magnitude cheaper than the 800-sim MCTS
`docs/RUST-ENGINE.md` trigger #1 assumed. **No Rust port for this plan.**

**Measured after building** (smoke run, `performance` profile):

| What | Value |
|---|---|
| `gen_games.py --lineup ab,ab,ab,ab`, 21 games, 7 workers | 0.32 games/s incl. pool startup/tail; **158 samples/game** at `--sample-p 0.5` (~316 ticks/game — AB games are ~136 turns, not the ~340 of random games) |
| `train_value.py` on 3,309 samples, XPU | seconds per epoch; held-out log-loss 0.60 → 0.56 in 3 epochs, base rate 0.25 |
| `ValueNetPlayer` seat vs 3x WR (batch-1 torch forward per leaf) | **9.0 s/game** vs AB's 1.8 s — **5x**, not the ~1.7x the per-leaf arithmetic predicted: torch per-op dispatch at batch 1 (~10 ops × ~25 µs) dominates, not the matmuls |

That 5x only hits generation for iterations ≥1 (iteration 0 is AB-only
games) and the gate eval (~16 s/game → 300 games ≈ 12 min on 7 workers).
Batched leaf evaluation (expand the depth-2 tree, encode all leaves, one
forward) is the fix — see the next section.

**Also fixed:** `Encoder` cached its map template keyed by `id(catan_map)`;
CPython recycles addresses (18 distinct ids over 40 sequential games measured),
so a long-lived encoder could in principle keep a stale template. Now holds
the map by reference and compares with `is`. Never lands on two *consecutive*
maps in the patterns measured, so it can't be reproduced deterministically —
no regression test, the fix is correct by construction.

**Corrections to the reviewer-caught design details, recorded so nobody
re-derives them:** the search averages leaf values over dice/dev-card/robber
outcomes (`minimax.py:124`), so `value_function` must return a
**probability**, not a logit; the search *does* evaluate won states and
`gen_games` never records a post-winning-move state, so terminal leaves are
scored exactly (`1.0 if winner == p0_color`).


### Batched exact expectimax (M4 Step 2) — and a Catanatron search bug

`ValueNetPlayer.decide()` now expands the whole depth-2 tree, encodes every
leaf, and scores them in one forward. Verified against the base class's
recursive `alphabeta()` at depth 1 (no cutoffs possible there): same action
on 40/40 decisions, root values equal to 6e-8; at depth 2, same action
40/40, **81 ms/decision vs 204 ms** for the recursive hook, measured
back-to-back under the same (contended) load. Full expansion averages ~230
leaves/decision (max ~2,300) — about what AB's cutoffs leave, because AB
passes alpha/beta through chance nodes unadjusted and rarely cuts.

**Found while verifying: `catanatron.players.tree_search_utils.execute_spectrum`
does not pin stochastic outcomes.** It sets the dice / drawn card as
`action.value`, but `apply_roll` and `apply_buy_development_card` read
`action_record.result` (falling back to `roll_dice()` / `listdeck.pop()`).
Measured: expanding the same ROLL from the same state twice gives different
leaves (11 of 11 differ), because each "outcome" re-rolls the dice at random;
and every dev-card "option" pops the *true* top card. So `AlphaBetaPlayer`'s
expectation over dice is really 11 random rolls weighted by the dice
probabilities, and its dev-card branch leaks the next card. Only
`MOVE_ROBBER` is pinned correctly (it passes an `ActionRecord`).
`value_net.expand_outcomes` pins ROLL and BUY_DEVELOPMENT_CARD via
`action_record`, so our search is a deterministic, exact expectimax where
AB's is noise. `test_env.py::test_batched_search_matches_recursive` guards
both properties. We do **not** patch the opponent: the target is
`AlphaBetaPlayer` as shipped.

**Iteration 0 (running unattended via `run_it0.sh`, log
`checkpoints_value/it0.log`):** AB-vs-3xAB calibration (300 games), 5,000
`ab,ab,ab,ab` games, train `v0.pt`, `v0` vs 3x AB (300 games). Decision rule:
iterate unless v0's Wilson upper bound is below the AB baseline's point
estimate. Results go here when they land.

| Stage | Result |
|---|---|
| Calibration: `--player ab` vs 3x AB, 300 games, seeds 0-299 | **79/300 = 26.3%** [21.7%, 31.6%] — matches the 25% symmetry expectation; no seat bias, evaluator path sound |
| `gen_games.py --lineup ab,ab,ab,ab --games 5000` | 4h 0m at 0.35 games/s on 7 workers; 754,800 samples (151/game), 0 games without a winner |
| `train_value.py`, first config (no regularization, 10 epochs) | **memorized**: train 0.028, held-out **2.12** vs the constant base-rate loss 0.562; already 0.61 after epoch 0. Calibration: predicted 0.98 → actual 0.51 |

### The value net memorizes games; what fixed it

Sweep on the same 754k samples (by-game 10% held-out, 4 epochs, held-out
checked every 90 optimizer steps), best held-out BCE:

| Config | Best held-out | Where |
|---|---|---|
| Logistic regression | 0.418 | end (still improving slowly) |
| 3x512 MLP as shipped | 0.421 | step 90, then 1.58 by epoch 4 |
| 3x512, static map features masked | 0.419 | step 180, then 1.05 |
| 3x512, wd 1e-4, dropout 0.3 | 0.416 | step 180, then 0.75 |
| **3x512, wd 1e-4, dropout 0.3, static masked** | **0.408** | step 180, then 0.56 |
| 3x128, dropout 0.3, static masked, lr 3e-4 | 0.410 | step 540, then 0.47 |

Two readings. (1) The signal is real and mostly linear: a logistic regression
beats the base rate by a wide margin, the best MLP only by a little more.
(2) Every MLP peaks within half an epoch and then memorizes. The 206 raw
tile/port one-hots uniquely fingerprint a map, and all ~150 samples from a
game share that map and its outcome, so "this map → this winner" is the
cheapest fit. 5,000 games is ~5,000 bits of outcome signal against a
1M-parameter net. **Masking the static features at the net's input +
dropout 0.3 + weight decay 1e-4 + early stopping on held-out** is now the
default in `value_net.ValueNet` / `train_value.py`. Retrained `v0.pt`:
best held-out **0.412** at step 270, calibrated (top bucket predicted 0.90
vs actual 0.87).

**Implication for the speed-up work:** more games is the lever that
actually adds information, not more epochs or more capacity. Denser
targets (final VPs of all four players, or AB search values as
distillation targets) would add bits per game and are the cheap
complement to faster generation.

### Iteration-0 gate: NOT met — and why

```
uv run python evaluate.py --player vnet:checkpoints_value/v0.pt --opponent alpha_beta --games 300
vnet:checkpoints_value/v0.pt: 18/300 wins = 6.0%  Wilson 95% CI [3.8%, 9.3%]  vs alpha_beta
```

vs the AB-in-seat-BLUE baseline of 26.3% [21.7%, 31.6%]. The plan's rule
(stop and debug if v0's upper bound is below the baseline's point estimate)
fires. Diagnostics, same afternoon:

| Probe | Result |
|---|---|
| `v0` vs 3x WeightedRandom, 105 games | **81.9%** [73.5%, 88.1%] — PPO's old ceiling, far below VFP 98% / AB ~99% |
| 189 BLUE decisions in AB-vs-AB games: `ValueNetPlayer` picks AB's exact action | **37%** (VFP's: 34%) |
| … agreement on action *type*, by AB's type | BUILD_ROAD 56/59, BUILD_SETTLEMENT 22/23, BUILD_CITY 7/7, MOVE_ROBBER 14/14, DISCARD 35/35, **MARITIME_TRADE 20/34, END_TURN 8/17** |
| Root sibling spread of the net's 1-ply values | median 0.029 win-prob, min 4e-5 |

So the search is fine (verified exact) and the net is calibrated on the
states it was trained on, but it is a poor *decision* evaluator: it agrees
on *whether* to build but not *where*, and it trades/holds resources wrong
(the END_TURN / MARITIME_TRADE rows). Mechanism: outcome regression on
expert games sees only the trajectory states. The counterfactual siblings
a search compares — "didn't build", "traded the wheat away", "the other
node" — are never in the data (AB always builds, so their outcomes are
never observed), and the net's values for them are just the parent's value
plus noise. A calibrated win-probability is not the same thing as a
ranking of siblings, and search needs the ranking.

**What would fix the evaluator** (not yet built, ordered by expected
payoff per effort):

1. **Sibling-ranking signal from AB's own search.** Record, for a subset of
   decisions in AB games, the pinned child states of every legal action and
   AB's chosen one; add a listwise loss (`softmax` over the net's child
   values must put AB's choice on top) next to the outcome loss. Directly
   teaches the missing discrimination; data comes free with the games
   (the search is already run). Storage is the constraint (~15 states ×
   1030 × 2 B per decision) — subsample decisions.
2. **Expert iteration proper**: generate games with `ValueNetPlayer` itself
   so its own mistakes become on-distribution states with observed
   outcomes. Correct in the limit, slow from a 6% start; needs the
   generation speed-up to be practical.
3. **Deeper search** over any base_fn-quality evaluator — see the depth-3
   calibration below.

**Depth-3 calibration (35 games, `--player ab3`, i.e. `AlphaBetaPlayer(depth=3)`
vs 3x depth-2 AB):** 9/35 = **25.7%** [14.2%, 42.1%]. One extra ply of the
same heuristic buys nothing measurable (point estimate at symmetry; the
interval is wide, but there is no hint of the large effect that would make
"deeper search" a path to 50%). Consistent with AB's chance nodes being
random re-rolls (see the execute_spectrum bug above): each extra ply adds
noise as well as lookahead. **So the evaluator, not the depth, is the whole
game.** Lever 3 is dropped; levers 1 and 2 stand.

## 2026-09-01 — Rust rules engine (`catan_engine/`), conformance 100%

User decision after the gate miss: start the Rust engine now (every
remaining path needs many more games), with the ranking-loss work alongside.

**Scope of the port.** `catan_engine/` (PyO3 + maturin, ~1,100 lines of
Rust): state, move generation, apply_action, board (components, longest
trail, cuts), the 1030-feature encoder, and depth-d expectimax expansion
with pinned chance outcomes. **Not ported:** map generation and its RNG
(Python hands the map over once per game), players, the game loop, and
player-to-player trading (never enabled here). Build:

```
uv run maturin develop --release -m catan_engine/Cargo.toml
```

**Conformance (the deliverable metric, per `docs/RUST-ENGINE.md`):**
Python plays, Rust replays every `ActionRecord` with its pinned result, and
after *every* step the legal-action **set** and a full state snapshot
(hands, decks, buildings, roads, components in list order, longest-road
bookkeeping, prompt/turn flags) must be equal (`rust_bridge.state_spec`
vs `State.snapshot()`).

| Lineup | Games | Steps | Match after every step |
|---|---|---|---|
| 4x RandomPlayer | 40 | 46,645 | **40/40** |
| 4x WeightedRandomPlayer | 15 | 9,348 | **15/15** |
| 4x ValueFunctionPlayer | 4 | 1,206 | **4/4** |

Encoder: 552 (state, perspective) pairs equal to `encode_for_value` within
1e-6. Search: same leaf count and same chosen action as the Python
expansion on 25 decisions (`test_env.py`, three new checks).

**Quirks that had to be reproduced to get there** (all found by the
oracle, none by reading): the dev deck pops from the *end* (`list.pop()`),
so a pinned draw must remove the last occurrence; the two halves of a cut
enemy component are appended in networkx's adjacency insertion order, not
sorted node order — component list order is observable through later
`_get_connected_component_index` lookups, so `STATIC_GRAPH`'s neighbor
order is passed in from Python; the longest-road holder after a cut is
recomputed by a dict `max` (first max in seating order, can award below
5); `dfs_walk` enters enemy nodes; `iter_players` is a cyclic rotation.
`Vec<u8>` crosses PyO3 as `bytes`, not a list.

**Speed, uncontended (`ValueNetPlayer` seat, random net):**

| Path | s per seat-game vs 3x WR |
|---|---|
| Python expansion (`decide_python`) | 3.57 |
| **Rust expansion (`decide_rust`)** | **0.71** (5.0x) |

Per decision: Rust `expand` 1.2 ms (was 81 ms contended in Python);
per-decision `state_spec` conversion 0.1 ms; the torch forward over ~230
leaves is now **6.7 ms — the dominant cost**. A 3x value-net + 1x AB game
runs in 1.7 s. Next lever is therefore the forward pass (cross-game
batching on the XPU from a Rust-driven game loop, or a cheaper net), not
the engine.

### Generation profile after the port, and the two next levers

3x `ValueNetPlayer` (Rust) + 1x Python `AlphaBetaPlayer`, uncontended:
**3.97 s/game, of which the Python AB seat is 74%**; Rust `expand` 3%; the
rest is the torch forward. `gen_games.py` with that lineup: **1.34 games/s**
on 7 workers (iteration 0's 4x-AB lineup ran at 0.35).

**Lever A — `RustAlphaBetaPlayer` (`--player rab`, `value_net.py`):**
`base_fn(DEFAULT_WEIGHTS)` ported to `catan_engine/src/heuristic.rs`
(production with robber, level-1 road reachability, hand synergy,
blockable tiles, buildable nodes, longest road, dev cards, knights) and an
exact depth-2 expectimax over it. Parity: **0.0 relative error on 676
(state, perspective) pairs** against Python `base_fn`. Speed: **0.03
s/game vs 3.06** for the Python AB seat against 3x WR (100x). It is a
generation-only opponent — exact chance nodes make it a slightly different
(and, if anything, stronger) player than the shipped one, so the gate
keeps the Python `AlphaBetaPlayer`. Strength check, `--player rab` vs 3x
Python AB, 105 games: **21.0%** [14.3%, 29.7%] — parity within the
interval (symmetry is 25%); exact chance nodes did not make it measurably
stronger. Fine as a generation opponent of AB's class.

**Lever B — the forward pass.** Batch 230 (one decision's leaves), measured
while a 7-worker generation run was contending:

| Net / device | ms per decision | µs per leaf |
|---|---|---|
| 3x512, CPU 1 thread | 12.0 | 52 |
| 3x512, XPU (incl. transfer) | 6.0 | 26 |
| **3x256, CPU 1 thread** | **4.3** | **19** |

Width above 128 bought nothing on held-out loss in the sweep above, so
`train_value.py --hidden` now defaults to 256 (loading infers the width
from the checkpoint). Per-decision XPU is not a win at this batch size;
it becomes one only with cross-game batching from a Rust-driven game loop
(batch ≥2048: 1.6M samples/s), which is the next speed step if needed.

## 2026-09-01 (late) — what the value net was missing, and the residual design

**Sibling-ranking pairs alone did not help.** `v1_interim` (iteration-0
outcomes + 76k AlphaBeta chosen-vs-other pairs; held-out pair accuracy
0.79) scored **3.8%** [1.5%, 9.4%] vs 3x AB — no better than v0.

**Diagnostic that explained it** (190 BLUE decisions in AB games; all
deterministic children of each decision scored by the net and by AB's own
`base_fn`):

| Net | top-1 agreement with `base_fn` | all-pairs ordering agreement |
|---|---|---|
| v0 (outcomes only) | 22% | 61% |
| v1_interim (+ pairs) | 35% | 71% |

By `base_fn`'s chosen type: BUILD_ROAD 5/48 and 9/48, MARITIME_TRADE 0/15
and 4/15, DISCARD 11/63 and 23/63. Road placement was the tell: with the
raw tile features masked (the memorization fix), the net **cannot see
where a road leads** — `base_fn` uses reachable production at 0/1/2 roads
for exactly that.

**Fix 1 — heuristic-summary features.** `catan_engine` now appends
`base_fn`'s own terms to the encoding (per relative player: production
score, reachable production at 0/1/2 roads, tiles touched; plus p0's hand
synergy; 21 features, N_FEATURES 1051), each parity-tested against
catanatron's `value_production` / `reachability_features`. Old 1030-wide
datasets and checkpoints are obsolete; regenerating is now cheap.

**Speed after the Rust AlphaBeta seat:** `gen_games.py --lineup
rab,rab,rab,rab` runs at **34.6 games/s** on 7 workers — 4,000 games in
116 s, vs. 4 h 0 m for iteration 0's 5,000 (≈100x). It records 153
outcome samples, 71 AB chosen-vs-other pairs and 46 sibling sets per game.

**Fix 2 attempted — sibling-ordering distillation.** Sibling sets (up to 6
deterministic children, `base_fn` value of each from a random
perspective) with an all-pairs logistic ordering loss. Held-out top-1
agreement stalls at **0.44** (v2, combined losses) and **0.48** trained
on that loss alone. Cause: `base_fn` is lexicographic (weights 3e14, 1e8,
1e4, 1e3, ...). A bounded logit trained with a logistic pair loss cannot
express million-to-one priority ratios, so it can't reproduce the
ordering even though every term is now an input feature.

**Exact depth-3 over `base_fn` (`--player rab3`)**: 30/105 = **28.6%**
[20.8%, 37.8%] vs 3x AB (depth-2 `rab`: 21.0%). Depth helps a little
with exact chance nodes, nowhere near 50%. Confirms the evaluator is the
lever.

**Design that follows (v3): a smooth stand-in for `base_fn` as the net's
prior, residual learned from outcomes.** `smooth_base_fn` (Rust) /
`value_net.smooth_heuristic` (torch, parity 2e-5 on 676 pairs): the same
terms in the same priority order with weight ratios of ~3-10 instead of
~1e6 — `10·VP + 3·(prod − enemy prod) + 1·reach1 + 0.5·synergy +
0.1·buildable + ...`. `ValueNet.forward = alpha · smooth_heuristic(x) +
mlp(x)` with the MLP's last layer zero-initialized, so a fresh net plays
exactly like the smooth heuristic and training only learns corrections.
Calibration of the prior itself: `--player rsab` vs 3x AB, below.

**v2 gate (heuristic-summary features + outcome + aux + pair + sibling
losses, trained on 4,000 `rab` games, 300 games vs 3x Python AB):**

```
vnet:checkpoints_value/v2.pt: 56/300 wins = 18.7%  Wilson 95% CI [14.7%, 23.5%]  vs alpha_beta
```

Up from 6.0% (v0) and 3.8% (v1_interim). Not parity (26.3%) yet, but the
first net that plays in AlphaBeta's league; the features were the missing
piece, the ordering losses the second.

**The smooth prior is a bad player: `--player rsab` (exact depth-2 search
over `smooth_base_fn`) = 6/105 = 5.7%** [2.6%, 11.9%] vs 3x AB, while the
lexicographic `rab` scores 21.0% with the identical search. It agrees
with `base_fn`'s top child on 96.7% of sibling sets, and with `rab`'s
depth-2 decision on 84% of real decisions — but the 16% it gets wrong are
the ones that decide games: robber placement (19/40 differ), which road
(16/82), trade vs end turn (9/64). Those are decided by `base_fn`'s tiny
terms (a pip of production is 2.8e6 vs. hand synergy ≤ 1e2), and a
bounded-ratio stand-in cannot be both lexicographic and a trainable logit.
The prior is switched off (`ValueNet.PRIOR_SCALE = 0`), v3/v4 (residual
designs) are not pursued beyond their gates. Lesson recorded: **don't
smooth AlphaBeta's heuristic; learn the choice.**

**Next: listwise top-1 sibling loss.** Ask the net only for the *choice* a
`base_fn` search makes among a decision's children (argmax of
`base_fn(p0)` when p0 decides, argmin — the opponent's worst-for-p0 reply
— otherwise), as a softmax cross-entropy, instead of the all-pairs ordering
that demanded million-to-one gaps. Data regenerated with the decider flag
(`sib_isp0`). v5 gate below.

**v4 gate** (smooth prior at fixed scale 0.1 + residual MLP, outcome + aux +
pair + all-pairs sibling losses, 4,000 `rab` games):

```
vnet:checkpoints_value/v4.pt: 64/300 wins = 21.3%  Wilson 95% CI [17.1%, 26.3%]  vs alpha_beta
```

Best so far; the interval reaches the AB baseline's point estimate
(26.3%). So the prior is a poor *player* on its own (5.7%) but a useful
*initialization*: the residual repairs its tiny-term decisions. Both
v2 (18.7%, no prior) and v4 sit in the same band; neither is parity yet.

**v5 gate — AlphaBeta parity** (listwise top-1 sibling loss, no prior,
outcome + aux + pair losses, 4,000 fresh `rab` games; held-out sibling
top-1 0.575, up from 0.44 with the all-pairs loss):

```
vnet:checkpoints_value/v5.pt: 76/300 wins = 25.3%  Wilson 95% CI [20.7%, 30.5%]  vs alpha_beta
```

vs. AlphaBeta itself in the same seat: 26.3% [21.7%, 31.6%]. Progression
on the same 300-game gate: v0 6.0% → v1 3.8% → v2 18.7% → v4 21.3% →
**v5 25.3%**. Two things account for it: `base_fn`'s terms as input
features (the net can *see* what AlphaBeta values) and asking the net for
the *choice* among siblings rather than the full lexicographic ordering.
Total generation cost of the winning dataset: 94 seconds.

Next: the expert-iteration loop (`run_exit.sh`: 2 value-net seats + 2 Rust
AB seats per game, retrain on everything, gate each round) to move from
parity toward the >50% M4 gate — the on-distribution outcomes of the net's
own play are what can exceed the teacher.

**Iteration 7** (`run_exit.sh`: 4,000 games of 2x v5 + 2x `rab`, 2.6
games/s; retrain on it2 + it3 + it7 warm-started from v5):

```
vnet:checkpoints_value/v7.pt: 82/300 wins = 27.3%  Wilson 95% CI [22.6%, 32.6%]  vs alpha_beta
```

First net above AlphaBeta's own point estimate in this seat. From
iteration 9 on, sibling sets recorded at value-net decisions are labeled
with the net's *own* search choice (from its perspective) instead of
`base_fn` — the expert-iteration improvement step proper; AB-seat
decisions keep the `base_fn` labels.

## 2026-09-02 — two OOM classes, a training-target bug, and the Rust arena (generation 5.4 → 16.8 games/s)

**What killed the box (kernel log of the previous boot).** Two different OOMs:

| When | Process | Cause | Status |
|---|---|---|---|
| 00:11, 00:13 | one `train_value.py`, 26 GB RSS | unbudgeted load of 4 iterations of data, `np.concatenate` doubling it | fixed by the budget commits (c25ff7b..7543b7b) |
| 00:36, 00:45 | seven `gen_games.py` workers, **5-6 GB each**, ~1 GB each swapped | `rust_bridge._MAP_CACHE` (dict keyed by `id(map)`) held every game's map + `Ctx` forever | fixed: one-entry cache compared with `is` (the `Encoder` pattern) |

Probe, one worker, 12 games: `rab x4` +0.5 MB/game; `vnet x2 + rab x2` **+15.3 MB/game**; the same with the
cache cleared **+0.0**. 570 games/worker × 15 MB = the observed 6 GB. After the fix: +63 MB after 10 games, flat
through 40. The swapping also explains why it7/it8 generation ran at 2.5 games/s while it9's fresh workers ran 5.4.
A worker that dies leaves `imap_unordered` hanging forever — that is why the log just stops.

**Training-target bug (train_value.py, found by the audit).** When the sample budget subsampled a shard, the
auxiliary targets (final VPs, turns left) were appended *whole*, so `auxd[idx]` indexed unrelated rows. Dormant
until v8, the first run where the budget bit (2.5 M samples > 1.5 M): **v8's auxiliary heads trained on misaligned
targets** through the shared trunk. Fixed (subsampled with the same index, asserted). v8 gated 27.0% regardless,
so the win head survived it; v9 warm-starts from v8 and re-fits the aux heads on correct targets. Also fixed: the
sibling budget counted sets in shards that were then skipped for lacking `sib_isp0` (it2), so 89 k landed instead
of 120 k; and the feature-width check materialized every shard's `X` (6.7 GB of reads for a scalar) — now read
from the `.npy` header.

**Generation profile (single process, `vnet x2 + rab x2`, v8, uncontended).** Per value-net decision: `rust_state`
0.05 ms, Rust `expand` 2.09 ms (708 leaves on average here), **torch CPU forward 6.31 ms = 68% of wall**, backup
0.01 ms; game loop + rab seats + sampling 60 ms/game (8%). 76 value-net decisions per game.

**The CPU forward depends on which core the worker lands on.** Lunar Lake has 4 P + 4 E cores; the 3x256 forward
at batch 708, one thread: **8.9 ms on a P-core, 52 ms on an E-core**, and with 7 workers three of them live on
E-cores. The XPU does the same batch in 0.59 ms alone (1.6-2.7 ms with 7 processes sharing it), and at batch
7-16 k **0.66 µs/row** (1.5 M rows/s) including transfer. The earlier note "per-decision XPU is not a win at this
batch size (6.0 ms)" was measured under a contending run and is wrong today.

### The arena: Rust game loop + one forward per step (`catan_engine/src/arena.rs`, `arena.py`)

`catan_engine.Arena` holds G games; `step(values)` resumes every parked game from the previous forward, then
advances all games in parallel (rayon) until each ends or a value-net seat needs a forward, at which point its
depth-2 leaves are parked; `fill(buf)` copies all parked leaves into a Python-owned buffer; Python runs one
forward over them. `rab` seats use `decide_heuristic` in Rust; chance outcomes come from the state's own RNG
(`apply(action, None)`). The recorder mirrors `gen_games.StateSampler` one-for-one (samples, chosen-vs-other
pairs, sibling sets with `base_fn` or self-play one-hot labels) and writes the identical shard schema, so
`train_value.py` is untouched. Map generation, deck shuffle and seating stay in Python: a fresh catanatron `Game`
per seed is handed over once. `gen_games.py` routes any lineup made of `vnet:`/`rab` seats through it (the
7-process path remains for `ab`/`vf`/`wr`); `evaluate.py --opponent rab` uses it for the proxy gate.

**Correctness: the mirror oracle** (`test_env.test_arena_games_replay_in_python`). The arena logs every
(action, outcome); catanatron replays them with the outcome pinned (`Game.execute(action, ActionRecord)`).
Every action must be legal where it was played, the final `state_spec` must equal the arena's final snapshot, and
the winner must agree — 6 games mixing `rab` and value-net seats pass. One replay artifact: catanatron's pinned
draw removes the *first* matching dev card while a live draw pops the last, so the replayed deck is a permutation
of the arena's; nothing else observes deck order, the test compares the multiset.

**Three things that had to be fixed to get the speed, each measured:**

| Step (batch 64-128) | Rust step | forward | games/s |
|---|---|---|---|
| first version: leaves concatenated into a fresh Vec each step | 27 ms parallel + **40 ms serial concat** (page faults on 136 MB) | 27 ms | 5.6 |
| persistent Python-owned buffer, filled in parallel; per-game leaf buffers reused | 23 ms + 4 ms fill | 27 ms | 10.1 |
| + pinned host buffer (pageable H2D copy blocked the host 8.3 ms; pinned non_blocking 0 ms) | same | 20 ms | 11.2 |
| + forward and its wait in a helper thread, two arenas ping-ponging | 30 ms (now 90% of wall) | **1-2 ms waited** | **16.0-16.7** |

Rayon thread scaling on this chip: 1 thread 94 ms, 8 threads 23 ms for the same parallel section (E-cores add
little; 6 threads is within noise of 8). The XPU forward itself stays at ~15 ms with up to 7 cores busy and jumps
to 40 ms only when all 8 are saturated (the submitting thread starves), which is why the helper-thread design
works while device-side overlap does not: **waiting on an XPU event recorded after forward A blocks until a
later-queued oneDNN matmul B also finishes**, on separate `torch.xpu.Stream`s or with `torch.xpu.Event` alike
(measured: A; sleep 20 ms; B; event-sync A = 38 ms, where an elementwise B gives 21 ms). Don't build on streams.

**End to end** (`gen_games.py`, `vnet x2 + rab x2`, 1,000 games, while the test suite ran alongside):
**16.8 games/s**, 158 samples / 36 pairs / 43 sibling sets per game (the Python path: 153 / 35 per rab seat / 46).
`rab x4`: **94.6 games/s** (Python loop: 34.6). Proxy gate `evaluate.py --opponent rab`: 300 `rab`-vs-`rab` games
in 3.7 s (25.0%, symmetry), **1,000 games of v8 vs 3x rab in 36 s: 28.0% [25.3%, 30.9%]**. Remaining cost is the
Rust step (expand ≈ 3 µs/leaf incl. the heuristic-summary features); the forward is hidden.

**Loop changes (`run_exit.sh`).** Generation is skipped only if the *last* shard exists (it9 had 4 of 8);
training uses the last 4 iteration dirs (budgets remain the memory ceiling); the 1,000-game `rab` proxy gate runs
every iteration (±2.7 pt) and the 300-game Python-AB gate — still the number reported here — every third
iteration. Cycle: ~4 min gen + 1.5 min train + 0.6 min proxy (+ 9.5 min AB gate every third) ≈ **6 min** vs 23-38.
Known, unchanged: the rank/sibling held-out split is the tail of the concatenated arrays, not by game.

**Progression on the 300-game Python-AB gate:** v0 6.0% → v1 3.8% → v2 18.7% → v4 21.3% → v5 25.3% → v7 27.3% →
**v8 27.0%** [22.3%, 32.3%] (AB itself: 26.3%).

### Iteration 9: self-labeled sibling sets hurt; the proxy gate caught what the AB gate could not

it9 (4,000 games of 2x v8 + 2x `rab` in the arena: 230 s, 17.4 games/s; train 77 s; proxy gate 36 s) was the first
round with sibling sets at value-net decisions labeled by the net's *own* search choice. Same 1,000 proxy seeds
throughout (v8: 28.0% [25.3%, 30.9%]):

| Net | Training data (all warm-started from v8) | vs 3x `rab`, 1,000 games | vs 3x Python AB, 300 |
|---|---|---|---|
| v9 (self-play sibling labels) | it3 + it7 + it8 + it9 | **20.7%** [18.3%, 23.3%] | 26.0% [21.4%, 31.2%] |
| v9a (`--self-sibs 0`: those sets dropped) | it3 + it7 + it8 + it9 | 25.2% [22.6%, 28.0%] | — |
| v9b (no it9 data; aux-target fix only) | it3 + it7 + it8 | **29.1%** [26.4%, 32.0%] | — |

Distilling the depth-2 choice of a parity-strength net into its own 1-ply ranking made it worse, not better
(v9 → v9a is the whole effect; v9a → v9b overlaps). Meanwhile the 300-game Python-AB gate read 26.0% for v9 —
indistinguishable from v8's 27.0% — so it would have let the regression through; the ±2.7-point proxy is now the
per-iteration decision signal. The loop continues from **v9b as `v9.pt`** (the self-labeled net is kept as
`v9_selfsib.pt`) with `train_value.py --self-sibs 0`; the arena still records the self-play sets, the flag drops
them at load. Sibling labels stay `base_fn`'s: the teacher's evaluator is still the best ranking signal we have.

## 2026-09-02 (later) — the arena OOMed the box too: the XPU caching allocator, and a stage that would not die

**Process table at the 02:25 kill** (kernel log): `gen_games.py` (arena, it11, ~1,200 games in) at **7.1 GB
resident + 4.7 GB swapped**, plus an older Python at 3.6 GB + 1.2 GB that still held the GPU (`xe: Timedout job
... in python3 [18011]`). Everything else was tiny. Two causes:

1. **The XPU caching allocator over-reserves by 10-40x.** Tracker over 2,000 arena games: RSS 4.9-5.7 GB while
   `torch.xpu.memory_reserved()` sat at **4.4-5.9 GB for 0.1-0.5 GB allocated**. Every step's forward has a
   different row count, so freed blocks never fit the next request and new ones keep being reserved — and on an
   iGPU "device" memory is host RAM. Standalone, 400 forwards of 25-60 k rows: raw sizes **1,992 MB reserved**;
   rows padded to a multiple of 16,384 **680 MB**; raw with `PYTORCH_ALLOC_CONF=expandable_segments:True`
   **604 MB**. Under pressure the process swapped into zram (which is RAM) and the GPU driver began timing out
   jobs. The 1,000-game smoke test peaked at 2.7 GB and never showed it.
2. **A stalled generation survived `pkill`.** The first it11 gen wrote its last shard at 02:15:00 and then nothing
   for four minutes: grown, swapping, stuck in the GPU driver (the job-timeout message names it). It stayed
   resident next to the restarted loop's gen. Two 6-12 GB GPU processes plus the desktop is 30 GB.

**Fixes, measured (tracker, `vnet x2 + rab x2`, batch 128, 4,000 games):** `arena.py` sets
`PYTORCH_ALLOC_CONF=expandable_segments:True` before torch is imported and pads every forward to a multiple of
16,384 rows (`ROW_BUCKET`; the padding is stale data, sliced off); pinned host buffers grow in the same buckets;
per-game Rust leaf buffers shrink after an outsized expansion. Result: **RSS flat at 2.7-4.4 GB over 4,000 games,
reserved 1.0 GB** (1.8-2.7 GB when the env var is only set inside `arena.py`, after the caller has imported torch —
so `gen_games.py`, `evaluate.py` and `run_exit.sh` set it first; was 4.4-5.9 GB and climbing to 11.8 GB under pressure); games/s unchanged; the 1,000-seed
proxy result for v10 moved by one game (282 → 283 wins: a tie-break under the padded batch shape), the arena
replay oracle still passes.

**Guards, so the box can never go down again (`run_exit.sh`):** every stage runs as
`systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0 ...` — a runaway stage is OOM-killed inside its own
cgroup (verified: a 3 GB allocation under a 2 GB cap dies with 137, 1 GB passes) and `|| exit 1` stops the loop;
the loop refuses to start any stage while a `gen_games.py` / `evaluate.py` / `train_value.py` process exists;
its pid is in `checkpoints_value/run_exit.pid` — stop it with `kill $(cat ...)`, never `pkill -f run_exit`
(which matches, and killed, the invoking shell twice tonight).

**Proxy at 4,000 games (±1.4 pt), same seeds:** v8 27.0% [25.6%, 28.3%], v9 27.2% [25.8%, 28.6%], v10 27.4%
[26.0%, 28.8%]. The 1,000-game readings of 28.0 / 29.1 earlier were noise-high; three expert-iteration rounds
with `base_fn` sibling labels are flat at the noise floor, and the self-labeled v9 (20.7% on 1,000) remains the
one clear regression.

## 2026-09-02 (afternoon) — iterations 11-25 under the caps: expert iteration climbs ~4 points, then saturates near 31% vs `rab`

Cycle under the new guards: gen 4,000 games in ~285 s (14 games/s with the padded forwards), train ~80 s, proxy
gate(s) ~2.5 min each, Python-AB gate 10 min every third round. No OOM, no stall, every stage inside its cgroup.

**Rounds 11-15, sequential warm start from v(k-1), 4,000-game proxy on seeds 0-3999 (v8 27.0%, v9 27.2%, v10
27.4% on the same seeds):** v11 27.9%, v12 25.7%, **v13 30.5%**, **v14 31.8%**, v15 27.1%. Python-AB gate: v12
28.3% [23.5, 33.7], v15 27.3% [22.6, 32.6]. Successive checkpoints swing 3-5 points on the proxy while early
stopping (composite of held-out BCE, pair accuracy, sibling top-1) keeps picking the step-90 checkpoint — the
selection signal does not track play. So an acceptance gate was added: the best-by-proxy checkpoint is the
incumbent generator and warm start; a challenger replaces it only if it wins more proxy games.

**Rounds 16-18, incumbent v14 scored once on the fixed seeds (1,271):** challengers 1,127 / 1,248 / 1,107 — all
rejected, all below. That is the winner's curse: the incumbent's number is the max of noisy draws. Fixed by
**head-to-head on fresh seeds each round** (both incumbent and challenger play 4,000 games on seed
k·10⁶ + 7; the incumbent's fresh scores were 30.4-32.1%, i.e. ~1 point below its selected 31.8).

**Rounds 19-25, fresh-seed head-to-head (incumbent vs challenger, same seeds):**

| k | incumbent | challenger | decision |
|---|---|---|---|
| 19 | v14 30.4% | v19 30.8% | accepted (coin-flip margin) |
| 20 | v19 32.1% | v20 30.2% | rejected |
| 21 | v19 31.5% | v21 31.2% | rejected; v21 vs Python AB 29.7% [24.8, 35.1] |
| 22 | v19 31.6% | v22 25.2% | rejected (a bad training draw) |
| 23 | v19 31.8% | v23 30.2% | rejected |
| 24 | v19 31.2% | v24 30.5% | rejected; v24 vs Python AB 30.3% [25.4, 35.8] |
| 25 | v19 30.4% | **v25 32.4%** | accepted — final incumbent |

**Final incumbent v25 vs 3x Python AlphaBeta, 1,000 games (seeds 0-999, under the cap, 31 min):**

```
vnet:checkpoints_value/v25.pt: 309/1000 wins = 30.9%  Wilson 95% CI [28.1%, 33.8%]  vs alpha_beta
```

The symmetry baseline for one seat of four is 25.0% (AB itself measured 26.3% [21.7, 31.6] at 300 games), so this
is the first interval that excludes parity: **the value-net player is measurably stronger than AlphaBeta**, by
about 6 points of seat win rate. It is not the >50% M4 gate.

**Reading.** Against 3x `rab` the line went from ~27% (v8-v11) to ~31-32% (v14 onward) and then flat: seven
challengers trained from a ~31% incumbent on fresh on-policy data scored 25-32%, with one accepted at a
2-point margin. Expert iteration with `base_fn` sibling labels and outcome/pair losses is worth ~4-5 points over
AlphaBeta-parity and no more at this data volume and net. The M4 gate is >50%; more rounds of this loop will
not get there. Candidates, in FINDINGS' earlier order: a richer per-game signal (final VPs are in; AB search
values as distillation targets are not), and revisiting the evaluator design (the net still cannot see what
depth-2 sees). The pipeline is now cheap enough (6-8 min/round, safe) that these are afternoon experiments.

## 2026-09-02 (evening) — search depth is not the lever: every deeper / reshaped tree scores *below* depth 2 with the same net

Setup for all rows: `v25.pt` in seat BLUE vs 3x `rab` (Rust AlphaBeta, depth 2), **the same 1,000 seeds (0-999)**,
arena (`evaluate.py --opponent rab`). ±2.8 pt at 1,000 games. The arena now takes a separate `rab_depth`
(before this the half-built `vnet3:` spec would have deepened the opponents too).

Catanatron's `depth` counts **actions, not turns**: depth 2 = my action + (my next action | the opponent's ROLL).
Depth 3 is the first depth at which an opponent *acts*. Leaf counts at depth 3 (102 BLUE mid-game decisions):
median 244, p90 10.6k, p95 160k, max **428,620** rows (1.8 GB of features) — **8% of decisions hold 95% of all
leaves**, and the first depth-3 run was OOM-killed in its cgroup at 12.6 GB after 30 s. Fix: a per-decision leaf
cap (`search.rs expand_into(max_leaves)`, `VNET_MAX_LEAVES`, default 20,000): a tree deeper than 2 that overflows
is abandoned and redone one ply shallower; depth-2 trees are never capped (verified: capped depth-3 expansion ==
depth-2 expansion on three overflowing states). With the cap, depth 3 costs ~2x depth 2 (4 min / 1,000 games).

| Search (same `v25.pt`) | vs 3x `rab`, seeds 0-999 |
|---|---|
| **depth 2 (as trained, the incumbent)** | **307/1000 = 30.7%** [27.9, 33.6] |
| depth 3, paranoid min at the opponent's decision, cap 20k (`vnet3:`) | 249/1000 = **24.9%** [22.3, 27.7] |
| own-turn depth 2: opponent decisions are leaves, an end-turn branch always finishes with the ROLL chance node (`vnet2o:`) | 244/1000 = **24.4%** [21.8, 27.2] |
| own-turn depth 3 (`vnet3o:`) | 282/1000 = **28.2%** [25.5, 31.1] |

Three readings.

1. **Min over the opponent's replies hurts.** A min over 10-15 replies scored by a noisy evaluator is biased low,
   and by a different amount per branch (branches differ in how many replies they open), so every end-turn branch
   is mis-ranked against the keep-acting branches. `rab3`'s +7.6 over `rab` (FINDINGS, 105 games) does not transfer:
   `base_fn` is deterministic, the net is not.
2. **The evaluator is co-adapted to the depth-2 tree shape.** Own-turn depth 2 differs from depth 2 in exactly one
   place — after "build, END_TURN" the leaf is the post-roll state (averaged over 11 rolls) instead of the pre-roll
   state — and that alone costs 6 points. So the net's values are **not consistent across state phases** (pre-roll
   vs post-roll, my turn vs theirs): v25's numbers only rank correctly for the leaf distribution it was trained
   inside (25 rounds of depth-2 expert iteration). Swapping the search under a fixed net is not a valid test of the
   search; the loop would have to be re-run with the new search for the net to re-adapt — hours per variant with
   no evidence any variant is better in the limit.
3. **The lever is the evaluator's consistency, not depth.** The failure mode in (2) is the thing search-value
   distillation targets fix directly: V(pre-roll) must equal E_roll[V(post-roll)] and V(s) must equal the value
   of its best child, on the very states the search visits. Built this session (below); depth work is parked.
   The `vnetN:` / `vnetNo:` specs, the cap and the split `rab_depth` stay (cheap, tested) for when the net is
   consistent enough to try again.

**Search-value distillation rows ("TreeStrap-lite", `arena.rs Recorder::record_tree`).** At each value-net decision,
with probability `--ts-p`, the arena records the root (from the decider's perspective, value = the search's root
value) and up to 5 random deterministic children (value = that child's backed-up expectation) — soft targets in
[0, 1], on states the trajectory never visits. `train_value.py --ts-weight w` adds `BCE(net(ts_x), ts_v)`; shards
without the rows load as before. Not v9's self-labels: v9 turned the search's *argmax* into a one-hot listwise
label and lost 7 points; this regresses chance-averaged *values*. it26 (4,000 games, `--ts-p 0.25`): ~95 rows per
game, +0.4 GB per iteration on disk. Results below.

**it26 results — both challengers rejected, the distillation net badly.** Fresh-seed head-to-head, 4,000 games each
vs 3x `rab`, seed 26000007 (the loop's protocol):

| Net (all warm-started from v25) | Training data | vs 3x `rab` |
|---|---|---|
| **v25 (incumbent)** | — | **1214/4000 = 30.3%** [28.9, 31.8] |
| v26_alldata: same budgets, **all 21 iterations** (84k games instead of 16k) | it2..it25 | 1146/4000 = 28.6% [27.3, 30.1] — rejected |
| v26ts: last 4 iterations + **search-value distillation** rows (`--ts-weight 1`, 300k rows) | it23..it26 | 932/4000 = **23.3%** [22.0, 24.6] — rejected |

Held-out numbers said nothing about this (v26ts: BCE 0.460 / rank 0.862 / sib top-1 0.596 vs the incumbent's
usual 0.45 / 0.86 / 0.60). Two conclusions:

- **Anything derived from the net's own depth-2 search makes the net worse**, whether as hard labels (v9, one-hot
  argmax: −7 pts) or as soft chance-averaged values (v26ts: −7 pts). The search is too shallow to know more than
  the net (depth 1 vs depth 2 with the same net, seeds 0-999: **27.0%** vs 30.7% — the search is worth ~4 points),
  so its values are the net's own biases plus noise, and regressing onto them is self-reinforcement. Bootstrapped
  targets (TD-leaf / TreeStrap) need a search that is genuinely stronger than the evaluator; ours is not. Recorded
  so nobody builds a third variant of this.
- **More distinct games from older, weaker generators is off-policy and slightly harmful** (−1.7 pts). The
  outcome signal is not data-starved at 16k games; it is the wrong kind of signal.

**So the net at 1-ply is already the player** (27% alone vs 25% symmetry; `base_fn` at 1-ply scored 10%), and every
remaining lever is a *better value target*: not the outcome bit (1 bit per game, shared by 150 states), not the
net's own search (self-referential), not `base_fn`'s ranking (caps at AlphaBeta). What is left is measured
continuation value: **rollout-labeled children** (`arena.rs Recorder::record_rollouts`, `--roll-p`, `--roll-m`) —
at a sampled decision of any seat, up to 6 deterministic children are each played out `roll_m` times by `rab` in all
four seats (own RNG stream), and the decider's win fraction is the target (`ro_x` / `ro_v`; trained with
`--ts-weight w --ts-key ro`). It is the value of the AlphaBeta continuation — the quantity a perfect evaluator would
need to beat AlphaBeta — measured on the sibling states the search compares. Cost and result below.

**it27 — rollout labels: the first new signal that does not regress, and the first net that does not memorize.**
`gen_games.py --lineup v25 x2 + rab x2 --games 4000 --roll-p 0.1 --roll-m 1` (one rollout per child: with a soft
BCE the information per rollout is the same and more states get covered): 40 min at 1.68 games/s (14 without
rollouts; a mid-game `rab x4` playout is ~110 ms CPU), **279,586 rollout-labeled rows** (70/game) next to the
usual samples / pairs / sibling sets. Train v27 = v25 warm start, it24-it27, `--ts-key ro --ts-weight 1`, the other
losses as in the loop. Early stopping picked **step 3150** (every earlier net peaked at step 90-270 and then
memorized) at held-out BCE **0.448** (the incumbent line sits at 0.45-0.46). Fresh-seed head-to-head, seed 27000007:

| Net | vs 3x `rab`, 4,000 games |
|---|---|
| v25 (incumbent) | 1304/4000 = 32.6% [31.2, 34.1] |
| **v27** (rollout rows, weight 1) | **1326/4000 = 33.1%** [31.7, 34.6] — accepted (coin-flip margin) |

Not a jump, but the first challenger in nine rounds that is not below the incumbent, from a single iteration's
worth of rows at weight 1. Weight / loss-mix sweep on the same data next (v27b/c/d), then more rollout iterations.

**Weight / loss-mix sweep on the same it24-it27 data, same seeds (v25 32.6%, v27 33.1%):**

| Net (v25 warm start) | losses | held-out BCE / pair acc / sib top-1 | vs 3x `rab` |
|---|---|---|---|
| v27b | outcome + aux + pair 0.5 + sib 1 + **rollout 3** | 0.441 / 0.846 / 0.604 | 1391/4000 = 34.8% [33.3, 36.3] |
| v27c | ... + rollout **10** | 0.438 / 0.801 / 0.575 | 1210/4000 = 30.2% [28.8, 31.7] |
| **v27d** | outcome + aux + rollout 3, **no pair / sibling losses** | 0.417 / 0.762 / 0.387 | **1528/4000 = 38.2%** [36.7, 39.7] |

**The `base_fn` imitation losses were the cap.** Every net since v2 carried AlphaBeta's chosen-vs-other pairs and
`base_fn`-labeled sibling sets; they were what lifted the line from 6% to parity (v0 → v5) and they are what held
it at ~31%: a net that must agree with `base_fn`'s ranking cannot rank better than `base_fn`. With a measured
value target on the same sibling states (rollouts), the imitation losses can be dropped: held-out outcome loss
falls to 0.417 (never below 0.45 before), agreement with `base_fn` collapses to 39% top-1 — and the player gains
5.6 points on the incumbent in one round. v27b/v27c show the same thing from the other side: the more rollout
weight next to the imitation losses, the more the two fight (0.5 → 34.8%, 10 → 30.2%).

`run_exit.sh` now generates with `--roll-p 0.1 --roll-m 1` and trains with `--rank-weight 0 --sib-weight 0
--ts-key ro --ts-weight $TS_WEIGHT` (default 3). Incumbent: `v27d`. Python-AB gate and the next rounds below.

**Second sweep, base_fn losses off, same data and seeds:**

| Net | losses | held-out BCE / rollout BCE | vs 3x `rab` |
|---|---|---|---|
| v27e | outcome + aux + rollout **1** | 0.410 / 0.417 | 1145/4000 = 28.6% [27.2, 30.0] |
| **v27d** | outcome + aux + rollout **3** | 0.417 / 0.416 | **38.2%** |
| v27f | outcome + aux + rollout **10** | 0.424 / — | 1345/4000 = 33.6% [32.2, 35.1] |
| v27g | outcome + rollout 3, **no aux heads** | 0.419 / — | 1162/4000 = 29.0% [27.7, 30.5] |

v27d and v27e are indistinguishable on every held-out number and 10 points apart in play; the weight curve
(1 → 28.6, 3 → 38.2, 10 → 33.6) is not monotone. Either the weight matters a lot in a way no held-out metric
sees, or a single training draw of this configuration has a ~±5-point spread — the loop already saw 3-5 point
swings between successive checkpoints. Seed replicates of v27d's exact configuration (below) settle which.

**v27d vs 3x Python AlphaBeta, 300 games: 112/300 = 37.3% [32.1%, 42.9%]** (v25: 30.9% at 1,000 games; AB
itself 26.3%). The proxy and the headline gate agree.

**Seed replicates of v27d's configuration, same data, same seeds:** v27d (seed 0) 38.2%, **seed 1: 1302/4000 =
32.6%** [31.1, 34.0], **seed 2: 1315/4000 = 32.9%** [31.4, 34.3]. Held-out numbers of the three are within noise of
each other. So one training draw of this configuration spreads over ~6 points, v27d is a favorable draw, and the
configuration's honest single-net gain over the incumbent is small. Training-draw noise, not the signal, is the
dominant error of a single net — which is also why the loop's rounds 15-25 swung 3-5 points on identical recipes.

**Weight averaging removes it: the soup of the three (`soup.py`, plain mean of the state dicts — same warm start,
same data, so they share a basin) scores 1715/4000 = 42.9%** [41.3, 44.4] on the same seeds — +4.7 over the best
single draw, +10.3 over the incumbent. `run_exit.sh` now trains `N_SEEDS` (default 3) nets per round from the
incumbent and soups them into the candidate. Fresh-seed confirmation, a 5-seed soup and the Python-AB gate below.

**Fresh seeds (28000007), head-to-head:** v27d_soup **1747/4000 = 43.7%** [42.1, 45.2] vs v25 1258/4000 = 31.4%
[30.0, 32.9] — +12.3 points, confirmed off the selection seeds. **A 5-seed soup (two more draws, seeds 3-4) scored
38.6%** [37.1, 40.1] on the same seeds: plain averaging is not monotone in the number of draws — some land in a
different basin and pull the mean down. `soup.py --greedy` (rank checkpoints by a 1,000-game arena proxy, add one
only if the soup's proxy does not drop — Wortsman et al.'s greedy soup) is the fix; result below.

**Greedy soup over the five draws** (`soup.py --greedy`, 1,000-game proxy on seeds 5000-5999): singles 36.8 / 34.4 /
33.0 / 28.4 / 26.7% (v27d, s2, s1, s4, s3); v27d + s2 → 42.5%, + s1 → **43.9% kept**, + s4 → 40.4% dropped, + s3 →
40.6% dropped. It recovers exactly the three-net soup and rejects the two bad draws — ~7 minutes, no human in the
loop. `run_exit.sh` uses it from round 29 (N_SEEDS=5).

**Round 28 (the new loop, first round; it28 generated by the single v27d, trained 3 seeds from v27d_soup, plain
soup):** v28 **1871/4000 = 46.8%** [45.2, 48.3] vs the incumbent's 1747/4000 = 43.7% on the same fresh seeds —
accepted. Rounds 29+ use the greedy 5-seed soup. Per-round table continues below.

| k | incumbent (fresh seeds) | challenger (greedy 5-seed soup) | decision |
|---|---|---|---|
| 29 | v28 46.8% | **v29 49.6%** [48.1, 51.1] (3/5 draws kept, 49.1% on selection seeds) | accepted |
| 30 | v29 49.0% | **v30 50.7%** [49.1, 52.2] (3/5 kept, 51.5% on selection seeds) | accepted |

**v30 vs 3x Python AlphaBeta, 300 games: 156/300 = 52.0% [46.4%, 57.6%]** — the first point estimate above the
M4 gate (>50%); the interval still includes 50%, a 1,000-game run is the confirmation. Loop paused after round 30
(user request: implement the generation speed-up first).

**Rules audit (user request, same evening):** see `docs/AUDIT-rules.md`. Headline: catanatron #378 (longest road with both
ends capped by enemy settlements) is present in both engines and undercounts by 2 in the common ordering; #376 and
#350 are fixed in the pinned commit; the bank-shortage rule deviates. Nothing changed yet — the fix touches catanatron
itself (fork) to keep the replay oracle.

**v30 vs 3x Python AlphaBeta, 1,000 games (seeds 0-999): 491/1000 = 49.1% [46.0%, 52.2%]** — at the gate, not
above it (the 300-game 52.0% was the top of its interval). Measured under catanatron `d3f4ad0` rules (before the
#378 fix below).

## 2026-09-02 (night) — generation 4.8x faster; catanatron #378 fixed in both engines

Plan and measurements in `docs/PLAN-gen-speed.md`; rules audit in `docs/AUDIT-rules.md`. Quiet machine, v30 x2 +
rab x2, 256 games (`ARENA_PROF=1`):

| | before | after |
|---|---|---|
| generation with rollouts (`--roll-p 0.1 --roll-m 1`) | 1.31 games/s (rust 299 ms/step) | **6.29 games/s** (63 ms/step) |
| generation without rollouts | 10.0 | 11.3 |
| `rab x4` | 94.6 | 132 |
| rab decision, exact depth 2 / rollout policy | 320 µs / 320 µs | 202 µs / **32 µs** |
| `base_fn` / `encode` | 0.30 / 1.4 µs | 0.17 / 0.67 µs |
| value-net `expand(2)` per leaf (Rust timers, `catan_engine.prof()`) | 4.95 µs | 2.53 µs (encode 2.0, children 0.2) |

What did it: (1) **the rollout policy searches depth 1 on robber prompts** (depth 2 elsewhere, no trades at the
second ply) — half of all rollout leaves were 7-roll states (~30 robber moves x 5 steal outcomes x the whole
post-roll action list); 97.7% agreement with the exact depth-2 choice on 300 decisions (robber 21/24, roads 45/48,
all else identical), 5.9x per decision. The `rab` opponent seats and every gate still use the exact search.
(2) Per-node production precomputed per map (`Map.node_prod`), `count_production` / `reachable_production` over
set bits, `buildable_node_ids(..).len()` → `count_ones()` — this is the `base_fn` / `encode` / `rab` speed-up.
A first pruning attempt (robber only onto enemy-adjacent tiles) was worth 1.03x: nearly every tile touches an
enemy building. A round is now ~gen 11 min + 5 trainings 8 min + greedy soup ~4 min + gates ~4 min ≈ **27 min**
(was ~60).

**catanatron #378** (a road capped by enemy settlements at both ends lost an edge at each end: 7 for a 9-edge
road in the common ordering) is fixed in a fork pinned in `pyproject.toml`
(`TSVRN9/catanatron@c61d218`, branch `fix-longest-road-capped-ends`: the trail may start and end at an enemy node,
never pass through one) and identically in `catan_engine/src/board.rs`; `test_env.py` has the scenario for both
engines and the replay oracles still hold. **Every number above this line was measured under the old rule**;
the incumbent is re-scored on fresh seeds by the loop, so the next rounds' incumbent numbers are the new baseline.

### Round 31 on the fast pipeline: the loss optimum and the best player have come apart

Three it31 variants, each 4,000 games from v30, five draws, greedy soup, gate vs v30 on fresh seeds (31000007,
under the fixed #378 rule; v30 = **2046/4000 = 51.1%** [49.6, 52.7] there):

| variant | gen | draws (1,000-game proxy, seeds 31500000) | greedy soup | gate |
|---|---|---|---|---|
| standard (`--roll-p 0.1`, new rollout policy) | 590 s | 52.0 (stopped at step 90 ≈ v30), 43.1, 42.6, 36.8, 35.5 | 1/5 kept, 52.0% | **48.8%** rejected |
| depth-1 rollout policy | 495 s | — | 2/5, 48.8% | **46.8%** rejected |
| **`--roll-p 0.3`** (957k rows, `--max-ts 900000`) | 1511 s | 51.4, 46.6, 45.8, 44.0, 40.7 | v30 + 2 draws: 54.3% (v30 alone 51.8%) | **2094/4000 = 52.3%** [50.8, 53.9] — accepted as **v31** |

Every draw that actually trained scored 8-16 points *below* the incumbent. Not the engine or the rule change
(old draws re-score the same under the new engine: v30_s1 46.4% vs 45.6%, v29 50.2% vs 49.0%), not the new
rollout labels (training on it28-it30 only, seed 1: **37.6%**), and monotone in the learning rate (1e-3 → 37.6%,
3e-4 → 44.3%, 1e-4 → 47.1%): the less the net moves from v30, the less it loses. Held-out BCE improves throughout.
So from v30 on, **descending the loss (outcome + aux + rollout values) makes the player worse**; v30's strength
came from play-selected weight averaging, not from the loss. The greedy soup seeded with the incumbent
(`soup.py --base`, now in `run_exit.sh`) keeps a round from regressing (v30 + it31_s2 → 52.2% vs 52.0% on the
selection seeds: a wash), but the loop as configured has plateaued at ~51% vs `rab` / 49% vs Python AB.
Rounds are now ~27 min, so the remaining levers are cheap to test.

- **Wider net from scratch** (hidden 512, 3 draws on it28-it31, best held-out ever at 0.401-0.406): **30.8-40.4%**.
  The warm-start lineage carries what the loss does not measure; width is not the lever.
- **3x denser rollout labels** (`--roll-p 0.3`, all 957k rows used): draws 40.7-51.4% (vs 35-43% at 0.1), and the
  incumbent-seeded greedy soup (v30 + two draws) gates at **52.3%** [50.8, 53.9] vs v30's 51.1% — the first proxy
  interval entirely above 50%. Accepted as v31. Generation at 0.3 costs ~25 min (contended) vs ~10.
  The loop's default is now `ROLL_P=0.3` with `--max-ts 900000`.
- **Pairwise ranking between rollout-labeled siblings** (`--ro-rank-weight 1`, 126k pairs from one round, labels
  from one rollout each): draws **23.6-43.9%** on the selection seeds (v30 51.5%). Binary single-rollout labels
  turned into hard pairwise targets are noise sharpened into labels — the v9 / v26ts failure again, from the
  other direction. Stopped after the first variant. Soft BCE on the same rows is the right use of them.

**v27d_soup vs 3x Python AlphaBeta, 300 games: 125/300 = 41.7% [36.2%, 47.3%].** Progression on this gate:
v0 6.0% → v5 25.3% (parity) → v25 30.9% → **v27d_soup 41.7%**. The M4 gate is >50%; the loop
(`run_exit.sh 28 40`: rollout labels, no `base_fn` losses, 3-seed soups, incumbent v27d_soup) is running.

## Prior art

- [Catanatron](https://github.com/bcollazo/catanatron) — the engine we build on.
- [settlers-rl](https://settlers-rl.github.io/) — best public deep-RL attempt. PPO,
  factored conditional action heads, attention over tiles, 128 processes / 640 concurrent
  games, ~450M decisions, ~1 month on 32 cores + RTX 3090. Still short of human experts.
  Their forward search was **inference-time only**. Read before attempting factored heads.
- [Deep Catan (Driss & Cazenave)](https://www.lamsade.dauphine.fr/~cazenave/papers/DeepCatanEvo.pdf) — cross-dimensional NN + PUCT.
