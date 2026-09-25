# Plan: faster game generation (2026-09-02)

## Where the time goes (quiet machine, `ARENA_PROF=1`, v30 x2 + rab x2, 256 games)

| | without rollouts | with rollouts (`--roll-p 0.1 --roll-m 1`) |
|---|---|---|
| games/s | **10.0** | **1.31** (1.68 at 4,000 games) |
| Rust parallel section per arena step | 32 ms | 299 ms |
| forward wait | 1.6 ms | 0.9 ms (hidden) |

Micro-benchmarks (per call): state copy 0.2 µs, `playable_actions` 0.4 µs, `base_fn` 0.3 µs, `encode` 1.4 µs,
`decide_heuristic(1)` 10 µs, **`decide_heuristic(2)` 320 µs** (~700 leaves → 0.46 µs/leaf), value-net `expand(2)`
2.4 ms/decision = **4.95 µs/leaf**, one rab-vs-rab rollout **46 ms** (143 depth-2 decisions).

Per game: ~79 rollout rows × 46 ms ≈ **3.6 s CPU of rollouts** vs ~0.4 s of value-net expansion (152 decisions ×
2.4 ms) vs ~0.1 s for everything else. 256 games × 3.6 s = 930 CPU-s; the observed extra wall time was 169 s on
4 P + 4 E cores, i.e. the rollout work is already ~70-95% parallel-efficient. **Generation is compute-bound on
rollouts; the encoder is under 10% of it.** The encoder is, however, ~90% of the round's *evaluation* time:
proxy gates (2 × 4,000 games) + greedy soup (~5 × 1,000 games) ≈ 12 of a ~60-minute round.

Round budget today: gen ~40 min, 5 trainings ~8 min, greedy soup ~6 min, gates ~5 min.

## What to change, in order of payoff

### 1. Cheaper rollout decisions (target 3-4x on generation) — `catan_engine/src/heuristic.rs`, `arena.rs`
The rollout policy is `decide_heuristic(2)`: an exact depth-2 expectimax over `base_fn`, ~700 leaves per decision,
0.46 µs each. Two independent cuts:
- **a. Fewer leaves: prune the rollout policy's action list** the way catanatron's `list_prunned_actions` does for
  its own AlphaBeta (drop maritime trades that do not complete a build, robber moves onto tiles with no victim,
  duplicate road placements that reach the same buildable set). Applied **only inside rollouts** (a separate
  `decide_rollout`), so the `rab` opponent seats and the proxy gate stay the exact player they are now. Expected
  2-3x fewer leaves; measured on the micro-benchmark before/after.
- **b. Cheaper leaves**: per-node production precomputed once per map (`Map.node_prod[node][resource]`, the
  robber's tile subtracted at use), so `effective_production` / `production_score` / `reachable_production` are
  O(buildings) instead of O(buildings × tiles × resources); `buildable_node_ids(..).len()` → `count_ones()`;
  `outcomes()` / `playable_actions()` writing into reused buffers instead of allocating. Expected ~1.5x per leaf.
  These also speed up the encoder's heuristic block and every `rab` decision.
- Not proposed: a depth-1 rollout policy. It is 30x cheaper (10 µs/decision) but a different, weaker policy
  (`vf`-class, 10% vs AB's 25%), so the labels change meaning; worth one gated round as an experiment *after* the
  above, not as the default.

### 2. Cheaper value-net expansion (target ~2x on expand → proxy gates + greedy soup 12 → ~6 min/round; gen −5%) — `search.rs`, `encode.rs`
4.95 µs/leaf today vs 1.4 µs for the encode itself. The rest is the 4.2 KB static-template copy per leaf, the
per-node `Box<Node>` / `Vec` allocations of the tree, and `outcomes()` allocations.
- Fill the static template once per leaf buffer and only write + clear the dynamic slots per leaf (the buffer
  is per game, one map).
- Tree nodes in one `Vec<Node>` arena with index children instead of boxed nodes; children/outcomes into reused
  buffers.
- Item 1b's precomputed production also lands here.

### 3. Measure, don't guess
Every step re-runs the micro-benchmark above and the 256-game `ARENA_PROF` profile; `test_env.py` (Rust search ==
Python search, arena replay oracle, encoder parity, rollout rows) after each Rust change. Numbers go to FINDINGS.

### Expected outcome
Rollouts 3-4x cheaper → generation ~10-12 min instead of 40; evaluation ~6 min instead of 12; a round ~30 min
instead of 60 (training 8 min is then the largest fixed cost). If the rollout budget is spent on more rows instead
(`ROLL_P` 0.1 → 0.3 at the same wall time), the value target gets 3x denser — the more likely path to a higher
ceiling, decided by a gated round after the speed-ups land.

### Not in scope
Bigger changes with unclear payoff: thread pinning to P-cores (rayon cannot; E-cores still add throughput), moving
rollouts to a separate pool (imbalance loss measured ≤30%), GPU anything (forward wait is already ~1 ms).

## Progress log

- **Step 1b** (per-node production table, allocation-free buildable count, set-bit iteration in
  `reachable_production`): landed; wall-clock effect measured once the machine is quiet (below).
- **Step 1a** (rollout-only pruning): the first cut (robber onto enemy-adjacent tiles, no trades at ply 2) was
  worth **1.03x** — most tiles touch an enemy building, so nothing was pruned where it mattered. The census
  said half of all rollout leaves come from robber prompts (~30 moves x 5 steal outcomes x the whole post-roll
  action list), so the rollout policy now searches **depth 1 on robber prompts** (depth 2 elsewhere, no trades at
  ply 2): **5.9x faster per decision, 97.7% agreement** with the exact depth-2 choice on 300 rab decisions
  (robber 21/24, roads 45/48, everything else identical), rollouts 12 ms instead of ~50. Depth 1 on discard
  prompts too was 8.8x but only 93% agreement (discards 95/108) — not taken.
- Expansion timers (`catan_engine.prof()`): per leaf ~76% is the leaf encode (incl. the template copy), ~10%
  child generation, ~14% tree bookkeeping. So step 2's ceiling without incremental encoding is ~1.3x, not 2x.
- **Quiet-machine result:** generation with rollouts 1.31 → **6.29 games/s (4.8x)**; without rollouts 10.0 → 11.3;
  `rab x4` 94.6 → 132; expand 4.95 → 2.53 µs/leaf; encode 1.4 → 0.67 µs. Step 2's remaining items (template copy,
  tree arena) are not worth it: encode is now 2.0 of the 2.5 µs and the arena step is bounded by P/E-core
  imbalance, not by expand.
- Next: the approved depth-1 rollout experiment and the denser-labels (`ROLL_P` 0.3) variant, each one gated round
  vs v30 on the same fresh seeds, then restart the loop with the winner.
- **2026-09-22, `State::clone_light()`:** the table above predates two hot-path additions — domestic trading
  (09-03) and the `pieces`/`events` history on `State` (09-07, for the jSettler mirror and the site) — and
  `ROLL_P` is now 0.3, not 0.1. The history is appended on nearly every action and read only off the live game,
  but `#[derive(Clone)]` copied it at every tree node of every rollout decision, every value-net expansion and
  every trade what-if. `clone_light()` (history empty) at those 12 sites (`search.rs` `outcomes()`, `trade.rs`
  `with_hand`/`confirm_offer`, the `arena.rs` Recorder): playout from turn 60 4.5 → 3.9 ms, `decide_rollout`
  −10-15%/decision; **generation (v40 x2 + rab x2, `--roll-p 0.3`, 256 games, quiet) 2.44 → 3.00 games/s
  (+23%)**, Rust step 219 → 178 ms. Same seed produced bitwise-identical shards (all 16 arrays) and
  `test_env.py` passes, so labels are provably unchanged. `Clone` itself stays exact for replay and the mirror.
- **2026-09-22, where the 178 ms step goes** (same run, ablated): rollouts off → 37 ms/step (13.5 games/s), so
  **rollouts are 141 ms = 79%** of the step; `rab x4` alone 138 games/s. `perf` (self time, 96 games): `trail_from`
  16%, `reachable_production` 16%, **malloc/free/memmove/`Vec::clone` ~40%**, `base_fn` 5%, `longest_acyclic_path` 2%.
- **`search_actions()` no longer generates the ~300 domestic offers it then filtered out** (`actions.rs`, an
  `actions(with_offers)` split; every offering prompt also has Roll/EndTurn/RejectTrade so the list is the same):
  3.00 → **3.28 games/s**, bitwise-identical shards.
- **mimalloc as the global allocator** (`lib.rs`, `python` feature only; the wasm build keeps the default):
  3.28 → **4.83 games/s**, Rust step 162 → 109 ms, playout from turn 60 3.4 → 2.4 ms, bitwise-identical
  shards. Bundle over build: a dependency and five lines against converting `State`'s small Vecs to arrays
  across every module; the remaining allocation share decides whether the refactor is ever worth it.
- **Tried and reverted:** branch-and-bound in `trail_from` on "p's roads left" — 4.83 → 4.53 games/s. The only
  cap that is safe (a trail may leave the component through an enemy endpoint) is all of p's roads, which
  prunes nothing on the tree-shaped road graphs that dominate; the cost is calls, not depth.
- **Inline lists in `State`** (`arrayvec`): `Player.settlements/cities/roads`, `dev_deck` and each player's
  component list are fixed-capacity inline arrays (5/4/15/25/16), so a copy is a memcpy plus two Vec headers
  instead of ~20 heap allocations. Call sites unchanged (`Deref<[T]>`). 4.83 → **5.35 games/s**, Rust step
  109 → 98 ms, playout from turn 60 2.4 → 2.2 ms, bitwise-identical shards; wasm build type-checks.
- **Longest-road DFS from odd-degree starts only** (`board.rs` `longest_acyclic_path`): a longest trail that
  starts at an even-degree, non-enemy node leaves an unused edge at its start and could be extended, so some
  longest trail starts at an odd-degree component node or an enemy endpoint; none of those means the graph
  is Eulerian and one start with a road reaches every edge. Same maximum, a third of the starts: `trail_from`
  was 26% of generation. 5.35 → **6.00 games/s**, Rust step 98 → 87 ms, playout from turn 60 2.2 → 1.8 ms,
  bitwise-identical shards. (The earlier branch-and-bound attempt pruned branches, which are cheap; the
  starts were the waste.)
- **`reachable_production` memo on `State`** (`ReachCache`, relaxed atomics because the PyO3 class must be
  `Sync`): it depends only on the board, so `board_build_settlement` / `board_build_road` clear it and every
  other child inherits the parent's. It only pays if the root is primed (`decide_rollout`, `decide_heuristic`,
  `expand_into`): `base_fn` runs at leaves, so without priming each leaf computed into a copy that was dropped
  (5.35 games/s, a loss). Primed: `reachable_production` 20% → 10% of samples.
- **Tried and reverted:** `players` inline too. It halved nothing and grew `State` by ~600 B; `outcomes()`
  builds each child then moves it into a Vec, so memmove went 10% → 22% and generation fell to 5.35-5.99.
  Heap `players` + inline small lists + memo: **6.18 games/s**, Rust step 84 ms, playout from turn 60 1.8 ms.
- **`for_each_outcome`** (`search.rs`): the expectimax over `base_fn` evaluates each child where it is built
  instead of `outcomes()` moving every child into a Vec it reads once; `outcomes()` is now a wrapper for the
  tree path. Components capacity 16 → 10 (bound in `state.rs`). 6.18 → **6.68 games/s**, Rust step 78 ms,
  playout from turn 60 1.7 ms.
- Cumulative today: **2.44 → 6.68 games/s (2.7x)** at `--roll-p 0.3`, zero label change (bitwise-identical
  shards on the 256-game seed after every step; `test_env.py` passes). A round's generation (4,000 games)
  is ~10 min instead of ~27, now about equal to the five trainings. Left on the table, per the last perf:
  copying a State is still ~30% (memmove + `clone_light` + the `players` Vec), `trail_from` 14%,
  `reachable_production` 11%, `base_fn` 8%; the next real cut is apply/undo instead of clone-per-child,
  which is a rewrite of the search, not a patch.
- **2026-09-22 (later), the net as the rollout policy — `valuenet.rs` forward 174 → ~3 µs/leaf.** FINDINGS had killed
  net-in-the-loop rollouts on the scalar Rust forward (174 µs/leaf, `zip().map().sum()` dots that never vectorise).
  Rewritten as a sparse axpy: weights stored transposed (`n_in x n_out`), one `out += x_j * W[j, :]` per **nonzero**
  input — the masked encoding has ~108 nonzeros of 1051 and the incumbent's ReLU layers are 4% / 18% / 71% nonzero
  (v49, 20k real rows), so ~43k MACs instead of 402k; the mask is folded into layer 0's rows; the AVX2+FMA path is
  explicit intrinsics (8 ymm accumulators per 64 outputs, weight rows read once, `is_x86_feature_detected!`
  dispatch, the portable loop for wasm; a `[f32; 64]` accumulator in plain Rust was *not* register-allocated and
  measured slower); layer 1 of a decision's leaves is computed as a correction to the root's pre-activation
  (`forward_from`, ~30 changed features per leaf instead of ~110). Parity with torch 2e-7 on P(win), 4e-6 on the
  heads. `decide_net_rollout`: one ply over the pruned rollout action list, leaves batched through the forward on
  the rayon thread; 24-38 µs per decision vs `decide_rollout`'s 35, but the net makes ~1.4x more non-trivial
  decisions per playout (it buys dev cards; `rab` never does), so a playout from turn 60 is 6.4 ms vs 1.7 (was
  9.1 before the incremental layer 1 and the intrinsics). Generation (v40 x2 + rab x2, 256 games, `ARENA_PROF`):

  | rollout policy | `--roll-p` | games/s | Rust step |
  |---|---|---|---|
  | `rab` (unchanged, bitwise-identical shard) | 0.3 | 6.73 | 77 ms |
  | net, all four seats (`--roll-net all`) | 0.3 | 2.99 | 178 ms |
  | net, all four seats | 0.1 | 6.32 | 83 ms |
  | net for the labeled decider only, `rab` for the rest (`--roll-net own`) | 0.3 | 4.88 | 108 ms |
  | net for the decider only | 0.1 | 9.59 | 53 ms |

  The kill line was 2 games/s. `perf` on the all-seats run: 77% in the forward kernel, 7% memmove, 4% encode —
  the net rollout is the forward now, nothing else is left to shave there but the net itself (the 6-wide head
  layer is a scalar tail; int8/VNNI would be the next step if it ever matters).

## 2026-09-23: pooled generation (round 59's config), profiled live

The config is `vnetx:v57` x2 plus two opponents drawn from {rab3, uct5000, cvnet:v55}, `--roll-p 0.3 --roll-m 4
--roll-net own`: 1.06 games/s. `perf record -p` on the running generator, then forward-consumer timers in a scratch
build (a scratch package ahead on PYTHONPATH, so the running loop is never touched). The bench is 32 fixed-seed games
with every shard array hashed; runs are interleaved A/B because the loop shares the machine.

- CPU split: **the net rollout policy is 77%** (2.56M `decide_net_rollout` calls, 135 µs each, ~40 leaves), the CPU
  v55 seat 4%, the trade evaluator 1%. `layer_fma` is 37% of all samples, and inside it ~15-20% was the scalar tail
  loop for the 6-wide head and ~25% the nonzero scan.
- **Head layer in one ymm** (`Layer.wt8`, rows padded to 8, unfused mul then add = the scalar tail's two roundings in
  the same order): **212/211 → 199/195 CPU-s, shards identical.** Kept.
- Fusing layer 1's diff pass with its nonzero scan: 224/233, slower. A scalar fused loop loses the vectorized
  subtraction. Reverted.
- Thread-local scratch in place of `forward_from`'s per-call buffers: 224 vs 228, no change. Reverted.
- Not attempted: dropping the per-leaf template copy. `encode_into` assumes zeroed one-hot slots, so the copy is
  required. The per-outcome `clone_light` (~15% with its Vec clones) is the next exact target, but it needs
  `components: Vec<Vec<u64>>` flattened, an engine-wide refactor.

## 2026-09-23 (later): two exact wins from the hardware investigation (`docs/RESEARCH-HARDWARE.md`)

- **History pushes skipped on light copies** (`State.light`, set by `clone_light`). `apply` no longer grows
  `pieces`/`events` on search, rollout and what-if copies; only a live game's history is ever read (the jSettler
  brain). The allocator was 10.9% of E-core cycles, ~60% of it from those pushes. **204 → 192.5 CPU-s** on the pooled
  bench, shards identical; jSettler tables' logs identical; `test_env.py` and the 14 unit tests pass.
- **`ROW_BUCKET` 16384 → 4096** (`arena.py`, env-overridable). 64% of the rows the iGPU computed were padding (31% real
  in the gate lineup). The agent measured the values bitwise identical at 2048-16384, and the pooled bench is
  identical at ~2% less CPU (198/193 → 185/192 CPU-s) with the same peak RSS. The main point is that it halves the
  iGPU's work and its driver busy-wait. The package is power-limited (PL1 33 W; the iGPU sits at its 800 MHz floor),
  so GPU power not spent is CPU clock.

## 2026-09-24: the gate, profiled by seat; five exact wins

Where the gate's CPU goes (`perf` with frame pointers, `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only RUSTFLAGS="-C
force-frame-pointers=yes"`, on a gate-mix bench: `vnetx:v60` vs 3 opponents drawn per seed exactly as `gate.py` draws
them from the loop's GATE_POOL). Inclusive: **UCT search 45%** (random playouts 42%), heuristic search 16% (rab3 seats,
UCT's non-search prompts), jSettler 13%, the v-net tree 11%, CPU net forwards 10% (cvnet seat, trade net), longest-road
DFS 10% (mostly inside UCT playouts). Per opponent, `vnetx` + 3x it, CPU s/game: rab3 0.89, jsrobot 0.77, cvnet 1.02,
uct5000 2.59.

The yardstick is the gate-mix bench's summed user instructions (P + E counters; `perf stat -e instructions:u`): CPU
seconds swing ±5% with the loop's phases, instruction counts don't for identical games. Behaviour gate: every game
log hashed per seed; for generation, every shard array compared (`vnetx` x2 + rab x2, 48 games, seed 424242).

| change | gate-mix instructions (128 games) | notes |
|---|---|---|
| installed engine | 3,042 G | |
| playouts reuse one move-list buffer (`search_actions_into`) | 3,008 G (-1.1%) | UCT bench -8-10% CPU |
| jSettler `rolls_and_rsrc_fast` jumps to the next roll where a resource arrives | 2,834 G (-5.8%) | exact: `our` is unchanged on empty rolls and `trade_toward` is idempotent; jsrobot lineup -15.5% instructions |
| longest road: forest diameter in one pass, the DFS only as fallback | 2,728 G (-3.9%) | UCT bench -14% CPU; 96.6% of calls take the fast path |
| `port_resources` from the player's buildings (`Map.node_port`) | (UCT bench -2.9% instructions) | the earlier "no change" was the short bench's noise |

All games identical (UCT bench hash, gate-mix logs, jsrobot logs), generation shards identical. The longest-road fast
path was checked against the DFS on every call in a scratch build: 103M calls over 256 gate-mix games, 0.9M over the
UCT bench, 48 generation games, no mismatch. The first version did mismatch, which found a catanatron quirk the fast
path must respect. The DFS may start a trail at an enemy node and leave through any road of p's there, so a
component's "longest road" can count a trail that lies wholly in the neighbouring component across an enemy
settlement. The fast path now falls back when an enemy leaf has another road of p's.

Measured and skipped: `Arc<Map>` refcount traffic (<1% of the gate), a streaming gate (candidate and incumbent
interleaved, no per-block tail: the tail of a 512-game `play()` is 3 s of 165 s), robber-victim `Vec`s (~1%).

Live effect (round 63, the first on a quiet machine with this engine and the NPU leaf forward): generation **1.32
games/s** (3,037 s for 4,000 games) against 1.06-1.10 for rounds 59-60; the gate **~210 games/min** (12,000 in 57
min) against ~180 for round 60. The generation gain is larger than the gate-mix numbers suggest: its pool seats are
rab3, uct5000 and cvnet, and the rollouts build roads (longest road).

## Next (approved 2026-09-24): device calls in Rust

After round 68, on a quiet machine. The NPU calls move from Python (`arena.py` + the OpenVINO Python API) into the
engine through Intel's `openvino` crate (0.11, runtime-linked against the `libopenvino_c.so` + NPU plugin the venv's
wheel already ships), behind a Cargo feature so the wasm build is untouched.

1. **Rollout forwards first.** A rollout service inside the Rust step batches every parked decision across the
   arena's games, calls the NPU and continues, so a playout takes many net decisions per arena step instead of one
   (today 5,085 steps against ~1,000 inline, games held alive until their last playout, ~1 core idle). Rows go over in
   fp16 without a Python copy (fill_roll + numpy buffers are ~2 GB of the 9.1 GB peak and ~9% of each step).
2. **Then the search-leaf forward** the same way; Python keeps orchestration, shards and training.
3. **Measure Python's share** with a per-DSO `perf` breakdown on the first benchmark (Rust, libpython, numpy,
   OpenVINO, idle). The ~13% headroom seen so far is idle cores, not Python time, but if orchestration is more than a
   few percent it moves to Rust too.

Gates, as always: `test_env.py`, the unit tests, and label identity against the CPU backend (`ROLL_PARK=1`, order-free
shard compare); fp16 vs CPU labels compared with `label_diff.py` (today: 97.3% identical).

## 2026-09-24 (evening): self-play rollouts, and their CPU side

`--roll-net all` (every seat plays the net in the playouts, user-approved as the next recipe change) with the NPU
path: 256 games 240 s against 158 s for `own` (+54%), NPU 47% busy at 950/1,900 MHz. A net decision's CPU side costs
more than a `rab` decision. Profile (frame pointers): the first layer's sparse path was 48% of all CPU: the scalar
nonzero scan over 1,051-wide diff rows 19%, the FMAs 14%, element-by-element f32→fp16 10.7%; the leaf-minus-root diff
9%, template copies per leaf 7% of the memmove, `encode_into` 14%.

- **AVX2 nonzero scan** (`nonzero_avx2`: compare 8, movemask, emit set bits; same indices, same order) and **batched
  fp16 conversion** (`half`'s slice converter, F16C 8-wide, same rounding): self-play **240 → 196 s (-18.5%)**, CPU
  -20%, NPU 57% busy. Exact: the 48-game shard from the morning's baseline is bitwise identical; `test_env.py` and the
  unit tests pass. The scan speeds every sparse CPU forward in the engine.
- Remaining, measured (self-play): FMAs 18% (14.5 of it layer 1 of the rollout rows), memmove 18% (37% of it the
  template copy per leaf row, 23.5% numpy in the Python drain and shard building), `encode_into` 11%, the diff loop
  7.5%, the scan 5.3%. Next exact candidates: a fused diff + scan pass; fp16 and shard arrays produced in Rust instead
  of `astype` in Python. Encoding writes interleave with the static template's indices, so the template copy can't be
  shrunk to a dynamic region without a sparse encoder.

Round 69 (2026-09-24 18:39) is the first self-play-rollout round: `ROLL_NET=all ROLL_M=4 ROLL_PARK=rust`, rounds 69-71.
- **AVX2 fused diff + nonzero** in `layer0_from` (one pass for the leaf-minus-root difference and its nonzero indices):
  exact (parked self-play shards identical); instructions -0.3% and -3.6% in two NPU-leaf runs (the counts carry ~±2%
  of driver noise; with XPU leaves the busy-wait makes them useless). In `forward_from` it measured +1.1% and was left
  out.
- **The gate on 32 arenas**: gate mix 256 games 77.0 / 77.8 s against 87.9 / 82.8 s on 16, interleaved under the loop's
  load (-9%). `arena.py` now defaults to 32 arenas whenever a lineup has CPU-searching seats.
- **fp16 rows straight from Rust**: `PyArena.finished` converts X, rank, sib, ts and ro rows with F16C (`to_f16`); the
  Python drain's `astype(np.float16)` (numpy's scalar software conversion plus a copy) became a no-op. Shards bitwise
  identical to the morning's baseline; `test_env.py` passes. The drain's numpy memmove was ~4% of self-play CPU.
- **Pool seats' searches on the NPU** (`POOL_NPU=1`: a `cvnet` seat parks its depth-2 tree, the arena scores all
  parked trees through the pool net's full fp16 IR inside the step, then resumes): gate mix 256 games **82.3 / 77.9 s
  against 77.1 / 75.3 s on the CPU**, with 6% less CPU. A pool search is ~1,000 leaves, so a synchronous NPU round
  trip costs more latency than the CPU forward it saves. Kept opt-in, off. In self-play generation the CPU net seats are
  ~2% of CPU (rollouts 78%), so they were never the target there; in the gate they are ~10%.
- **Sparse layer-1 differences (reverted).** `encode_into` only assigns over the static template, so a leaf's row can
  differ from the root's only where either encoding wrote. A version tracked those positions in 1,051-bit masks per
  decision, rebuilt each leaf in a scratch copy of the root row, and walked the set bits in ascending order: no template
  copy, no 1,051-wide subtraction or scan. Exact (shards identical), but **+25% instructions and +15-30% CPU** in the
  production mode (744 / 726 → 852 / 966 CPU s on 128 self-play games). The scalar bit walk and scattered stores cost
  more than the dense SIMD passes and 4 KB copies they replaced. The dense path stays.
