# Levers

The index of what could still make the agent stronger or the loop faster, and what has already been tried. One
line of evidence per entry; details in the linked doc. Update the entry when a lever is tried: move it, don't
append a log. (Created 2026-09-25 from `docs/FINDINGS.md`, `docs/PLAN-gen-speed.md`, `docs/RESEARCH-HARDWARE.md`.)

Current: incumbent **v76 played as `vnets3x`** (2026-09-25: depth-2 self-play rollout labels +0.95 and +0.97 in two rounds, trade offers inside the search +3.7); v64 had plateaued since round 63 (FINDINGS "The
pooled loop"). Diagnosed cause: rollout labels come from a policy weaker than the depth-2 student.

## Strength: planned (docs/PLAN-plateau.md, in this order; rewritten 2026-09-25)

| Lever | Why it might work | Cost |
|---|---|---|
| **Depth-2 self-play rollout labels** (`scripts/run_d2.sh`: `--roll-net all --roll-net-depth 2 --crn`, `roll_p 0.02`, `roll_m 2`, 4,000 games/round at 1.47 games/s) | Counterfactual siblings labelled by the depth-2 player itself: what outcome labels lack (FINDINGS 2026-09-25) | Rounds 75-76 accepted (+0.95, +0.97; v76); continue from 77 with `scripts/run_d2.sh 77 ...` |
| EMA weights (`--ema 0.999`) as the loop's default checkpoint | The only outcome-only candidate that didn't regress (+0.26, tie at 12k) | Flag exists; one gated arm on rollout labels |
| Aux heads used in the search (VP-margin tiebreak, max^n backups) | Training them in is a tie: aux + EMA +0.53, warmed heads +0.21, EMA alone +0.26 (FINDINGS 2026-09-25) | Engine work + a gate |
| Remaining outcome arms: all four seats' views (`--sample-all`), luck-adjusted labels (~15% variance with a calibrated control), 120° rotation | Only worth running on top of a recipe that doesn't regress | One gated arm each |
| Depth-2 rollout labels (the labelled seat plays the depth-2 player, net leaves on the NPU, `roll_p` ~0.03) | Targets the diagnosed cause; AlphaZero's rule: value targets from the strongest player. 100k labels were as good as 900k, so 10x fewer, 25x dearer labels fit | Engine work (parked depth-2 trees exist: `pool_npu`); feasibility check first, build only if ≥ 0.8 games/s |
| Trade search width k (`vnets1x` / `vnets5x` / `vnets8x` vs `vnets3x`), and opponents' offers at their nodes | `vnets3x` accepted at +3.7 on 1,000 games (FINDINGS 2026-09-25); the loop plays it from round 76 | One gate each, no retraining |
| Soft listwise sibling loss (softmax over a decision's labelled children vs softmax of their rollout values), then CRN rollouts | Uses label *differences*; hard pairwise targets were dead, the soft version untested | Training-only on `it63-71`, ~1-2 h |

## Strength: open, not yet planned

- **Luck-adjusted outcome labels** (`gen_games.py --luck`, built): unbiased, but with v64 as the control net it removes
  only ~6% of residual variance (FINDINGS 2026-09-25). Re-measure with an outcome-calibrated net.
- **Label volume at the fixed step.** The "dead" sweep ran under the destructive step (every draw 5-9 points below
  its warm start, audit #3); never re-run at `--lr 1e-4 --dropout 0 --weight-decay 0`. Moot for rollout labels, but
  volume is the main variable for outcome labels.
- **Peer-checkpoint ensemble at the leaves** (e.g. v61+v62+v64). The pool test used members 5-7 points weaker than v57.
- **Soft listwise sibling loss after CRN** (PLAN-plateau #3 ran it before common random numbers, which RESEARCH-SIGNAL
  §3.1 makes its prerequisite).
- **`ro_rank_acc` as a selection signal**, retrospectively against rounds 59-71's gates (audit #23): hours, no generation.
- **Depth 3 / MCTS on the pool with net trades.** Both were judged against rab only, without `x` trades.
- **Resignation in self-play** (speed): the leader past 0.9 swings a median 0.008 over the last ~31% of a game. Needs a
  calibrated net and a logged false-resign rate first.

- **Refresh the pool's cvnet (v57 → v64) in gate and generation.** Keeps the earlier-self opponent hard. At a series
  boundary only (breaks comparability).
- **Opponents' offers at their nodes** in the trade search (extension of the planned own-offer version).
- **Policy prior for search (PPO or distilled).** Only if search earns it; MCTS with net values tied depth 2 at ~20x.
- **MCTS with net leaves on the NPU.** The 20x cost was CPU leaves; unexplored at NPU prices. Tied in strength, so low prior.
- **Larger net by Net2Net widening** (`widen.py`): 512 wide at matched lineage and data scored +0.77 vs v75 at the 12k
  cap (llr +2.57, FINDINGS 2026-09-25). Widen the incumbent and re-gate after more depth-2 data; cross-width gates need
  `VNET_DEVICE=xpu` (NPU plugin bug).

## Strength: dead (don't re-run without a new reason)

| Lever | Verdict | Where |
|---|---|---|
| More labels / more data per round (100k vs 300k vs 900k) | No gain (677, 669, 661 per 1,000); the training pass is the damage, not volume | FINDINGS 2026-09-22 label-scaling sweep |
| Smaller training step alone (epochs 1-2, lr 3e-4 / 1e-4, dropout kept) | Superseded: the fixed step (`--lr 1e-4 --dropout 0 --weight-decay 0`) is non-destructive and adopted | FINDINGS 2026-09-22 "The non-destructive step exists" |
| `ROLL_M` 8 (more playouts per label) | +0.15, -1.06, -0.42 over three rounds | FINDINGS "The pooled loop" |
| Self-play rollouts (`--roll-net all`) | -0.84, -0.60, -0.29 over three rounds; still a 1-ply policy | same |
| Self-play outcome labels alone (v64 x4, 36k games/round, K=16, fixed step) | −2.4, −4.6, −1.35 over rounds 72-74; the pilot on pool games −1.5; aux heads −1.4. EMA ties (+0.26). Worse the more they fit: trajectory states never show the siblings the search compares | FINDINGS 2026-09-25 |
| Outcome loss at 4k games/round, destructive step | Draw 53.0% → 30.1%. At the fixed step no per-game memorization shows (FINDINGS 2026-09-25); the outcome-label plan revisits it | FINDINGS 2026-09-03 |
| Aux heads under rollout labels | Tie within ±0.5 points; calibrated heads kept (`checkpoints_value/aux/w1.pt`). Not tested as the outcome loss's partner (planned arm) | FINDINGS 2026-09-22/23 aux |
| Partner model = the net (`vnetxx`) | -12.5 vs `base_fn` partners | FINDINGS 2026-09-23 pool gates |
| Checkpoint ensemble of older nets at the leaves | +2 vs 3x rab, but weaker than v57 alone in the mixed pool (members 5-7 points weaker; a peer ensemble is open) | FINDINGS 2026-09-22 / 09-23 |
| Deeper play-time search (depth 3, soft-min, reply pruning) | Every deeper tree scores below depth 2 with the same net | FINDINGS 2026-09-02 evening, 2026-09-22 steelman #6 |
| MCTS with net values | Ties depth 2 at ~20x the cost | FINDINGS steelman "MCTS with net values" |
| Self-labelled sibling sets (the net's own search choice as target) | Hurt (iteration 9); every target from the net's own search regressed | FINDINGS iteration 9 |
| Smooth prior / smoothed `base_fn` | 5.7% as a player; "learn the choice, don't smooth AB's heuristic" | FINDINGS 2026-09-01 late |
| PPO self-play (M1-M3) | Plateaued ~80% vs weak bots, lost 98% to ValueFunctionPlayer | FINDINGS M3; `legacy/ppo/` |
| Loosening the gate | Rounds 63-71 average slightly negative: no hidden small gains | FINDINGS "The pooled loop" |

## Speed: open

- **Gate:** move generation in the UCT seat's random playouts (`actions_into` + `push_road_building` ~19% of gate
  CPU), `cvnet` seats' CPU forwards (~12% with trades).

- **Gate: UCT playouts** are ~45% of gate CPU (pure game logic). Remaining exact wins are small: tile lookup by dice
  number (~1.3% of UCT), the uniform-pick modulo (~3%).
- **Generation: encoding (~11%) and FMAs (~18%) of self-play CPU** are what remains; no exact idea left that measured
  well (see the dead list).

## Speed: dead or adopted

Adopted 2026-09-25 (self-play 4.9 → 32.7 games/s): leaves scored by the engine inside the step (`leaf_npu`, hidden-only
rows; 0.24% decision flips vs exact CPU, fewer than the Python path's), streaming leaves through layer 1 (`LeafSink`,
exact), batched root-diff trade evaluation (~1e-7), outcomes expanded where built (exact), offers parked on the NPU with hand-delta rows (-10% wall at 1,024 games in flight).
Adopted earlier (all exact): 32 arenas; NPU for search leaves and rollout dense layers (engine-side, fp16 rows); AVX2 nonzero
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
