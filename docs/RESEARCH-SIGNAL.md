# The training step, not the labels: why every draw plays worse, and what to do instead

Research note, 2026-09-22. Reading + literature only; nothing here was benchmarked and no training was
launched. Repo claims cite `file:line` or a `docs/FINDINGS.md` entry; every literature claim carries a URL.

Companion reading: `docs/FINDINGS.md` (all measured numbers), `docs/RESEARCH-EXPERT.md` (the AlphaZero /
label-provenance pass), `docs/RESEARCH-DATA.md`.

---

## 0. What changed, and the one-paragraph diagnosis

`docs/RESEARCH-EXPERT.md` diagnosed the plateau as **label provenance** — DAgger with a permanent AlphaBeta
oracle — and ranked "net-in-the-loop rollouts" first. That lever was built and run. The four 2026-09-22
entries in `FINDINGS.md` now report:

- net rollout policy at 3 µs/leaf, `all` and `own` variants, rounds 50-53 → every draw still 5-24 points
  below its warm start; the *all-seats* (self-play) labels were the **worst** arm;
- `roll_m = 4` (round 53) → the three best single draws of the campaign, still all below base;
- label volume 100k / 300k / 900k → flat, mildly negative;
- step size α ∈ {0.15, 0.3, 0.5, 0.7, 1.0} → α ≈ 0.15-0.3 best on the 1,000-game selection seeds, **exact
  tie (2712 vs 2710) on the 4,000-game gate**;
- and then the result that settles it: **`train_value.py --self-target`**. One draw from v51 on round 54's
  rows with every label replaced by *v51's own prediction* — a literal fixed point of the objective —
  trained with the loop's recipe, BCE flat at the floor (0.526 → 0.5255), scored **636/1000 vs v51's 692,
  −5.6 points**.

That last number removes labels from the causal chain entirely. With zero label signal and zero label noise,
the update still costs 5-6 points of play. **Every "draw lands below its warm start" result in this project,
under every label policy, is at most partly about labels; the floor of the effect is the optimiser and the
regulariser moving a converged net to a different function that fits an equally-good objective value and
plays worse.**

And the diagnostic is sharper than "the optimiser did it", because of how it is wired.
`train_value.py:247-252` computes the substitute labels with `net.eval()`, then calls `net.train()` and
trains with dropout 0.3. So the data term is a fixed point of the **clean** objective, not of the objective
actually being optimised. At the warm start, the residual *systematic* gradient of the self-target run is,
by construction, exactly **dropout plus coupled weight decay** — nothing else. Everything else is minibatch
noise. That is not a list of suspects; it is a derivation, and §1.2-1.5 are its arithmetic.

So the spine of this note is not provenance. It is:

1. §1 — the mechanics of the destructive update, with the arithmetic, and the four suspects ranked;
2. §1.6-1.10 — why the *metric* (held-out BCE) and the *consumer* (depth-2 expectimax over probabilities)
   are close to orthogonal, so "loss down, play down" is the expected outcome rather than a paradox;
3. §2-§4 — the label-side literature, which only becomes actionable *after* the update is non-destructive;
4. §5 — the fine-tuning-stability toolbox and what evidence each tool actually has;
5. §6 — a ranked list, with the items that are unlikely to work named as such.

One correction to carry through the whole document, because it changes which losses in §2 are even
admissible: **the depth-2 expectimax takes an expectation over chance nodes between the net's output and
the root argmax** (`catan_engine/src/valuenet.rs:238,279` average `sigmoid(logit)` over dice outcomes with
known probabilities). A root decision is therefore invariant to *positive affine* transforms of the net's
**probability** output, **not** to monotone ones. "Only the ordering matters" is false here. The net needs
sibling ordering **plus affine-consistent scale across chance branches**. A scale-free ranking loss destroys
exactly the second thing — which is the theoretical account of the repo's own dead result (hard pairwise
siblings: 23.6-43.9% vs incumbent 51.5%, `FINDINGS.md:2282-2285`).

---

## 1. Why a converged value net can lose play while its regression loss improves

### 1.1 The self-target diagnostic forces the ordering of causes

Before the self-target run, "draws land below the warm start" had four candidate explanations competing:
label noise, label policy, distribution shift, optimisation. The self-target run holds the first three
fixed (same rows, same distribution, zero label error by construction) and still loses 5.6 points. Whatever
the labels contribute is *on top of* a ~5-6 point optimisation/regularisation floor, and the observed range
is 5-24 points. The upper end of that range (round 50's net-self-play labels, −24) is plausibly label
damage; the lower end is pure update damage.

Everything in §1.2-1.5 is a mechanism for that floor. Every one of them is testable by rerunning the same
`--self-target` diagnostic with one flag changed, at ~8 minutes of training plus 1,000 games of scoring
each, and none of them requires generation.

### 1.2 Adam restarted with zero moments: a random walk of size `lr·√T`

`train_value.py:253` constructs a fresh `torch.optim.Adam` every round. The warm start therefore begins at
step 1 with `m = v = 0` and bias correction `m̂ = m/(1-β₁ᵗ)`, `v̂ = v/(1-β₂ᵗ)`. The immediate consequence
is the one RAdam was written about: the adaptive learning rate has *undesirably large variance in the early
stage of training* because it is estimated from a handful of samples, which is why warmup exists and works
as a variance-reduction technique ([Liu et al., "On the Variance of the Adaptive Learning Rate and Beyond",
ICLR 2020](https://arxiv.org/abs/1908.03265)).

The deeper problem is not the first few steps, it is the whole run. At a converged point the minibatch
gradient is approximately zero-mean noise. Adam normalises by the RMS of that noise, so the update magnitude
per coordinate is **≈ `lr` regardless of how small the gradient is**. The displacement accumulates as a
random walk. With momentum β₁ = 0.9 the telescoping sum gives `Σₜ m̂ₜ ≈ Σₜ gₜ`, and dividing by
`√v̂ ≈ σ_g` leaves

```
per-coordinate drift after T steps  ≈  lr · √T
```

Plug in the loop's recipe (`run_exit.sh:53`: `--epochs 6`, `train_value.py` defaults `--batch-size 2048`,
`--lr 1e-3`). The outer loop is sized by the *sample* rows (`train_value.py:330`, `n = len(tr_idx)`), not
the rollout rows, so read `best@step` from the training log for the exact `T`; for 300k train rows
`T ≈ 792`, for the `--max-samples 1.5 M` ceiling `T ≈ 4,400`:

| T | `lr` | drift `lr·√T` | as a fraction of the 256→256 He scale (√(2/256) = 0.088) |
|---|---|---|---|
| 792 | 1e-3 | 0.028 | **32%** |
| 792 | 1e-4 | 0.0028 | 3.2% |
| 792 | 1e-5 | 0.00028 | 0.32% |
| 4,400 | 1e-3 | 0.066 | **75%** |

A displacement of a third to three-quarters of the initialisation scale, driven by nothing but gradient
noise, is not a fine-tune. It is a re-randomisation with a good starting point. And the table predicts the
measured `sweep_train.log` result exactly: at `--lr 1e-4` a draw still lands 2-6 points under its warm start,
because 3% of the weight scale is still a real perturbation for a net whose decisions turn on sibling gaps
of ~0.01 in probability (§1.8).

**Note a discrepancy in the brief:** the recipe is `lr = 1e-3` (`train_value.py:178` default, not overridden
by `run_exit.sh:53`), not 3e-4. 3e-4 and 1e-4 were the *sweep* arms. At 1e-3 the drift is 3× the number
anyone reasoning from "3e-4" would compute.

**Cheapest fixes, in order of how much they are worth testing:** persist the optimiser state across rounds
(the loop is one long training run interrupted by generation, and treating it as such removes the restart
entirely); linear warmup over the first ~200 steps; or drop Adam for plain SGD at the fine-tune stage, which
removes the `1/√v̂` normalisation that makes small gradients produce full-size steps.

### 1.3 L2 weight decay inside Adam: the one term that drifts linearly, not as √T

`train_value.py:179` defaults `--weight-decay 1e-4` and passes it to `torch.optim.Adam`, i.e. **coupled** L2,
added to the gradient before the adaptive normalisation. Loshchilov & Hutter's result is that L2 and weight
decay are equivalent for SGD but **not** for adaptive methods, precisely because the L2 term appears in both
the numerator and the denominator of the Adam step ([Loshchilov & Hutter, "Decoupled Weight Decay
Regularization", ICLR 2019, arXiv:1711.05101](https://arxiv.org/abs/1711.05101)).

At a converged point this is the dominant systematic force in the update. The data gradient is noise with
mean ≈ 0; the decay term `λθ` is a *constant direction*. Noise accumulates as `√T`; a constant direction
accumulates as `T`. Whatever fraction `f = λ|θ| / σ_g` of each step is systematic, after 792 steps the
systematic displacement is `f · lr · T = f · 0.79` against a random `0.028`. The systematic part wins unless
`f < 3.5%`.

The direction is toward zero — a **shrink**. That has a specific, checkable signature (§1.6): the draw's win
logits have smaller spread than the incumbent's, its probabilities sit closer to the base rate, sibling gaps
compress, and the depth-2 expectation over chance nodes is flattened toward "all children look alike", at
which point the argmax is decided by whatever noise survives. It also explains why the self-target run's BCE
*improved* slightly (0.526 → 0.5255) while play fell: shrinking a slightly over-confident net toward the base
rate is a small log-loss win and a large decision loss.

**Test:** rerun `--self-target` with `--weight-decay 0`. This is one flag and it is the single highest-value
experiment in this document.

**Probe (free, no training):** on a fixed 100k-row set, compare `std(win_logit)` and the 5-bucket calibration
table (`train_value.py:290-296` already prints it) for incumbent vs draw. If the draw's logit spread is down
5-20%, the update is a shrinkage and a **single scalar temperature** on the final layer's weight and bias
should recover most of the lost play — a one-parameter candidate that the existing gate can score.

### 1.4 Dropout 0.3 on a converged regressor: the net that trains is not the net that plays

`value_net.py:144-146` puts `nn.Dropout(0.3)` after all three hidden layers; the net plays in `eval()` mode.
Two distinct problems.

First, the objective being minimised is the expectation over dropout masks, whose minimiser is **not** the
eval-mode network. At the incumbent's weights, the dropout-objective gradient is not zero even when the
clean-objective gradient is. So dropout supplies a *systematic* pull off the play optimum, of unknown sign
with respect to play, at every step — the help text at `train_value.py:176` already states the hypothesis;
the self-target run is the evidence that the hypothesis has something to explain.

Second, the direction of that pull is known analytically: for generalised linear models the dropout penalty
is **first-order equivalent to an L2 penalty applied after scaling features by an estimate of the inverse
diagonal Fisher information** ([Wager, Wang & Liang, "Dropout Training as Adaptive Regularization", NIPS
2013](https://papers.nips.cc/paper/4882-dropout-training-as-adaptive-regularization.pdf)). It is a shrinkage
— an adaptive, feature-dependent one, which is worse than uniform shrinkage for this consumer, because it
compresses different directions of the value surface by different amounts and so is *not* affine in
probability. Per §0, non-affine distortion changes the expectimax's answer at chance nodes even when it
preserves every sibling ordering.

Dropout 0.3 earned its place at M4 iteration 0, training a net **from scratch** on correlated rows where
memorisation was the failure mode (`FINDINGS.md:1559-1570`). On a converged net being nudged by one round
of new data, it is the wrong tool: there is nothing left to regularise and the regulariser is the largest
remaining gradient.

**Test:** `--self-target --dropout 0`. Second flag, same cost.

### 1.5 Selecting the checkpoint on held-out loss, when held-out loss is at its noise floor

`train_value.py:308-324` evaluates every `--eval-every 90` steps and keeps the best `score`. Over 792 steps
that is ~9 candidate checkpoints. The self-target run's entire loss range across the run was **0.0005**
(0.526 → 0.5255).

A separate bug hides in the same two lines. `consider()` first fires at **step 90**, and again at every
epoch boundary (`train_value.py:349-350`); the warm start itself is never a candidate. By step 90 the §1.2
drift is already `1e-3 · √90 ≈ 0.0095`, ~11% of the hidden-layer weight scale. **Even a training run that is
a perfect fixed point cannot return its own starting weights.** That alone accounts for part of the self-target
run's 5.6 points.

The held-out split is 10% of *games* (`train_value.py:200-201`), ~400 games and ~30k rows, and rows within a
game are near-duplicates — the module docstring says so at `train_value.py:7`. The effective sample size is
closer to the number of games than the number of rows, so the standard error on held-out BCE is on the order
of `0.1/√400 ≈ 0.005` — **ten times the entire spread the selection is choosing among.** The checkpoint
picked is, to a good approximation, a uniform random draw from nine perturbed nets, with a mild bias toward
whichever one happens to fit the held-out split's noise best. That is best-of-nine selection on pure noise,
which is a known way to make things worse, not better.

Two further misalignments in the same `score`:

- `score` starts at `ho_loss` — the BCE of the win head against **game-outcome labels `y`** — even though
  the loop sets `WIN_WEIGHT=0` (`run_exit.sh:19`) because optimising that exact signal was measured as
  *actively harmful* (30.1% vs 53.0%, `FINDINGS.md:2330-2336`). A quarter of the selection criterion is a
  quantity the project deliberately refuses to train on.
- `ro_rank_acc` — held-out **sibling-pair concordance against the rollout labels** (`train_value.py:281-286`)
  — is computed and printed but enters `score` only at `--ro-rank-weight`, which the loop never sets. This
  is the one diagnostic in the codebase that measures the thing the search actually consumes, and it is
  switched off. See §1.8 and recommendation #4.

**Test:** `--self-target --epochs 1 --eval-every 10000`. Note `consider()` also runs at every epoch end, so
a large `--eval-every` alone reduces the candidate set to one per epoch rather than removing selection; one
epoch plus a large interval is the closest thing to "keep the final weights" the current script allows. If a
draw recovers, the selection is part of the damage — and if the fix looks worthwhile, add a flag that saves
the final weights, and one that makes step 0 a candidate.

### 1.6 What the search consumes: sibling ordering, plus affine calibration across chance nodes

`catan_engine/src/valuenet.rs:238` maps every leaf through `sigmoid`, and `:279` accumulates
`ev[i] += p · sigmoid(logit)` over the chance node's outcomes with their exact probabilities. The root then
takes an argmax over `ev`. So the root's answer is unchanged under `p ↦ a·p + b` with `a > 0` and unchanged
under any relabelling that preserves both the ordering *and* the relative gaps that survive the chance
average. It is **not** unchanged under a monotone-but-non-affine map of `p`, and a uniform shrink in
*logit* space is exactly such a map (it is affine in logit, strongly non-affine in probability, compressing
hardest near p = 0 and p = 1).

Three consequences that should govern every later section:

1. Any loss that is invariant to the scale of the net's output (pure pairwise, pure listwise, any
   Bradley-Terry-style objective) is throwing away a quantity the search needs. This is the mechanism
   behind `FINDINGS.md:2282-2285`. Ranking terms are admissible only as **auxiliaries on top of BCE**.
2. A calibration-improving update can be a play-degrading update and vice versa — they are different
   functionals of the same net.
3. `own_turn` search (`search.rs:129-133`) makes every end-turn branch terminate at a **post-roll** leaf,
   so the chance-averaging is load-bearing on exactly the branches that decide whether to build now or
   bank resources. This is where scale distortion bites hardest.

### 1.7 Max-over-noisy-siblings: the search amplifies i.i.d. error and cancels shared error

`K_SIB = 6` (`arena.rs:15`), and at play the expansion considers every legal child. Suppose the net's error
decomposes into a component shared by all siblings of a decision (a position-level bias) and a component
independent across siblings. The argmax is blind to the first and maximally sensitive to the second:
selecting the maximum of K estimates each carrying independent noise `σ` overestimates by
`≈ σ·√(2 ln K)` — `1.89 σ` at K = 6, `2.5 σ` at K = 20 — and, more importantly, picks the *wrong* child
whenever the independent noise exceeds the true gap.

This is the Thrun & Schwartz mechanism: the maximum over noisy estimates is biased upward by Jensen's
inequality, and the bias is a prime source of failure when function approximation meets a max operator
([Thrun & Schwartz, "Issues in Using Function Approximation for Reinforcement Learning", CMSS
1993](https://www.ri.cmu.edu/pub_files/pub1/thrun_sebastian_1993_1/thrun_sebastian_1993_1.pdf)); it is the
lineage that produced Double Q-learning and the optimizer's-curse literature.

The practical statement for this project: **an update that lowers mean-squared error by reducing shared bias
while raising independent sibling noise is net-negative for play, and MSE/BCE cannot tell the difference.**
That is a perfectly ordinary thing for a noisy gradient update to do, and it is a complete account of "loss
down, play down" on its own — independent of everything in §1.2-1.5.

The repo has already measured the search-side version of the same effect and written it down:
"paranoid depth 3 scored 24.9% vs 30.7% for depth 2, the min over a noisy net's estimates of 10-15 replies
biases every end-turn branch low" (`search.rs:130-133`). Same mechanism, opposite sign, already confirmed
in this codebase.

### 1.8 Held-out BCE is dominated by global discrimination; play depends on sibling differences

Held-out BCE integrates over the whole state distribution, where the spread of true win probability is
enormous — a 2-VP opening position versus a 9-VP position. Almost all of the loss's dynamic range is
"winning vs losing position", and almost all of a gradient step's leverage is there too. Play is decided
between **siblings one action apart**: build this settlement or that one, trade or not. Those gaps are on
the order of a percentage point or two of win probability, against a per-state absolute error plausibly an
order of magnitude larger.

The two objectives are close to orthogonal. BCE can improve entirely by sharpening global discrimination or
by fixing calibration in the tails, while sibling-difference error rises. Nothing in the current loop
measures the second quantity as a selection signal.

This is not speculation about this codebase; it is the field's experience. Wang, Emmerich, Preuss & Plaat
found that in AlphaZero-like self-play on 6×6 Othello and Connect Four, *optimising the sum of policy and
value loss performs consistently worse than optimising the value loss alone* — i.e. the relationship between
the training objective and strength is not monotone and not obvious ([Wang et al., "Policy or Value? Loss
Function and Playing Strength in AlphaZero-like Self-play", IEEE CoG
2019](https://liacs.leidenuniv.nl/~plaata1/papers/CoG2019.pdf)). And work on enumerable game trees finds
AlphaZero playing optimally while its value function makes many high-error predictions — strength and value
accuracy come apart in both directions.

**This is the project's missing instrument, and it is already half-built.** `ro_rank_acc`
(`train_value.py:281-286`) computes held-out pairwise concordance between the net's ordering of a decision's
children and the rollout labels' ordering. Extend it minimally and you have the diagnostic that would have
explained fifteen flat rounds for free:

- concordance of **draw vs incumbent** on the same held-out sibling sets (how much did the update change the
  ordering at all — the value-net analogue of policy churn, §1.12);
- concordance of each against **multi-rollout ground truth** (only meaningful on decisions with `roll_m ≥ 3`,
  which round 53's shards have);
- restricted to sibling sets whose ground-truth top-1 gap exceeds some threshold, so the metric is not
  dominated by ties.

All of it runs on existing shards. No generation, no games, minutes of compute. If every draw's sibling
concordance falls while its BCE falls, §1.7 is confirmed and the loop finally has a selection signal that
is not 1,000 arena games.

### 1.9 Label noise on near-identical siblings: the difference carries √2·σ

Even setting §1.1 aside, the label design puts noise precisely where the search reads. `arena.rs:70-79`
(`rollout`) begins each playout with `s.rng = splitmix(&mut self.rng)` — **a fresh, independent seed per
child, per replicate.** So the six siblings of one decision get six independent dice futures.

With `roll_m = 1` each label is a raw Bernoulli draw, variance 0.25 at p = 0.5, and the *difference* between
two sibling labels carries `√2 · σ ≈ 0.71` — against a true sibling gap of ~0.01-0.03. The regression target
is unbiased, so the net is asked to recover a 0.02 signal by averaging away 0.5-magnitude noise across
near-duplicate feature vectors that the MLP will largely smooth together anyway. This is the "noise sharpened
into labels" observation at `FINDINGS.md:2284`, stated as a variance budget.

`roll_m = 4` halves that (round 53, best single draws of the campaign, still below base — consistent with
label noise mattering *at the margin* on top of a larger optimisation floor). §3 argues that the right fix
is not `roll_m` but **common random numbers**, which attacks the difference variance directly and costs
nothing.

### 1.10 Distribution shift: training rows are pre-chance children, play leaves are post-chance

`record_rollouts` (`arena.rs:87-114`) filters to `deterministic(a)` actions and encodes the **child state
immediately after the decider's action** — pre-chance, the decider still to move or about to end turn. At
play, `expand_node` (`search.rs:155-175`) stops at depth 0 on the decider's own actions, but the end-turn
branches run through the opponent's decision node and its `Roll` chance node, so **"the leaf is the post-roll
state"** (`search.rs:132-133`).

So the two distributions overlap but are not the same population: the net is trained on "just after my build"
and queried at play on "just after my build, the opponent replied, and the dice fell". Hands are different
sizes, the robber may have moved, production has landed. The shift is small in feature space and possibly
large in the tails where the sibling gaps live.

**Check, cheap and decisive:** dump the leaf encodings of a few thousand real depth-2 expansions during an
arena game, and compare the net's calibration buckets and logit distribution there against the training
`ro_x` rows. If the play-time leaves land in a region where the net is systematically mis-calibrated, that
is a coverage bug with a trivial fix (record a fraction of *post-chance* grandchildren as training rows too),
and it is orthogonal to everything else in this document.

### 1.11 Plasticity and warm-starting: what the literature says, and why it is *not* the explanation here

Three literatures get cited for "repeated fine-tuning goes wrong", and it is worth being precise about which
apply.

**Warm-starting hurts generalisation (Ash & Adams).** Training on data that arrives in chunks, warm-starting
from the previous round's weights generalises measurably worse than re-initialising, and the fix is
"shrink and perturb": `θᵗ ← λθᵗ⁻¹ + N(0, σ²)` with `0 < λ < 1` ([Ash & Adams, "On Warm-Starting Neural
Network Training", NeurIPS 2020, arXiv:1910.08475](https://arxiv.org/abs/1910.08475)). **This does not apply
here and should not be tried.** Their finding is relative to *fresh initialisation*, and this repo has
measured fresh/wider nets at 30.8-40.4% against a ~51% incumbent while posting the best held-out loss on
record (`FINDINGS.md:2277`). Fresh init is far worse here, so the remedy for a warm-start pathology is not
indicated. Worse, "shrink" is precisely the operation §1.3 suspects of doing the damage.

**Loss of plasticity (Dohare et al.).** Standard deep-learning methods gradually lose the ability to learn
in continual settings until they perform no better than a shallow network; the proposed remedy is a
continual random component (continual backprop), and L2 also helps ([Dohare et al., "Loss of plasticity in
deep continual learning", *Nature* 632:768-774,
2024](https://www.nature.com/articles/s41586-024-07711-7)). **The observed symptom here is the opposite of
plasticity loss.** A net that had lost plasticity would fail to *move* — draws would cluster tightly around
the incumbent and held-out loss would stop improving. Here held-out loss improves every time and play moves
5-24 points, reliably, in one direction. The net has too much plasticity for the size of the signal, not
too little.

**Primacy bias / periodic resets (Nikishin et al.).** Periodically re-initialising the last few layers while
keeping the replay buffer improves SAC/DrQ/SPR and allows higher replay ratios
([Nikishin et al., "The Primacy Bias in Deep Reinforcement Learning", ICML 2022,
arXiv:2205.07802](https://arxiv.org/abs/2205.07802)). Same objection: this is a remedy for under-fitting
late data, and this loop's problem is that it over-responds to every round. Worth knowing for one detail
only — their result that the *last layers* are the plastic, resettable part supports the converse
recommendation in §5: freeze the trunk and fine-tune only the head.

### 1.12 Policy churn: small weight changes flip many decisions

Schaul et al. measured that in a typical DQN run on Atari, **the greedy policy changes in ~10% of all states
after a single gradient update** ([Schaul, Barreto, Quan & Ostrovski, "The Phenomenon of Policy Churn",
NeurIPS 2022, arXiv:2206.00730](https://arxiv.org/abs/2206.00730)). They frame it as useful implicit
exploration in an online RL setting; here there is no exploration to buy, and the same number is the cost.

If a single update flips ~10% of argmaxes in a domain with a handful of actions, the update in §1.2 —
hundreds of steps, drift a third of the weight scale — will flip a large fraction of this project's sibling
decisions. A 5-point drop in a 4-player game needs only a small edge in that churn to be adverse. This is
the sanity check that makes §1.7 and §1.8 quantitatively plausible, and it is directly measurable with the
draw-vs-incumbent concordance in §1.8.

---

## 2. Losses that target ordering rather than absolute value

With the §0 constraint in force: **every item below is an auxiliary term added to the existing
`tree_loss` BCE, never a replacement.** A scale-free objective alone removes the calibration the chance
averaging consumes, and this repo has already paid for that lesson.

### 2.1 Listwise / softmax over sibling sets — the best-supported untested option here

Take one decision's `n` rollout-labelled children (`ro_n` already records the group sizes,
`arena.rs:58`), form a softmax over the net's `n` win logits, and cross-entropy it against a **soft** target
distribution derived from the rollout win fractions — not against the argmax.

- *What it needs:* `roll_m > 1` to make the target distribution meaningful; with `roll_m = 1` the soft target
  collapses to a hard one-hot-ish vector over 0/1 labels and you have re-derived the failed experiment.
  Round 53 already generates `roll_m = 4` shards.
- *Evidence:* listwise objectives that project scores and labels onto the probability simplex via softmax
  (ListNet) are the standard formulation (Cao, Qin, Liu, Tsai & Li, "Learning to Rank: From Pairwise
  Approach to Listwise Approach", ICML 2007 — ACM DOI not verified here; [Xia et al., "Listwise
  Approach to Learning to Rank — Theory and Algorithm", ICML
  2008](https://icml.cc/Conferences/2008/papers/167.pdf); Bruch et al.'s analysis of softmax cross-entropy
  for ranking, [SIGIR ICTIR 2019](https://dl.acm.org/doi/10.1145/3341981.3344221)). On noise robustness the
  IR literature is consistent: each noisy label produces *more* corrupted pairs under a pairwise objective
  than under a pointwise/listwise one, so pairwise methods degrade faster under label noise
  ([Niu et al., "Which noise affects algorithm robustness for learning to rank", *Information Retrieval
  Journal* 2015](https://link.springer.com/article/10.1007/s10791-015-9253-3)). That is the precise
  distinction between the dead hard-pairwise experiment and this one.
- *Precedent in game search:* Tesauro's **comparison training** — present the expert's child and every
  sibling, and adjust the evaluation so the expert's move wins the comparison — produced Neurogammon, gold
  medallist at the first Computer Olympiad ([Tesauro, "Connectionist learning of expert preferences by
  comparison training", NIPS 1
  (1989)](https://bkgm.com/articles/tesauro/NeurogammonANeuralNetworkBackgammonProgram.pdf)). The
  industrial-strength version is the **Bonanza method / MMTO**, which optimises a 40-million-parameter
  evaluation function so that *minimax search results* agree with expert move choices, and which won the
  2013 World Computer Shogi Championship ([Hoki & Kaneko, "Large-Scale Optimization for Evaluation Functions
  with Minimax Search", JAIR 49 (2014)](https://www.jair.org/index.php/jair/article/view/10871)).
- *Pitfall:* both precedents rank against a **stronger** signal (a human expert, a deep search). Here the
  signal is a rollout by a policy at best comparable to the student. Ranking against a weak signal teaches
  the weak signal's ordering, which is the DAgger ceiling again — just expressed in a different loss.
- *Repo fit:* `sibling_loss` (`train_value.py:116-123`) already implements listwise top-1 over a sibling
  set. It currently targets `base_fn`'s pick. Pointing the same function at soft rollout targets is a
  handful of lines, and `--sib-weight` already exists to weight it against BCE.

### 2.2 Pairwise with soft targets

`sibling_pairs` (`train_value.py:145-157`) + `rank_loss` (`:159-161`) exist and the hard version is measured
dead. The soft version replaces the 0/1 comparison outcome with `σ(V(a) − V(b))` regressed onto the
*rollout-estimated* probability that `a` beats `b`, so ties and near-ties stop generating full-strength
gradients. Cheaper to implement than §2.1; strictly worse-founded, per the noise-robustness result above.
Only worth it if §2.1 is somehow awkward.

### 2.3 TreeStrap / TD-leaf / RootStrap

TreeStrap regresses **every node in the search tree** toward that same search's backed-up value and reached
2157 ± 31 Elo from random weights in Meep, ahead of TD-Leaf and RootStrap ([Veness, Silver, Uther & Blair,
"Bootstrapping from Game Tree Search", NIPS
2009](https://proceedings.neurips.cc/paper/2009/file/389bc7bb1e1c2a5e7e147703232a88f6-Paper.pdf); already
summarised in `RESEARCH-EXPERT.md` §C.3).

**This project has measured its own version and it lost 7 points** (v26ts, soft chance-averaged values from
the net's own depth-2 search, `FINDINGS.md:2105`), and the hard-argmax version lost 7 points too (v9,
`FINDINGS.md:2110`). The condition under which TreeStrap works is that the search knows substantially more
than the evaluator — AlphaZero's raw net was 3,055 Elo against its searched player's 5,185. Here the gap
between depth-2 and depth-1 is a few points. **Do not retry this until the search-vs-net gap is larger.**

### 2.4 KL to search visit distributions / AlphaZero's policy loss

The canonical ordering target in modern game RL is cross-entropy to the MCTS visit distribution, which
Grill et al. showed is an approximation to the solution of a specific *regularized policy optimization*
problem — and that using the exact solution instead reliably outperforms the original algorithm across
domains ([Grill et al., "Monte-Carlo Tree Search as Regularized Policy Optimization", ICML 2020,
arXiv:2007.12509](https://arxiv.org/abs/2007.12509)).

**Not available here.** There are no visit counts: the search is a full depth-2 expectimax, not a sampling
search, so there is no visit distribution to distil, and there is no policy head. `RESEARCH-EXPERT.md` §E
item 6 already parks the policy-head idea behind "only after the evaluator knows more".

### 2.5 Gumbel-style completed-Q improvement targets

Gumbel AlphaZero/MuZero replaces the visit-count target with a *policy improvement* target built from
completed Q-values, guaranteeing monotone improvement even at very few simulations, and matching state of
the art on Go, chess and Atari while substantially improving the low-simulation regime ([Danihelka, Guez,
Schrittwieser & Silver, "Policy improvement by planning with Gumbel", ICLR
2022](https://iclr.cc/virtual/2022/poster/6418)). The guarantee is conditional on action-values being
correctly evaluated. `FINDINGS.md:2105` (v26ts) is direct evidence that this project's action-values are
not. Park it.

### 2.6 MuZero Reanalyse

Revisit trajectories already in the buffer and re-run search on them with the *latest* network, producing
fresh value and policy targets with no new environment interaction; the reanalyse ratio trades fresh
experience against reanalysed experience and is the mechanism behind MuZero's sample efficiency
([Schrittwieser et al., "Online and Offline Reinforcement Learning by Planning with a Learned Model",
NeurIPS 2021, arXiv:2104.06294](https://arxiv.org/abs/2104.06294)).

Applied literally here — recompute `ro_v` from the current net's own search on old `ro_x` rows — it is v26ts
with extra steps, already measured at −7. The *transferable* part is the cheap one: **re-use old states with
new labels.** This project regenerates states every round at ~10 minutes a round. If states are not the
binding constraint (and the label-scaling sweep says they are not), keeping a state buffer and spending the
generation budget on *better labels for the same states* (§3) is the Reanalyse idea in the form that suits
this loop.

### 2.7 Distributional / categorical value heads

Farebrother et al. show categorical cross-entropy with HL-Gauss smoothing beating MSE regression
consistently across Atari, robotic manipulation, chess without search and Wordle, attributing the gain to
robustness against **noisy targets and non-stationarity** ([Farebrother et al., "Stop Regressing: Training
Value Functions via Classification for Scalable Deep RL", ICML 2024,
arXiv:2403.03950](https://arxiv.org/abs/2403.03950)); Ruoss et al. use K = 128 bins in the chess setting and
report log-loss beating L2 on two of three metrics ([Ruoss et al., "Grandmaster-Level Chess Without Search",
arXiv:2402.04494](https://arxiv.org/abs/2402.04494)).

Two caveats for this project, both real. The current head is already a **binary cross-entropy on a
probability**, which is the two-bin case — most of the "stop regressing" gain over plain MSE is already
banked. And the labels are Bernoulli 0/1, so Gaussian label smoothing has nothing to smooth until
`roll_m` rises. Keep it as a stacked, low-priority experiment.

### 2.8 Multi-outcome / margin targets from the rollout

Untouched by anything measured and still the cheapest richer target: each playout already knows the 4-way
finishing order and the decider's final VP margin, and `N_HEADS = 6` already exists. Deep Catan trains a
softmax over **MCTS root win-rates for all 4 players** and reports UCTNet beating UCT 240/400 and ExIt
iteration 2 beating iteration 1 231/400 ([Driss & Cazenave, "Deep Catan",
EvoApplications 2022](https://www.lamsade.dauphine.fr/~cazenave/papers/DeepCatanEvo.pdf)); Gendre & Kaneko
shape with ±0.02 per VP of margin on top of ±0.75 win/loss ([arXiv:2008.07079](https://arxiv.org/abs/2008.07079));
KataGo's ablation shows removing auxiliary ownership/score targets produces a noticeable drop in learning
efficiency within an overall ~9.1× speed-up, and generalises it to "predicting subcomponents of desired
targets can greatly improve training" ([Wu, "Accelerating Self-Play Learning in Go",
arXiv:1902.10565](https://arxiv.org/abs/1902.10565)).

Note carefully what the repo's outcome-head failure was: **game outcomes shared across ~150 correlated
states** (`FINDINGS.md:2330-2336`). A per-child *rollout* finishing order is a different object with a
different noise structure, and the aux heads were dropped alongside the outcome loss rather than ablated
on their own (`FINDINGS.md:2353`). Untested, not refuted. Still second-order to §1.

---

## 3. Variance reduction for rollout labels

### 3.1 Common random numbers across siblings — the highest-value label change, and ~5 lines

Today `rollout` draws a fresh `splitmix` seed for every child and every replicate (`arena.rs:71`). Siblings
therefore see independent dice futures, and the *difference* between two sibling labels — the only thing
the search reads — carries `√2 · σ` of pure noise (§1.9).

Common random numbers is the oldest variance-reduction technique in stochastic simulation and the entire
point is this case: compare alternatives under the same conditions so differences are attributable to the
alternatives rather than random fluctuation. It is standard in backgammon rollout practice: **duplicate
dice, applying the same roll sequence to compared plays, reduces variance in relative equities and commonly
cuts the required trials by a factor of 3 or more** ([GNU Backgammon manual, rollouts
chapter](https://www.gnu.org/software/gnubg/manual/html_node/Rollouts-in-GNU-Backgammon.html);
[Montgomery, "Variance Reduction", GammOnLine 2000](https://bkgm.com/articles/GOL/Feb00/var.htm)). Paired
evaluation is statistically the same estimator, and the variance reduction is governed by the covariance
between the paired outcomes.

**Recipe.** In `record_rollouts`, draw `roll_m` seeds *once per decision*, before the loop over children,
and give every child the same seed for replicate `j`. Each label is still a marginally unbiased playout
from that child — the BCE target's expectation is unchanged, which is the objection to pre-empt — but the
sibling *differences* lose most of their noise.

**The honest caveat**, and it needs measuring rather than arguing: sharing a seed only aligns the chance
stream while the children consume it identically. Children differ in how many dev-card draws and robber
steals they trigger, so the streams desynchronise. The robust version is to **split the state RNG into a
dedicated dice stream and an everything-else stream**, seed the dice stream commonly across siblings, and
let the other stream diverge. That is how backgammon gets exact duplication (a pre-generated dice
sequence) and it is a contained change to `State`. Measure the payoff directly: on a held-out set of
decisions with `roll_m = 8`, compare the empirical standard deviation of `ro_v[a] − ro_v[b]` with and
without CRN. If it does not drop by ≥2×, the streams are not aligning and the split-stream version is
needed.

Ranked above `roll_m` because `roll_m` buys `1/√m` on each label *independently* — at 4× the playout cost
for a 2× reduction in difference noise — while CRN buys a similar or larger reduction for free.

### 3.2 Control variates: the luck adjustment, and why it dodges this project's curse

Backgammon's other standard technique is **luck-adjusted equity**: subtract, at every roll, the difference
between the post-roll evaluation and the pre-roll expected evaluation. The correction has expectation zero
by construction because the dice distribution is known, so the estimator stays **unbiased for any control
function, however bad**. GNU BG and XG apply it automatically whenever lookahead exceeds one ply.

This transfers to Catan exactly, because the dice distribution at a `Roll` node is known and small (11
outcomes with exact probabilities), and the engine already computes chance expectations
(`valuenet.rs:279`). Per roll: evaluate the 11 post-roll states, take the probability-weighted mean, and
accumulate `(realised − expected)` as the luck term; subtract the accumulated luck from the playout's
outcome.

Two things make this unusually attractive here:

- **It is the one way to use the net's own beliefs that cannot poison the labels.** Every target this
  project has derived from the net's beliefs has failed (v9 −7, v26ts −7, `FINDINGS.md:2105,2110`). A
  control variate is different in kind: the correction's expectation is exactly zero whatever evaluator
  you plug in, so the label's mean is untouched and only its variance moves. The "externally measured
  only" pattern in `RESEARCH-EXPERT.md` §C.2 is preserved.
- **`base_fn` is fast enough to be the control function.** At ~0.17 µs per leaf (`FINDINGS.md:2237-2241`),
  11 evaluations per roll is ~2 µs, and a playout has on the order of 60-100 rolls — well under 1 ms added
  to a 4-6 ms playout. The net at 3 µs/leaf would cost ~33 µs per roll and roughly double a playout;
  start with `base_fn`.

Caveat: the variance reduction is proportional to the correlation between the control and the outcome. A
weak control function buys little. Measure it the same way as §3.1, on the sibling-difference standard
deviation.

### 3.3 Truncated rollouts with a value bootstrap (TD(n))

Tesauro & Galperin's own numbers are the argument, and they cut against intuition. On their test set, the
error-rate reduction of the Monte-Carlo player over its base player was **2.5× (random), 3.2× (Lin-1), 3.8×
(Lin-2), 3.9× (Lin-3) with full rollouts** — but with **truncated rollouts of 7-11 steps** bootstrapped by
the evaluator, the reductions were **4.8× (10 hidden units) and 6.6× (80 hidden units)** in the thorough
setting, 3.5× and 4.5× optimistic ([Tesauro & Galperin, "On-line Policy Improvement using Monte-Carlo
Search", NIPS 1996](https://papers.nips.cc/paper_files/paper/1996/hash/996009f2374006606f4c0b0fda878af1-Abstract.html);
[arXiv re-release 2501.05407](https://arxiv.org/abs/2501.05407)). Truncation did not merely save time; the
truncated estimator was *better*, because cutting the tail removes far more variance than the bootstrap adds
bias, once the evaluator is decent.

This is the standard bias-variance knob of TD(n), and it is the structure Bertsekas formalises: multistep
lookahead + **truncated rollout with a base policy** + a **terminal cost function approximation**, which
retains the fundamental cost-improvement property of rollout while capping cost ([Bertsekas, *Lessons from
AlphaZero for Optimal, Model Predictive, and Adaptive Control*,
2022](https://web.mit.edu/dimitrib/www/LessonsfromAlphazero.pdf)).

**For this project, with the tension stated honestly:** a truncated label bootstrapped by the net
reintroduces the net's own beliefs into the target, which is the family of signals that has failed here five
times. Two ways to keep most of the external signal: bootstrap with **`base_fn`** rather than the net (a
genuinely external evaluator, and the thing the labels have always implicitly used anyway), or truncate
**late** — run the playout to within ~15 turns of a typical finish and bootstrap only the residual. Rank
this below §3.1 and §3.2, which are unbiased.

### 3.4 Antithetic variates

No natural negation exists for a 2d6 roll and the obvious "swap the dice of paired playouts" pairing is
weak. Low value; skip.

### 3.5 "Fewer states, more rollouts each" — what the literature and this repo's own curve say

The general result from simulation metamodelling is that a budget must be split between **design points**
(distinct states) and **replications** (rollouts each), and replications exist mainly to let the metamodel
estimate and separate the intrinsic noise; accuracy improves by staging replication rather than front-loading
it ([Ankenman, Nelson & Staum, "Stochastic Kriging for Simulation Metamodeling", *Operations Research*
58(2), 2010](https://dl.acm.org/doi/abs/10.1287/opre.1090.0754)).

The game-playing precedent pushes hard toward **many states, one sample**: AlphaGo's value network
overfitted when trained on all positions of each game, because successive positions are strongly correlated
and share one outcome; the fix was to play 30 million self-play games and **keep exactly one position from
each** ([Silver et al., "Mastering the game of Go with deep neural networks and tree search", *Nature* 529,
2016](https://www.nature.com/articles/nature16961)).

But this project has already measured its own curve and it is flat: 100k / 300k / 900k rollout rows give
soup-game means of 677 / 669 / 661, i.e. no gain and possibly a slight loss
(`FINDINGS.md`, label-scaling sweep). **The state axis is saturated.** That does not mean "spend the budget
on `roll_m`" — it means spend it on reducing the *difference* variance within a decision, which CRN (§3.1)
and control variates (§3.2) do at a fraction of the cost of more replicates, and `roll_m` does only at
`1/√m`. Round 53's `roll_m = 4` run producing the campaign's best three single draws is weak evidence in
the same direction: difference noise matters, and there are cheaper ways to cut it.

---

## 4. Rollout policy iteration: what it buys, what it costs, and the trap

### 4.1 Tesauro & Galperin, the numbers

The structure is exactly this project's: a stochastic game, an evaluator, and rollouts of candidate moves
under a fixed base policy to produce an improved online player. Measured, full rollouts:

| base player | base equity (ppg) | Monte-Carlo player (ppg) |
|---|---|---|
| Lin-1 | −0.52 | −0.01 |
| Lin-2 | −0.65 | −0.02 |
| Lin-3 | −0.32 | **+0.04** |

Error-rate reductions on the test set: 2.5× (random), 3.2× / 3.8× / 3.9× (Lin-1/2/3); with truncated
rollouts and multilayer nets, 4.8× and 6.6×. Cost: **5-65 seconds per move on 32 SP1 nodes**, "several tens
of thousands of trials" per decision after pruning
([NIPS 1996](https://papers.nips.cc/paper_files/paper/1996/hash/996009f2374006606f4c0b0fda878af1-Abstract.html)).

Two things to take from that table. First, rollout policy improvement is a **large, reliable** improvement —
it turns a −0.5 ppg player into a break-even one. Second, they explicitly listed "train a controller on the
computed rollout equities" as *future work* and reported no completed results. The step this project is
stuck on was left undone in the paper that invented the setting.

Bertsekas's framing explains why the online improvement is so reliable and the training step is not:
approximation in value space with one-step lookahead is **a single step of Newton's method** for Bellman's
equation, which is why an offline-trained controller improves so much when wrapped in online lookahead plus
truncated rollout ([*Lessons from AlphaZero*](https://web.mit.edu/dimitrib/www/LessonsfromAlphazero.pdf)).
Newton's step is a property of the *online* operator. Distilling it back into the evaluator is a separate,
lossy, and — as this repo has now measured fifteen times — far less reliable operation.

### 4.2 The trap: a stronger rollout policy can make the estimates worse

This is the literature result that best explains round 50, and it is not in `RESEARCH-EXPERT.md`.

Gelly & Silver found that using an offline-learned value function as the default (simulation) policy in
MoGo performed better than a random simulation policy but **worse than a weaker, handcrafted one**
([Gelly & Silver, "Combining Online and Offline Knowledge in UCT", ICML
2007](https://ai.dmi.unibas.ch/research/reading_group/gelly-silver-icml2007.pdf)). Silver & Tesauro then
built the theory: what a rollout policy needs is not strength but **balance** — that it be equally good for
both sides, so that the sampled outcome is an unbiased estimate of the position's value; they optimise the
rollout policy directly for estimation accuracy rather than playing strength ([Silver & Tesauro,
"Monte-Carlo Simulation Balancing", ICML
2009](https://www.semanticscholar.org/paper/Monte-Carlo-simulation-balancing-Silver-Tesauro/1886b7cb26105a8fcb3f2eb3cf03ee85ed09de58)).

Round 50 is the textbook instance: `--roll-net all` (every seat plays the one-ply net) produced the worst
draws of the campaign, 612 / 587 / 574 / 551 / 488 against a base of 727. `FINDINGS.md` attributes this to
distance from the arena's `vnet + 3 rab` condition; the balance literature says the same thing more
generally and predicts it in advance. `--roll-net own` — net for the labelled decider, `rab` for the other
three — is the *balanced* option relative to the gate's condition, and it scored like `rab` labels rather
than worse. That is a literature-to-measurement match, and it is a better-supported reason than the
provenance story for why "stronger rollout policy" did not pay.

**Consequence: "make the rollout policy stronger" is not the lever. "Make the rollout policy match the
condition the gate measures, and make its estimates lower-variance" is.** §3.1 and §3.2 are that lever.

### 4.3 The economics here, with this project's measured constants

Given: net forward ~3 µs/leaf (AVX2 sparse kernel, `catan_engine/src/valuenet.rs`), a one-ply net playout
from mid-game ~6 ms, a `rab` playout ~4 ms, a labelled decision = up to 6 children × `roll_m` playouts.

The one provenance option genuinely untried is labels from playouts by the **full depth-2 net player** —
the actual student. That requires a depth-2 expansion per playout decision. Even at ~2,000 leaves per
decision that is ~6 ms *per decision*, against ~150-200 decisions per playout: ~1 s per playout, ~6 s per
labelled decision, ~160× the current cost. At 350k rows per round this is arithmetic, not a judgement call.
`FINDINGS.md` prices the batched-on-XPU variant at ~50× per row. **Provenance is economically blocked, not
conceptually refuted** — worth one paragraph and no more engineering until something else changes.

What *is* affordable, and is the correct reading of §4.1 + §4.2 together:

- **truncated playouts** (§3.3), which Tesauro measured as strictly better estimators, not merely cheaper;
- **CRN + luck adjustment** (§3.1, §3.2), which buy variance reduction without touching the policy at all;
- **`own` rather than `all`**, which is what the balance literature recommends and what the round-51/52
  numbers already prefer.

---

## 5. Fine-tuning stability: which tools have evidence in game value nets

Ordered by how directly the evidence applies here.

**EMA / weight averaging — strong evidence, and this project reinvented it.** SWA takes the arithmetic mean
of iterates along the optimisation trajectory and lands in the centre of a flat region rather than on its
edge ([Izmailov et al., "Averaging Weights Leads to Wider Optima and Better Generalization", UAI
2018, arXiv:1803.05407](https://arxiv.org/abs/1803.05407)). Leela Chess Zero introduced SWA into network
training at Test30 ([lczero.org](https://lczero.org/blog/2018/10/lc0-training/)). The greedy model soup in
`soup.py` is a coarse, expensive, arena-gated approximation of this: it averages **five independently
perturbed endpoints** selected by 1,000 noisy games, where SWA averages **hundreds of points along one
trajectory** for free. Moving the averaging inside the training run — keep an EMA of the weights from step 1
and save the EMA, not the best-held-out checkpoint — is cheap, removes the §1.5 selection noise, and is
strictly better-founded than what the loop does now. It would also render the α-step result (`soup.py
--alphas`, α ≈ 0.15-0.3 best) unsurprising: small steps toward the perturbation mean *is* averaging, done
worse.

**KL-to-incumbent / L2-SP — good indirect evidence, ~3 lines.** Regularising toward the *starting point*
rather than toward zero is the right inductive bias when the starting point is better than any nearby
alternative; L2-SP (and its Fisher-weighted variant) is the recommended baseline penalty for transfer
([Li, Grandvalet & Davoine, "Explicit Inductive Bias for Transfer Learning with Convolutional Networks",
ICML 2018, arXiv:1802.01483](https://arxiv.org/abs/1802.01483)). The function-space version — add
`λ · BCE(net(x), sigmoid(incumbent_logit(x)))` on the same rows, i.e. a distillation term toward the
incumbent — is better suited here than a weight-space penalty, because it constrains the thing that matters
(the function the search queries) rather than the parameters. This is the trust region PPO has and value
nets usually lack, and it directly targets the §1.7 mechanism: it lets the update move the *shared* component
while penalising per-state divergence. Note it also subsumes the §1.3 fix — swapping weight decay (pull
toward zero) for L2-SP or KL-to-incumbent (pull toward the incumbent) removes the shrink without removing
regularisation.

**Freeze the trunk, fine-tune the head — plausible, one line, untested here.** Fine-tuning all parameters
can distort pretrained features and underperform relative to linear probing when the new data is
distributionally shifted, which motivates LP-FT ([Kumar et al., "Fine-Tuning can Distort Pretrained Features
and Underperform Out-of-Distribution", ICLR 2022, arXiv:2202.10054](https://arxiv.org/abs/2202.10054)).
Freezing the three hidden layers and updating only `heads` shrinks the perturbation to a few hundred
parameters, which caps the §1.2 drift almost to zero while still letting the round's data move the output.
Nikishin's result that the last layers are the plastic part is consistent with this being where the useful
update lives.

**Tiny learning rate with SGD — the direct antidote to §1.2.** Plain SGD's step is proportional to the
gradient, so at a converged point it *stops*; Adam's is not, so it does not. No game-specific evidence, but
the mechanism is exact and the test is one flag.

**LoRA-style low-rank updates — evidence exists, but for a different problem size.** LoRA learns less and
forgets less than full fine-tuning — it is a stronger regulariser that keeps the base model's behaviour
outside the target domain ([Biderman et al., "LoRA Learns Less and Forgets Less", TMLR 2024,
arXiv:2405.09673](https://arxiv.org/abs/2405.09673)). On a 1051→256×3 MLP with ~400k parameters, the
motivation (memory) is absent and the regularisation effect is achieved more simply by freezing layers.
Skip.

**SAM — no evidence in this setting.** Sharpness-aware minimisation finds flatter minima
([Foret et al., ICLR 2021, arXiv:2010.01412](https://arxiv.org/abs/2010.01412)) and is roughly 2× the
training cost; a head-to-head study found SWA and SAM both help but in setting-dependent ways
([Kaddour et al., "When Do Flat Minima Optimizers Work?", NeurIPS 2022,
arXiv:2202.00661](https://arxiv.org/abs/2202.00661)). Given SWA is nearly free and already half-implemented
as the soup, SAM is the wrong place to spend.

**Replay of old data — already present.** `DATA_LAST` keeps a multi-round window, which is AlphaZero's
sliding replay window. No change indicated.

**Shrink-and-perturb, periodic resets, continual backprop — contra-indicated.** See §1.11. All three are
remedies for a net that will not move; this one moves too much.

---

## 6. Ranked recommendations

Scoring protocol for every item, unchanged from `RESEARCH-EXPERT.md` §E and from `FINDINGS.md:2270`: draws
from one warm start → soup/α selection → **fresh-seed 4,000-game head-to-head vs the incumbent against
3× `rab`**. Held-out loss is not a valid selection signal in this repo. Items 1 and 2 change the apparatus
itself, which is why they come first.

---

### 1. Finish the self-target ladder: find the first non-destructive update. *(~3 h, no generation, highest EV by a wide margin)*

**Score this ladder on 4,000 games per arm, not 1,000.** The ladder is five arms picked by best-of-five, and
§1.5 is the argument against exactly that: at σ ≈ 15 on 1,000 games, five arms spread ~25 points on noise
alone, so a draw landing at 690 means nothing. There is no generation in this item — five 4,000-game gates
at ~3.5 min each is ~20 minutes, which is the cheap part of the experiment. If you insist on 1,000-game
scoring, set the acceptance threshold at **+30 points or better** and treat anything under it as a tie.

Run `train_value.py --self-target` from v51 on round 54's rows, one flag changed per draw, each scored
against v51 on the same seeds (v51 = 692 on the 1,000-game soup seeds; re-measure it on whichever protocol
you use):

| draw | change | hypothesis it kills |
|---|---|---|
| a | `--weight-decay 0` | §1.3 — Adam-coupled L2 is a systematic shrink |
| b | `--dropout 0` | §1.4 — the dropout objective's minimiser is not the eval-mode net |
| c | `--lr 1e-5` | §1.2 — `lr·√T` drift |
| d | `--eval-every 10000` (keep last, no best-checkpoint pick) | §1.5 — selection on a 0.0005 spread with σ ≈ 0.005 |
| e | all four together | the floor |

Whichever draw recovers the warm start's score by more than the threshold is the first non-destructive update
this loop has had. Then re-run the winning configuration with **real labels** — that is the actual next
round, and it is the first round whose result means anything.

**The falsifiable prediction, from §1.1:** with `--dropout 0 --weight-decay 0` the self-target objective is
flat at the warm start, so the net should barely move and the play score should be preserved. If draw (e)
*still* loses ~5 points, the diagnostic is leaking rather than the optimiser misbehaving — check
`prior_scale` and the registered buffers round-trip through `load_state_dict`, and check the step-90
checkpoint trap above, before blaming Adam.

Add the free probe alongside: `std(win_logit)` and the 5-bucket calibration table for incumbent vs each
draw. If the draws are uniformly compressed in logit space, try a **single scalar temperature** on the final
layer as a one-parameter recovery and gate it. Cost: minutes.

Blunt note: if draw (e) still loses 5 points, §1.7 is the whole story — the update is moving the function in
directions BCE cannot see — and the priority shifts entirely to item 4 plus the KL-to-incumbent term in
item 5.

### 2. Make the gate paired: common random numbers between incumbent and candidate. *(half a day, then permanent)*

The soup's +28 on 1,000 games evaporating to 2712 vs 2710 on 4,000 is the apparatus failing, not the model.
σ ≈ 15 per 1,000 games, with best-of-six selection on top, is a selection procedure that cannot see a
3-point effect — which is every effect in this document.

Score incumbent and candidate on **identical board layouts, identical dice streams, identical opponent
seeds, identical seat assignment**, and report the *paired difference* rather than two independent totals.
Common random numbers is the oldest variance-reduction technique in simulation for exactly this comparison,
and the reduction is governed by the seed-level correlation between the two arms
([GNU BG rollouts](https://www.gnu.org/software/gnubg/manual/html_node/Rollouts-in-GNU-Backgammon.html);
Montgomery, [Variance Reduction](https://bkgm.com/articles/GOL/Feb00/var.htm)); engine testing has used
paired openings with colours reversed for decades for the same reason.

**Do not expect the several-fold cut that engine testing gets.** There, both arms play the same opening
with the same opponent and diverge late. Here the two arms are different players in different games: they
diverge at the first differing decision and the chance streams decorrelate almost immediately. What pairing
shares is the board layout, the initial placements, and the opponents' seeds — a real but bounded share of
Catan's variance. If it buys 20-30%, the honest conclusion is a **budget statement, not a free lunch**: at
σ ≈ 15 per 1,000 games, a 3-point effect needs on the order of **10,000 games** to separate from a tie,
paired or not. That is the number that should drive what gets scheduled — it means the loop can afford
roughly one real decision per hour of gating, and item 4's cheap ordering diagnostic is how you avoid
spending it on obvious losers.

**The larger win in the same place is probably the outcome measure, not the pairing.** Score **VP margin or
finishing rank**, not win/loss. A four-way rank or a VP differential is a finer-grained observation of the
same underlying strength difference and has materially lower variance than a Bernoulli. Gendre & Kaneko
shape their Catan reward with ±0.02 per VP on top of ±0.75 win/loss for exactly this reason
([arXiv:2008.07079](https://arxiv.org/abs/2008.07079)), and `gen_games.py:151-153` already records all four
seats' final VPs. Cheap, orthogonal to pairing, stacks with it. Keep reporting win rate as the headline —
it is what `docs/BENCHMARK.md` compares against — but select on the lower-variance statistic.

### 3. Common random numbers across siblings in `record_rollouts`. *(~5 lines of Rust, one round to score)*

Hoist the seed draw out of the per-child loop in `arena.rs:87-114` so every child of a decision plays
replicate `j` against the same chance stream. Labels stay marginally unbiased — state that explicitly in the
commit, it is the objection someone will raise — while the sibling *differences* the search reads lose most
of their noise. Backgammon practice: duplicate dice commonly cut required trials by ≥3×.

Gate it in two stages: first the cheap statistical check (on `roll_m = 8` shards, does
`sd(ro_v[a] − ro_v[b])` drop by ≥2×?), then one training round under the item-1 recipe. If the streams
desynchronise too fast, split `State`'s RNG into a dice stream and an everything-else stream and seed only
the dice stream commonly.

Stack the **luck-adjustment control variate** (§3.2) on top if CRN pays: `base_fn` over the 11 dice outcomes
at each roll, accumulate `(realised − expected)`, subtract from the playout outcome. Unbiased for any
control function, ~2 µs per roll, and it is the one use of a learned evaluator that cannot poison a label.

### 4. Turn sibling-ordering concordance into the loop's instrument, and then its selection signal. *(hours, no generation)*

`ro_rank_acc` (`train_value.py:281-286`) already computes held-out pairwise concordance against the rollout
labels and is already printed. It enters `score` only at `--ro-rank-weight`, which the loop never passes
(`run_exit.sh:53`). Three cheap extensions and one change:

- add **draw-vs-incumbent** ordering agreement on the same held-out sibling sets (the churn measure, §1.12);
- report concordance restricted to sibling sets with a ground-truth top-1 gap above a threshold, so ties
  stop diluting it;
- run it retrospectively over every stored draw of rounds 46-54 and **correlate it with the arena score
  those draws got**. If concordance tracks play and BCE does not, the loop finally has a selection signal
  that costs seconds instead of 1,000 games;
- drop `ho_loss` from `score`, or at least stop letting the game-outcome BCE — the signal the loop refuses
  to train on because it is harmful — contribute a quarter of the checkpoint criterion.

This is the measurement that would have explained fifteen flat rounds for free, and it is the prerequisite
for evaluating item 5 without burning arena games on every variant.

### 5. Constrain the update instead of shrinking it: KL-to-incumbent + EMA. *(a day; do it if item 1's flags are not enough)*

Two changes, both small, both aimed at the residual after item 1:

- add `λ · BCE(net(x), sigmoid(incumbent_logit(x)))` over the round's rows — a function-space trust region,
  the value-net analogue of PPO's, and the well-founded version of "pull toward something". Sweep λ so the
  draw's held-out divergence from the incumbent is bounded rather than the draw's weights being bounded.
  Simultaneously **replace `--weight-decay` (pull toward zero) with this** (pull toward the incumbent):
  L2-SP's argument, applied in function space.
- keep an **EMA of the weights** from step 1 and save the EMA instead of the best-held-out checkpoint. This
  is SWA, it is what Lc0 does, and it makes the greedy soup's job smaller or unnecessary.

Optionally: freeze the three hidden layers and update only `heads`. One line, caps the §1.2 drift to a few
hundred parameters, and LP-FT is the evidence.

### 6. Soft listwise sibling loss as an auxiliary on top of BCE. *(one round, only after items 1 and 3)*

Point the existing `sibling_loss` machinery (`train_value.py:116-123`) at soft targets derived from the
rollout win fractions of a decision's children, with `--sib-weight` small relative to `--ts-weight 3`, on
`roll_m ≥ 3` shards. **Never as a replacement for BCE** — the search needs affine-consistent scale across
chance nodes, and a scale-free objective destroys it (§0, §1.6); the hard-pairwise result at 23.6-43.9% is
the receipt.

Must beat the same-budget BCE-only arm under the item-2 paired gate, not merely beat the incumbent. Expected
value is modest and conditional: the signal being ranked is a rollout by a policy no stronger than the
student, and both successful precedents (comparison training, the Bonanza method) rank against something
stronger.

### 7. Truncated playouts with a `base_fn` bootstrap. *(a day of Rust, one round)*

Cut playouts at a fixed horizon and bootstrap the tail with `base_fn` rather than the net. Tesauro measured
truncated rollouts as producing **larger** error reductions than full ones (4.8× and 6.6× vs 2.5-3.9×), so
this is a variance win and a cost win simultaneously. Sweep the horizon; the shorter it is, the more the
label inherits `base_fn`'s beliefs, which is the failure mode this project has hit repeatedly — so treat
the horizon as the bias-variance dial it is, and start long.

---

### What is unlikely to work, stated bluntly

- **More labels.** Measured flat-to-negative at 100k / 300k / 900k. The state axis is saturated. Do not
  revisit without a new reason.
- **A stronger rollout policy per se.** Round 50 (`--roll-net all`) produced the worst draws of the
  campaign, and the simulation-balancing literature says to expect that: rollout policies need balance and
  low estimator variance, not strength. `own` over `all` is the correct reading.
- **Depth-2-net playout labels.** ~160× the current cost per row by this project's own constants; ~50× for
  the batched variant. Economically blocked. Do not re-engineer it.
- **Any target derived from the net's own search values.** v9 (hard argmax) −7, v26ts (soft chance-averaged)
  −7. TreeStrap's precondition — a search that knows far more than its evaluator — does not hold at depth 2
  with this evaluator. The one exception is a **control variate**, which is unbiased by construction and
  therefore not a target at all.
- **Pure ranking losses.** Scale-free objectives delete the calibration the chance averaging consumes.
  Measured dead here, and now with a mechanism.
- **Bigger or wider nets.** Measured negative while posting the best held-out loss on record — which, given
  §1.8, is exactly what that result should look like.
- **Deeper search at play.** Measured negative repeatedly; `search.rs:130-133` explains it as max/min over
  noisy sibling estimates, the §1.7 mechanism.
- **Shrink-and-perturb, periodic resets, continual backprop.** Remedies for a net that will not move. This
  one moves too much.
- **Distributional / HL-Gauss heads.** The head is already a two-bin cross-entropy; with Bernoulli labels
  there is nothing for Gaussian smoothing to smooth. Revisit only after `roll_m` rises, and only as a
  stacked variant.
- **One more α-step or soup tweak.** The α = 0.3 net tied 2712-2710 on 4,000 games. The soup's per-round
  "gain" is its own selection noise. Item 5's EMA is the principled replacement; more soup variants are not.

---

## Appendix: claims that need checking before they are acted on

- The `lr·√T` drift table assumes `T` from the sample-row count; read `best@step` from a real training log
  and recompute. If the outer loop actually runs at the `--max-samples` ceiling, the drift is ~2.4× the
  table's 300k row.
- The sibling-gap magnitude ("~0.01-0.03 in probability") is an estimate, not a measurement. It is
  computable on `roll_m ≥ 3` shards in minutes and it sets the scale for every noise argument in §1.7-1.9.
- CRN's realised benefit depends on how fast sibling chance streams desynchronise in this engine; §3.1 gives
  the two-line statistical check that settles it before any training run.
- The paired-gate variance reduction (item 2) depends on how fast two nets' games decorrelate after their
  first differing decision. Measure the realised σ of the paired difference against the current unpaired σ
  ≈ 15 before relying on it.
