# Audit: every lever FINDINGS records as killed — which kills survive the 2026-09-22 confounds

Written 2026-09-22 against `docs/FINDINGS.md` (2,891 lines, read in full), `docs/RESEARCH-SIGNAL.md`,
`docs/RESEARCH-PLAYTIME.md`, `CLAUDE.md`. Nothing else was modified. This is an audit of the *record*, not
new measurement: every number below is quoted from FINDINGS.

## How to read the confound column

Three confounds were established on 2026-09-22 and apply retroactively to most of the log.

**(A) The training step itself was destructive.** `train_value.py`'s defaults (Adam lr 1e-3, dropout 0.3,
coupled weight decay) moved a converged net **−5.6 points in play with labels equal to its own predictions**
(self-target, v51: 636 vs 692 on the same 1,000 games). `dropout 0 + lr 1e-4 + decay 0` is exactly
non-destructive (692, the base, to the game). A splits into two very different shapes and the distinction
decides most verdicts in this document:

- **A-neutralised** — the kill is a *within-round A/B* where every arm took the same step. The −5 is a common
  offset and cancels out of the delta. (v9 vs v9a/v9b; v27b/c/d/e/f/g; the v35 loss-mix ablation.) The kill
  survives A.
- **A-dominant** — the kill is of the form *"the draw landed N points below its warm start."* There the
  destructive step is not an offset, it **is** the measured quantity. A real +1-2 point effect of the thing
  under test was invisible underneath a −5 constant. (Label scaling, `sweep_train`, `--roll-net all`, rounds
  50-53.) The kill measured the optimiser, not the lever.

**A caveat on the in-flight rounds.** The certified non-destructive recipe is `dropout 0 + lr 1e-4 +
weight-decay 0` (self-target → 692, exactly the base; decay alone was worth ~12 of the 56 lost games).
Rounds 56-57 run `TRAIN_EXTRA="--lr 1e-4 --dropout 0"` — **no `--weight-decay 0`** — so the loop is
currently taking a *partially* fixed step, with the one term RESEARCH-SIGNAL §1.3 names as the only
systematic force at a fixed point still active. Every re-test below that says "the fixed step" means all
three flags, and no in-flight round should be read as having already answered a question posed against it.

**(B) Gate power.** σ ≈ 1.5 points on a 1,000-game score; the 4,000-game paired gate has ~30-40% power at
1.5 points and ~80% at 3 points; "best of several on the same 1,000 games" carries ~+1.3σ selection bias.
Derived anchors used in the re-test column (approximate, from those givens): to separate an effect of
**~2 points** needs on the order of **10,000 games per arm**; **3 points ≈ 4,000**; **5 points ≈ 1,500-2,000**;
**7+ points ≈ 800-1,000**. Anything decided on 30-300 games saw only effects larger than ~10 points.

**(C) Cost kills against an implementation that has since changed.** The Rust engine is 2.7x faster than on
2026-09-02 (and ~100x faster than the Python loop it replaced); the net forward went 174 µs → **~3 µs per
leaf**; the arena batches leaves on the XPU. Net-in-the-loop rollouts were killed on cost and revived the
same day once the forward was rewritten — that is the template, and it should be applied to every other
cost kill in the log.

Cost anchors for re-test estimates, all from FINDINGS: 4,000-game arena proxy vs 3x `rab` ≈ **1.75 min**;
generation of 4,000 games ≈ **10 min** at 6.3-6.6 games/s; one training draw ≈ **1.6 min** (≈0.5 min at
`MAX_TS 300000`); 300-game Python-AlphaBeta gate ≈ **9.5 min**, 1,000 games ≈ **31 min**; full loop round
≈ **22 min**. A full one-ply net playout ≈ 6 ms; a depth-2 decision 1.5-3 ms.

Current facts the audit is measured against: incumbent **v55 beats 3x `rab` at ~69%** one seat of four
(2762/4000); a **four-checkpoint prediction ensemble at the leaves scored 2842/4000 on the same seeds,
+2 points**; the headline line vs 3x Python AlphaBeta is v40 55.2% → v49 57.3% → v51 56.3%, all inside one
interval.

---

## Main table — kills bearing on the live M4 loop

| # | Idea (one line) | Where in FINDINGS | Kill numbers | Kill condition | Confounds | Mechanism still stands? | Minimal re-test today |
|---|---|---|---|---|---|---|---|
| 1 | **Deeper search over a deterministic `base_fn`** (depth 3 instead of 2) | 09-01, "Iteration-0 gate: NOT met", *Depth-3 calibration* | `ab3` vs 3x AB **9/35 = 25.7%** [14.2, 42.1] vs 25% symmetry → "Lever 3 is dropped" | One 35-game run, one player, Python AB with *random* chance nodes | **B, extreme.** 35 games sees only effects ≥ ~15 points. **Contradicted inside FINDINGS itself**: `rab3` (exact chance nodes) **28.6%** [20.8, 37.8] at 105 games vs `rab` 21.0% — **+7.6 points**, never routed back to the dropped lever | **No.** The claim "one extra ply of the same heuristic buys nothing" is false as stated; FINDINGS' own later note (each extra ply of AB adds noise *because its chance nodes re-roll*) is the correct scope, and `rab3` has exact ones | Already answered — re-score `rab3` vs `rab` at 4,000 arena games (~4 min, no training) to nail the +7.6. Useful only as the control for #2 |
| 2 | **Depth 3 / reshaped trees under the *net* evaluator** | 09-02 (evening), "search depth is not the lever" | same `v25.pt`, seeds 0-999: depth 2 **30.7%**; depth-3 paranoid **24.9%**; own-turn depth-2 **24.4%**; own-turn depth-3 28.2% | 1,000 seeds per arm, one fixed net, swapped search | **B mild** (deltas 5.8 / 6.3 pts ≈ 4σ, real); A not applicable (no training) | **Yes, with a named repair.** Min over 10-15 replies scored by a noisy evaluator is biased low and by a different amount per branch; and v25's values are not consistent across state phases, so it is co-adapted to the depth-2 leaf distribution. FINDINGS itself flags "swapping the search under a fixed net is not a valid test of the search" | **Not plain depth 3** — top-k reply pruning (k=2-3, net's own 1-ply order, bias 1.74σ→0.85σ per RESEARCH-PLAYTIME §2) then a soft-min τ-sweep at min nodes. Each arm: no generation, 4,000-game gate ~2-4 min at 10-30 ms/decision (call it 30-60 min/arm). Needs ~4,000 games to see 3 points; 5 arms ≈ half a day |
| 3 | **Label volume** (`--max-ts` 100k / 300k / 900k) | 09-22, "label-scaling sweep" | draws **677 / 669 / 661** mean (soup's 1,000 games) vs v49's **731**; every arm's soup kept no draw | 3 draws per budget, one shared 1,000-game seed, incumbent v49, loop's default (destructive) step | **A-dominant** — every draw carried the −5 constant, and the measured spread across budgets (16 games ≈ 1.6 pts) is inside draw noise. **B**: 1,000-game scoring, 3 draws/arm | **Unproven either way.** "More labels don't help" was measured *given a step that destroys 5 points before any label enters*. The state axis may still be saturated — but this experiment cannot say so | Re-run the same three budgets with `--lr 1e-4 --dropout 0 --weight-decay 0`, 3 draws each, on the **existing** `it46-49` shards. **Zero generation**; 9 draws × 0.5-1.6 min + 3 × 4,000-game gates ≈ **40-60 min**. Counts as a result if a budget's mean draw lands within ~2 points of its warm start while another is ≥3 below (≈4,000 games/arm) |
| 4 | **Update size** (epochs 1/2, lr 3e-4 / 1e-4) | 09-22, "Update size, same protocol" | every arm ties the incumbent; draws 634-677 vs base 695; "at a tenth of the learning rate a draw still lands 2-6 points under its warm start" | 3 draws/arm, 1,000-game soup seeds, 4,000-game gate on the soup | **A-dominant, and specifically incomplete**: the lr arms kept **dropout 0.3**, and the later self-target sweep shows dropout 0.3 + lr 1e-4 is *still* −11 (681 vs 692). Decay was never zeroed in this sweep | **Partly.** "Step size alone is not the lever" is right for the axes tested; the axis that mattered (dropout × lr × decay jointly) was found two entries later | Largely superseded — the non-destructive step is already identified. What is untested is **epochs at the fixed step**: 1 / 2 / 6 epochs with `--lr 1e-4 --dropout 0 --wd 0`, existing shards, **~30 min**, 4,000-game gate per arm |
| 5 | **Net-in-the-loop rollout labels, all four seats** (`--roll-net all`) | 09-22, rounds 50-53 table | round 50 draws **612 587 574 551 488** vs base 727 — "the worst draws of the campaign" | 5 draws, one round, 1,000-game soup seeds, loop's destructive step, `DATA_LAST=1` | **A-dominant** (every draw −5 before labels) **+ a real second effect**: the self-play net-vs-net continuation is the furthest from the arena's and the gate's `vnet + 3 rab` condition | **Yes — and it now has literature.** Simulation balancing (Gelly & Silver): rollout policies need *balance* and low estimator variance, not strength. `own` over `all` is the correct reading and FINDINGS says so | Low priority. If revisited, only as `all` vs `own` vs `rab` at the **fully** fixed step on one round's shards, 3 draws each, ~1 h. Rounds 56-57 run `own` at `--lr 1e-4 --dropout 0` but **without `--weight-decay 0`**, so they are close to but not the certified step — don't treat them as the answer, and don't duplicate them either |
| 6 | **Rollout-only vs +outcome vs +aux** — the outcome loss dropped, the aux heads dropped | 09-03, "the outcome loss was the drag" | full recipe **30.1%**, no-outcome 51.1%, **rollout-only 53.0%**, no-aux 36.0%, rollout-10-no-outcome 42.9% (v31 = 56.3% there) | **One draw per config**, 1,000-game proxy, all through the destructive step | Outcome-vs-rollout: **A-neutralised** (23-point gap, survives). Aux-vs-no-aux: **B, badly** — 51.1 vs 53.0 is 1.9 points on one draw each, when FINDINGS' own v27d seed replicates measured a **±6-point single-draw spread on identical configs**. That is a coin flip recorded as a decision | Outcome loss: **the mechanism is real** (one bit per game shared by ~150 correlated states — the iteration-0 memorisation result is the independent receipt), though its *magnitude* is A-inflated: a loss with a real gradient moves the net far, and a far move at lr 1e-3 + dropout 0.3 is doubly destructive. Aux heads: **no mechanism was ever offered** | **Aux heads only** (see shortlist #5): retrain from v55 with `--aux-weight 1` at the fixed step, 3 draws, existing shards. **No generation, ~20 min + one 4,000-game gate.** The consequence, not the win rate, is the point: v40/v55's per-seat VP heads are untrained, which blocks max^n backups (RESEARCH-PLAYTIME §2d) *and* costs the site its VP display. Counts as a result if play is within ~2 points (≈10,000 games to prove a tie; in practice accept "no worse at 4,000") **and** the VP heads calibrate |
| 7 | **Wider net** (hidden 512, from scratch) | 09-02 (night), round 31 bullet list | 3 draws on it28-it31: **30.8-40.4%** vs the incumbent's ~51%; "width is not the lever" | 3 from-scratch draws, 1,000-game proxy, destructive step | **Three confounds stack.** **A-dominant**; **from-scratch vs the warm-start lineage** (FINDINGS' own explanation: "the warm-start lineage carries what the loss does not measure") — width was never varied at matched initialisation; and the 512 arm posted the **best held-out loss on record (0.401-0.406)**, which per RESEARCH-SIGNAL §1.8 is exactly what a good net looks like when the selection signal is broken | **Not as a width claim.** As a *"from-scratch loses the lineage"* claim, yes, strongly | Don't re-test width. The cheap form of "more capacity" is the **prediction ensemble**, which has already paid +2 points (2842 vs 2762). See shortlist #3 |
| 8 | **Pairwise ranking between rollout-labeled siblings** (`--ro-rank-weight 1`) | 09-02 (night), round 31 bullet list | draws **23.6-43.9%** vs v30's 51.5% on the selection seeds; "stopped after the first variant" | 126k pairs from one round, one variant, 1,000-game selection seeds, destructive step | **A-dominant** for the magnitude; the *direction* is far outside draw noise (−8 to −28) | **Yes for hard pairwise**: binary single-rollout labels turned into hard pairwise targets are noise sharpened into labels — the v9 / v26ts failure from the other side. FINDINGS names the right use itself: "Soft BCE on the same rows" | **The soft/listwise variant is genuinely untested** (RESEARCH-SIGNAL #6). Prerequisite: CRN across siblings (#9) so the sibling *difference* is not √2·σ of noise, and `roll_m ≥ 3` shards. One round of generation (10-25 min) + 3 draws + one 4,000-game gate ≈ **1 h**. Must beat a same-budget BCE-only arm, not just the incumbent — needs ~4,000 games for 3 points |
| 9 | **Any target derived from the net's own depth-2 search** — v9 (hard argmax self-labels) and v26ts (soft chance-averaged search values) | 09-02, "Iteration 9: self-labeled sibling sets hurt"; 09-02 evening, "it26 results" | v9 **20.7%** [18.3, 23.3] vs v8 28.0% on the same 1,000 proxy seeds; v26ts **23.3%** [22.0, 24.6] vs v25 30.3% at **4,000 games** — both ≈ −7 points | Two independent designs, two eras, 1,000 and 4,000 games | **A-neutralised** (within-round A/B, −7 pts ≫ noise); **B satisfied** at 4,000 games for v26ts | **Yes — the strongest mechanism kill in the log.** TreeStrap/TD-leaf need a search genuinely stronger than the evaluator; here depth 1 vs depth 2 with the same net is 27.0% vs 30.7% — **the search is worth ~4 points**, so its values are the net's own biases plus noise, and regressing onto them is self-reinforcement | **Do not re-test.** The only form that is not a target is a **control variate** (unbiased by construction) — RESEARCH-SIGNAL §3.2's luck adjustment, ~2 µs/roll. That is a different object and is untested |
| 10 | **Older, more distinct games** (v26_alldata: 21 iterations / 84k games instead of 16k) | 09-02 evening, "it26 results" | **28.6%** [27.3, 30.1] vs v25's 30.3% [28.9, 31.8] — −1.7 points, rejected | 4,000-game head-to-head, one draw, destructive step | **B, marginal** — 1.7 points on an unpaired 4,000-game comparison is ~2σ, i.e. right at the gate's 30-40%-power band. **A-dominant** for a one-draw result | Weak. "Off-policy data from weaker generators is slightly harmful" is plausible and consistent with #3's flat scaling, but this number alone does not establish it | Low value, and **subsumed by #3**: run the label-volume re-test with a *window* axis (last 1 / 4 / all iterations) at the fixed step. Same ~1 h, no generation |
| 11 | **`ent_coef=0.01` + separate pi/vf trunks** (PPO) | 08-31, "M2 v2"; 09-01 corrected curve | **62.6%** [59.6, 65.5] at 1.51M steps vs the shared trunk's own 1.50M checkpoint **77.6%** [74.9, 80.1]; confirmed off-slice at seed 5000 (63.1 vs 77.9) | 1,000 games × 2 disjoint slices, matched step budget | **B satisfied** (a 15-point gap at 1,000 games is ~10σ). No A (pre-value-net era) | **Yes as a joint kill.** Higher `value_loss` throughout (0.03-0.04 vs ~0.003) is consistent with the separate value head needing more samples | **`ent_coef` alone on the shared trunk was never run** — FINDINGS says so twice and it stayed unrun. But the whole PPO line is dormant and its ceiling (79% vs weighted-random, 1.7% vs VFP) is three orders of magnitude from the M4 gate. **Recommend leaving dead**; the mechanism gap was search, and that is settled |
| 12 | **Production / buildable-node observation features** (24 extra) | 09-01 (continued, 2), "observation-gap lever tried, also ruled out" | M2 peak 78.2% = baseline; M3 bridge **2.3% / 1.7%** vs baseline 1.7% at 300 games | 11 checkpoints × 1,000 games (M2), 300 games (M3) | B mild on the M3 arm (300 games) but the M2 curve is well-powered | **The null stands for PPO. The conclusion drawn from it does not.** The same information, re-expressed as `base_fn`'s own terms, is what took the value net from 6.0% to 18.7% (v2) — FINDINGS: "the features were the missing piece" | **Nothing to re-test; keep it as the epistemic exhibit.** "Null under algorithm X" ≠ "no information in the feature." The 2026-09-01 write-up generalised a PPO null into a representation verdict and was wrong by its own later record |
| 13 | **Factored conditional action heads** (PPO) | 09-01, "BC-from-VFP result" | killed by *positive counter-evidence*: BC into the flat `Discrete(370)` head reached **96.2%** [94.1, 97.6] vs 3x weighted-random, vs VFP's own 98.2% | 500 held-out games | B satisfied | **Yes.** The flat head demonstrably represents VFP-quality play; representation was not the M2 bottleneck | Dead and correctly dead *for the stated question*. It was never tested as a sample-efficiency or generalisation lever (settlers-rl uses them), but that question is moot — the project no longer trains a policy head |
| 14 | **1-ply greedy search over PPO's own critic** | 09-01 (continued, 3) | search **59.3%** [53.7, 64.7] vs reactive 61.3% [53.3, 68.8] (300 / 150 games); vs `value_function` 3.3% vs 0.7% | 300 games, one checkpoint | B: intervals wide, but both readings point the same way | **Yes, and it is the intellectual root of the whole M4 line.** PPO's critic and policy are trained from the same on-policy data under the same objective, so greedily maximising that critic is near-redundant. AlphaZero-style values are trained on search-bootstrapped targets and are not that | Dead and correctly dead. Superseded by `value_net.py`, which is the fixed version of exactly this idea |
| 15 | **The smooth `base_fn` stand-in as a player** (`rsab`, PRIOR_SCALE) | 09-01 (late), "the smooth prior is a bad player" | `rsab` **6/105 = 5.7%** [2.6, 11.9] vs 3x AB, against lexicographic `rab`'s 21.0% with the identical search | 105 games | **B**: 105 games — but a 15-point gap at n=105 is still ~3σ | **Yes.** `base_fn` is lexicographic (weights 3e14 … 1e2); a bounded trainable logit cannot be both lexicographic and differentiable. Robber placement 19/40 differ, roads 16/82, trade-vs-end-turn 9/64 — exactly the tiny terms | Dead as a *player*. Note the same entry records it working as an **initialisation** (v4 at prior scale 0.1 = 21.3%, best at the time), and that half was abandoned when v5's listwise loss overtook it rather than because it failed. Not worth reviving — the current net is 3 generations past base_fn |
| 16 | **All-pairs sibling ordering distillation of `base_fn`** | 09-01 (late), "Fix 2 attempted" | held-out top-1 agreement stalls at **0.44** (combined) / **0.48** (alone) | held-out metric, no play gate | No A/B/C — this was killed on a held-out *ceiling*, not a play score | **Yes.** Same lexicographic-ratio mechanism as #15 | Dead, and it produced the fix that worked: listwise top-1 (0.575 → v5 parity). Nothing to revive |
| 17 | **`base_fn` imitation losses** (chosen-vs-other pairs + `base_fn` sibling labels) | 09-02 evening, v27d sweep | v27d (no pair/sib) **38.2%** [36.7, 39.7] vs v27b (pair 0.5 + sib 1 + rollout 3) 34.8% and v27c (rollout 10 alongside) 30.2%; incumbent v25 32.6% | 4,000 games per arm, same seeds, single draws | **A-neutralised** (all arms same step); B satisfied at 4,000 games for a 5.6-point effect | **Yes.** "A net that must agree with `base_fn`'s ranking cannot rank better than `base_fn`" — and the line had sat at ~31% for 15 rounds under exactly that constraint | Correctly and permanently dead. The student is now far past the teacher |
| 18 | **`base_fn`-continuation rollout labels themselves** (the current loop's signal) | 09-22, "the labels still point down" | real `rab` labels from v51 through the **fixed** step: **673, 652** (two seeds), lr 3e-5: 640, old step: 643 — vs base **692** | 1,000 games, 2-4 draws, non-destructive step | **A removed by construction** (this is the post-fix measurement); **B**: 1,000 games, σ≈1.5, so −2 to −5 points is 1.5-3σ — suggestive, not airtight | **Yes, and it is the loop's actual ceiling.** The depth-2 student is stronger than `rab` and than its own one-ply self; regressing toward a weaker policy's continuation values is a step toward that policy. It is an *economic* cap (labels from the depth-2 student itself are ~160x per row), not a bug | Confirm at power before building on it: the same two arms at **4,000 games each** (~4 min of gating, draws already exist) to turn a 1.5-3σ reading into a decision. This is the single number the next three months of the project hinge on |
| 19 | **Net-in-the-loop rollouts, killed on cost** | 09-22, "killed by one number" → "un-killed" | killed on **174 µs/leaf** (rollout decision = 35 µs), projected 0.05-0.1 games/s against a kill line of 2 | one micro-benchmark of the scalar Rust forward | **C, and the log's own worked example.** A sparse AVX2/FMA kernel over a ~90% zero input (43k MACs instead of 402k) put it at **~3 µs/leaf**; `--roll-net all` then ran at 2.99 games/s and `own` at 4.88 | The *idea* was never wrong; the *implementation* was | Already revived the same day. **Read this row before accepting any other cost kill in the table** — it is the calibration for how much a "too slow" verdict is worth here |
| 20 | **Rollout MCTS** (Python `MCTSPlayer`) | 08-31, "Search cost"; 09-03 tournament; 09-07 thesis agents | Python: **13-40 s/game at 10 sims** vs 0.02 s/game random → "dead in Python at any useful simulation count". Strength: `mcts100` **0/400 = 0.0%** in the EUMAS pool; UCT/BUCT/VPI 34/30/10% vs stock jSettlers | cost kill (2026-08-31), then two independent strength kills | **C dissolves the cost kill entirely** — `catan_engine/src/mcts.rs` runs **5,000 playouts in ~0.25 s**. The strength kills are real but are of *random-playout, VP-reward* MCTS, not of MCTS with net values | Cost claim: dead. Strength claim: scoped to the variant tested | **Steelman it, don't retry it** (the item just outside the shortlist's eight): `Mcts::playout` returns the net's P(win) at a **2-4 round** cutoff instead of VP/10; root children seeded from `backup_full`'s depth-2 EVs as prior visits; λ-mix of truncated playout and net value. Tune to a **30 ms** decision budget (not `uct`'s 0.25 s, which makes a 4,000-game gate 3.6 h). ~1 week to the λ arm |
| 21 | **"Label the trade policy"** (RESEARCH-DATA #4) | 09-22, "Retired on reading" | no measurement — retired by code reading | `trade.rs` scores *hand-modified* states with the net and never searches `OfferTrade` children, so rollout labels on offer-pending states would train something no decision consumes | None of A/B/C — this is an argument, and a correct one **given the current search** | **Yes, conditionally.** It is true only while offers stay outside the search tree | **The premise is the thing to change, not the conclusion.** Put offers *inside* the depth-2 tree (RESEARCH-PLAYTIME #5: rank `domestic_trade_possibilities` by 1-ply net gain, keep top 3-5, model each opponent's accept with the same net, attach accept/reject as a chance node). ~3 days, +1-3 ms/decision. The jSettler's negotiator is worth **~15 points to its own seat** (32.0% with, 16.5% without) — the largest structural gap per line of code in the project |
| 22 | **The α step-size / soup tuning axis** | 09-22, "the soup's 1,000-game gains do not transfer" | round 53 α=0.3 scored **+28 on the soup's 1,000 games**, then **2712 vs 2710 on 4,000 fresh gate games — an exact tie** | 1,000-game selection with best-of-six on top, then a 4,000-game gate | **B is the finding, not the confound.** σ≈15 games per 1,000 plus a best-of-six pick reproduces +28 from nothing | **Yes.** The soup's per-round "gain" is mostly its own selection noise; the accepted rounds since v40 (+3.1, +0.7, +0.15 on 4,000 games, each a strict `>` on one seed) are consistent with a flat line — v40 55.2 → v49 57.3 → v51 56.3, all inside one interval | **Do not tune the soup further.** The principled replacement is an **EMA of the weights** from step 1 (SWA; what Lc0 does), saved instead of the best-held-out checkpoint. Hours, no generation. Judge it against the same rebuilt gate as everything else |
| 23 | **Held-out BCE as the checkpoint-selection signal** | 09-02 afternoon, rounds 11-15; 09-02 evening (v26ts); 09-02 night (512 net) | "early stopping keeps picking the step-90 checkpoint — the selection signal does not track play"; v26ts posted *normal* held-out numbers while losing 7 points; the 512 net posted the **best held-out loss on record** while playing 10-20 points down | repeated across eras | not a confound — this is the instrument failing | **Yes, with a mechanism** (RESEARCH-SIGNAL §1.8): held-out BCE is dominated by global discrimination; play depends on *sibling differences* | **The replacement is the highest-value free measurement in the project.** `ro_rank_acc` already exists in `train_value.py:281-286` and is already printed; it enters `score` only at `--ro-rank-weight`, which `run_exit.sh` never passes. Run it **retrospectively over every stored draw of rounds 46-55 and correlate with the arena score those draws got** — hours, zero generation, and it either hands the loop a seconds-cost selection signal or rules one out |
| 24 | **Self-play PPO from BC** (M3) | 09-01, "M3 Step 5" | **9.0%** [7.4, 10.9] vs 3x VFP, gate >50%; BC alone was 7.8% [5.8, 10.5] — CIs almost fully overlap | one 1M-step run, one pool trajectory (uniform sampling, single BC seed), 1,000-game gate | B satisfied for "not 50%"; **under-powered for "no better than BC"** | Partly. FINDINGS reads it cautiously itself and lists three untested causes (pool diversity, uniform-over-history sampling, budget) | Dormant era; the whole PPO line's ceiling is 1.7-9.0% vs VFP while the value net is at 55-57% vs *AlphaBeta*. **Leave dead** |
| 25 | **Opponent-strength curriculum** (`mixed_1vf`) | 09-01 (continued) | mean **80.1%** vs baseline 78.6-79.3% (6 checkpoints × 1,000 games); M3 bridge **2.0%** vs 1.7% at 300 games | well-powered on the M2 gate | B satisfied on M2 | **Yes.** A 1-in-3 curriculum is a much easier field than the gate it was meant to transfer to | Dead, and superseded: the value-net loop's `vnet x2 + rab x2` arena *is* a curriculum, and it works |
| 26 | **`torch.set_num_threads(1)` in the trainer's main process** | 08-31, CPU thread-pool investigation | ~512-515 fps → **~250-276 fps**; reverted | instantaneous per-iteration fps, three configs | The *first* evidence for it (an isolated micro-benchmark showing 1 thread 5x faster) was **measured while the live training job was running** — the 8-thread arm was contended against itself | **Yes, and it is a two-sided finding**: the opposite call is correct inside `self_play.py`'s *workers* (many batch-1 calls in a process already fighting for threads), and FINDINGS establishes that empirically rather than assuming it | Dead; the whole path is legacy. Kept in the table because it is the log's clearest example of a contended micro-benchmark producing a confidently wrong conclusion |

---

## Compact table — kills whose mechanism is arithmetic, bitwise-verified, or otherwise closed

One line each. These are solid; the reasoning is in the closing section where it is not obvious.

| Idea | Where | Kill | Verdict |
|---|---|---|---|
| Shared-memory IPC to replace the pickled request queue | 09-01, "IPC bottleneck: contention, not pickling" | 8 procs on 8 threads: shm 8,680/s vs Queue 9,174/s — **marginally slower** | **Solid.** The cause was process/CPU contention, not serialisation; busy-polling spends the cycles `Queue.get()` yields back. Directly retracts RUST-ENGINE trigger #2's proposed fix |
| `target_kl` as the explanation for the PPO plateau | 08-31, "`target_kl` fix"; 09-01 corrected curve | `approx_kl` 0.39-0.46 → 0.009-0.014, win rate 76.0% → 75.5% (and the corrected 1,000-game curve is flat 79.3 → 79.3 from 1.0M to 3.0M) | **Solid.** The hygiene fix was real and kept; the plateau hypothesis is dead |
| More PPO steps (1.0M → 3.0M) | 09-01, "the real M2 learning curve" | 69.8 (0.6M) / **79.3** (1.0M) / 77.6 / 79.0 / 78.8 / **79.3** (3.0M) at 1,000 games each | **Solid.** Seven points, every CI overlapping, confirmed off-slice at seed 5000 |
| `gamma=0.99` hiding the win reward | 09-01, "Hypotheses killed this session" | `ep_len_mean` ≈ **70** decisions, not 435; `0.99^70 ≈ 0.50` | **Solid** — ruled out analytically before spending a run, which is the right call |
| `TURNS_LIMIT` truncation losing games | same | **0 truncations in 50 games** | Solid |
| `vp_shaped_reward` not telescoping across the skip | same | mean episode return on wins **1.96 ≈ 1.0 + 0.1×10 VP** | Solid |
| Multi-threaded torch non-determinism explaining eval spread | same | `OMP_NUM_THREADS=1` **reproduced** the spread (44/50 then 38/50); `PYTHONHASHSEED=0` fixed it | Solid, and the real cause (hash randomisation → set iteration order → opponents' `random.choice`) is nailed |
| `torch.set_num_threads(1)` in `evaluate.py` | 09-01 | "tested here and is not the cause" | Solid |
| `FastCatanatronEnv`'s `AssertionError` fallback firing | 09-01, hypotheses table | **0 hits in 50 games** | **Partly wrong, and FINDINGS corrects it**: the `CachedMaskVecEnv` staleness bug made it fire on **100% of episode boundaries / 1.29% of transitions** in the *SubprocVecEnv training* path. The 50-game probe measured a different path. Common-mode across all PPO arms, so no A/B is invalidated |
| BC-from-VFP as a destination (not a diagnostic) | 09-01 | 96.2% vs weighted-random but **7.8%** vs 3x VFP; VFP itself is 10% vs 3x AB | **Solid** by construction — BC cannot exceed its teacher, and the teacher does not clear M4 |
| Device-side XPU overlap via streams/events | 09-02, arena section | waiting on an event recorded after forward A blocks until a later-queued matmul B finishes (A; sleep 20 ms; B; sync A = **38 ms**) | **Solid, measured.** "Don't build on streams" — the helper-thread + ping-pong-arena design is the working answer |
| Robber pruning (robber only onto enemy-adjacent tiles) | 09-02 night, gen-speed | **1.03x** — "nearly every tile touches an enemy building" | Solid |
| Branch-and-bound in the longest-road DFS | 09-22, gen-speed | **−6%**, reverted | Solid, bitwise-verified |
| Inline `players` list on `State` | 09-22, gen-speed | +600 B per State copy, **−10%**, reverted | Solid, bitwise-verified |
| Unprimed `reachable_production` memo | 09-22, gen-speed | "unprimed it was a loss" | Solid |
| Plain (ungreedy) soup over 5 draws | 09-02 evening | 5-seed plain soup **38.6%** vs the 3-net soup's 43.7% — averaging is not monotone in draws | Solid; replaced by `soup.py --greedy`, which recovered exactly the 3-net soup |
| Incumbent scored once on fixed seeds (rounds 16-18 acceptance rule) | 09-02 afternoon | incumbent 1,271 vs challengers 1,127/1,248/1,107 — **all rejected**; diagnosed as the winner's curse | Solid; fixed by fresh-seed head-to-head each round |
| `GreedyPlayoutsPlayer` in the tournament | 09-03 | excluded at **34 s/game** | Cost exclusion, not a strength claim; `mcts100` scored 0/400 on its own |
| Patching catanatron's `execute_spectrum` chance-node bug in the *opponent* | 09-01, batched expectimax | deliberately not done — "the target is `AlphaBetaPlayer` as shipped" | Correct scoping, not a kill. Our own search pins outcomes; AB's does not |
| Maximum drawdown as the "run of bad luck" marker | 09-06 | median span **138 steps / 42% of the game** — what a random walk's drawdown always does | Solid; a fixed 5-roll window captures 58% of the depth in a readable span |
| Entropy drop as the deciding-move selector | 09-06 | top-5 by \|ΔH\| overlaps top-5 by \|Δp\| only **26%**, drags rolls and end-turns back in | Solid |
| A "played well, got unlucky" badge | 09-06 | describes **60% of games** at any reasonable threshold | Solid |
| Total variation ½Σ\|Δp\| instead of max_k\|Δp_k\| | 09-06 | tracks max_k within 0.01 at **every** percentile | Solid — theoretically correct, empirically identical, so the cheaper form ships |
| A bare \|Δp\| threshold for deciding moves | 09-06 | 0.15 marks nothing in **50%** of games; count is not lineup-portable (5.1 vs 2.6 marks at 0.12) | Solid; top-5-with-floor-0.10 is the shipped rule and both halves bind |
| Labelling a single roll's luck | 09-06 | residual sd 0.015 against luck sd 0.017 — **S/N ≈ 1.1** | Solid. Aggregate before displaying; the running sum is trustworthy, one roll is not |
| Zero-sum across seats as a luck correctness check | 09-06 | Σp_k median **1.079** — four independent sigmoids, no softmax | Solid; mean-zero per seat is the property that holds |
| DRRL's literal readings (`drrl:blcw` etc.) | 09-07 | arena 7.0-10.7%; bridge: `drrl:c` 16.0%, fully literal `drrl:blcw` **5.0%** vs the paper's 45% | Reproduction work, not our lever. The earlier "counter-offers help" gain evaporated to 5.0% once the engine actually *applies* counters — "the gain from `c` was the gain of rejecting" |
| Regret at decision nodes as a human-mistake marker | 09-06 | `vnet` regret 0.000 by construction; `heuristic` under `vnet` eval: median 0.000, p99 0.065 | Measured but not shipped — it inherits the net's bias where luck does not |

---

## Ranked shortlist — top 8 re-tests by expected value / cost

**Slot 1 is a precondition, not a competitor.** At σ ≈ 1.5 points per 1,000 games and ~30-40% power at
1.5 points on the 4,000-game gate, slots 2-8 are individually invisible: every effect worth chasing here is
1-3 points, and the project has already bought that lesson twice (the round-53 α=0.3 "+28" evaporating to
2712-2710; rounds 16-18's winner's curse). Do slot 1 first or the other seven produce noise with confidence
intervals on it.

### 1. Rebuild the gate: per-game logging, paired differences, SPRT to a 16k cap
*≈1 day; then +0-12 min per round, often less than today's 3.5.*

**Steelman.** This is not a kill being revived — it is the instrument every kill in the table was measured
with, and the table shows it failing in three distinct ways: 35-game decisions (`ab3`), 1,000-game
best-of-N selection (α-search, the label sweeps), and one-draw-per-config comparisons with a known ±6-point
draw spread (the aux-head drop). The fix is standard and cheap: log per-game rows, score incumbent and
candidate on **identical board layouts, dice streams, opponent seeds and seat assignments**, report the
paired difference, and run a normal-approximation SPRT (H0 = −0.005, H1 = +0.010, α = β = 0.05, bounds
±2.944, cap 16,000). Two caveats worth stating up front so nobody over-promises: pairing here shares the
board and the opponents' seeds but the two arms **diverge at their first differing decision**, so expect
20-30%, not the several-fold cut engine testing gets — the honest output is a *budget statement* (≈10,000
games to separate 2 points). The larger win in the same place is probably the **outcome measure**: score VP
margin or finishing rank instead of win/loss. `gen_games.py:151-153` already records all four seats' final
VPs, it is orthogonal to pairing, and it stacks. Verify with an A/A run — incumbent against itself on
different seeds — and confirm the accept rate is ≈ α. SPRT also *saves* time on average, because most
candidates are not close.

### 2. Replace the checkpoint-selection signal: sibling-ordering concordance, measured retrospectively
*Hours. Zero generation. The code already exists and is already printed.*

**Steelman.** The kill being revived is "held-out BCE tells you which checkpoint plays best" — and the log
shows it failing in three separate eras with the same signature: early stopping kept picking the step-90
checkpoint through rounds 11-15 while successive nets swung 3-5 points in play; v26ts posted entirely
normal held-out numbers (0.460 / 0.862 / 0.596) while losing 7 points; the 512-wide net posted the **best
held-out loss on record** while playing 20 points down. RESEARCH-SIGNAL §1.8 gives the mechanism — held-out
BCE is dominated by global discrimination across dissimilar states, while play depends entirely on
*differences between siblings of one decision*, which is a rounding error in that average. The replacement
already exists: `ro_rank_acc` (`train_value.py:281-286`) computes held-out pairwise concordance against the
rollout labels, is already printed every round, and enters `score` only at `--ro-rank-weight`, which
`run_exit.sh:53` never passes. The experiment is free and retrospective: compute it over **every stored
draw of rounds 46-55 and correlate it with the arena score those draws actually got**. If concordance
tracks play where BCE does not, the loop gains a selection signal costing seconds instead of 1,000 games —
which is the prerequisite for evaluating slots 4, 5 and 8 without burning a gate on every variant. Two
cheap extensions while you are in there: restrict concordance to sibling sets whose ground-truth top-1 gap
clears a threshold, so ties stop diluting it; and add draw-vs-incumbent ordering agreement as a churn
measure. One change regardless of the outcome: drop `ho_loss` from `score` — the game-outcome BCE the loop
deliberately refuses to *train* on because it is harmful currently contributes a quarter of the criterion
that picks which checkpoint ships.

### 3. Play-time prediction ensemble at the leaves — K=3-5, then make it the loop's candidate
*Hours. Already +2 points measured (2842/4000 vs 2762 on the same seeds).*

**Steelman.** The kill this revives is "bigger/wider nets are measured negative" — a verdict resting on one
from-scratch 512-wide arm that posted the best held-out loss ever recorded here (0.401-0.406) while playing
30.8-40.4%, i.e. three confounds deep (from-scratch loses the warm-start lineage, the destructive step, and
selection on a signal that does not track play). The right reading of that arm was never "capacity is
useless"; it was "our selection cannot tell a good net from a bad one." Meanwhile every 2026-09-22 result
says the binding constraint is **variance**, not capacity: single draws are 5-24 points below their average,
and weight averaging is the only thing that has produced gains. Averaging *predictions* of K diverse
checkpoints is strictly more diverse than averaging their weights, and it shrinks σ at the leaves — which
in turn shrinks every max/min bias in the search (RESEARCH-SIGNAL §1.7), making slot 6 more likely to work.
The forward is 3 µs/leaf, so K=3-5 is 2 ms → 6-10 ms per decision and nothing else in the pipeline changes.
The +2 points is already in hand; what is not yet done is (a) confirming it under slot 1's paired gate
(2 points needs ~10,000 games unpaired), (b) sweeping K and the checkpoint set, and (c) the consequential
question — **if ensembling beats souping, that is a statement about what fifteen rounds of training have
actually been doing**, and the loop's candidate should become an ensemble rather than a soup.

### 4. Settle the label ceiling at power, then re-run the volume and window sweeps at the fixed step
*Four minutes for the first half. ≈40-60 min for the second. Zero generation — the shards and the draws exist.*

**Do the four-minute half first.** Row 18 is the number the project's direction hinges on: `rab` labels
from v51 through the fixed step gave draws of **673, 652** (and 640 at lr 3e-5, 643 at the old step)
against a base of **692** — a 2-5 point downward pull measured on 1,000 games, i.e. 1.5-3σ. Suggestive is
not decided. Those draws are on disk; re-gating two of them against v51 at **4,000 games** is ~4 minutes
of arena time and converts the pivotal reading into a decision before anything else on this list is run.
If the pull is real, every Monte-Carlo-value lever in this document is capped and the effort belongs at
play time (slots 3, 6, 7 and the MCTS item); if it is noise, the label axis reopens.

**Then the sweeps.** "More labels do not help and may hurt" (100k / 300k / 900k, means 677 / 669 / 661 against a
warm start of 731) is the most confidently-stated dead end in the recent log, and it is the purest
A-dominant kill in the table: every draw in every arm carried a −5-point constant from the optimiser before
a single label entered, and the spread *between* budgets was 16 games — about 1.6 points, comfortably inside
draw noise. The experiment measured the step, not the data. It is also the cheapest thing on this list to
redo correctly, because the shards are on disk and the non-destructive recipe is already identified:
from the **current incumbent v55** (not the original sweep's v49) on the existing `it46-49` shards,
`--lr 1e-4 --dropout 0 --weight-decay 0`, three draws per budget, scored on 4,000 games rather than 1,000.
Naming the warm start matters here — an unmatched initialisation is exactly what made row 7's width kill
uninterpretable.
Fold in the window axis while you are there (last 1 / last 4 / all iterations), which subsumes the
v26_alldata kill — that one was −1.7 points on a single unpaired 4,000-game draw, right at the gate's
power floor. The result that counts: a budget whose mean draw lands within ~2 points of its warm start while
another lands ≥3 below. If all budgets still sit 2-5 points down, that is not a failed experiment — it is
the clean confirmation of row 18, which is the number the project's direction hinges on.

### 5. Aux heads back on, at the non-destructive step
*≈20 min + one gate. No generation.*

**Steelman.** This is the flimsiest kill in the training-side record: `aux + rollout` 51.1% vs `rollout
only` 53.0%, **one draw each, on 1,000 games**, in a log that elsewhere measures a **±6-point spread across
seed replicates of an identical configuration**. A coin flip was recorded as a decision and then hard-coded
(`--aux-weight 0` in `run_exit.sh`), and no mechanism was ever offered for why predicting final VPs and
turns-left through a shared trunk should hurt a win-probability head — the usual auxiliary-task argument
runs the other way. What lifts this above "it was probably a wash" is the *consequence*: v40's and v55's
per-seat VP heads are untrained, which blocks max^n / vector backups (RESEARCH-PLAYTIME §2d needs exactly
those six outputs), removes the finer-grained VP-margin statistic slot 1 wants as its selection signal, and
costs the site its VP display — FINDINGS notes that last one explicitly. Re-test is retraining only: from
v55 on existing shards with `--aux-weight 1`, dropout 0, lr 1e-4, decay 0, three draws. It counts as a win
if play is **no worse** at 4,000 games (proving a true tie needs ~10,000, so accept the weaker standard
here) *and* the VP heads come back calibrated. This is the rare case where "no effect on win rate" is the
successful outcome.

### 6. Depth 3 with top-k reply pruning and a soft-min backup
*≈2 days for the sweep; per-arm gate 30-60 min at 10-30 ms/decision.*

**Steelman.** Two depth kills sit in the record and they are not the same kill. The first — `ab3` at
25.7% on **35 games**, CI [14.2, 42.1] — was decided on a sample that could not see anything under ~15
points, and FINDINGS itself later measured `rab3` at 28.6% vs `rab`'s 21.0%, **+7.6 points**, without ever
routing that back to the dropped lever. The second — v25 at depth 3 scoring 24.9% vs 30.7% over 1,000 seeds
— is well-powered and **correct as stated**, but its own write-up names the reason and the reason is
repairable: a `min` over 10-15 replies scored by a noisy evaluator is biased low, by a *different amount per
branch* (branches differ in how many replies they open), so end-turn branches are systematically mis-ranked
against keep-acting branches. RESEARCH-PLAYTIME sizes that bias at ≈1.74σ — 5-15x the 0.01-0.03 differences
between good root moves — and halves it to 0.85σ with top-k reply pruning (k=2-3) by the net's own 1-ply
order, which is *also* what makes depth 3 fit under `max_leaves`. So pruning goes in first and every later
arm rides on it; then sweep a soft-min τ ∈ {0, 0.02, 0.05, 0.1, ∞}. The honest caveat, from FINDINGS: the
net is co-adapted to the depth-2 leaf distribution (own-turn depth 2 differs in exactly one place and costs
6 points), so a fixed-net swap understates any search change — if an arm ties at depth 2, that is
encouraging, not neutral. Slot 3's ensemble shrinks the σ this whole family is fighting, so run it after.

### 7. Offers inside the search — which retires the "label the trade policy" retirement
*≈3 days; +1-3 ms per decision where offers exist.*

**Steelman.** "Label the trade policy" was retired on a code-reading argument that is correct and also
entirely contingent: `trade.rs` scores hand-modified states and never searches `OfferTrade` children, so
rollout labels on offer-pending states would train something no decision consumes. The fix is not better
labels, it is making the decision exist. The prize is the largest single structural gap the project has
measured in any opponent: the jSettler wins **32.0% with its negotiator and 16.5% without** — nearly half
its strength is trading — while our bots trade 1-ply, outside the tree, with the arena using `base_fn` for
both seats' trade decisions. The recipe needs no retraining: rank `domestic_trade_possibilities` by 1-ply
net gain (0.9 ms for ~300 candidates, already built), keep the top 3-5, model each opponent's accept with
the same net from its seat (two forwards per opponent), attach accept/reject as a chance node, and let the
existing depth-2 expectimax choose. One gating warning worth respecting: against `rab` the accept model is
*exact* (the opponent uses the same evaluator), so the arena gate will flatter this — pair slot 1's SPRT
with a 300-game bridge run against real jSettlers before believing the number.

### 8. Soft listwise sibling loss on rollout labels, *after* common random numbers across siblings
*≈5 lines of Rust + one round (~1 h) for CRN; then one round for the loss.*

**Steelman.** The kill here is hard pairwise ranking on rollout-labeled siblings (draws 23.6-43.9% against
51.5, stopped after one variant), and its mechanism is right: a single binary rollout per child turned into
a hard pairwise target is noise sharpened into a label — the v9 and v26ts failure arriving from a third
direction. But FINDINGS names the correct use in the same sentence and never ran it: **soft BCE on the same
rows**. Two things have to be true first, which is why this is slot 8 and not slot 4. (a) The sibling
*difference* currently carries √2·σ of independent rollout noise; hoisting the seed draw out of the
per-child loop in `arena.rs:87-114` so every child of a decision plays replicate *j* against the same chance
stream leaves the labels marginally unbiased while removing most of that — backgammon practice cuts
required trials by ≥3x with duplicate dice, and there is a two-line statistical pre-check (on `roll_m = 8`
shards, does `sd(ro_v[a] − ro_v[b])` drop ≥2x?) that settles it before any training run. That half is new
work, not a revival — label it as such. (b) The loss must be an **auxiliary on top of BCE, never a
replacement**: the search consumes affine-consistent scale across chance nodes, and a scale-free objective
destroys it — the 23.6-43.9% result is the receipt. Expected value is genuinely modest and conditional,
because the thing being ranked is still a rollout by a policy no stronger than the student. It must beat a
same-budget BCE-only arm under slot 1's paired gate, not merely beat the incumbent.

### Just outside the eight, on cost alone: MCTS with net values
*≈1 week to the λ-mix arm. Code exists (`catan_engine/src/mcts.rs`). Highest ceiling on this list.*

**Steelman.** MCTS is carrying three kills and exactly one of them is about the idea. The cost kill
(13-40 s/game at 10 simulations, 2026-08-31) is dead — confound C in its purest form; `mcts.rs` runs 5,000
playouts in ~0.25 s, a four-orders-of-magnitude change, and the project has already once un-killed an idea
on precisely this basis. The two strength kills (`mcts100` 0/400 in the EUMAS pool; UCT/BUCT/VPI at
34/30/10% vs stock jSettlers) are real but scope to a specific configuration: **random playouts to a round
cutoff with VP/10 rewards**, i.e. an evaluator vastly weaker than the one we now have. The live version
replaces the playout's return with the net's P(win) at a 2-4 round cutoff, seeds root children from
`backup_full`'s depth-2 EVs as prior visits, and λ-mixes the truncated playout with the net value at the
tree node. The external precedent is exact — AlphaGo's λ=0.5 mixture beat both pure variants in ≥95% of
games — and it lines up with this project's own observation that `uct` (41.5%) and `vnet` (49.8%) are
*differently* wrong, which is the condition under which mixing pays. It sits below the eight only because a
week of work cannot be justified before slot 1 makes its result readable; on ceiling alone it outranks
everything except the gate. Two discipline points when it runs: report a **strength-vs-budget curve** and
pick the 30 ms operating point, because `uct`'s 0.25 s makes a 4,000-game gate 3.6 h and the 16,000 games
slot 1 says you need take 14 h; and gate each stage separately, since the ceiling is high but so is the
number of ways to get it wrong.

---

## Kills I consider solid — do not spend a round on these

- **Any training target derived from the net's own depth-2 search.** Two independent designs, two eras,
  both −7 points (v9 hard argmax at 1,000 games; v26ts soft chance-averaged at 4,000). TreeStrap/TD-leaf
  need a search that knows materially more than its evaluator; here depth 1 → depth 2 with the same net is
  27.0% → 30.7%, so the search is worth ~4 points and its values are the net's own bias plus noise.
  Regressing onto them is self-reinforcement. The only non-target use — a control variate, unbiased by
  construction — is a different object and remains untested.
- **The `base_fn` imitation losses.** 38.2% without them vs 34.8/30.2% with, 4,000 games, and the line had
  sat at ~31% for fifteen rounds under exactly that constraint. A net required to agree with `base_fn`'s
  ranking cannot rank better than `base_fn`. The student is now far past the teacher.
- **Smoothing `base_fn`** (as a player) and **all-pairs ordering distillation of it.** Same arithmetic
  mechanism twice: weights spanning 3e14 to 1e2 are lexicographic, and a bounded trainable logit cannot
  express million-to-one priority ratios. The 5.7% player and the 0.44/0.48 held-out ceiling are two
  measurements of one fact.
- **Outcome labels as a *primary* training signal.** One bit per game shared by ~150 correlated states,
  against a net with ~1M parameters; iteration 0 memorised outright (train 0.028, held-out 2.12) and the
  memorisation was only ever patched, never cured. The 23-point full-recipe-vs-rollout-only gap survives
  confound A as a within-round comparison. (Its *magnitude* is A-inflated — a loss with a real gradient
  moves the net far, and a far move at lr 1e-3 + dropout 0.3 is doubly destructive — but the re-test EV is
  low: row 18 shows even rollout labels through the fixed step point 2-5 points down. Adding a weaker signal
  back is not the lever.)
- **Shared memory in place of the pickled queue.** Measured slower under the concurrency that matters
  (8,680/s vs 9,174/s at 8 processes on 8 threads); the bottleneck was contention, and busy-polling spends
  exactly the cycles `Queue.get()` returns to the scheduler.
- **Device-side XPU stream/event overlap.** Waiting on an event recorded after forward A blocks until a
  later-queued oneDNN matmul B finishes (38 ms vs 21 ms with an elementwise B). Hardware behaviour, not a
  tuning failure.
- **The `gamma`, truncation, telescoping-reward and torch-nondeterminism hypotheses** from the PPO era.
  Each killed with a direct count or a two-line calculation before a run was spent — the cheapest good work
  in the log.
- **BC as a destination**, and **the flat `Discrete(370)` head as the M2 bottleneck.** BC hit 96.2% vs
  weighted-random with the flat head, which is positive counter-evidence rather than a null, and it cannot
  exceed a teacher that itself scores 10% against AlphaBeta.
- **The four analysis/UI rejections** (max drawdown, entropy-drop selection, the "unlucky" badge, bare
  thresholds) and **total variation vs max_k|Δp|**. Each measured on 140-340 games with the deciding number
  stated; drawdown's median span really is 42% of the game, and TV really does track max_k within 0.01 at
  every percentile.
- **The perf reverts** (branch-and-bound DFS −6%, inline `players` list −10%, robber pruning 1.03x,
  unprimed memo). Each measured one change per build against a bitwise-identical-shard oracle. That
  protocol is why they are trustworthy and most of this document's other kills are not.

**Two corrections the record should carry.** (i) "One extra ply of the same heuristic buys nothing"
(2026-09-01, 35 games) is contradicted by FINDINGS' own `rab3` measurement at 105 games (+7.6 points) and
should not be cited as a depth verdict. (ii) "The `AssertionError` fallback never fires" (0 hits in 50
games) was measured on a path that was not the training path; the `CachedMaskVecEnv` staleness bug made it
fire on 100% of episode boundaries. Common-mode across all PPO arms, so no A/B comparison is invalidated,
but the probe did not test what it was read as testing.
