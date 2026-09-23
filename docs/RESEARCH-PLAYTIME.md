# Research: play-time strength and cheap evaluation (2026-09-22)

Commissioned after the 2026-09-22 FINDINGS entries: training on `rab`-continuation labels is measured dead
(every single draw lands 5-24 points below its warm start; the soup's per-round "gain" is its own selection
noise; v40 → v49 → v51 are one interval), while the engine got 2.7x faster at generation and the net forward
got 58x faster (174 → 3 µs/leaf). The remaining levers are at **decision time** and in **how we measure**.
This document is research only — nothing here is implemented, and no file outside this one was touched.

Everything below is anchored on four measured facts from this repo:

1. **A depth-2 net decision costs ~1.5-3 ms.** Derived: a round's two 4,000-game gates take 3.5 min on 8
   threads (FINDINGS 2026-09-22 part 2) → ~0.2 CPU-s per gate game for the one vnet seat → ~1.5-3 ms per
   decision over ~100-150 decisions/game. Consistent with 300-3000 leaves x 3 µs of forward plus expansion.
   That works out to ~38 gate games/s on 8 threads, against generation's 6.5 games/s, so it looks like a
   dropped factor — it is not, and two independent checks in FINDINGS confirm it. (i) The stage arithmetic:
   gen ~10 min + train/soup 8 min + gates 3.5 min = 21.5 min against the stated "a round is ~22 min", so the
   3.5 min covers **both** 4,000-game gates (8,000 games), not each. (ii) "Rollouts are 79% of the Rust step":
   gate games carry no label rollouts, so ~4.8x over generation's 6.5 games/s ≈ 31 games/s, bracketing the 38.
2. **A full playout under the 1-ply net policy costs ~6 ms** (~200 decisions at 24-38 µs).
   So **one full playout ≈ two to four whole depth-2 decisions.**
3. **Random-playout UCT on this engine is already within 8 points of the net player.** Phase F, 6-agent pool:
   `vnet(v40)` 49.8% [44.9, 54.6], `uct` 41.5% [36.8, 46.4]; vs 3 real jSettlers, 45% vs 37%
   (`docs/BENCHMARK.md`). Two evaluation mechanisms of comparable strength that are wrong in different ways —
   which is the precondition AlphaGo's mixed evaluation exploited.
4. **The gate cannot see what we are trying to measure.** A 4,000-game paired gate resolves ~3 points; every
   accepted round since v40 except round 46 was inside its own noise (FINDINGS says so explicitly).

The net's head layout matters twice below and is easy to forget: `N_HEADS = 6` =
*win logit, final VPs of the 4 relative seats / 10, turns remaining / 100* (`catan_engine/src/valuenet.rs:11`).
**We already have a per-seat value vector at every leaf, for free.**

---

## 0. The budget arithmetic that decides everything

Any play-time addition is paid for twice: once in play, and again (x2, both arms) every time it is gated.
With ~125 decisions per game per searching seat and 8 threads:

| per-decision cost | multiple of today | 4,000-game gate | 16,000-game gate |
|---|---|---|---|
| 2 ms (today) | 1x | ~2 min | ~7 min |
| 10 ms | 5x | ~9 min | ~35 min |
| 30 ms | 15x | ~26 min | ~1.8 h |
| 100 ms | 50x | ~1.5 h | ~6 h |
| 250 ms (`uct`'s budget) | 125x | ~3.6 h | ~14 h |
| 1 s | 500x | ~14 h | ~2.4 days |

Read with §3: **12,000-17,000 games are needed to see a 1.5-point change.** So the envelope for anything that
must live inside the loop's gate is **≤ 10-30 ms per decision**; 100 ms+ is a one-off overnight measurement,
and 1 s is off the table — at 1 s you can only afford 1,000 games, where σ ≈ 1.5 points, so you would be
measuring nothing.

Two consequences that kill the naive designs immediately:

- **Full playouts at the root are out.** N=5 candidates x K=20 playouts x 6 ms = **600 ms/decision** (300x).
  Truncation is not an optimisation here, it is the entry ticket.
- **Any depth-3-shaped expansion must keep `max_leaves`.** `search.rs:135` already re-expands one ply
  shallower on overflow, and FINDINGS records that 8% of depth-3 decisions hold 95% of the leaves.

---

## 1. Play-time improvement with rollouts

### 1a. Rescoring the top-N root moves with K playouts (Tesauro/Bertsekas rollout policy iteration)

The primary source is [Tesauro & Galperin, *On-line Policy Improvement using Monte-Carlo Search*, NIPS 1996](https://arxiv.org/abs/2501.05407)
([NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/1996/file/996009f2374006606f4c0b0fda878af1-Paper.pdf);
the arXiv copy is text-extractable, the NeurIPS scan is not). What it actually reports:

**Gains.** Average equity loss per decision on an 800-position test set, base player → rollout player
(their Table 2, full rollouts to game end):

| evaluator | base loss | Monte-Carlo loss | ratio |
|---|---|---|---|
| Random | 0.330 | 0.131 | 2.5 |
| Lin-1 | 0.040 | 0.0124 | 3.2 |
| Lin-2 (noise added) | 0.0665 | 0.0175 | 3.8 |
| Lin-3 | 0.0291 | 0.00749 | 3.9 |

and with **truncated** rollouts over multi-layer nets (their Table 3):

| net | base loss | truncated rollout loss | ratio | CPU (32 SP1 nodes) |
|---|---|---|---|---|
| 10 hidden | 0.0152 | 0.00318 (11-step, thorough) / 0.00433 (11-step, aggressive pruning) | 4.8 / 3.5 | 25 s / 9 s per move |
| 80 hidden (TD-Gammon 2.1 1-ply) | 0.0120 | 0.00181 (7-step) / 0.00269 (7-step, aggressive) | 6.6 / 4.5 | 65 s / 18 s per move |

Three claims from that paper are directly load-bearing for us:

- "**as one increases the strength of the base player, the ratio of error reduction due to the Monte-Carlo
  technique appears to increase**" — the rollout gain does not evaporate against a strong base policy.
- Truncated rollouts, where the net's estimate replaces the terminal outcome, "**offer favorable tradeoffs
  relative to doing full rollouts**": fewer steps per trial **and** much lower variance per trial, "since only
  a few random steps are taken and a real-valued estimate is recorded, rather than many random steps and an
  integer final outcome", giving "at least an order of magnitude speed-up". The truncated players were
  *both better and faster* than the full-rollout players.
- Their 7-step and 11-step horizons are roughly 25-40% of a backgammon game's remaining length.

**How N and K were chosen.** Not by a rule of thumb — by the resolution required. Backgammon has ~20 legal
moves; candidates "frequently differ in expected value by on the order of .01" ppg against a per-trial σ of
order 1 ppg, so "**one would need on the order of 10K or more trials per candidate**", i.e. hundreds of
thousands per decision. They cut this to "several tens of thousands of trials" per decision with **statistical
pruning**: continually monitor the accumulated statistics and drop (i) candidates outside a confidence bound
on being best and (ii) candidates close enough to the leader that the choice does not matter. That is a racing
/ best-arm-identification allocation, and it is the only reason the method was affordable at all. N is
therefore not fixed: it starts at all legal moves and shrinks.

**What this costs here, honestly.** Our per-playout outcome is a Bernoulli win/loss, σ ≈ 0.45. Two good root
moves in Catan differ in true P(win) by roughly 0.005-0.03. Resolving 0.02 needs SE ≲ 0.01, i.e.
**K ≈ 2,000 full playouts per candidate** — 12 s per candidate. Dead on arrival, exactly as in backgammon.
Three multipliers rescue it, and all three are needed:

1. **Truncate and evaluate with the net.** Cut the playout at 1-3 rounds and take the net's P(win). Cost
   drops from 6 ms to ~0.3-1 ms, and — the bigger effect — the per-trial σ drops from 0.45 (Bernoulli) to the
   spread the dice induce over 1-3 rounds in a continuous value. **σ_trunc is the one unmeasured number that
   decides whether any of §1a is viable, and it is an afternoon's work**: 200 truncated playouts from ~50
   mid-game states, take the SD. This document assumes 0.08-0.15, which puts K for SE = 0.01 at ~100-200
   instead of ~2,000; if σ_trunc comes back at 0.3, every budget below is 4x worse and §1a drops behind
   everything else in §5.
2. **Common random numbers across candidates.** We only need the *difference* between candidates, and the
   dominant noise (the dice) is shared. Var(d) = 2σ²(1−ρ); at ρ = 0.7 that is a further 3.3x cut in K.
   Implementation detail that matters: `State.rng` is a stream, and different root moves consume different
   numbers of draws, so CRN by seeding the stream is only approximate. Pre-draw a **dice tape** (array of
   2d6 results indexed by turn) per trial k and have the truncated playout read rolls from the tape; the
   stream then only covers card draws and steals. [Veness, Lanctot & Bowling, *Variance Reduction in
   Monte-Carlo Tree Search*, NIPS 2011](https://papers.nips.cc/paper/4288-variance-reduction-in-monte-carlo-tree-search)
   is the reference study of CRN / antithetic variates / control variates inside MCTS on stochastic games
   (Pig, Can't Stop, Dominion).
3. **Trigger selectively, and race.** Only rescore when the depth-2 top-2 EVs are within ε (an
   experiment-tunable ε; expect 20-30% of decisions to qualify, since most Catan decisions are forced or
   obvious). Then allocate trials by Tesauro's pruning rule rather than a flat K.

**Budget with all three:** trigger 25% of decisions, N=4 after a first-pass prune, K=64 truncated playouts
with CRN → 256 x 0.6 ms ≈ 150 ms on triggered decisions → ~40 ms averaged → **~20x**, a 16,000-game gate in
~1.2 h. A smaller first cut (N=3, K=16, 1-round truncation, ε tight) lands at ~3-5x and gates in ~30 min but
is at the edge of resolving anything (SE ≈ 0.017 on the difference, against differences of 0.01-0.02).

**Expected gain.** A rollout step is one step of policy iteration over the *rollout policy*, so its ceiling is
tied to that policy's strength. Our rollout policy would be the 1-ply net (24-38 µs/decision, and FINDINGS
2026-09-02 puts depth-1 net ≈ depth-2 `rab` as a player). The current player is depth-2 net, which is
meaningfully above that. So a *pure* rollout player is unlikely to beat what we have — the value is in the
**hybrid**: depth-2 generates and pre-orders candidates, rollouts break the near-ties it cannot resolve.
Tesauro's own ratios (3-6x error reduction on decisions) are against a base with no lookahead; expect much
less here, but the decisions it changes are by construction the close ones.

### 1b. Leaf evaluation as a mix of net value and short playouts

This is AlphaGo's leaf evaluation, and it is the single most encouraging precedent for this repo:
V(s_L) = (1−λ)·v_θ(s_L) + λ·z_L, with z_L the outcome of a fast rollout.
[Silver et al., *Mastering the game of Go with deep neural networks and tree search*, Nature 2016](https://papers.baulab.info/papers/Silver-2016.pdf)
states: "**the mixed evaluation (λ = 0.5) performed best, winning ≥95% of games against other variants**",
against λ=0 (value net only) and λ=1 (rollouts only), because "the two position-evaluation mechanisms are
complementary".

Our fact 3 above is the same configuration: `uct` (rollouts only, random policy) at 41.5% and `vnet` (value
only) at 49.8% in the same pool. Two comparable, differently-wrong evaluators. **Mixing them is the highest
expected-value untested idea in this document.**

Where to put the mix matters. Mixing at *every* depth-2 leaf is unaffordable (300-3000 leaves x a playout
each). Two affordable placements:

- **Mix only at the root children** (that is §1a with λ: final score = (1−λ)·depth-2 EV + λ·rollout mean).
  Cheap, and the depth-2 EV is already computed by `Search::backup_full` (`search.rs:205`).
- **Mix inside an MCTS whose tree nodes are few** (§1c): a few hundred tree nodes, each getting one
  truncated playout plus one net eval, instead of thousands of leaf evals.

A third, nearly-free variant worth testing first because it costs one line: at a depth-2 leaf, replace the
net's P(win) with a **0-step "playout"** — the net's value averaged over the 11 dice outcomes of the next
roll. That is a chance-node smoothing of the evaluator, not a rollout, and at 11 x 3 µs per leaf it is 33 µs
per leaf, i.e. 10x the decision cost. Probably too expensive at 3000 leaves; affordable if applied only to
the ~20 root children (+0.7 ms/decision). Mentioned because it is the cheapest possible probe of "is the
noise in the leaf evaluator what is limiting us".

### 1c. MCTS variants with net priors/values for a stochastic, multi-player, hidden-information game

**The build is 90% done.** `catan_engine/src/mcts.rs` is a working UCT/BUCT/VPI with chance handled by simply
applying stochastic actions (each simulation re-samples), a 10-round playout cutoff, and reward = own VP/10.
The grafts, in increasing order of work:

1. **Terminal reward → net P(win).** `Mcts::playout` returns `actual_vp.clamp(0,10)/10.0` (`mcts.rs:179`).
   Return the net's win probability at the cutoff state instead. One net eval (3 µs) per playout, free next to
   the ~120 applied actions a playout already costs.
   *Caveat the code will hit:* `Node::alpha[K]` is a Dirichlet over 11 integer VP categories, used by BUCT and
   VPI. A continuous P(win) either needs binning (lossy but trivial) or those two policies stay on the VP
   reward. UCT — the strongest of the three here, 41.5% — only needs `mean()`, so **do UCT first**.
2. **Truncate hard.** With a real evaluator at the horizon, a 10-round cutoff is wasteful. Try 2-4 rounds.
   Tesauro's Table 3 is the precedent (7-step beat 11-step on quality *and* cost); AlphaGo's method note calls
   its value net "truncated Monte Carlo search". Expect ~3-5x more simulations for the same budget.
3. **Priors at the root.** `backup_full` already returns (action, E[value]) for every root child. Seed the
   root children's UCT statistics with those as virtual wins (the standard "prior visits" trick — Dobre &
   Lascarides do exactly this in Catan, setting `Xj = Q(s,a)`, `nj = 10`, see §4). No new net head, no
   training. A PUCT-style prior would need a policy head we do not have; the depth-2 EVs are the substitute.
4. **Implicit minimax backups**, if the above works: keep two values per node, the MC average and a
   minimax-backed heuristic value, and select on (1−α)·Q̂ + α·v_minimax.
   [Lanctot, Winands, Pepels & Sturtevant, *MCTS with Heuristic Evaluations using Implicit Minimax Backups*
   (arXiv:1406.0486)](https://arxiv.org/abs/1406.0486) report α ∈ [0.15, 0.4] as a safe range (higher,
   [0.5, 0.6], in Breakthrough with node priors), with large gains in Breakthrough and marginal ones in Lines
   of Action. Note their honesty about LOA: 50.59% over **32,000 games**, statistically significant — see §3.

**Hidden information: do nothing.** Catan's private hands are the sort of hidden information that
determinization handles well, and our arena is fully observable anyway (`mcts.rs` playouts see opponents'
hands; BENCHMARK Phase D records this as a deliberate deviation). The theory that says this is fine is
[Long, Sturtevant, Buro & Furtak, *Understanding the Success of Perfect Information Monte Carlo Sampling*,
AAAI 2010](https://ojs.aaai.org/index.php/AAAI/article/view/7562): PIMC's errors (strategy fusion,
non-locality) are neutralised in games with high **leaf correlation**, low **bias**, and a high
**disambiguation factor** — Catan reveals hidden cards steadily (dev cards get played, hands get spent) and
outcomes are strongly determined by board position, so it sits in the benign region. ISMCTS
([Cowling, Powley & Whitehouse, IEEE TCIAIG 2012](https://ieeexplore.ieee.org/document/6203567)) and belief
models (`sorinMD/MCTS`'s BMCTS/POMCP variants, from Dobre's thesis) are real machinery, but against our gate
opponents — who also see everything — they would buy nothing measurable. **Skip.**

**Multi-player MCTS backup.** [Sturtevant, *An Analysis of UCT in Multi-player Games*, ICGA/CG 2008](https://webdocs.cs.ualberta.ca/~nathanst/papers/mpuct_icga.pdf)
is the reference: UCT in n-player games naturally computes a **max^n** backup (each node backs up the vector,
each player maximising their own component), and this is the *right* structure — Schadd & Winands' overview
concludes "Best-Reply Search is generally the best minimax-based search technique, while Monte-Carlo Tree
Search performs best with the max^n tree structure". Our 6-head net gives us the per-seat value vector for
free, so a vector-valued MCTS backup is a small change if the scalar version works.

---

## 2. Fixing the depth-3 failure

The measured failure (recorded in `search.rs:130-134`): paranoid depth 3 scored 24.9% vs 30.7% for depth 2,
because "the min over a noisy net's estimates of 10-15 replies biases every end-turn branch low".

### The size of the bias, in numbers

If the net's error on a leaf is roughly N(0, σ) and an opponent node takes the min over b i.i.d.-ish replies,
the backed-up value is biased low by

&nbsp;&nbsp;&nbsp;&nbsp;bias = σ · E[max of b standard normals]

Use the exact order statistic, not the √(2 ln b) asymptote — at these b it is 30%+ too large
(√(2 ln 15) = 2.33 against the true 1.74):

| b | 2 | 3 | 5 | 10 | 15 | 20 |
|---|---|---|---|---|---|---|
| E[max]/σ | 0.56 | 0.85 | 1.16 | 1.54 | 1.74 | 1.87 |

At b = 15 the bias is **1.74σ**. With a plausible net error of σ = 0.05-0.10 in P(win), that is a systematic
**0.09-0.17** penalty — 5-15x larger than the 0.01-0.03 differences between good root moves. And it is
applied *differentially*: end-turn branches pass through a full opponent reply set, build branches often end
at a chance node, so the comparison between "build now" and "end turn" is corrupted, not merely noisy. This is
textbook minimax pathology with a noisy evaluator — see [Lustrek, Gams & Bratko, *Is real-valued minimax
pathological?*, Artificial Intelligence 2006](https://www.sciencedirect.com/science/article/pii/S0004370206000117),
which states the mechanism exactly: minimax with a noisy evaluation introduces a bias into the backed-up
values. **Depth 3 did not fail because lookahead is worthless here; it failed because of the backup operator.**
That also explains why depth 2 is safe: at depth 2 the opponent's decision node *is* a leaf, so no extremum
over noisy values is ever taken.

### Fix A — soft-min backup (cheapest experiment in this document)

In `backup_node` (`search.rs:219`) every child's EV is already computed. Replace, at minimizing nodes:

&nbsp;&nbsp;&nbsp;&nbsp;v = Σ_i w_i·v_i,&nbsp;&nbsp; w_i = exp(−v_i/τ) / Σ_j exp(−v_j/τ)

τ → 0 is the measured-bad min; τ → ∞ is the mean (opponent ignored); a finite τ interpolates and shrinks the
order-statistic bias to roughly σ²/τ for τ ≫ σ. This is *only* a backup change — same expansion, same leaves,
same net — so a single dump of depth-3 trees can be re-backed up at many τ for free, and arm selection then
costs only the gate games. Literature: [*Learning Position Evaluation Functions Used in Monte Carlo Softmax
Search* (arXiv:1901.10706)](https://arxiv.org/abs/1901.10706) uses exactly this operator in place of minimax;
[Baum & Smith's](https://www.sciencedirect.com/science/article/pii/S0004370297000268) probabilistic
"best play for imperfect players" framing is the older version of the same argument.

**Product propagation** is the other natural operator for a tree whose leaves are probabilities: back up
∏(1−p_i) style rules that treat child values as independent win probabilities. See
[*An Analysis of Decision Quality of Minimaxing vs. Product Propagation*, IEEE SMC 2009](http://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/IEEE_SMC_2009/PDFs/877.pdf)
— product propagation beat minimax at most depths in one game class and lost in another, so treat it as a
second arm of the same sweep, not a favourite.

### Fix B — opponent reply pruning by the net's own ordering

Score the opponent's replies with the net at 1 ply (they are already encoded), keep the top k = 2-3, and
min/soft-min over those only. Two wins at once, and read the table above before dismissing the first: the
bias **halves**, from 1.74σ at b = 15 to 0.85σ at k = 3 (0.56σ at k = 2) — pruning is a bias fix in its own
right, not just a cost fix — and the leaf count at ply 3 drops ~5x, which is what makes depth 3 affordable at
all given `max_leaves`. The forward-pruning precedent in multiplayer search is
[BRS+ (Esser, Gras, Winands, Lanctot, Schadd, CG 2013)](https://mlanctot.info/files/papers/cg13-brsplus.pdf),
which uses move ordering to decide which opponents get searched.

### Fix C — max^n using the heads we already have

`N_HEADS = 6` includes each of the 4 relative seats' predicted final VP. At an opponent node, instead of
taking `min` over *our* noisy win estimate, **select the child that maximises that opponent's own predicted
VP head, and back up our win logit from the selected child.** This is max^n / an opponent model, and it is
almost free: the vector is already in the leaf matrix; only `backup_node` and the leaf-value plumbing change
(values would become a `[f64; 6]` slice per leaf, or two slices).

Why this is better than it looks: taking an argmax over the *opponent's* head and reading *our* head at the
winner is a selection, not an extremum over our own noise, so it does not inherit the −1.74σ bias. It has its
own (second-order) error — the opponent's head is noisy too, so the selected child is winner's-cursed on a
correlated quantity — but the direction of that error is not systematically anti-us.

The relevant literature agrees that paranoid is the wrong default in a 4-player game with a learned
evaluator: [Sturtevant, Zinkevich & Bowling, *Prob-maxn: Playing N-Player Games with Opponent Models*, AAAI
2006](https://webdocs.cs.ualberta.ca/~nathanst/papers/probmaxn.pdf) mixes opponent models probabilistically
and beat both max^n and soft-max^n against unknown opponents in Spades;
[Zuckerman, Felner & Kraus, *MP-Mix*, IJCAI 2009](https://mlanthology.org/ijcai/2009/zuckerman2009ijcai-mixing/)
switches between max^n, paranoid and an offensive strategy by the players' relative standing, which is very
natural in Catan (paranoid is approximately correct only when *we* are the leader at 8-9 VP; max^n is right
earlier). MP-Mix's "switch when the leader is within d of winning" rule is directly implementable from
`actual_vp`.

### Fix D — Best-Reply Search: interesting, but be careful in Catan

[Schadd & Winands, *Best Reply Search for Multiplayer Games*, IEEE TCIAIG 2011](https://dke.maastrichtuniversity.nl/m.winands/documents/BestReplySearch.pdf):
only the single opponent with the strongest counter-move is allowed to move, which collapses n successive
opponent plies into one MIN layer at branching factor b·(n−1), letting the root player be searched further.
Reported results are strong and consistent — BRS vs max^n: 72-88% in Chinese Checkers, 81-95% in Focus, 64-69%
in Rolit; BRS vs paranoid: ~59-71% in Chinese Checkers, 58-68% in Focus, equal in Rolit (all 1,000+ games).

**But** their stated drawback is our problem: "not all players are allowed to make a move, leading to illegal
positions", and they rule BRS out entirely for trick-taking card games on exactly this ground. In Catan,
skipping two opponents' turns skips their **dice rolls** — i.e. everyone's production, including ours — the
robber, and their builds. That is a far larger distortion than a skipped move in Chinese Checkers. If BRS is
tried here it should be BRS+ (all opponents move, only the best-reply opponent is searched in depth), and even
then I would rank it below fixes A-C. Note also the structural point BRS was built for: our `own_turn` mode
already achieves the same goal — more MAX nodes on the path — by treating opponent decisions as leaves.

### What the multiplayer-search literature says overall

[Nijssen & Winands' overview of search techniques in multi-player games](https://dke.maastrichtuniversity.nl/pim.nijssen/pub/cgw.pdf)
summarises the consensus: **BRS is generally the best minimax-based technique; MCTS works best with the max^n
tree structure**. Combined with our fact 3 (random-playout UCT is already at 41.5%), the literature is
pointing at the same place as the measurements: the depth-3 minimax line is the risky one, and the
MCTS-with-max^n-backups-and-net-values line is the one with both theory and a working codebase behind it.

---

## 3. Evaluation variance: seeing 1-2 points cheaply

### The numbers first

Per game, a win is Bernoulli(p) with p ≈ 0.68 against 3x `rab`, so σ = √(0.68·0.32) = 0.466. For a paired
design (candidate and incumbent on the same seed) the statistic is d_s = X_s − Y_s ∈ {−1, 0, 1} with

&nbsp;&nbsp;&nbsp;&nbsp;Var(d) = σ_X² + σ_Y² − 2ρσ_Xσ_Y = 2σ²(1−ρ) = 0.435·(1−ρ)

Fixed-N, one-sided α = 0.05, power 80%: N_pairs = (1.645+0.842)²·Var(d)/δ² = 6.18·0.435(1−ρ)/δ².

| δ (points) | ρ = 0 | ρ = 0.3 | ρ = 0.5 | ρ = 0.7 |
|---|---|---|---|---|
| 1.0 | 26,900 pairs | 18,800 | 13,400 | 8,100 |
| 1.5 | 11,900 | 8,400 | 6,000 | 3,600 |
| 3.0 | 3,000 | 2,100 | 1,500 | 900 |

(one pair = 2 games). **So the current 4,000-game gate — 2,000 pairs — has ~80% power at 3 points and
roughly 30-40% power at 1.5 points.** That is precisely the pattern FINDINGS reports: round 46's +3.1 was
seeable, the +0.7 and +0.15 accepts were coin flips. This is agreement with what the loop already concluded,
not a new discovery.

An independent Catan precedent for the same order of magnitude:
[Dobre & Lascarides, *Online learning and mining human play in complex games*](https://www.pure.ed.ac.uk/ws/files/19909731/Dobre_Lascarides_Online_Learning_and_mining_human_play_in_complex_games.pdf)
ran **10,000 games per arm** against 3 baseline jSettlers and state plainly that "results between 24-26% are
not considered significant" at p < 0.01, "due to the degree of non-determinism in the game". Their headline
gains were 28.74% / 28.48% / 30.43% against a 25% baseline. Lanctot et al. needed **32,000 games** to call
50.59% in LOA. The field's answer to "how do I see 1-2 points" is, first and always, *more games*.

### The good news: games are cheap here

At ~0.2 CPU-s per gate game (§0), **16,000 gate games cost ~7-14 min on 8 threads** — less than the ~10 min a
round already spends on generation. The cheapest available variance reduction in this project is
**quadrupling the gate**, and it costs less than the stage it gates. Everything below is worth doing, but it
should be understood as buying 1.3-2.5x on top of that, and mattering most when the candidate is 10x slower
and games stop being cheap.

### Variance reduction techniques, in order of value here

**1. Pairing (already partly done) — but compute the paired statistic.** The loop plays incumbent then
candidate on the same seed, then compares **totals**. That throws the pairing away in the analysis. Log
per-game outcomes (seed, seat, winner, VP) and compute d_s. The saving is (1−ρ), and ρ is currently unknown.

It cannot be recovered from rounds 46-53: `evaluate.py:145` already receives per-game rows from
`arena.play` (`for _, w, _, _ in ...`) and sums them on the spot, and `run_exit.sh`'s `proxy()` only parses
the printed total — so nothing per-game was ever written. Measuring ρ therefore waits on the logging change,
which is recommendation #1 anyway, and is then one A/B run away (16k games ≈ 7-14 min). If ρ comes back at
0.15, all the paired-design cleverness is worth 15%.

Realistic expectation: the board and the initial deck shuffle are shared, but the dice stream diverges as soon
as the arms play differently, so I would guess ρ ≈ 0.2-0.4, not 0.7.

**2. Seat-rotation blocks (a duplicate-bridge analogue) — phase 2, not phase 1.** Seat order drives
first-settlement choice and is a large variance component. Play each seed 4 times with the candidate in each
of the 4 seats (same board, same initial shuffle) and score the block as wins ∈ {0..4}. The Fishtest
[pentanomial model](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html) is the
same idea for colour-reversed game pairs — "the trinomial model overestimates elo confidence intervals, and as
a result it takes more effort than necessary".

But do not oversell the analogy, and do not ship it in the first version: a Fishtest pair shares only the
opening, whereas a block of 4 shares the **whole board layout**, the dominant variance component. That makes
the block's games strongly positively correlated — Var(block mean) = σ²(1 + 3ρ_board)/4 — so 4 games in a
block are worth well under 4 independent games. And board and seat already cancel in the paired difference
d_s. Adopt it only if the logged data shows a seat component big enough to pay for the 4x games.

**3. Control variates / CUPED on a pre-outcome covariate.** The classic estimator
([Deng, Xu, Kohavi & Walker, *Improving the Sensitivity of Online Controlled Experiments by Utilizing
Pre-Experiment Data*, WSDM 2013](https://www.researchgate.net/publication/237838291_Improving_the_Sensitivity_of_Online_Controlled_Experiments_by_Utilizing_Pre-Experiment_Data)):

&nbsp;&nbsp;&nbsp;&nbsp;Ŷ_cv = Ȳ − θ(X̄ − E[X]),&nbsp;&nbsp; θ* = Cov(Y,X)/Var(X),&nbsp;&nbsp; Var(Ŷ_cv) = Var(Ȳ)(1−ρ²)

The covariate must be **unaffected by the treatment**. Two are available for free here:

- **the net's win-probability head evaluated at the end of the initial placement phase** for the
  candidate's seat (3 µs, and the placement phase is nearly identical between arms);
- **the outcome of a fixed reference player on the same seed/seat** — the "how favourable was this board"
  regressor, and the same idea as poker's use of a known strategy in
  [AIVAT (Burch, Schmid, Moravcik, Morrill & Bowling, AAAI 2018)](https://arxiv.org/abs/1612.06915), which
  "reduce[s] the number of hands needed to draw statistical conclusions by more than a factor of 10" by using
  a heuristic state value plus the *known strategies* of some players. Our gate has three known-strategy
  opponents (`rab`) and a full simulator, so an AIVAT-flavoured estimator is possible in principle; it is a
  research project, not a week's work, and I would not start there. Expect ρ ≈ 0.3-0.5 for the cheap
  covariates → 10-25% variance reduction. Worth the ten lines, not worth a redesign.

**4. Sequential testing (SPRT).** This is the one that saves real wall-clock, because most candidates are not
close calls. Using the normal approximation with observations d_i (mean δ, variance σ_d²), testing
H0: δ = δ0 against H1: δ = δ1:

&nbsp;&nbsp;&nbsp;&nbsp;LLR_N = ((δ1−δ0)/σ_d²) · Σ_i (d_i − (δ0+δ1)/2)

stop and accept H1 when LLR ≥ log((1−β)/α), accept H0 when LLR ≤ log(β/(1−α)). At α = β = 0.05 the bounds are
**±log(19) = ±2.944**. The worst-case expected duration (truth halfway between the hypotheses) is, from
[van den Bergh's *Comments on normalized Elo*](https://cantate.be/Fishtest/normalized_elo_practical.pdf),
T = log(19)²/(t_{n,1} − t_{n,0})² where t_n = δ/σ is the normalized t-value — i.e.

&nbsp;&nbsp;&nbsp;&nbsp;**T ≈ 8.67 · σ_d² / (δ1−δ0)²** observations, worst case; far fewer when the truth is at
either hypothesis.

For δ1−δ0 = 0.015 and ρ = 0.3 (σ_d² = 0.305): T ≈ 11,700 pairs worst case, but a candidate that is truly
+3 points or truly −1 point stops in a small fraction of that. That asymmetry is the whole point: **the loop
currently pays a fixed 4,000 games to learn nothing; an SPRT pays a few hundred to reject a bad draw and pays
the full price only when the answer is genuinely near the boundary.** Fishtest's standard practice — see the
[SPRT page](https://chessprogramming.org/Sequential_Probability_Ratio_Test) — is exactly this, with
"gainer" bounds like [0, 3] and non-regression bounds like [−3, 1] in Elo.

Normalized Elo is the right figure of merit to carry: e_n = δ/σ_pg (scaled), "a measure for the amount of
games it takes to prove that one engine is stronger than another". It is what tells you that a variance
reduction and a strength gain are worth the same thing.

### Recommended gate design for this project

1. **Log per-game rows** (round, arm, seed, seat, winner, VP, decisions, wall-time). Nothing else in this
   section is possible without it, and it is nearly free: `evaluate.py:145` already has the per-game tuples
   from `arena.play` and discards them in the `sum(...)`.
2. **Unit of observation = the paired difference on one seed**, d_s = X_s − Y_s ∈ {−1, 0, 1}, with both arms
   on the same seed and the same seat. (Seat-rotation blocks are the phase-2 upgrade; see above.)
3. **Per-round accept gate: a non-regression SPRT**, H0: δ = −0.005, H1: δ = +0.010, α = β = 0.05, cap
   16,000 games (~4,000 blocks, ~15 min). Accept on the H1 boundary, reject on H0, and on the cap **keep the
   incumbent** (the loop's current bias toward accepting a tie is what lets noise accumulate as "progress").
4. **Optional CUPED adjustment** with the post-placement net value as covariate; report both adjusted and raw
   so the adjustment can be audited.
5. **Headline runs (a new search design, not a new checkpoint): a separate SPRT** with H0: δ = 0,
   H1: δ = +0.02, cap 40,000 games, run overnight. For a 30 ms/decision player that is ~4 h.
6. **Stop reporting 1,000-game soup scores as gains.** FINDINGS already established that the round-53
   α = 0.3 net's +28 on 1,000 soup games was worth exactly 0 on 4,000 gate games. At σ ≈ 15 wins per 1,000,
   a best-of-six pick has an expected selection bias of ~+1.3σ ≈ +20 wins with no real difference at all —
   which matches the observed +28 almost exactly.

---

## 4. What the strong Catan bots do at decision time that depth-2 expectimax does not

### Trading — the biggest structural gap, and it is not a learning problem

The evidence in this repo is unusually clean. BENCHMARK Phase E: `jsrobot` vs 3 stock jSettlers scores
**32.0% with its negotiator and 16.5% without** (97 games each). Nearly **half of the jSettler's strength is
its trade policy.** Meanwhile on our side:

- `search_actions()` deliberately excludes every `OfferTrade` (`actions.rs:133-137`), so **trades are never
  searched** — no offer is ever compared against a build at depth 2;
- `trade.rs` decides them with a 1-ply policy over hand-modified states, and FINDINGS' retired item #4 notes
  those states are ordinary hand states that existing training rows already cover.

So the value net is asked nothing new by a proper trade search, and no retraining is implied. Concretely:

1. Generate candidate offers (`domestic_trade_possibilities` already exists, ~300 before filtering).
2. Rank them by a 1-ply net gain on our own post-trade hand: ~300 x 3 µs = **0.9 ms**. Keep the top k = 3-5.
3. **Model each opponent's reply with the same net** — value their hand with and without the trade, 2
   forwards x 3 opponents x k offers = 30 x 3 µs = **0.1 ms**. Against the gate's `rab` opponents the accept
   rule is actually *known exactly* (it is our own engine's), so the model can be exact — which is a strength
   in the gate and an overfitting risk against jSettlers and humans. Report both.
4. Put the surviving offers into the root action set as real children, with the accept/reject branch as a
   chance node weighted by the model. They then compete with builds inside the existing depth-2 expectimax.

Per-decision cost: ~1-3 ms extra on the ~30% of decisions where a useful offer exists. **This is the
cheapest large structural change available, and it is a search feature, not a learned one.**

### Long-horizon planning — already ported, currently unused by the search

jSettlers plans by estimating **how many turns until each player reaches 10 VP**, via
`SOCBuildingSpeedEstimate` ETAs and `SOCPlayerTracker`'s `win_game_eta`, including the longest-road and
largest-army races explicitly. BENCHMARK Phase E records that `catan_engine/src/jsettler/` reproduces those
to **100% oracle agreement** (13k+ `win_game_eta` values, all seats; 1,308 possible-piece sets; 100% on the
build plan). That is a validated, oracle-matched long-horizon feature sitting in this repo that the value
search never consults. Three uses, cheapest first:

- **A tiebreaker / small additive term at the root** when the depth-2 EVs are within ε (the same trigger as
  §1a). Cost: one tracker rebuild per root child — measure it, `tracker.rs` rebuilds from `State` per decision
  by design, so this may be the expensive option.
- **A rollout policy** for §1: `jsrobot` plays at roughly `rab` strength (24.7% vs 3x `rab`), so it is not
  better than the 1-ply net policy, but it is *differently* biased and it plans over a horizon the net does
  not. Mixed rollout policies are worth an arm.
- **A net input.** Ruled out for now: training is measured dead, and adding an input means retraining.

### Catanatron's AlphaBeta, and what it does *not* do

Our own `rab`/`ab` is a depth-2 expectimax over a hand-tuned `base_fn` — the same shape as ours with a
different evaluator. Phase F: `rab` 29.0% and `ab` 24.0% vs real jSettlers, inside each other's intervals.
Nothing in it is a decision-time idea we lack.

### The MCTS agents

Already covered: `uct` at 41.5% / 37% is the strongest non-net agent we have, built on **random** playouts.
The older Catan MCTS literature is consistent —
[Szita, Chaslot & Spronck, *Monte-Carlo Tree Search in Settlers of Catan*, ACG 2009](https://link.springer.com/chapter/10.1007/978-3-642-12993-3_3)
first showed MCTS with domain knowledge in the playouts beating the jSettlers heuristic agent, and
[Dobre & Lascarides](https://www.pure.ed.ac.uk/ws/files/19909731/Dobre_Lascarides_Online_Learning_and_mining_human_play_in_complex_games.pdf)
got +3.7 points over a 25% baseline from a flat-UCB layer on *one* decision (the initial placement) alone,
plus another +1.7 from informing the search with mined human play — using prior visits `nj = 10` with
`Xj = Q(s,a)`, the same prior trick recommended in §1c. Their
[`sorinMD/MCTS`](https://github.com/sorinMD/MCTS) code has belief-model and typed-rollout variants if the
hidden-information question is ever reopened (§1c says don't).

### 2023-2026

Thin, and mostly not search work. The most relevant recent item is
[*Agents of Change: Self-Evolving LLM Agents for Strategic Planning* (arXiv:2506.04651)](https://arxiv.org/abs/2506.04651)
and its successor [HexMachina](https://openreview.net/forum?id=V0Fb4pwhS4), which use **Catanatron** as the
benchmark and report evolving a player that beats `AlphaBetaPlayer` (a **54%** win rate is claimed for
HexMachina). That is the same opponent as our M4 gate, and our v49 is at 57.3% [54.2, 60.3] over 1,000 games
against 3x Python `AlphaBetaPlayer` — so the claim is, at face value, comparable to where this project
already is. Treat the number with §3's scepticism until the sample size behind it is known. The method (an
LLM rewriting a heuristic player's code) has no decision-time idea to borrow.

---

## 5. Ranked experiments

Ranked by expected value / cost. Costs are per-decision estimates; gate times assume §3's design.

### 1. Rebuild the gate: per-game logging, seat-rotation blocks, SPRT, 16k cap

**Why first:** nothing else in this list can be evaluated. The loop's current gate has ~30-40% power at the
size of every change we are contemplating, and the project has already spent rounds 46-53 learning this the
expensive way. It is also the only item that *saves* time on average (SPRT stops early on clear answers).

**Recipe:** log per-game rows (one line in `evaluate.py`); paired d_s per seed; normal-approx SPRT with
H0 = −0.005, H1 = +0.010, α = β = 0.05, bounds ±2.944, cap 16,000 games; keep the incumbent on the cap. Then,
as a one-off, measure ρ and the discordance rate from the first logged round and re-tune the bounds — ρ is
not recoverable from rounds 46-53, which printed only totals. Seat-rotation blocks are a phase-2 option, to
be justified from the logged seat component rather than assumed.
**Cost:** ~1 day; +0-12 min per round (often less than today's 3.5 min).
**Gate:** itself — verify by an A/A run (incumbent vs itself on different seeds) that the accept rate is ≈ α.

### 2. Soft-min / max^n backup sweep at depth 3

**Why:** it attacks the one measured search failure with a bias whose size (≈1.74σ, 5-15x the signal) explains
the 24.9%-vs-30.7% result quantitatively, and the code change is confined to `backup_node`.

**Recipe, in this order:** (a) top-k reply pruning (k = 2-3) by the net's own 1-ply order — it halves the
bias (1.74σ → 0.85σ) *and* is what makes depth 3 fit under `max_leaves`, so it goes in first and every later
arm rides on it; (b) τ-sweep of a soft-min at minimizing nodes, τ ∈ {0 (=min), 0.02, 0.05, 0.1, ∞ (=mean)};
(c) product propagation as a second arm; (d) max^n using the per-seat VP heads already in the net's 6 outputs
(needs the leaf value plumbing widened from `&[f64]` to per-leaf vectors).
**Cost:** ~2 days. Per-decision: depth-3 expansion with k=3 pruning ≈ 10-30 ms (measure; `max_leaves` stays).
**Gate:** #1's SPRT vs the depth-2 incumbent. Expect the sweep to need 4-6 arms x ~1-3 h each.

### 3. Play-time prediction ensemble (near-free, tests the noise hypothesis directly)

**Why:** every 2026-09-22 result says the net's problem is *variance*, not capacity — the soup's weight
averaging is the only thing producing gains, and single draws are 5-24 points worse than their average.
Averaging the *predictions* of 3-5 diverse checkpoints (v40, v46, v49, v51, plus draws) is strictly more
diverse than averaging their weights, and it shrinks σ, which in turn shrinks every bias in §2.

**Recipe:** load K nets in `valuenet.rs`, average the win logits at each leaf. 3 µs → 3K µs per leaf, i.e.
**2 ms → 6-10 ms** per decision at K=3-5. Nothing else changes.
**Cost:** hours. **Gate:** #1's SPRT, K=3 first. If prediction-ensembling beats the soup, that is also a
statement about what the training loop has been doing.

### 4. Net values inside the existing MCTS (truncated playouts + root priors)

**Why:** highest ceiling in the list, and the strongest external precedent (AlphaGo's λ=0.5 mixture beat both
pure variants in ≥95% of games) lines up exactly with our own fact 3 (uct 41.5% vs vnet 49.8%, differently
wrong). The code exists.

**Recipe, in the order they should be tried, each gated separately:**
(a) `Mcts::playout` returns the net's P(win) at the cutoff instead of VP/10, UCT policy only;
(b) cutoff 10 rounds → 2-4 rounds;
(c) root children seeded from `backup_full`'s depth-2 EVs as prior visits (Xj = EV, nj ≈ 10);
(d) λ-mix of the truncated playout and the net value at the tree node, λ ∈ {0, 0.25, 0.5, 0.75, 1};
(e) only if all of the above pays: vector (max^n) backups using the per-seat heads, per Sturtevant.
**Cost:** ~1 week to (d). Per-decision: tune the simulation count to a **30 ms** budget and report the
strength-vs-budget curve; `uct`'s current 0.25 s is 8x too expensive for a loop gate but fine for a headline.
**Gate:** #1's SPRT at 30 ms; a 40,000-game headline run at the larger budget if it wins.

### 5. Offers inside the search

**Why:** the jSettler's negotiator is worth ~15 points to its own seat (32.0% vs 16.5%), our offers never
enter the search tree, and the net needs no retraining to evaluate them. Largest structural gap per line of
code.

**Recipe:** rank `domestic_trade_possibilities` by 1-ply net gain (0.9 ms for ~300), keep top 3-5, model each
opponent's accept with the same net (two forwards per opponent), attach the accept/reject as a chance node,
and let the existing depth-2 expectimax choose. **Cost:** ~3 days. Per-decision: +1-3 ms where offers exist.
**Gate:** #1's SPRT **plus** a 300-game bridge run vs real jSettlers — against `rab` the accept model is
exact, so the arena gate alone will flatter it.

### 6. Root rollout rescoring (Tesauro), truncated + CRN + racing

**Why:** the classical answer to the exact question, with a measured 3-6x decision-error reduction in
backgammon. Ranked below #4 because MCTS *is* rollout rescoring with adaptive allocation, and the two share
the truncated-playout primitive — build the primitive for #4 and this becomes a half-day variant.

**Prerequisite, before writing any of it:** measure σ_trunc (200 truncated playouts from ~50 mid-game
states, SD of the net value at the horizon). K, and therefore the whole budget below, is set by it; at
σ_trunc ≥ 0.25 this experiment is not affordable and should be dropped rather than scaled down.

**Recipe:** trigger when the depth-2 top-2 EVs are within ε; N = top 4-6 root children; K truncated playouts
(1-3 rounds) under the 1-ply net policy, terminal value = net P(win); **CRN via a pre-drawn dice tape shared
across candidates**; Tesauro-style pruning of candidates outside a confidence bound and of candidates too
close to matter; final score = (1−λ)·depth-2 EV + λ·rollout mean. **Cost:** ~3 days after #4's primitive.
Per-decision: ~40 ms averaged at N=4, K=64, 25% trigger. **Gate:** #1's SPRT; also report the fraction of
decisions changed — if rollouts change < 2% of decisions, the ceiling is ~0 regardless of their quality.

### 7. MP-Mix-style backup switching by standing

**Why:** cheap, and the paranoid assumption is only defensible when we are the leader. Implement after #2
tells you which backup operators actually work; MP-Mix is just a rule for choosing between them per position.
**Cost:** hours on top of #2. **Gate:** #1's SPRT.

---

## Be blunt: what the measured facts make unlikely

- **More training of any kind.** Three sweeps on 2026-09-22 (label volume 100k-900k, epochs, lr, and three
  label policies including the net-in-the-loop ones) all produced draws 5-24 points below their warm start.
  Nothing in this document should be spent on labels.
- **Depth 3 with a `min` backup.** Measured worse (24.9% vs 30.7%), and §2 gives the reason and its size.
  Do not re-run it as a control; run the backup operators instead.
- **A bigger net.** The project is simulation-bound (CLAUDE.md), and the leaf forward is now 3 µs. A bigger
  net multiplies the one cost that is currently free and does nothing about the variance that §2 and #3
  identify as the binding constraint.
- **Hidden-information machinery (ISMCTS, belief models, POMCP).** The arena is fully observable and so are
  the gate opponents; Long et al.'s conditions put Catan in the region where determinization is benign. This
  would be weeks of work for a quantity the gate cannot measure.
- **Raw MCTS at 0.25 s/decision as the shipped player.** It is 125x the current cost, which means a 4,000-game
  gate takes 3.6 h and the 16,000 games you actually need take 14 h. Use the budget curve from #4 to pick the
  operating point; do not adopt `uct`'s.
- **Any experiment gated at 1,000 games.** σ ≈ 1.5 points there, and a best-of-N pick on that sample has an
  expected selection bias of the same size as every change being tested — which is exactly how the round-53
  α = 0.3 "+28" evaporated on the 4,000-game gate.
- **Expecting a single change to be worth 5+ points.** The realistic shape is several 1-3 point gains, which
  is why #1 comes first: without it they are individually invisible and collectively indistinguishable from
  the flat line v40 → v51 already traced.

---

## Sources

- Tesauro & Galperin, *On-line Policy Improvement using Monte-Carlo Search*, NIPS 1996 — [arXiv:2501.05407](https://arxiv.org/abs/2501.05407) · [NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/1996/file/996009f2374006606f4c0b0fda878af1-Paper.pdf)
- Silver et al., *Mastering the game of Go with deep neural networks and tree search*, Nature 2016 — [PDF](https://papers.baulab.info/papers/Silver-2016.pdf)
- Veness, Lanctot & Bowling, *Variance Reduction in Monte-Carlo Tree Search*, NIPS 2011 — [NeurIPS](https://papers.nips.cc/paper/4288-variance-reduction-in-monte-carlo-tree-search) · [PDF](https://webdocs.cs.ualberta.ca/~bowling/papers/11nips-vrmcts.pdf)
- Lanctot, Winands, Pepels & Sturtevant, *MCTS with Heuristic Evaluations using Implicit Minimax Backups* — [arXiv:1406.0486](https://arxiv.org/abs/1406.0486)
- Schadd & Winands, *Best-Reply Search for Multi-Player Games*, IEEE TCIAIG 2011 — [PDF](https://dke.maastrichtuniversity.nl/m.winands/documents/BestReplySearch.pdf)
- Esser, Gras, Winands, Lanctot & Schadd, *Improving Best-Reply Search*, CG 2013 — [PDF](https://mlanctot.info/files/papers/cg13-brsplus.pdf)
- Nijssen & Winands, *An Overview of Search Techniques in Multi-Player Games* — [PDF](https://dke.maastrichtuniversity.nl/pim.nijssen/pub/cgw.pdf)
- Sturtevant, *An Analysis of UCT in Multi-player Games*, CG 2008 — [PDF](https://webdocs.cs.ualberta.ca/~nathanst/papers/mpuct_icga.pdf)
- Sturtevant, Zinkevich & Bowling, *Prob-maxn: Playing N-Player Games with Opponent Models*, AAAI 2006 — [PDF](https://webdocs.cs.ualberta.ca/~nathanst/papers/probmaxn.pdf)
- Zuckerman, Felner & Kraus, *Mixing Search Strategies for Multi-Player Games* (MP-Mix), IJCAI 2009 — [entry](https://mlanthology.org/ijcai/2009/zuckerman2009ijcai-mixing/)
- Lustrek, Gams & Bratko, *Is real-valued minimax pathological?*, AIJ 2006 — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0004370206000117)
- *An Analysis of Decision Quality of Minimaxing vs. Product Propagation*, IEEE SMC 2009 — [PDF](http://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/IEEE_SMC_2009/PDFs/877.pdf)
- *Learning Position Evaluation Functions Used in Monte Carlo Softmax Search* — [arXiv:1901.10706](https://arxiv.org/abs/1901.10706)
- Long, Sturtevant, Buro & Furtak, *Understanding the Success of Perfect Information Monte Carlo Sampling in Game Tree Search*, AAAI 2010 — [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/7562)
- Cowling, Powley & Whitehouse, *Information Set Monte Carlo Tree Search*, IEEE TCIAIG 2012 — [IEEE](https://ieeexplore.ieee.org/document/6203567)
- Szita, Chaslot & Spronck, *Monte-Carlo Tree Search in Settlers of Catan*, ACG 2009 — [Springer](https://link.springer.com/chapter/10.1007/978-3-642-12993-3_3)
- Dobre & Lascarides, *Online learning and mining human play in complex games* — [PDF](https://www.pure.ed.ac.uk/ws/files/19909731/Dobre_Lascarides_Online_Learning_and_mining_human_play_in_complex_games.pdf) · code: [sorinMD/MCTS](https://github.com/sorinMD/MCTS)
- *Agents of Change: Self-Evolving LLM Agents for Strategic Planning* — [arXiv:2506.04651](https://arxiv.org/abs/2506.04651) · HexMachina — [OpenReview](https://openreview.net/forum?id=V0Fb4pwhS4)
- Burch, Schmid, Moravcik, Morrill & Bowling, *AIVAT*, AAAI 2018 — [arXiv:1612.06915](https://arxiv.org/abs/1612.06915)
- Deng, Xu, Kohavi & Walker, *Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data* (CUPED), WSDM 2013 — [PDF](https://www.researchgate.net/publication/237838291_Improving_the_Sensitivity_of_Online_Controlled_Experiments_by_Utilizing_Pre-Experiment_Data)
- Fishtest mathematics (GSPRT, pentanomial) — [Stockfish docs](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html)
- van den Bergh, *Comments on normalized Elo* — [PDF](https://cantate.be/Fishtest/normalized_elo_practical.pdf)
- SPRT in engine testing — [Chess Programming Wiki](https://chessprogramming.org/Sequential_Probability_Ratio_Test)
