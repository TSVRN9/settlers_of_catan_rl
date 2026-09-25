# Research: using the laptop's hardware better

Written 2026-09-23 during round 60's generation (`vnetx:v59` x2 + pool {rab3, uct5000, cvnet:v55}, `--roll-p 0.3
--roll-m 4 --roll-net own`, 16 threaded arenas x 8 games, `RAYON_NUM_THREADS=8`). The held-out jSettlers bench
(java + `jsettlers_server.py`, ~15% of a core) was also running, so it counts as a co-tenant in every live number here.

**Reading rule.** Each number is labelled **M** (measured here) or **I** (inferred from measured numbers, with the
arithmetic shown). Live numbers are passive: `/proc` schedstat, `perf record/stat -p`, xe sysfs, and DRM fdinfo.
The microbenchmarks ran under `nice -n 19`, pinned to one core, and used thread CPU time. They shared the machine
with the loop, so treat them as the loaded regime, not an idle one. Nothing touched the loop's processes, the venv or
the engine source. Scratch scripts are in `/tmp/claude-1000/hw/`, which is tmpfs and won't survive a reboot. The
microbenchmarks overlapped it60's shard 3, which logged 0.95 games/s against 1.06-1.08 for the shards before it.
GPU busy is the delta of the generator's DRM fdinfo `drm-cycles-ccs` over `drm-total-cycles-ccs`, cross-checked
against `/sys/class/drm/card1/device/tile0/gt0/gtidle/idle_residency_ms`.

## Summary

The box is **power-bound, not thermally bound, and the CPU is nearly full.** Generation uses 696% of 800. The P-cores
run 96-98% busy, the E-cores 83-85%. The package runs at its 33 W PL1: the iGPU reports `throttle/reasons: pl1` and
sits at its 800 MHz floor (max 1950). The CPU cores run about 20% below their rated maximum clocks. Every watt the GPU
or NPU draws therefore comes out of CPU clocks. "Idle accelerator" is not free capacity here.

The one clear waste is the XPU leaf forward: **64% of the rows it computes are padding** (`ROW_BUCKET = 16384`
against ~6,000 real rows per forward). A smaller bucket is bitwise exact. The ~77% net-rollout forward should **stay on the CPU**: the GPU can't absorb
its leaf rate at the throttled clock, and the NPU can't compile a model on this install.

## 1. Where the capacity goes (live generation, 20 s windows)

| | value | |
|---|---|---|
| Generator process CPU | 694-696% of 800 | M (`/proc/<pid>/task/*/schedstat`, `/proc/stat`) |
| Machine busy per core | cpu0-3 (P) 96-98%, cpu4-7 (E) 83-85%; 724% total | M |
| 8 rayon workers | each 82-87% running, 3-6% runnable-waiting, ~10% asleep (no work) | M |
| Forward helper thread | 15% running, **32% runnable but not scheduled**, 64% of its samples in `NEO::CommandStreamReceiver::baseWaitFunction` (busy-wait) | M |
| Worker placement | each worker splits ~40-75% of its run time on P-cores, the rest on E; per-CPU sample counts are even | M (`perf --sample-cpu`, `psr` sampling) |
| Effective clock under load | P 3.84 GHz (rated max 4.7-4.8), E 3.0 GHz (rated max 3.7) | M (`perf stat` cycles / task-clock per core type) |
| IPC | P 3.65, E 2.51. An E-core does ~0.54x a P-core's instructions per second | M |
| iGPU compute engine (CCS) | **58-63% busy**, running at 800 MHz, throttle reason `pl1` | M (DRM fdinfo `drm-cycles-ccs`, `gt0/gtidle`, `freq0/throttle`) |

Idle capacity is ~76% of 800 (M). Most of it sits on the E-cores, which are worth ~0.5 P-core each, so it is roughly
0.4 P-core equivalents (I). Rayon workers sleep when an arena step has no runnable game. A step waits for its slowest
game, and a game running `record_rollouts` does up to K_SIB x 4 full playouts sequentially on one thread.

The XPU is not the cause. From the measurements, a forward takes ~16.4 ms of service time at ρ ≈ 0.6. The M/D/1
queueing estimate then puts an arena's mean forward wait at ~28 ms per ~450 ms cycle, so about 1 of 16 arenas is
waiting at any moment (I). The forward thread's 32% run-queue wait is its busy-wait competing with the rayon workers
for cores. The 16 arenas hide that latency.

## 2. Should the net-rollout forward move to the iGPU or the NPU? No.

Per-call costs, same 40 mid-game states (turns 20-100), thread CPU time, best of 3, two interleaved passes (M):

| | P-core (cpu1/cpu3) | E-core (cpu5/cpu6) | E/P |
|---|---|---|---|
| `decide_net_rollout` (whole decision) | 22-24 µs | 49-55 µs | 2.3x |
| `decide_rollout` (rab heuristic) | 11 µs | 18.5-20.4 µs | 1.75x |
| `ValueNet.forward`, full row, no root diff | 4.2-4.4 µs/row | 7.9-8.3 µs/row | 1.9x |

The torch XPU forward goes through arena.py's path: pinned H2D, forward, sigmoid, D2H. It ran on the shared,
PL1-throttled device. Min over 15 reps (M):

| batch | 40 | 256 | 4,096 | 6,144 | 16,384 |
|---|---|---|---|---|---|
| ms | 0.40 | 0.95 | 4.94 | 6.17 | 16.4 |
| µs/row | 10.1 | 3.7 | 1.2 | **1.0** | **1.0** |

At 16,384 rows, H2D is 3.1 ms and the fp32 forward 16.1 ms. bf16 is no faster (16.5 ms). An earlier idle-machine
measurement gave 0.66 µs/row (FINDINGS). The throttled clock costs ~1.5x.

- **Per-decision placement (batch ~40) loses.** One XPU call is 400 µs. The entire CPU decision is 22-50 µs on these
  self-play states, or 135 µs per call as measured live (PLAN-gen-speed 2026-09-23; the live mix is heavier). The
  XPU call is slower either way, and the calling thread busy-waits throughout.
- **Batched placement doesn't fit.** The CPU forward kernels (`layer_fma` + `layer` + `forward_from`) are 38.5% of live
  samples, i.e. 2.7 cores (M). At ~3 µs/leaf mixed P/E, that is ~0.9 M rollout leaves/s (I; the range is 0.6-1.8 M
  for 1.5-4.5 µs/leaf). At 1.0 µs/row that is 0.6-1.8 GPU-seconds per second. On top of the ~25-30% the de-padded leaf
  forward leaves busy (§6), that comes to roughly 85-200% of the GPU. The low end might fit. What holds across the
  whole range: a busier GPU climbs off its PL1 floor with package power taken from the CPU, which runs everything
  else. The sparse CPU kernel does ~24k MACs per leaf; the dense GPU GEMM does 401k (I). The GPU buys
  throughput by doing 17x the arithmetic in a power-capped package.
- **It would also cost a rewrite and exactness.** Rollouts are sequential chains, so batching them means making
  `Recorder::rollout` resumable, with one round trip per ply and thousands of parked playouts. Dense fp32 oneDNN also
  sums in a different order from the sparse kernel, so near-tie argmaxes flip. Labels would change, and the result
  would need the pool gate.
- **NPU: not usable as installed (M).** OpenVINO 2026.4 in a scratch venv sees the NPU ("Intel(R) AI Boost"). Every
  compile fails, even a one-op ReLU: `ZE_RESULT_ERROR_UNSUPPORTED_FEATURE`, `NPU_COMPILER_VERSION 0`. Fedora's
  `intel-npu-driver-1.32` ships only `libze_intel_npu.so`, without the driver-side compiler, and the wheel has no
  plugin compiler. Even with a compiler the NPU runs fp16, so labels would change. It also has the same batching
  problem as the GPU and sits inside the same PL1 budget (I). Not worth a system-package install for this workload.

## 3. P/E cores, pinning, `RAYON_NUM_THREADS`

- **E-cores hurt the net rollout more than the heuristic** (2.3x vs 1.75x, table above). Assigning net rollouts to
  P-cores and heuristics to E-cores is still worth at most **~5%** (I). Split the live work into P-seconds: net
  N ≈ 0.74, other H ≈ 0.26. Mixed on every core, capacity is 4 + 4/2.16 = 5.85 units. Optimal assignment gives 6.12,
  +4.6%. Getting there needs two thread pools and a work split inside `ArenaGame::advance`. Not worth it.
- **Pinning:** the scheduler already keeps P-cores at 96-98% and spreads workers evenly. Pinning 8 workers 1:1 can't
  create capacity, only lose migrations. No.
- **`RAYON_NUM_THREADS`:** keep 8. The idle time is missing runnable work, not missing threads (workers sleep ~10%, not
  queue). 7 would give up an E-core's worth of work to spare the busy-wait thread. More than 8 adds nothing.

## 4. Memory and cache

- **Not bandwidth-bound (M).** P-core TopdownL1: retiring 41.5%, backend 39.2% (memory 20.4%, core 19.7%), bad
  speculation 7.7%, frontend 11.7%. Within memory-bound: L1 7.5%, L2 2.1%, L3 0.9%, DRAM 4.1%.
- **E-cores stall on L2 misses (M).** On Lunar Lake, `cpu4-7/cache` shows L1 plus a 4 MB L2 shared by the four
  E-cores, and no L3 (the 12 MB L3 is `shared=0-3`). E-core load stalls take 20.5% of cycles, 16.8% of them L2
  misses. Those miss stalls sit in `memmove` (27%) and `layer_fma` (26%). One net's weights are ~1.6 MB f32 (layer 0
  1.08 MB transposed, 2x256 KB, the head), which fits a P-core's 2.5 MB L2. In the 4 MB E-cluster L2 they compete
  with a second net (cvnet v55), MCTS trees and state copies from four threads. `rust_value_net` caches per path, so
  the rollout, trade and seat uses of v59 share one copy (verified in `value_net.py`).
- **Allocation is 3x dearer on E-cores (M).** mimalloc's fast path `_mi_page_malloc_zero` takes 10.9% of E-core cycles
  and 3.6% of P-core cycles. LBR call stacks attribute ~60% of those samples to `State::apply` / `build_road` and ~9%
  to `rollout_actions`. Hypothesis (I, not verified): `apply`'s `self.events.push` and `pieces.push` allocate fresh on
  every `clone_light` child, whose history starts empty. That's an allocation per search or rollout child, for a
  history the search never reads. A `no-history` flag on light states would be exact. The candidate goes to
  `PLAN-gen-speed.md`'s bitwise-shard protocol, not here.
- Generator RSS 4.0 GB (HWM 4.7 GB) out of ~30 GB. Pinned leaf buffers are ≥ 16 x 69 MB.

## 5. Power, clocks, thermals

- **Config is already maximal (M).** Governor, EPP, `platform_profile` and `tuned-adm` are all performance /
  throughput-performance. `intel_pstate` is active with turbo on, and the machine is on AC.
- **PL1-limited, not thermal (M).** RAPL PL1 is 33 W (28 s window) and PL2 37 W. Package temperature is 78 °C. Package
  thermal throttling totals 23 ms since boot, core throttling 0. The GPU's own throttle register says `pl1`. RAPL
  energy and turbostat need root, so CPU-side power draw was not read. The ~20% clock deficit (3.84 vs 4.8 GHz P,
  3.0 vs 3.7 E) is consistent with PL1, not proven.
- **1-core vs 8-core clock drop:** not measurable without stopping the loop. The spec single-core maximum is 4.8 GHz and
  the observed all-core P clock is 3.7-3.84 GHz (I).

## 6. Recommendations, ranked by gain per effort

| # | Change | Expected gain (evidence) | Cost | Risk | Behaviour |
|---|---|---|---|---|---|
| 1 | **`ROW_BUCKET` 16384 → 4096** (`arena.py`, one constant) | GPU time per forward ~16.4 → ~8.5 ms (I, 1.0 µs/row). Real rows go 36% → 71% for generation (mean 6,031 real rows over 600 steps) (M); the gate lineup is 31% real at 16384 (mean 5,222) (M). GPU busy ~60% → ~30%, H2D 3.1 → ~1.5 ms per forward, and the busy-wait thread's share of a core drops by half (I, proportional). Games/s: probably +0-5%, from package power handed back to the CPU and a spare core slot (I, unmeasured, needs a quiet A/B). | 1 line | CLAUDE.md: varying forward sizes once reserved 4-6 GB and OOM-killed the box. Padding and `expandable_segments` stay; only the shape count grows. | **Exact.** For 300-9,000 real rows padded to 2048/4096/8192 buckets vs 16384, every value was bitwise identical (M, `pad_ident*.py`). Pool lineups are per-seed anyway. Confirm with the bench_gen hash. |
| 2 | **More games in flight: `--batch 256`** (16 per arena) | More runnable games per step to fill the ~0.4 P-equivalent of E-core idle. Rows per forward ~12k, so padding is small even at `ROW_BUCKET` 16384. ≤ ~5% (I). | 1 flag in `run_exit.sh` for generation. `gate.py` hard-codes `batch=128` (line 38), so gating needs a code edit. | ~+0.5-1 GB RAM | Exact per seed (threaded arenas). The shard *order* changes, as it already does between runs. |
| 3 | **Don't co-schedule** the held-out jSettlers bench with generation or gating | Its ~15% of a core plus run-queue churn (M) | none | none | Exact |
| 4 | **Lead:** skip history pushes on `clone_light` states (§4) | Allocation is 6.7% of all samples and 10.9% of E-core cycles (M). How much is `events.push` is unverified (I). | Small engine change, scratch build + shard hash | Low | Exact if nothing in search reads `events`/`pieces` |
| 5 | Raise PL1 33 → 37 W (root: `/sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw`, not persistent) | ~+3-4% clocks (I: +12% power, P ∝ f^≈3). 78 °C now, so there's headroom. | One root command | Heat, fan, battery. Firmware may clamp it. | Exact |
| — | Net rollouts on the iGPU | Negative or zero (§2) | Rewrite of `Recorder` | High | Not exact, needs a pool gate |
| — | NPU via OpenVINO | Can't compile on this install (§2) | System package + rewrite | High | Not exact (fp16) |
| — | P/E split, pinning, other `RAYON_NUM_THREADS` | ≤ 5%, via a two-pool rewrite (§3) | High | Medium | Exact |
| — | bf16 leaf forward on the XPU | 0% (16.5 vs 16.1 ms at 16,384, M) | Low | — | Not exact |

Bucket menu for #1, from the same 600 generation steps (M): real-row share / distinct forward shapes are 2048 85% / 13,
**4096 71% / 7**, 8192 55% / 4, 16384 36% / 2. 4096 halves the waste while keeping the shape count low. 2048 is the
next step if `torch.xpu.memory_reserved()` stays flat.

**How to verify #1 and #2** when the loop is between rounds or stopped: interleave A/B runs of
`/tmp/claude-1000/-home-tavern-Projects-py-settlers-of-catan-rl/efc8f133-e566-446b-ac38-93a12b865323/scratchpad/bench_gen.py` (the 32-game pooled bench with every shard array hashed; `ARENA_PROF=1`) with `ROW_BUCKET`
monkeypatched (`arena.ROW_BUCKET = 4096` before `arena.play`; it is read at call time) and with `batch=256`. Compare
wall-clock games/s and CPU-seconds, sample GPU busy with `/tmp/claude-1000/hw/gpu.py 20 <pid>`, and log `torch.xpu.memory_reserved()` under
`run_exit.sh`'s memory cap. A
shared-machine A/B can't measure these gains: they come from idle and power, which contention hides.

**Bottom line:** the CPU work itself is the budget. The hardware has no large untapped device. The iGPU is best used
for what it already does, the dense depth-2 leaf batches, and it should stop computing padding. The next big
generation gains are still algorithmic, in the `PLAN-gen-speed.md` list: `clone_light` / apply-undo, and allocation
in `apply`.

## 2026-09-24 addendum: the NPU with its compiler installed

The user copied `libnpu_driver_compiler.so` (from Intel's linux-npu-driver 1.32.0 Ubuntu build) into `/usr/lib64`, and
the NPU now compiles. For the v59 net (1051→256→256→256→6) under OpenVINO 2026.4, fp16 on the device, with the loop
sharing the CPU (M):

| batch | latency min / median | per row | host CPU per call | 4 requests pipelined | max \|logit err\| vs fp32 |
|---|---|---|---|---|---|
| 40 | 0.23 / 0.98 ms | 5.7 µs | 0.05 ms | 100k rows/s | 3.8e-3 |
| 256 | 0.37 / 0.45 ms | 1.4 µs | 0.08 ms | 92k rows/s | 4.6e-3 |
| 1,024 | 0.82 / 0.85 ms | 0.80 µs | 0.20 ms | 641k rows/s | 6.7e-3 |
| 4,096 | 3.0 / 3.2 ms | 0.74 µs | 0.78 ms | 776k rows/s | 7.7e-3 |
| 8,192 | 6.2 / 6.5 ms | 0.76 µs | 1.74 ms | 1.09M rows/s | 4.3e-3 |

- **Search-leaf forward on the NPU instead of the iGPU** (an opt-in `VNET_DEVICE=npu` path in `arena.py`, one compiled
  static shape per padded row count): **slower**. On 256 games of `vnetx:v60` vs 3x rab, the second pass took 35 s
  against 20 s on the XPU (the first took 119 s, mostly compiles), at the same host CPU (~50 CPU-s). All 256 game logs
  differ from the XPU run, as expected once fp16 flips any decision. The path was removed again.
- **Rollout forwards, the 77%:** one call per decision loses 10-40x against the 22 µs CPU decision. Batched, ~1.1M
  rows/s pipelined sits in the low-middle of the rollouts' 0.6-1.8M leaves/s demand, at ~0.2 µs host CPU per row. Only
  the forward half of each decision would move (encoding and cloning stay on the CPU), so the ceiling is roughly
  1.4-1.6x generation. That would need resumable rollouts that park their net calls like search leaves, and fp16 changes
  the labels, so it would have to pass the pool gate. Parked unless generation speed becomes the binding constraint.

## 2026-09-24, second pass: the NPU leaf forward works; rollout demand and layer split measured

**The first leaf measurement was contaminated.** The path traced the torch module and compiled all its shapes inside
every `play()` call, and the bench timed that. `perf` of the old path showed `libnpu_driver_compiler.so` at 8.6% of
the run. Rebuilt: the OpenVINO graph comes straight from the weights (mask folded into W0, head row 0 only, logits to the
host, sigmoid in float64), one compiled request per ROW_BUCKET multiple is compiled on first use and kept per process,
and `OV_CACHE_DIR` caches blobs (`VNET_DEVICE=npu`, `uv sync --extra npu`). Gate config, `vnetx:v60` + rab3/jsrobot/
cvnet:v57, 256 games, warm, interleaved x2 (M):

| | wall (4 timed passes) | CPU s |
|---|---|---|
| XPU | 59.9, 60.8, 61.3, 57.6 (mean 59.9) | 203-214 |
| NPU | 58.0, 53.7, 56.1, 52.9 (mean 55.2) | 196-202 |

**Fidelity (M):** 229 of 256 games are move-for-move identical to the XPU run. The first divergence is always a v-net
decision: 27 flips in 34,181 v-net decisions, **0.08% per decision**. NPU runs are deterministic (256/256 identical
across passes). Earlier "every game differs" came from the traced path.

**Rollout demand (M, instrumented scratch engine, `vnetx:v60` x2 + pool, `--roll-p 0.3 --roll-m 4 --roll-net own`,
128 games):** the CPU net sees ~720k rows per game, 97% of them rollout rows. That is ~18 rows per rollout decision, and
~0.66M rows/s at the loop's 0.94 games/s. Mean nonzero inputs per row by layer: 11.8 (layer 0 works on the diff from the
root row), 46, 60, 188 (head input). Multiply-adds per row are ~3.0k (layer 0), 11.8k, 15.4k and ~1.5k (head). **The
two hidden layers are ~87% of the CPU forward; layer 0 is ~10%.** A split where the CPU keeps the sparse layer 0 and
the NPU runs 256→256→256→head moves 256 floats per row instead of 1,051, and it drops the 269k-MAC dense first layer
that dominated the NPU's 1.1M rows/s.

**Gate cost per pool opponent (M, `vnetx:v60` + 3x the opponent, 64 games, CPU s/game):** rab3 0.89, jsrobot 0.77,
cvnet:v57 1.02, **uct5000 2.59**. Each uct5000 seat costs ~0.6 CPU s/game, about 6x a rab3 seat, and it's ~35-40% of
gate CPU (matches the live gate `perf`: `actions` 12%, `trail_from` 8%, `apply` 6%, `Mcts::playout` 4%, malloc and
memmove ~19%).

**Generation config, interleaved x4 (M):** `vnetx:v60` x2 + pool, `--roll-p 0.3 --roll-m 4 --roll-net own`, 96 games:
XPU 150-153 s wall (mean 151.3), 538-560 CPU s; NPU 145-150 s (mean 147.3), 531-554 CPU s. The search-leaf forward is
a small share of generation, so the gain is 2.7% there against 8% in the gate. **Adopted 2026-09-24:** `arena.py`
defaults to the NPU when `/dev/accel/accel0` exists and OpenVINO is installed (`uv sync --extra npu`); `VNET_DEVICE`
overrides. The loop switched at round 62's gate.

## 2026-09-24, third pass: rollouts on the NPU (`ROLL_PARK=npu`), adopted

**Design.** A net rollout (`Recorder::rollout`) is now a resumable task (`arena.rs RollTask`). At each of the decider's
net decisions it builds its one-ply leaves and runs only the sparse first layer on the CPU
(`ValueNet::layer0_from`, the root-diff trick intact), then parks with 256-wide rows. Every arena step, each game resumes
its parked tasks from the rows' win logits and plays them to their next net decision. A game is drained only once its
rollouts finish. Python copies all rows of an arena into one buffer (`fill_roll`), and a second forward thread runs the
dense rest (256→256→256→head) on the NPU in 4,096-row chunks through one compiled shape. Seeds are drawn at spawn in
the order the inline rollouts drew theirs.

**Exactness (M).** With the CPU backend (`ROLL_PARK=1`: the dense layers in Rust, `ValueNet::hidden_heads`, the same
arithmetic as `forward_from`), per game every sample array is identical to inline rollouts and the 13,392 rollout rows
and labels are the same multiset. Only the order games finish in changes. The inline path itself is bitwise the old
engine's (48-game shard compare). `test_env.py` and the 14 unit tests pass.

**Labels under fp16 (M).** Same seeds, so the games are identical and only rollout decisions can differ: of 85,585
rollout-labeled rows, **97.3% get the identical label**; 0.68% of the 342k playout outcomes changed; mean label 0.3796
vs 0.3795. No gated round was run for the switch (the user's call, 2026-09-24): the change is far inside the labels'
own noise (4 playouts each) and unbiased.

**Speed and memory, quiet machine (M)**, `vnetx:v64` x2 + pool, `--roll-p 0.3 --roll-m 4 --roll-net own`, 256 games,
batch 128:

| | wall | CPU s | peak RSS |
|---|---|---|---|
| inline (CPU rollouts) | 213, 216 s | 1,503, 1,524 | 4.8-5.1 GB |
| parked, CPU backend | 220 s | 1,566 | 7.0 GB |
| parked, NPU (per-size shapes) | 194, 189 s | 1,327, 1,305 | 9.7 GB |
| **parked, NPU (one chunked shape)** | **184, 185, 183 s** | 1,270 | 9.1 GB |
| ... 2 NPU forward threads | 183 s | 1,275 | 9.2 GB |
| ... batch 256 | killed at a 12 GB cap | | |

**-14% wall, -16% CPU.** Where the time goes (`ARENA_PROF`): 5,085 arena steps against ~1,000 inline, because a
rollout advances one net decision per step. Rollout forwards average 36.7k rows and 15.5 ms per call, 44% of wall on
their thread, and leaf forwards 20%. The CPU runs ~6.9 of 8 cores. Memory: parking holds each arena's first-layer rows
(mean 36.7k, peak 104k rows per arena step) and keeps games alive until their last playout, +2.1 GB. The NPU path adds
the Python copy and OpenVINO's buffers, another +2.1 GB. Shrinking burst-sized buffers didn't move the peak. Batch 128
fits the loop's 14 GB generation cap; batch 256 doesn't.

Not done, in order of expected value: fp16 rows (halves the rows' memory and the copy; the NPU computes in fp16
anyway), fewer arena steps (several net decisions per task per step would need the NPU inside the Rust step), and a
fixed per-step row cap if memory binds.

## 2026-09-24, fourth pass: the NPU calls in the engine (`ROLL_PARK=rust`), adopted; Python's rollout path removed

**Design.** `npu.rs` runs the rollout net's dense layers through OpenVINO's C API (the `openvino` crate, runtime-linked
to the wheel's `libopenvino_c`; `arena.py ov_rollout_ir` saves the IR once per checkpoint). Inside `PyArena::step`,
after the games advance, the step batches every parked rollout decision of the arena, calls the NPU in 4,096-row
chunks, resumes the rollouts, and repeats while at least one full chunk is parked; a remainder waits for the next
step's first batch. Rows are stored and sent as fp16 (the `half` crate, round to nearest even). The Python NPU rollout
path (`fill_roll`, its buffers and forward pool) is deleted; `ROLL_PARK=1` (the CPU backend) remains as the exactness
check.

**Exactness (M).** With f32 rows, the Rust path's shards equal the Python path's exactly (24 games). With fp16 rows and
XPU search leaves, every game is identical to inline CPU rollouts and 96.7% of rollout labels are identical (the
Python f32 path: 97.3%); 0.83% of playout outcomes change; mean label 0.3802 vs 0.3800. With NPU search leaves the
games themselves can differ between modes: the NPU's per-row result depends on which batch shape a row lands in, and
the modes batch the leaves differently (the XPU is batch-independent). Near-tie flips, as the 0.08%-per-decision
leaf measurement found.

**Speed (M, quiet machine, `vnetx:v64` x2 + pool, `--roll-m 4 --roll-net own`).** 256 games at batch 128: inline 221 s,
Python NPU path 186 s / 9.2 GB, Rust path 192 s / 5.5 GB with f32 rows and 192 s / 5.3 GB with fp16 rows. Python is
0.4% of generation CPU in the Rust path (per-DSO `perf`: engine 86%, libc 13%); moving orchestration to Rust is not
worth it. The idle ~1.6 cores came from the lockstep batches inside a step (each waits for its slowest game) with too
few arenas to cover; rollout NPU calls block ~0.9 arena threads on average. **More arenas fix it**: 16 → 32 arenas
189.8 → 172.5 s, 6.4 → 7.6 cores busy; 48 and 64 the same as 32. Then batch x arenas on 512 games: 128 x 32 337 s
(6.3 GB), 256 x 32 361 s, 256 x 64 336 s (9.5 GB), 192 x 48 337 s, 384 x 64 over a 12 GB cap. **Adopted: batch 128,
32 arenas** (the default when `ROLL_PARK=rust`): 1.52 games/s on this bench, 1.31x inline CPU rollouts.
