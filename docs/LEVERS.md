# Levers

The index of what could still make the agent stronger or the loop faster, and what has already been tried. One
line of evidence per entry; details in the linked doc. Update the entry when a lever is tried: move it, don't
append a log. (Created 2026-09-25 from `docs/FINDINGS.md`, `docs/PLAN-gen-speed.md`, `docs/RESEARCH-HARDWARE.md`.)

Current: incumbent **v64**, ~50% wins in 4-player games vs the gate pool; plateau since round 63 (FINDINGS "The
pooled loop"). Diagnosed cause: rollout labels come from a policy weaker than the depth-2 student.

## Strength: planned (docs/PLAN-plateau.md, in this order)

| Lever | Why it might work | Cost |
|---|---|---|
| Depth-2 rollout labels (the labelled seat plays the depth-2 player, net leaves on the NPU, `roll_p` ~0.03) | Targets the diagnosed cause; AlphaZero's rule: value targets from the strongest player. 100k labels were as good as 900k, so 10x fewer, 25x dearer labels fit | Engine work (parked depth-2 trees exist: `pool_npu`); feasibility check first, build only if ≥ 0.8 games/s |
| Trade offers inside the search (own offers as children of own nodes, replies predicted as in `Eval::NetVsHeuristic`) | Trades are the largest proven lever class (+11.5 vs AB, +14.2 on the pool); today they're 1-ply outside the tree | Engine work + one gate, no retraining |
| Soft listwise sibling loss (softmax over a decision's labelled children vs softmax of their rollout values), then CRN rollouts | Uses label *differences*; hard pairwise targets were dead, the soft version untested | Training-only on `it63-71`, ~1-2 h |
| Outcome labels at scale (small `--win-weight` on ~36k depth-2-player games) | Killed at 4k games/round; 9x the games may change the verdict | Training-only; low prior |

## Strength: open, not yet planned

- **Refresh the pool's cvnet (v57 → v64) in gate and generation.** Keeps the earlier-self opponent hard. At a series
  boundary only (breaks comparability).
- **Opponents' offers at their nodes** in the trade search (extension of the planned own-offer version).
- **Policy prior for search (PPO or distilled).** Only if search earns it; MCTS with net values tied depth 2 at ~20x.
- **MCTS with net leaves on the NPU.** The 20x cost was CPU leaves; unexplored at NPU prices. Tied in strength, so low prior.
- **Larger net.** Dense layers now run on the NPU, but wider nets were measured dead and the plateau is labels, not capacity.

## Strength: dead (don't re-run without a new reason)

| Lever | Verdict | Where |
|---|---|---|
| More labels / more data per round (100k vs 300k vs 900k) | No gain (677, 669, 661 per 1,000); the training pass is the damage, not volume | FINDINGS 2026-09-22 label-scaling sweep |
| Smaller training step (epochs 1-2, lr 3e-4 / 1e-4) | Every arm ties; draws still land below their warm start | same section |
| `ROLL_M` 8 (more playouts per label) | +0.15, -1.06, -0.42 over three rounds | FINDINGS "The pooled loop" |
| Self-play rollouts (`--roll-net all`) | -0.84, -0.60, -0.29 over three rounds; still a 1-ply policy | same |
| Outcome loss at 4k games/round | Draw 53.0% → 30.1%: memorizes one bit per game | FINDINGS 2026-09-03 |
| Aux heads (final VPs, turns left) | Tie within ±0.5 points; calibrated heads kept (`checkpoints_value/aux/w1.pt`) | FINDINGS 2026-09-22/23 aux |
| Partner model = the net (`vnetxx`) | -12.5 vs `base_fn` partners | FINDINGS 2026-09-23 pool gates |
| Checkpoint ensemble at the leaves | +2 vs 3x rab, but weaker than v57 alone in the mixed pool | FINDINGS 2026-09-22 / 09-23 |
| Deeper play-time search (depth 3, soft-min, reply pruning) | Every deeper tree scores below depth 2 with the same net | FINDINGS 2026-09-02 evening, 2026-09-22 steelman #6 |
| MCTS with net values | Ties depth 2 at ~20x the cost | FINDINGS steelman "MCTS with net values" |
| Self-labelled sibling sets (the net's own search choice as target) | Hurt (iteration 9); every target from the net's own search regressed | FINDINGS iteration 9 |
| Smooth prior / smoothed `base_fn` | 5.7% as a player; "learn the choice, don't smooth AB's heuristic" | FINDINGS 2026-09-01 late |
| PPO self-play (M1-M3) | Plateaued ~80% vs weak bots, lost 98% to ValueFunctionPlayer | FINDINGS M3; `legacy/ppo/` |
| Loosening the gate | Rounds 63-71 average slightly negative: no hidden small gains | FINDINGS "The pooled loop" |

## Speed: open

- **Gate: UCT playouts** are ~45% of gate CPU (pure game logic). Remaining exact wins are small: tile lookup by dice
  number (~1.3% of UCT), the uniform-pick modulo (~3%).
- **Generation: encoding (~11%) and FMAs (~18%) of self-play CPU** are what remains; no exact idea left that measured
  well (see the dead list).

## Speed: dead or adopted

Adopted (all exact): 32 arenas; NPU for search leaves and rollout dense layers (engine-side, fp16 rows); AVX2 nonzero
scan; fused diff + scan in `layer0_from`; fp16 shard arrays from Rust; longest-road forest diameter; jSettler roll
jump; move-list buffer reuse; port bits (docs/PLAN-gen-speed.md, docs/RESEARCH-HARDWARE.md).

| Lever | Verdict |
|---|---|
| Sparse layer-1 diffs (bitmask of encoder writes, no template copy) | Exact, +15-30% CPU |
| Pool seats' searches on the NPU (`POOL_NPU=1`) | -6% CPU, +4-7% gate wall: ~1,000-leaf searches too small |
| Streaming gate (no per-block tail) | Tail is 3 s of 165 s |
| Bigger batch (192-384) with more arenas | No gain over 128 x 32 |
| Porting Python orchestration to Rust | Python is 0.4% of generation CPU |
| `Arc<Map>` refcount, robber-victim `Vec`s | < 1% each |
