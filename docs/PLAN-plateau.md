# Plan: past the v64 plateau (2026-09-25)

## Where we are

v64 is the incumbent: ~50% wins in 4-player games against the gate pool (`rab3, jsrobot, uct5000, cvnet:v57`), about
+6.7 points over v57 across five accepted pooled rounds. Since then (rounds 63-71), candidates land within about ±1
point. Label volume, `ROLL_M` 8, gentler steps and self-play rollouts all failed to move it (`docs/FINDINGS.md`,
"The pooled loop"). The diagnosed cause, measured by the 2026-09-22 sweeps: **the labels come from a policy weaker than
the student.** Rollouts play the net at 1-ply; the player searches at depth 2. Every full training pass pulls the net
toward the weaker labels; the soup's averaging only recovers the loss.

The plan tests that diagnosis head-on first. If labels from a player at least as strong as the student don't help,
label work stops, and the remaining effort goes to play-time strength.

## Rules for the whole series

- **Gate frozen** (from round 76: `uct5000` dropped by the user, ~45% of gate CPU, redundant signal; UCT goes to the held-out battery): `gate.py --pool rab3,jsrobot,uct5000,cvnet:checkpoints_value/v57.pt`, H0 -0.5, H1 +1.0, 1,000-game
  blocks to 12,000. Refreshing the pool's cvnet is a decision for a series boundary, not mid-series; results before
  and after it aren't comparable.
- **One change per gated experiment,** each with its kill rule stated up front. 1,000-game screens don't transfer
  (FINDINGS 2026-09-22), so every candidate gets the full gate: ~1 h, 6-12k paired games.
- **No benchmarks next to a gate or a generation run** (they skew both). The scratchpad is RAM: delete bench outputs.
- **A v64 held-out baseline first** (real jSettlers 100 games, Python AB 300, the buct/vpi/drrl/jsdroid pool), on the
  quiet machine. It's three accepts overdue and the reference for everything below.

## 2026-09-25: the order changed (user): self-play outcome labels first

The user chose pure self-play (`vnetx` x4), outcome labels only (no `ro_*` anchor, steelmanned even through a bad first
round), and depth-2 rollouts only if outcome labels show signal but stay noise-limited. The full plan is in
`~/.claude/plans/i-d-like-you-to-federated-beaver.md`. In short:

1. **Speed first, in Rust.** The engine scores the leaves itself (`leaf_npu`), streams them through layer 1 and batches
   the trade forwards. Self-play went from 4.9 to 32.7 games/s (`docs/PLAN-gen-speed.md` 2026-09-25).
2. **Pilot on existing data.** Outcome-only from v64 on it63-70 at K rows per game; K barely matters at the fixed step
   (FINDINGS 2026-09-25). The K=16 soup is gated against v64.
3. **Self-play rounds.** `SELFPLAY=1 DATA_PREFIX=sp ROLL_P=0 WIN_WEIGHT=1 TS_WEIGHT=0 MAX_TS=0 SAMPLE_P=0.03
   PER_GAME=16`, ~36k games per round, the frozen gate. Kill: after ≥ 4 rounds with a full window, the best candidate
   is still ≥ 3 points below v64 with no upward trend.
4. **Arms, one at a time:**
   - final-VP aux heads;
   - all four perspectives per state;
   - EMA weights (`--ema`);
   - board rotation;
   - luck-adjusted labels, which are built but weak with v64 as control (re-measure with a calibrated net).
5. **Depth-2 rollouts** for counterfactual sibling labels, with CRN, if 3 shows signal.

The sections below are the earlier plan (items 2 and 3 stay open; item 4 became step 2 above).

## The experiments, in order (as planned 2026-09-25 morning)

### 1. Depth-2 rollout labels (the diagnosis, head-on)

Rollouts where the labelled seat plays **the depth-2 search player itself** (net leaves on the NPU), so a label is
the outcome of the student's own play: AlphaZero's principle that value targets come from the strongest available
player. Cost control from measured facts: the label-scaling sweep found 100k labels as good as 900k, so `--roll-p`
can drop ~10x (0.3 → 0.03) and keep each round's labels near the 100k that suffices, while each rollout decision costs
~25x more (≈500 leaves against ≈18).

- **Feasibility first, before building:** count leaves per depth-2 rollout decision; NPU rows/s needed at `roll_p`
  0.03 against measured capacity (hidden-only fp16 via the root-diff trick ~7M rows/s; the rollout path runs ~57% busy
  today). **Build only if** projected generation stays **≥ 0.8 games/s**.
- **Build:** the parked-search machinery exists (`pool_npu`: a seat's depth-2 tree parked and scored by the NPU inside
  the step); rollout tasks would park depth-2 trees the same way.
- **Kill rule:** two gated rounds with the window at least half depth-2 labels and no accept → the label diagnosis is
  wrong or unfixable this way; stop label work.

### 2. Trade offers inside the search (play-time; independent of labels)

Trading is the largest proven lever (net-judged trades +11.5 against AlphaBeta, +14.2 on the pool). Today offers are
scored 1-ply outside the tree. Put the searching seat's best few offers (the existing `best_offer` ranking) into its
own nodes as children, with partners' replies predicted the way `Eval::NetVsHeuristic` does. No retraining: one gate
of v64-with-trade-search against v64 answers it. Engine work, so the replay oracle applies.

- **Scope (the user's call):** own offers only (first), or also opponents' offers at their nodes.
- **Kill rule:** rejected at the gate, and a variant (top-k, reply model) also rejected → drop.

### 3. Soft listwise sibling loss (training-only, existing data)

Train on the *differences* between sibling moves' rollout values rather than their absolute values: softmax
cross-entropy between the net's scores over a decision's labelled children (`ro_n` groups) and a softmax of their
labels. Hard pairwise targets were measured dead; the soft version is untested. Runs on `it63-71` without generation
(~1-2 h: train, soup, gate). If it helps, add common random numbers (sibling rollouts sharing seeds, so their outcomes
differ only through the move) in generation.

- **Kill rule:** gate reject at two temperatures → drop.

### 4. Outcome labels at scale (training-only, cheap, low prior)

The outcome loss was killed at 4,000 games per round (a draw fell from 53.0% to 30.1%: one bit per game over ~150
correlated states is memorized). `it63-71` now hold ~36k games played by the depth-2 player, 9x that. One small
`--win-weight` run on the whole set tests whether volume changes the verdict. Only if 1-3 leave time.

## Not on the plan, with reasons

- **Loosening the gate:** rounds 63-71 average slightly negative, so there are no hidden small gains to accept.
- **More data, bigger nets, deeper play-time search:** measured dead (label sweep; wider nets; depth 3; MCTS tied depth
  2 at ~20x).
- **Bootstrapped (TD-style) rollout labels:** the variant AlphaZero avoids for board games; item 1 is the faithful fix.

## Decisions for the user

1. ~~Commit first?~~ Committed by the user 2026-09-25.
2. **Trade-search scope** (item 2): own offers only, or opponents' too.
3. **When to refresh the pool** (cvnet v57 → v64): at the end of this series, or not at all.
