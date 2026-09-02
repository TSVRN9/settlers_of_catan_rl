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
