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
