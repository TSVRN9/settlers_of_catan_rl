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

## Prior art

- [Catanatron](https://github.com/bcollazo/catanatron) — the engine we build on.
- [settlers-rl](https://settlers-rl.github.io/) — best public deep-RL attempt. PPO,
  factored conditional action heads, attention over tiles, 128 processes / 640 concurrent
  games, ~450M decisions, ~1 month on 32 cores + RTX 3090. Still short of human experts.
  Their forward search was **inference-time only**. Read before attempting factored heads.
- [Deep Catan (Driss & Cazenave)](https://www.lamsade.dauphine.fr/~cazenave/papers/DeepCatanEvo.pdf) — cross-dimensional NN + PUCT.
