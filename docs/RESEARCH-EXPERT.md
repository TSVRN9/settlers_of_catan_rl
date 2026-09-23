# What AlphaZero actually did, what our loop actually is, and which training signals are left

Research note, 2026-09-21. Reading-only: nothing here was re-benchmarked and no training was
launched. Repo claims are cited `file:line`; literature claims carry a URL. Anything I could not
verify against a primary source is marked **UNVERIFIED**.

Companion reading: `docs/FINDINGS.md` (every measured number), `docs/BENCHMARK.md` (the tournament
protocol and the final standings).

---

## 0. The headline, before anything else

**Our loop is not AlphaZero expert iteration. It is DAgger with an AlphaBeta oracle.**

The states are ours; the labels are AlphaBeta's, permanently.

- States come from the current net: `scripts/run_exit.sh:43` generates every iteration with
  `--lineup "$V,$V,rab,rab"` — two incumbent value-net seats, two Rust-AlphaBeta seats.
- Labels come from AlphaBeta: the rollout that produces a training target plays **every seat** with
  `decide_rollout` (`catan_engine/src/arena.rs:70-79`), and `decide_rollout` is the hand heuristic
  `base_fn` under depth-2 expectimax, depth 1 on robber prompts
  (`catan_engine/src/heuristic.rs:158-167`). That is the `--roll-depth 2` default
  (`gen_games.py:204`) and the loop never overrides it; the depth-1 variant was tried and rejected
  at 46.8% (`docs/FINDINGS.md:2266`). So `ro_v` is defined in the code comment as
  "fraction of `roll_m` rab-vs-rab rollouts from that child the decider won"
  (`catan_engine/src/arena.rs:59`).
- Nothing in the *active* loss touches the net's own evaluations. `scripts/run_exit.sh:46` passes
  `--rank-weight 0 --sib-weight 0 --self-sibs 0 --ts-key ro --ts-weight "$TS_WEIGHT"`, and
  `scripts/run_exit.sh:19` defaults `WIN_WEIGHT=0 AUX_WEIGHT=0 TS_WEIGHT=3`. The only surviving term
  is `tree_loss` — `BCE(net(ro_x), ro_v)` — at `train_value.py:134-139`. `--ts-p` is never passed by
  the loop, so the net's own search values (`ts_x`/`ts_v`) are not even generated.

That is exactly Ross, Gordon & Bagnell's DAgger: roll out the *learner's* policy to collect states,
label them with the *expert*, aggregate, refit
([arXiv:1011.0686](https://arxiv.org/abs/1011.0686)). DAgger's guarantee is that you match the
expert on your own state distribution. It contains no mechanism for exceeding the expert.

This predicts the observed plateau precisely. `docs/FINDINGS.md:2385` already says it in one
sentence — "rollout labels are AlphaBeta-continuation values, which cap what the net can learn
about its own (now stronger) play" — and the measurements agree: the student passed the oracle
(v40 is 55.2% [52.1, 58.3] vs 3x Python AlphaBeta, `docs/FINDINGS.md:2368`), and the moment it did,
the line went flat (56-60% vs `rab` since round 36, `docs/FINDINGS.md:2385`).

One nuance so this is not overclaimed: depth-2 expectimax over the net **is** a genuine policy
improvement operator *at play time* — that is why the searched player beats the raw net, measured
at ~4 points (`docs/FINDINGS.md:2110-2112`, depth 1 27.0% vs depth 2 30.7%). What is missing is any
**training target derived from it**. And the repo has already measured why the obvious version of
that fails: regressing on the net's own backed-up search values cost 7 points
(`docs/FINDINGS.md:2105`, v26ts 23.3% vs incumbent 30.3%), because at depth 2 the search is barely
stronger than the evaluator, so its values are "the net's own biases plus noise"
(`docs/FINDINGS.md:2110-2113`). In AlphaZero the search is 1,600 simulations deep and the gap
between searched and raw policy is enormous; ours is two plies.

Everything below is detail on that one sentence.

---

## A. How AlphaZero and relatives actually chose their architectures

### A.1 AlphaGo Zero: the concrete numbers, from the paper

Silver et al., "Mastering the game of Go without human knowledge", *Nature* 550, 354-359 (2017).
Text verified from the author manuscript at
[discovery.ucl.ac.uk/id/eprint/10045895](https://discovery.ucl.ac.uk/id/eprint/10045895/1/agz_unformatted_nature.pdf).

Input: "a 19 × 19 × 17 image stack comprising 17 binary feature planes" — 8 planes for the current
player's stones over the last 8 positions, 8 for the opponent's, and one constant plane "1 if black
is to play or 0 if white is to play". Tower: one 3×3 convolution of 256 filters, then residual
blocks each of `conv 256 3×3 → BN → ReLU → conv 256 3×3 → BN → skip → ReLU`. Policy head: `conv 2
1×1 → BN → ReLU → FC to 362 logits`. Value head: `conv 1 1×1 → BN → ReLU → FC 256 → ReLU → FC 1 →
tanh`. Depth: "39 or 79 parameterised layers respectively for the residual tower, plus an additional
2 layers for the policy head and 3 layers for the value head" (20- and 40-block versions).
Self-play used 1,600 MCTS simulations per move (~0.4 s), 4.9 million games, 700,000 mini-batches of
2,048 positions.

### A.2 There was an ablation, and it is the answer to "handspun"

The paper's Figure 4 is a 2×2: `{dual, sep} × {res, conv}`, where `dual-res` is AlphaGo Zero and
`sep-conv` is AlphaGo Lee. All four were trained on one fixed dataset (the final 2 million self-play
games of a previous AlphaGo Zero run) and then each was dropped into AlphaGo Zero's search and rated
head-to-head at 5 s/move. The paper's text:

> "Using a residual network was more accurate, achieved lower error, and improved performance in
> AlphaGo by over 600 Elo. Combining policy and value together into a single network slightly
> reduced the move prediction accuracy, but reduced the value error and boosted playing performance
> in AlphaGo by around another 600 Elo."

The paper also gives the *reason*, which is the part usually dropped when this is retold: "This is
partly due to improved computational efficiency, but more importantly the dual objective
regularises the network to a common representation that supports multiple use cases." That is an
auxiliary-task argument, and it is the through-line to KataGo (§A.5) and to §C.

So: **+600 Elo for the residual tower, +600 Elo for the dual head**, each measured, not asserted.
The per-bar Elo values are not printed anywhere in the text — Fig. 4a is an unlabelled bar chart.
Reading the bars off the axis gives roughly dual-res ~4,300, sep-res ~3,750, dual-conv ~3,730,
sep-conv ~3,100; **UNVERIFIED**, treat only the two ~600 figures as quotable. (Fig. 4b/4c also show
`sep-res` slightly *better* on human-move prediction while `dual-res` has the lowest value MSE — the
dual head trades a little policy accuracy for a lot of value accuracy.)

### A.3 What was hand-chosen, and what was Bayesian-optimised

The paper answers this directly, in one sentence of Methods (author manuscript, "Self-Play Training
Pipeline"):

> "The neural network architecture (see Neural Network Architecture) is based on the current state
> of the art in image recognition, and hyperparameters for training were chosen accordingly (see
> Self-Play Training Pipeline). **MCTS search parameters were selected by Gaussian process
> optimisation**, so as to optimise self-play performance of AlphaGo Zero using a neural network
> trained in a preliminary run. For the larger run (40 block, 40 days), MCTS search parameters were
> re-optimised using the neural network trained in the smaller run (20 block, 3 days)."

So the split is explicit and stated by the authors: **network architecture and training
hyperparameters — adopted from image recognition, by hand. Search hyperparameters — machine-tuned
by GP/Bayesian optimisation.** There is no architecture search anywhere. (AlphaZero's paper
restates it: "AlphaGo Zero tuned the hyper-parameter of its search by Bayesian optimisation",
[arXiv:1712.01815](https://arxiv.org/abs/1712.01815).)

The dedicated account is Chen et al., "Bayesian Optimization in AlphaGo"
([arXiv:1812.06855](https://arxiv.org/abs/1812.06855)), verified from the PDF:

> "During the development of AlphaGo, its many hyper-parameters were tuned with Bayesian
> optimization multiple times. […] Prior to the match with Lee Sedol, we tuned the latest AlphaGo
> agent and this improved its win-rate from 50% to 66.5% in self-play games."

What was tuned: "the MCTS hyper-parameters, including the ones governing the UCT exploration
formula, node-expansion thresholds, several hyper-parameters associated with the distributed
implementation of MCTS, and the hyper-parameters of the formula for choosing between fast roll-outs
and value network evaluation per move", plus the policy/value softmax temperatures and the per-move
time-control formula; 3 to 10 parameters per task. The network was explicitly *not* a target: "We
focused on tuning the hyper-parameters associated with game playing. We did so because we had
reasonably robust strategies for tuning the neural networks."

Per-task numbers from the body (worth knowing, because the abstract's headline is easy to
misattribute): MCTS tuning moved self-play win-rate from 50% to **63.2% and 64.4%** across two
design iterations before the Lee Sedol match ("94 and 103 Elo gains"), and the **66.5%** in the
abstract is, in §3.5, the *time-control* task ("an improvement of a 66.5% win-rate against the
default time setting with a fixed 30-second search time per move"). Tuning the fast data-generation
players was worth "300, 285, 145 and 129" Elo on four versions. They first tried grid search and
gave up on cost: "using 400 GPUs, it took approximately 6.7 hours to estimate the win-rate p(θ) for
a single hyper-parameter value."

Two things worth carrying:

- "the automatically found hyper-parameter values were very different from the default values found
  by previous hand tuning efforts. Moreover, the hyper-parameters were often correlated, and hence
  the values found by Bayesian optimization were not reachable with element-wise hand-tuning."
- The BO run is what killed rollouts: "By tuning the mixing ratio between roll-out estimates and
  value network estimates, we found out that Bayesian optimization gave increased preference to
  value network estimates as the design cycle progressed. This eventual led the team to abandon
  roll-out estimates in future versions of AlphaGo and AlphaGo Zero."

That last quote is directly relevant to us: **their tuner chose the learned evaluator over measured
rollouts, and we currently do the opposite** (see §C).

### A.4 Verdict on "handspun"

Your professor is half right, and the half he is right about is the less interesting half.

- **Right:** the network topology was hand-designed from off-the-shelf parts. No NAS, no learned
  architecture, no per-game tuning of the net. The number of blocks (20/40), filters (256), planes
  (17), head shapes are engineering judgement.
- **Wrong about the implication:** "handspun" usually insinuates "arbitrary and fragile". The
  evidence runs the other way. (i) The two load-bearing choices were ablated head-to-head at ~600
  Elo each (§A.2). (ii) AlphaZero then reused one recipe unchanged across chess, shogi and Go — a
  robustness result no hand-tuned system would survive. (iii) Where DeepMind *did* find hand-tuning
  inadequate, they said so and replaced it with BO, and reported that hand-tuning had been reaching
  unreachable-by-hand optima (§A.3).

The honest summary: **architecture handspun and ablated; search hyperparameters machine-tuned;
training targets principled rather than tuned at all.** For this project the transferable lesson is
the third one — AlphaZero's leverage came from *what it regressed on*, not from the shape of the
net. Our own evidence says the same thing: a wider net from scratch scored 30.8-40.4% against an
incumbent at 51% while posting the best held-out loss ever recorded here
(`docs/FINDINGS.md:2277-2278`), and hidden 256 already matched 512 at equal loss for a third the
cost per leaf (`train_value.py:175`).

### A.5 AlphaZero, MuZero and later work

**AlphaZero** ([arXiv:1712.01815](https://arxiv.org/abs/1712.01815), *Science* 362, 1140-1144, 2018)
changed four things and kept everything else:

- Value target: "AlphaGo Zero estimates and optimises the probability of winning, assuming binary
  win/loss outcomes. AlphaZero instead estimates and optimises the expected outcome, taking account
  of draws."
- No data augmentation: "AlphaZero does not augment the training data and does not transform the
  board position during MCTS" (AGZ used the 8 board symmetries).
- No gating: AGZ promoted a challenger only at a 55% margin; "AlphaZero simply maintains a single
  neural network that is updated continually", "omitting the evaluation step and the selection of
  best player". **This matters for us** — our `run_exit.sh:49-55` gate is the AGZ design, not the
  AlphaZero one, and given `docs/FINDINGS.md:2270` (the loss does not track play) that is the right
  choice here.
- Hyperparameters reused unchanged: "we reuse the same hyper-parameters for all games without
  game-specific tuning. The sole exception is the noise that is added to the prior policy […]
  scaled in proportion to the typical number of legal moves" (Dirichlet α = 0.3 chess / 0.15 shogi
  / 0.03 Go). 800 simulations, lr 0.2 annealed three times, 700k steps of batch 4,096, for all
  three games.

Dirichlet noise and the absence of rollouts were both already in AGZ; only the α scale is new.

**MuZero** ([arXiv:1911.08265](https://arxiv.org/abs/1911.08265), *Nature* 588, 604-609, 2020)
learns a model: representation `h`, dynamics `g`, prediction `f`. Board-game trunk is "the same
convolutional and residual architecture as AlphaZero, but with 16 residual blocks instead of 20".
Targets: policy ← MCTS visit counts, value ← n-step return, reward ← observed reward, unrolled
K = 5 steps. The value bootstrap is
`z_t = u_{t+1} + γu_{t+2} + … + γ^{n-1}u_{t+n} + γ^n ν_{t+n}` where `ν` is **the MCTS search value**
— "For board games, we bootstrap directly to the end of the game […] for Atari we bootstrap for
n = 10 steps". Value and reward use a **categorical 601-bin support with the invertible transform**
`h(x) = sign(x)(√(|x|+1) − 1 + εx)`, ε = 0.001, from Pohlen et al.
([arXiv:1805.11593](https://arxiv.org/abs/1805.11593)) — but **for Atari only**; a footnote says
chess, Go and shogi keep "the same squared error loss as AlphaZero", since the categorical head is
there for reward-scale robustness, not for bounded outcome labels. Do not cite MuZero as precedent
for a categorical *win-probability* head.
*Reanalyse* re-runs search on old trajectories with current weights and uses the fresh policy as the
target for 80% of updates. The stated design philosophy is the same as AGZ's: "we started with the
network architecture and search choices of AlphaZero"; "For simplicity we preferentially use the
same architectural choices and hyperparameters as in previous work."

**KataGo** ([arXiv:1902.10565](https://arxiv.org/abs/1902.10565)) is the single most relevant paper
to §C. It claims ~50× less compute than ELF OpenGo, and its Table 2 gives the "factor increase in
training time to reach the same Elo" if each component is removed:

| Component | Factor if removed |
|---|---|
| Ownership + score targets | **1.65×** |
| Global pooling | 1.60× |
| Go-specific features | 1.55× |
| Playout cap randomization | 1.37× |
| Auxiliary policy target (opponent's reply) | 1.30× |
| Forced playouts + policy target pruning | 1.25× |

Its full loss (Appendix B) carries nine terms: game outcome (weight 1.5), policy, **opponent-policy
(0.15)**, **ownership (1.5/b²)**, **score-belief pdf (0.02)** and **cdf (0.02)**, score-mean and
score-stdev self-prediction (Huber, 0.004 each), and a score-scaling penalty (0.0005). Two readings
for us: (i) the auxiliary targets are the *largest* single ablation factor, and (ii) every one of
them is an **externally observable quantity of the played game**, not a function of the net's own
beliefs — the same pattern our own measurements found (§C.2).

**Leela Chess Zero** (official docs, [lczero.org/dev/backend/nn](https://lczero.org/dev/backend/nn/))
is "largely based on DeepMind's AlphaGo Zero and AlphaZero architecture" with Squeeze-Excitation
blocks, 112 input planes, a 1858-move policy head, a **WDL (win/draw/loss) 3-way value head** ("All
networks starting from July 2019 have the so-called WDL head",
[lczero.org/blog/2020/04/wdl-head](https://lczero.org/blog/2020/04/wdl-head/)) and a **moves-left
head** (v0.25, Apr 2020). Transformer/attention bodies arrived around v0.30. The WDL head is the
clean precedent for replacing a scalar win probability with a categorical outcome head.

**EfficientZero** ([arXiv:2111.00210](https://arxiv.org/abs/2111.00210)) adds three things to
MuZero: a SimSiam-style self-supervised temporal-consistency loss, an end-to-end value-*prefix*
prediction (LSTM), and a model-based off-policy correction that shortens the bootstrap horizon and
re-roots it at a **fresh MCTS value**, `z_t = Σ γ^i u_{t+i} + γ^l ν^MCTS_{t+l}`. Atari 100k:
the abstract reports 194.3% mean / 109.0% median human-normalised; the results section reports
1.904 / 1.160 on 26 games (the two are stated inconsistently in the paper — flagging rather than
picking).

**Gumbel MuZero/AlphaZero** (Danihelka et al., ICLR 2022; text verified from Danihelka's UCL thesis
ch. 5, [discovery.ucl.ac.uk/10167022](https://discovery.ucl.ac.uk/id/eprint/10167022/2/ivo_danihelka_thesis.pdf))
replaces four AlphaZero mechanisms: Gumbel-Top-k sampling without replacement instead of Dirichlet
noise at the root; Sequential Halving instead of PUCT at the root; the played action is Sequential
Halving's winner instead of a visit-count sample; and **the policy target becomes a policy
improvement built from completed root Q-values instead of the visit distribution**, with a
guarantee of improvement "when action-values are correctly evaluated". The headline: "MuZero fails
to learn from 16 or fewer simulations. Strikingly, Gumbel MuZero learns reliably even with 2
simulations." **This is the most directly transferable idea in the whole survey for a depth-2
searcher** — see §C.4.

**Sampled MuZero** ([arXiv:2104.06303](https://arxiv.org/abs/2104.06303)) extends the same policy
iteration to "arbitrarily complex action spaces by planning over sampled actions", with the
improved policy corrected by the sampling ratio β̂/β. Relevant in principle to Catan's ~250-action
lists; we already sample ≤6 children (`arena.rs:98`) without the correction.

**AlphaStar** (Vinyals et al., *Nature* 575, 350-354, 2019;
[DeepMind PDF](https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf))
is the counter-example: **no search at all** — "a model free, end-to-end learning approach […] which
sidesteps the difficulties of search-based methods due to imperfect models". Self-attention over
units, scatter connections, a deep LSTM, an auto-regressive policy and a pointer network. It was
*initialised by supervised learning on human replays*, then trained with TD(λ)/V-trace/UPGO under a
KL penalty toward the supervised policy, then league play (~900 players, 44 days). Its Fig. 3F is
another hand-designed-then-ablated architecture: baseline 0% → +action delays 7% → +pointer network
36% → +transformer 71% → +scatter connections 87% win rate vs the Elite bot.

**Imperfect information / multiplayer.** ReBeL ([arXiv:2007.13544](https://arxiv.org/abs/2007.13544))
searches over *public belief states* with CFR and "provably converges to a Nash equilibrium in any
two-player zero-sum game"; in perfect-information games it reduces to something AlphaZero-like.
Student of Games ([arXiv:2112.03178](https://arxiv.org/abs/2112.03178), *Science Advances* 2023)
unifies the two with growing-tree CFR and a counterfactual value-and-policy network, strong in
chess, Go, poker and Scotland Yard. Both are explicit that their guarantees are **two-player
zero-sum only**. Pluribus (Brown & Sandholm, *Science* 365, 885-890, 2019) is the 6-player result
and it has **no neural network at all** — a Monte-Carlo-CFR blueprint (12,400 core-hours, ~$144)
plus real-time depth-limited search over blueprint continuations — and its authors state plainly
that the algorithms "are not guaranteed to converge to a Nash equilibrium outside of two-player
zero-sum games"; the goal is "to create an AI that empirically consistently defeats human
opponents". DeepNash ([arXiv:2206.15378](https://arxiv.org/abs/2206.15378), *Science* 2022) reaches
top-3 human Stratego with R-NaD, model-free and **without search**, because "searching for a Nash
equilibrium in imperfect information games requires estimating private information of the opponent
from public states".

**Why that last paragraph matters here.** Catan is 4-player, stochastic and imperfect-information.
There is no equilibrium guarantee to chase, and the published precedent for our setting (Pluribus)
is explicitly *empirical*: beat the opponents you are given, and do not pretend the solution concept
is Nash. Our gate — "win more games vs 3x `rab` on fresh seeds" — is the right shape of objective
for this class of game, and the literature does not offer a better-founded one.

---

## B. Expert iteration: theirs, and ours

### B.1 AlphaZero's loop, stated precisely

1. **The expert** is PUCT MCTS run on the current network: the net supplies priors `p` and leaf
   values `v`, the tree does the improving. No rollouts (AlphaGo Zero: "AlphaGo Zero does not use
   any rollouts; it uses a single neural network instead of separate policy and value networks",
   author manuscript line 660), no hand heuristic anywhere in the system.
2. **The policy target** is the MCTS visit distribution `π ∝ N(s,a)^(1/τ)` — a full distribution
   over legal moves, produced by 1,600 simulations, i.e. hundreds of bits per state rather than one.
3. **The value target** is the final game outcome `z ∈ {-1, 0, +1}` from that state's perspective.
4. **Training** is one loss `(z-v)² - πᵀ log p + c‖θ‖²` on positions sampled from a replay buffer of
   recent self-play.
5. **The improvement argument**: search is a policy improvement operator over the net's own policy,
   and regressing the net onto the searched distribution is the projection step. The net gets
   better, so the search that uses it gets better, so next round's targets get better. That is the
   ratchet.

### B.2 Ours, from the code

Per iteration `k` (`scripts/run_exit.sh:36-59`):

| Stage | What happens | Where |
|---|---|---|
| Generate | 4,000 games, 2 incumbent `vnet` seats + 2 `rab` seats | `run_exit.sh:43` |
| Label | at a sampled decision of **any** seat, up to 6 deterministic children; each played out `roll_m` times with **AlphaBeta in all four seats**; target = decider's win fraction | `arena.rs:87-114`, `heuristic.rs:158-167` |
| Train | 5 seeds, warm-started from the incumbent, **only** `BCE(net(ro_x), ro_v)` at weight 3 | `run_exit.sh:45-47`, `train_value.py:134-139` |
| Combine | greedy weight soup, seeded with the incumbent, selected by 1,000 arena games | `soup.py:27-59`, `run_exit.sh:48` |
| Accept | challenger and incumbent each play 4,000 fresh-seed games vs 3x `rab`; challenger must win more | `run_exit.sh:49-55` |

The player itself: `ValueNetPlayer` subclasses catanatron's `AlphaBetaPlayer`, keeps its depth-2
expectimax, and replaces only the leaf evaluator (`value_net.py:281-341`). Leaf values are
probabilities, not logits, because the search averages over chance nodes (`value_net.py:283-287`).
The net is a 3×256 MLP with dropout 0.3, the 206 raw tile/port one-hots zeroed at the input
(`value_net.py:54-57`), the smooth-heuristic prior disabled (`PRIOR_SCALE = 0.0`,
`value_net.py:135`), and five auxiliary heads present but untrained in the winning recipe
(`value_net.py:91`, `AUX_WEIGHT=0` at `run_exit.sh:19`).

### B.3 Who is the expert, at each stage — the direct answer

**No. AlphaBeta is not only the bootstrap. It is the label oracle in every iteration, including the
current one.**

- Gen-0 was AlphaBeta *games* labelled by *outcomes* (`--lineup ab,ab,ab,ab`,
  `docs/FINDINGS.md:1573`). That era ended.
- Since round 28 the outcome label is gone (`WIN_WEIGHT=0`) and the only target is an AlphaBeta
  rollout value. The net's contribution to training is **state selection only** — which positions
  get labelled — plus the play-selected weight averaging in `soup.py`.
- The one place the net's own strength enters the weights is the greedy soup, and
  `docs/FINDINGS.md:2270-2271` states this outright: "from v30 on, descending the loss […] makes the
  player worse; v30's strength came from play-selected weight averaging, not from the loss."

So the correct label for the current loop is: *DAgger on the learner's state distribution with a
fixed heuristic-search oracle, plus a hill-climbing outer loop (soup + fresh-seed gate) that is the
only genuinely improving operator in the system.*

### B.4 How good is that expert, and what does 55% mean?

The expert is `rab` — depth-2 expectimax over `base_fn`. Its measured strength:

| Agent | Measure | Source |
|---|---|---|
| `AlphaBetaPlayer` in seat BLUE vs 3x AB | 26.3% [21.7, 31.6] (symmetry = 25%) | `docs/FINDINGS.md:1596` |
| `ValueFunctionPlayer` (same `base_fn`, 1-ply) vs 3x AB | 10% | `docs/FINDINGS.md:1455` |
| v40 vs 3x Python AlphaBeta, 1,000 games | **55.2% [52.1, 58.3]** | `docs/FINDINGS.md:2368` |
| v40 vs 3 stock jSettlers, 100 games | 45.0% [35.6, 54.8] | `docs/BENCHMARK.md:409` |
| `rab` vs 3 stock jSettlers, 100 games | 29.0% [21.0, 38.5] | `docs/BENCHMARK.md:412` |

Read the gap this way: 55.2% for one seat against three copies of the oracle is roughly a
2.2× over-representation relative to the 25% symmetry point. The student is decisively stronger than
the teacher whose continuation values it is still being trained on. In DAgger terms we are past the
regime where the guarantee says anything useful — matching the oracle on our own state distribution
is now a *downgrade* on the states where we already outplay it.

Is there a provable improvement operator, as in AlphaZero? **No.**

- The training step has no improvement guarantee: it is regression onto a fixed, weaker policy's
  continuation values.
- The play-time search is a real improvement operator (~4 points, §0) but feeds nothing back.
- The only thing driving the line upward since round 30 is `soup.py --greedy --base` plus the
  accept-only-if-better gate — i.e. **(1+λ)-evolution-strategy hill climbing in weight space,
  scored by games**. That is why the loop is monotone but slow and why it stalls: it improves only
  as fast as random draws from a warm start happen to land better, and each accept is worth ~1-2
  points against ±1.4-pt gate noise (`run_exit.sh:8`) plus ~1.5 pt of XPU non-determinism beyond
  binomial (`docs/FINDINGS.md:2353`).

Where it plateaus: 56-60% vs `rab` since round 36 (`docs/FINDINGS.md:2385`); rounds 38, 39, 41, 42,
43, 44, 45 all rejected at parity.

### B.5 The five structural differences, ranked by how much they explain the plateau

1. **Target provenance.** AlphaZero's targets come from a search over the *current* net, so they
   improve every round. Ours come from a search over a *fixed* hand heuristic, so they do not.
   *This is the plateau.*
2. **Target richness.** A visit distribution over ~250 legal moves versus one scalar per child from
   `roll_m = 1` Bernoulli playout (`run_exit.sh:19`). See §C.
3. **No policy head at all.** We have no priors, so the search cannot be narrowed or deepened
   cheaply; depth is capped by branching (`docs/FINDINGS.md:2050`, depth 3 p95 = 160k leaves).
4. **Search strength.** 1,600 simulations versus 2 plies. AlphaZero's raw net was 3,055 Elo and its
   searched player 5,185 — a colossal gap to distil. Ours is ~4 points.
5. **Selection signal.** AlphaZero trusts the loss. We cannot (`docs/FINDINGS.md:2270`), so every
   decision costs arena games. That makes each experiment ~27 min rather than free.

---

## C. Training signals beyond a binary label

### C.1 What our labels actually are, precisely

Three families exist in the code; **only the third is switched on**.

1. **Outcome** (`gen_games.py:145-155`, `arena.py:39-46`): `y` = did this perspective win (1 bit per
   game, shared by ~150 correlated states), plus `vp` (final VPs of all four seats, perspective
   order) and `turns_left`, fed to five auxiliary heads. **Disabled**: `WIN_WEIGHT=0 AUX_WEIGHT=0`.
2. **Imitation of AlphaBeta** — `rank_c`/`rank_o` pairwise (`train_value.py:158-161`) and `sib_x`/
   `sib_v` listwise top-1 (`train_value.py:116-123`). **Disabled**: `--rank-weight 0 --sib-weight 0`.
   Note they are still *generated* every round (`--rank-p 0.5 --sib-p 0.3`, `run_exit.sh:43`) and
   written to disk unused — free disk and CPU to reclaim.
3. **Rollout values** (`arena.rs:87-114`): at a sampled decision, up to `K_SIB = 6` deterministic
   children, each labelled with the decider's win fraction over `roll_m` full AlphaBeta-vs-AlphaBeta
   playouts. **This is the entire training signal.**

Two properties of (3) matter and are easy to miss:

- `ROLL_M=1` by default (`run_exit.sh:19`), so **each label is a single Bernoulli draw: a raw 0 or
  1.** The target is binary, per child, with variance 0.25 at p=0.5. It is *not* an averaged win
  probability. `roll_m > 1` appears never to have been measured — the "rollout 3 / rollout 10" rows
  in the ablation table at `docs/FINDINGS.md:2330-2336` are `--ts-weight` values
  (`run_exit.sh:19` `TS_WEIGHT=3`), not rollout counts. Do not read that table as a variance result.
- The loss is BCE against that 0/1 (`train_value.py:139`), so the net is regressing to the
  *conditional expectation* of an AlphaBeta continuation — the right quantity, estimated with one
  sample.

### C.2 What is already measured here — do not redo these

| Signal | Result | Source |
|---|---|---|
| Outcome BCE (game outcome) | **Actively harmful**: full recipe 30.1% vs no-outcome 51.1% vs rollout-only 53.0% | `FINDINGS.md:2330-2336` |
| Auxiliary heads (final VPs, turns left), *on top of* rollout values | ~-2 pts (no-outcome+aux 51.1% vs rollout-only 53.0%) — **one draw each, inside the proxy's ~1.5-pt noise floor.** Aux was dropped alongside the outcome loss, never independently ablated: **treat as untested, not refuted** | `FINDINGS.md:2330-2336`, `:2353` |
| `base_fn` pairwise + listwise imitation | Got v0→v5 off the floor, then caps at AlphaBeta; dropped at v27d | `FINDINGS.md:2377-2381` |
| Hard argmax labels from the net's own search (v9) | -7 pts | `FINDINGS.md:2110` |
| **Soft** chance-averaged values from the net's own search (v26ts, TreeStrap-lite) | **-7 pts** | `FINDINGS.md:2105` |
| Hard pairwise ranking between rollout-labelled siblings | 23.6-43.9% vs incumbent 51.5% | `FINDINGS.md:2282-2285` |
| Label density: `roll_p` 0.1 → 0.3 (3× rows/game) | draws 35-43% → 40.7-51.4%; accepted as v31 | `FINDINGS.md:2264, 2280` |
| More distinct games from older generators (84k vs 16k) | -1.7 pts (off-policy) | `FINDINGS.md:2106` |
| Wider net (512) from scratch, best held-out loss ever | 30.8-40.4% vs ~51% incumbent | `FINDINGS.md:2277` |
| Deeper search at play time (depth 3, own-turn variants) | all below depth 2 | `FINDINGS.md:2050` |

The pattern is unusually clear and worth stating: **every target that is a function of the net's own
current beliefs has failed here, and every target that is an externally measured quantity has
worked.** That is the opposite of AlphaZero's experience, and §B.5 line 4 is why — their search
knows far more than their net; ours barely knows more than ours.

### C.3 Literature on richer signals

**Bootstrapping from search — and the precise condition under which it works.** Veness, Silver,
Uther & Blair, "Bootstrapping from Game Tree Search", NIPS 2009
([PDF](https://proceedings.neurips.cc/paper/2009/file/389bc7bb1e1c2a5e7e147703232a88f6-Paper.pdf)).
TD-Leaf (Baxter et al., KnightCap) regresses the *root* evaluation toward the *next timestep's*
search value — one node, one step. RootStrap regresses the root toward *this* search's value.
TreeStrap regresses **every node in the search tree** toward that same search's backed-up value.
Self-play from random weights, chess program Meep, ratings relative to an untrained reference:

| Algorithm | Elo |
|---|---|
| TreeStrap(αβ) | **2157 ± 31** |
| TreeStrap(minimax) | 1807 ± 32 |
| RootStrap(αβ) | 1362 ± 59 |
| TD-Leaf | 1068 ± 36 |
| Untrained | 250 ± 63 |

TreeStrap beat TD-Leaf by ~1,100 Elo. **This looks like it contradicts our v26ts result (-7 pts,
`docs/FINDINGS.md:2105`) and it does not.** Meep's heuristic is *linear* and its search is a deep
alpha-beta — the search knows enormously more than the evaluator, so its values are real
information. Ours is a 3×256 MLP under a 2-ply search worth ~4 points
(`docs/FINDINGS.md:2110-2112`). `docs/FINDINGS.md:2113` states the condition exactly —
"Bootstrapped targets (TD-leaf / TreeStrap) need a search that is genuinely stronger than the
evaluator; ours is not" — and TreeStrap's own results are the strongest available evidence *for*
that reading. The actionable corollary: **TreeStrap does not become viable by tuning the loss; it
becomes viable when the label-side search gets stronger** (shortlist #1).

**TD-Gammon** (Tesauro, 1994/1995) is the historical counterweight: TD(λ) on raw self-play with no
expert data reached world-class backgammon, after Neurogammon — supervised on expert games — had
been merely strong. I did not re-verify Tesauro's numbers from a primary source in this pass;
treat specific figures as **UNVERIFIED**.

**Auxiliary targets: KataGo is the direct evidence.** §A.5 has the table; the headline is that
removing ownership + score targets costs a **1.65×** slowdown to reach the same Elo — the largest
single factor measured — and removing the auxiliary *opponent-reply policy* target costs 1.30×.
AlphaGo Zero's own Figure 4 makes the same argument in miniature: the dual head is worth ~600 Elo
because "the dual objective regularises the network to a common representation" (§A.2). Note what
all of these have in common: **every auxiliary target is an observable property of the played
game** (who owns which point, the final score, the move the opponent actually made) — never a
function of the net's current beliefs.

KataGo's stated rationale is worth quoting in full, because it is the argument for everything in
this section and it is our situation almost word for word:

> "although the game outcome is noisy and binary, it is a direct function of finer variables […]
> Decomposing the game result into these finer variables and predicting them as well should improve
> regularization" — and "enriching the training data with additional targets is valuable when data
> is limited or expensive".

Later KataGo versions (maintainer docs, not the paper —
[KataGoMethods.md](https://github.com/lightvector/KataGo/blob/master/docs/KataGoMethods.md), author
claims, **not peer-reviewed**) add short-term value/score heads regressing exponentially-averaged
future MCTS values at ~6/16/50-turn horizons, short-term error prediction with dynamic cPUCT
("about 75 Elo"), and a softened policy target `policy^(1/4)` plus an "optimistic policy" (40-90
Elo).

**The AlphaGo 2016 value-net overfitting result is the closest published twin of our iteration-0
failure.** Silver et al., *Nature* 529
([PDF](https://storage.googleapis.com/deepmind-media/alphago/AlphaGoNaturePaper.pdf)): a value net
trained on complete KGS games — correlated positions sharing one outcome — reached test MSE 0.37
against train 0.19; retrained on 30 million positions sampled **one per self-play game** it reached
0.226 train / 0.234 test. We rediscovered this at `docs/FINDINGS.md:1549-1578` ("all ~150 samples
from a game share that map and its outcome, so 'this map → this winner' is the cheapest fit"). We
fixed it differently from AlphaGo: static-feature masking + dropout + early stopping
(`docs/FINDINGS.md:1567-1578`, `value_net.py:54-57`), not one-sample-per-game. `train_value.py:196-199`
additionally holds out **by game**, which makes the held-out number honest but does nothing about
correlated *training* samples. Sampling one state per game is the untried third option, and
AlphaGo's numbers say it is the one that worked there.

**Distributional / smoothed value targets.** Leela Chess Zero replaced its scalar value with a WDL
3-way softmax in 2019 and added a moves-left head in 2020 (§A.5). Ruoss et al. 2024 (below) found
128 bins with HL-Gauss label smoothing optimal, ablating 16-256, and measured the loss choice
directly on a 9M model: HL-Gauss 82.0 puzzle accuracy vs log-loss classification 80.6 vs L2
regression 80.8 — a real but modest ~1.5 pt effect. Farebrother et al., "Stop Regressing"
([arXiv:2403.03950](https://arxiv.org/abs/2403.03950)) argues categorical cross-entropy "improves
performance and scalability" across Atari, robotics and chess-without-search; abstract only,
numbers **UNVERIFIED**.

**Multi-player outcome attribution — Suphx is the closest published analogue to our situation.**
Li et al., "Suphx: Mastering Mahjong with Deep Reinforcement Learning"
([arXiv:2003.13590](https://arxiv.org/abs/2003.13590)), rated above 99.99% of ranked human players
on Tenhou. Their motivation for the *global reward predictor* is, word for word, our outcome-loss
finding:

> "Since multiple rounds in the same game share the same game reward, using game rewards as a
> feedback signal cannot differentiate well-played rounds and poorly-played rounds. Therefore, one
> should better measure the performance of each round separately."

Their fix was a GRU-based predictor Φ, trained on human game logs, that attributes the final
**rank-based** game reward to each round. Two things transfer: (i) the diagnosis is identical to
`docs/FINDINGS.md:2337-2339` ("one bit per game shared by ~150 correlated states […] pulls the
evaluator away from good play"), independently arrived at; (ii) the reward itself is **rank-based
across 4 players**, not binary win/loss — which is the shape our `vp` targets already have and our
loss currently throws away (`AUX_WEIGHT=0`). Their ablation (SL < RL-basic < RL-1 with global
reward prediction < RL-2 with oracle guiding) is reported only as a box plot, so the size of the
gain is **UNVERIFIED**.

**Vector-valued heads for >2 players.** Petosa & Balch, "Multiplayer AlphaZero"
([arXiv:1910.13012](https://arxiv.org/abs/1910.13012)) make the value head output one expected
utility per player and regress it against the game's score vector — the obvious generalisation,
demonstrated only on two 3-player toy games. Multi-Labelled Value Networks for Go
([arXiv:1705.10701](https://arxiv.org/abs/1705.10701)) is the same trick along a different axis
(win rate at several komi at once) and reports the multi-label program beating the value-net-only
version 67.6%.

**Search as a *policy improvement operator*, and where the improvement guarantee actually lives.**
Anthony, Tian & Barber, "Thinking Fast and Slow with Deep Learning and Tree Search"
([arXiv:1705.08439](https://arxiv.org/abs/1705.08439)) is the paper that named Expert Iteration:
"Planning new policies is performed by tree search, while a deep neural network generalises those
plans. Subsequently, tree search is improved by using the neural network policy to guide search,
increasing the strength of new plans." The loop closes *because the expert is built from the
student*. Ours is not (§0) — which is why it is DAgger and not ExIt.

Two ExIt results transfer directly. (i) **Soft targets beat hard ones**: imitating the MCTS visit
distribution beat imitating only the chosen move by "50 ± 13 Elo" at almost identical prediction
error — the same direction as our v9 one-hot failure (`docs/FINDINGS.md:2110`). (ii) **Search-based
policy iteration is empirically stable**: ExIt "shows no sign of instability: the policy improves
consistently each iteration and there is little variation in the performance between each training
run" (5 runs). That is the single most useful sentence for §D.

Grill et al., "Monte-Carlo tree search as regularized policy optimization"
([arXiv:2007.12509](https://arxiv.org/abs/2007.12509)) supplies the theory: AlphaZero's search
approximately solves `π̄ = argmax_y [qᵀy − λ_N·KL(π_θ, y)]`, and the visit distribution
approximately follows that objective's gradient. Using the exact `π̄` instead of visit counts
"reliably outperforms" the original. The operative word for us is **`q`** — the guarantee is about
action values, and it is only as good as they are.

Gumbel MuZero (§A.5) is the refinement that matters at our search budget: it replaces the
visit-count policy target with a policy improvement computed from **completed root Q-values**, with
a stated guarantee of improvement "when action-values are correctly evaluated", and learns reliably
"even with 2 simulations" where MuZero "fails to learn from 16 or fewer simulations". We have exact
depth-2 root action values at every decision on the Python path (`value_net.py:386-395` computes an
EV per root action); the Rust path currently returns only the argmax (`rs.backup`,
`value_net.py:339`), so harvesting them there needs `backup` to return the per-action EVs. The
caveat is the guarantee's precondition — our action values are not correctly evaluated, which is
precisely what v26ts measured.

**Ranking / pairwise losses.** We tried both shapes and both are in the repo's measured-and-rejected
list (§C.2). The relevant literature reading is that the successful uses (Tesauro's comparison
training, the Bonanza method in shogi) rank against a *stronger* signal, and the failures here
ranked against a single Bernoulli playout — `docs/FINDINGS.md:2284` names it exactly: "Binary
single-rollout labels turned into hard pairwise targets are noise sharpened into labels." That is
an argument for `roll_m > 1` before any ranking loss is retried, not against ranking losses.

**Catan-specific.** Two published targets are richer than ours, and both are worth knowing:

| Work | Target | Reported strength |
|---|---|---|
| Driss & Cazenave, "Deep Catan", EvoApplications 2022 ([PDF](https://www.lamsade.dauphine.fr/~cazenave/papers/DeepCatanEvo.pdf)) | ExIt with a value net trained on **MCTS root win-rates for all 4 players** (softmax over 4 outputs), plus a local value net | UCTNet beat UCT 240/400 (60%); ExIt iter-2 beat iter-1 231/400 (58%) |
| Gendre & Kaneko ([arXiv:2008.07079](https://arxiv.org/abs/2008.07079)) | Self-play vs past versions; reward = **±0.75 win/loss plus ±0.02 per VP of margin** | 56.5% vs jSettlers, 1v1, no trading, ~30,000 steps (~5 weeks) |
| Guhe & Lascarides, CIG 2014 ([PDF](https://homepages.inf.ed.ac.uk/alex/papers/cig2014_gs.pdf)) | Hand-designed heuristic on JSettlers | 43% vs 3 JSettlers over 10,000 games |
| Xenou, Chalkiadakis & Afantenos, EUMAS 2018 | DRRL over action-dependent features | Reproduced here: **5.0% [2.2, 11.2]** vs real jSettlers (`docs/BENCHMARK.md:418`) |
| Szita, Chaslot & Spronck, ACG 2009 | MCTS on a perfect-information variant | 27% at 1k sims / 49% at 10k vs 3 JSettlers (secondary source, **UNVERIFIED**) |
| Pfeiffer 2004 | Hierarchical RL, model trees | No published comparison to JSettlers (**UNVERIFIED**) |

Deep Catan's 4-player win-rate vector and Gendre's VP-margin shaping are the two concrete precedents
for shortlist item #3. Note also the scoreboard: v40 scores **45.0% [35.6, 54.8]** against three
real jSettlers and leads every agent in the final pool (`docs/BENCHMARK.md:404-418`). **There is no
published Catan result this project is behind.**

### C.4 What that leaves, for us specifically

Ranked by (evidence it helps) × (compatibility with the "externally measured only" pattern above).
Costs and measurement protocol for each are in §E.

1. **Raise the rollout policy above `base_fn`.** The one lever `docs/FINDINGS.md:2386` names and
   nobody has run. Make `decide_rollout` use the incumbent net (via `catan_engine::ValueNet`, which
   already exists for the trade policy, `value_net.py:224-237`) instead of `base_fn`. This converts
   the loop from DAgger-with-a-fixed-oracle into real policy iteration: the label source improves
   with the student, and the plateau's stated cause is removed. It is also the only change that
   makes the targets *stronger* than the current player rather than weaker.
2. **Average more playouts per child (`roll_m > 1`).** Never measured. Halves label variance at
   `roll_m = 4`. Cost-neutral A/B available: `roll_p 0.3 / roll_m 1` vs `roll_p 0.1 / roll_m 3` is
   the same playout budget, and isolates *variance* from *coverage*.
3. **Multi-player targets.** We already record `vp` for all four seats (`gen_games.py:151-153`) but
   train with `AUX_WEIGHT=0`. A rank or VP-margin target from rollouts (not from the game outcome —
   the outcome is what poisons things) is untested. Catan's 4-player structure makes "who wins" a
   4-way categorical; the binary head throws away the difference between losing at 9 VP and losing
   at 3.
4. **Categorical / distributional value head with label smoothing.** Ruoss et al. found 128 bins
   with HL-Gauss smoothing optimal for exactly our problem shape (regressing a search's value)
   (§C.3). With `roll_m = 1` Bernoulli labels the smoothing story is different, but the
   *distributional* framing is cheap to test and orthogonal to everything above.

---

## D. "RL is very noisy and barely works; more supervised examples is better"

### D.1 Where the claim is right

The reproducibility literature is unambiguous and the numbers are worse than folklore suggests.

- **Henderson et al., "Deep Reinforcement Learning that Matters", AAAI 2018
  ([arXiv:1709.06560](https://arxiv.org/abs/1709.06560)).** The load-bearing experiment: ten TRPO
  runs on HalfCheetah, *identical hyperparameters*, split into two groups of five and averaged. The
  two curves are statistically different — "t = −9.0916, p = 0.0016". Their conclusion: "the
  variance between runs is enough to create statistically different distributions just from varying
  random seeds." They also find network architecture, activation function, reward scale and
  *codebase* each change results significantly: "implementation differences which are often not
  reflected in publications can have dramatic impacts on performance." Note what the paper does
  **not** say — it explicitly declines to prescribe a trial count: "there can be no specific number
  of trials specified as a recommendation". (Claims that it recommends 30 seeds are **UNVERIFIED**
  and I could not find them in the text.)
- **Islam et al. 2017 ([arXiv:1708.04133](https://arxiv.org/abs/1708.04133))** independently ran the
  same 5+5 split and reported that DDPG could not be made stable even with tuned hyperparameters.
- **Engstrom et al., ICLR 2020 ([arXiv:2005.12729](https://arxiv.org/abs/2005.12729))**: PPO's
  code-level optimisations — value clipping, reward scaling, orthogonal init, LR annealing — are
  "responsible for most of PPO's gain in cumulative reward over TRPO". The algorithm was not the
  algorithm.
- **Agarwal et al., NeurIPS 2021 ([arXiv:2108.13264](https://arxiv.org/abs/2108.13264))**: with 100
  runs per Atari-100k game as ground truth, 95% CIs on sample medians need "closer to 50-100 runs",
  not the 3-10 that are standard; the median at 5 vs 100 runs for SPR differs by 0.03, about 36% of
  its claimed gain over DrQ(ε).
- **The deadly triad** (function approximation + bootstrapping + off-policy) is real but narrower
  than usually implied. van Hasselt et al. 2018
  ([arXiv:1812.02648](https://arxiv.org/abs/1812.02648)) measured it across 57 Atari games:
  one-step Q-learning "soft-diverged" in 94% of runs, n = 10 bootstrapping cut that to 21%; heavier
  prioritisation (more off-policy) pushed Q-learning from 52% to 77%.
- **Where supervised beats online RL with plentiful expert data**: AlphaGo's SL policy net reached
  **57.0%** held-out accuracy on 30M KGS positions against a 44.4% prior state of the art, and the
  paper notes "small improvements in accuracy led to large improvements in playing strength"
  ([Nature 2016](https://storage.googleapis.com/deepmind-media/alphago/AlphaGoNaturePaper.pdf)).
  Ruoss et al. 2024 distilled Stockfish 16 into a 270M transformer by pure supervised learning and
  reached **2895 Lichess blitz Elo** with no search at all.

For our project the honest form of the warning is not "RL is noisy" but **"your evaluation is
noisier than you think"**, and the repo already learned this the expensive way: the evaluator was
non-reproducible and invalidated a milestone's numbers (`docs/FINDINGS.md:679`), fixed-seed
incumbent scores produced a winner's curse that rejected seven challengers in a row
(`docs/FINDINGS.md:2027-2031`), and there is ~1.5 pt of non-binomial noise on identical seeds from
XPU non-determinism (`docs/FINDINGS.md:2353`). The current protocol — fresh seeds every round,
both players scored in the same run, 4,000 games each — is the right answer and is unusually
disciplined by the standards of the papers above.

### D.2 Where it is wrong

The claim conflates "RL" with "policy gradients on a scalar reward". The whole AlphaZero family is
a counterexample, and the counterexample is *specifically* the part we are doing.

- **ExIt** reports the opposite of instability: "the policy improves consistently each iteration and
  there is little variation in the performance between each training run" (5 runs, 90% CI), and
  attributes it to search considering multiple opponent replies rather than overfitting one
  ([arXiv:1705.08439](https://arxiv.org/abs/1705.08439)).
- **Grill et al.** show why: AlphaZero's search *is* regularized policy optimization, and its
  training step is a projection of an already-improved policy — supervised regression, not a
  high-variance gradient estimate ([arXiv:2007.12509](https://arxiv.org/abs/2007.12509)).
- **TD-Gammon** is the historical rebuttal to "supervised on expert data always wins": raw TD(λ)
  self-play reached parity with Neurogammon (supervised on expert games), and with hand features
  added "greatly surpassed Neurogammon and all other previous computer programs"
  ([Tesauro 1995](https://www.bkgm.com/articles/tesauro/tdl.html)). Its signal was also not a scalar
  win bit — the output was a four-component outcome vector.
- **TDLeaf/KnightCap** took a chess engine from 1650 to 2110 FICS blitz in **308 games** by
  bootstrapping from search ([arXiv:cs/9901001](https://arxiv.org/abs/cs/9901001)), and **TreeStrap**
  beat it by ~1,100 Elo (§C.3).
- **Pluribus** beat human professionals at 6-player poker with no neural network and 12,400 CPU
  core-hours (§A.5).

And the ceiling on pure distillation is documented too: Ruoss et al.'s 270M model reaches 95.4%
puzzle accuracy against Stockfish's 99.8%, and the authors state it is unclear whether further
scaling closes the gap. Distilling a fixed teacher converges to the teacher, slowly, from below.
Which is §0 again.

### D.3 What it means for us

**We are not doing the thing the claim attacks.** There is no policy gradient, no bootstrapped TD,
no replay of our own value estimates, no entropy bonus, no importance sampling. `train_value.py` is
a supervised regression script: load a matrix of features, minimise BCE against labels measured by
playouts, early-stop. The deadly triad needs bootstrapping; our only bootstrapping attempt (v26ts)
was measured and rejected (`docs/FINDINGS.md:2105`). The PPO era that *was* the thing the claim
attacks is dormant in `legacy/ppo/` and topped out at 79% vs weighted-random, 1.7% vs
`ValueFunctionPlayer` (`docs/FINDINGS.md:1452-1456`).

So the professor's advice, applied literally, is advice we already took. The open question is the
second half — *does more supervised data help us?* — and here the repo is blunt in both directions:

- **For:** "more games is the lever that actually adds information, not more epochs or more
  capacity" (`docs/FINDINGS.md:1573`); 3× denser rollout labels lifted draws from 35-43% to
  40.7-51.4% and produced the first proxy interval entirely above 50%
  (`docs/FINDINGS.md:2264, 2280`).
- **Against:** 5× more *games* from older generators cost 1.7 points
  (`docs/FINDINGS.md:2106`), and the conclusion recorded there is "the outcome signal is not
  data-starved at 16k games; it is the wrong kind of signal."

Those are consistent if you separate the two axes: **labels per game helped; games per label source
did not.** What is missing is the clean curve.

Two literature anchors for what that curve might look like:

- **Ruoss et al. 2024** ran the sweep we have not: model sizes 7M-270M × datasets of 10K/100K/1M/10M
  games. At 10K games every model ≥7M parameters overfits and that disappears by 100K; accuracy
  rises with dataset size at *every* model size; and the conclusion is that "strong chess
  capabilities from supervised learning only emerge at sufficient dataset and model scale". Their
  target ablation is the sharpest datum for us: **action-value 83.3% vs state-value 77.5% vs
  behavioural cloning 65.7%** puzzle accuracy — *but at equal data points (40M) state-value and
  action-value were nearly identical*, so the action-value advantage was ~30× more labels, not a
  better target. **Label count, not label type, was the lever.** That is a direct argument for
  raising `roll_p` / `roll_m` before redesigning the head.
- **Jones 2021, "Scaling Scaling Laws with Board Games"**
  ([arXiv:2104.03113](https://arxiv.org/abs/2104.03113)), AlphaZero on Hex: "the trade-off is linear
  in log-compute: for each additional 10× of train-time compute, about 15× of test-time compute can
  be eliminated, down to a floor of a single-node tree search." Read against our situation, that is
  a warning: we are at a 2-ply floor and `docs/FINDINGS.md:2050` says buying depth does not help,
  so train-time compute (= labelled games) is the axis we have left.

### D.4 There is no scaling curve in this repo, and here is the cheapest one

Searched `docs/FINDINGS.md` for a data-size-vs-strength experiment: the only datapoint is
`roll_p 0.1 → 0.3` (`docs/FINDINGS.md:2264, 2280`), and it is confounded — the same round also
introduced the incumbent-seeded greedy soup. **State plainly: we do not know our data-scaling
exponent.**

Cheapest clean measurement, **zero generation cost**, using shards already on disk:

```
# same warm start, same data dirs, same seeds; only the label budget varies
for N in 100000 300000 900000; do
  for s in 0 1 2; do
    uv run python train_value.py --data <last 4 it dirs> --init <incumbent> \
      --out checkpoints_value/scale${N}_s$s.pt --seed $s --epochs 6 \
      --rank-weight 0 --sib-weight 0 --self-sibs 0 \
      --ts-key ro --ts-weight 3 --max-ts $N --win-weight 0 --aux-weight 0
  done
  uv run python soup.py --greedy --base <incumbent> --games 1000 --seed <fixed> \
    --out checkpoints_value/scale${N}.pt checkpoints_value/scale${N}_s*.pt
  uv run python evaluate.py --player vnet:checkpoints_value/scale${N}.pt --opponent rab --games 4000 --seed <fresh>
done
```

`--max-ts` subsamples **whole decisions** — it reads `ro_n` and keeps each decision's children
together (`train_value.py:56`, `83-89`) — so the sweep varies the number of labelled *decisions*
with sibling groups intact, which is exactly what a label-budget curve should vary. Cost: 9 trainings (~8 min per 5, so ~15 min), 3 soups (~12 min),
3 proxies (~7.5 min) — **well under an hour, no generation.** Three points on a log-x axis is
enough to tell "still climbing" from "saturated", which is the only thing the decision needs.

Run it **before** any of the shortlist below. If the curve is still climbing at 900k, the cheapest
win is more generation with the current recipe and the shortlist can wait. If it is flat, the
shortlist is the only way forward.

---

## E. Ranked shortlist

Costs are in this repo's units (one round ≈ gen 11 min + 5 trainings 8 min + soup 4 min + gates
4 min ≈ 27 min, `docs/FINDINGS.md:2270`). **Every item is scored the same way and only that way:**
N draws from one warm start → greedy soup seeded with the incumbent → 4,000-game fresh-seed
head-to-head vs the incumbent against 3x `rab`. Held-out loss is not a valid selection signal in
this repo (`docs/FINDINGS.md:2270`), and the proxy carries ~1.5 pt of non-binomial noise
(`docs/FINDINGS.md:2353`), so anything claiming under ~3 points needs a repeat.

| # | Change | Expected upside | Cost | Measurement |
|---|---|---|---|---|
| 0 | **Label-scaling curve** (§D.4) | none directly — it decides whether anything else is worth doing | <1 h, **no generation** | 3 × (3 draws + soup + 4,000-game proxy) on existing shards |
| 1 | **Net-in-the-loop rollout policy**: `decide_rollout` evaluates with the incumbent net instead of `base_fn` | **Largest.** Removes the named cause of the plateau (`FINDINGS:2386`); turns DAgger into policy iteration. If the labels rise with the student, the ceiling moves from "AlphaBeta continuation" to "our own continuation" | Highest: Rust change in `heuristic.rs`/`arena.rs` to thread a `ValueNet` into the rollout, plus a rollout-cost regression (net leaves cost ~2.5 µs vs `base_fn` 0.17 µs, `FINDINGS:2237-2241`) — expect generation several× slower, so pair with a lower `roll_p` | Two rounds, same protocol. Also report generation games/s: if it drops below ~2 games/s the lever is economically dead and should be capped (e.g. net rollouts only for the first N plies, `base_fn` after) |
| 2 | **`roll_m > 1` at constant playout budget** | 1-4 pts if label variance is the binding constraint; genuinely unmeasured | One round per arm; A/B is cost-neutral | `roll_p 0.3, roll_m 1` (current) vs `roll_p 0.1, roll_m 3`. Same CPU, same rows-per-playout, isolates variance from coverage |
| 3 | **Multi-outcome head from rollouts**: label each child with the rollout's 4-way finisher and/or the decider's final VP margin, train a 4-way softmax / margin head alongside the win head | 1-3 pts. Turns one Bernoulli bit into ~2-3 bits per playout at zero extra playout cost. Precedent: Deep Catan's 4-player win-rate vector, Gendre & Kaneko's ±0.02/VP margin shaping in Catan, Lc0's WDL head, KataGo's "decomposing the game result into finer variables" (§C.3). Untested here — the outcome-head failure was about *game* outcomes shared across ~150 states, not per-child rollout labels, and the aux heads were dropped with it rather than ablated on their own (§C.2) | Low: one `arena.rs` field, one loss term; `N_HEADS` is already 6 (`value_net.py:91`) | One round; must beat the same-budget rollout-only arm, not just the incumbent |
| 4 | **Distributional value head** (categorical bins + HL-Gauss smoothing) | 0-2 pts. Ruoss et al. measured HL-Gauss 82.0 vs L2 80.8 vs log-loss 80.6 — real but small, and our labels are 0/1 so smoothing has less to bite on until #2 lands. MuZero's categorical head is Atari-only and is *not* precedent here (§A.5) | Low: head + loss change in `train_value.py` | One round, stacked on #2 |
| 5 | **Stop generating the dead signals** (`--rank-p 0.5 --sib-p 0.3` at `run_exit.sh:43` feed losses weighted 0) | 0 pts strength; recovers disk and some generation time | ~1 line | Compare games/s and shard size on one round; must be strength-neutral |
| 6 | **A policy head / prior** trained on rollout-*values* (soft, not argmax — ExIt measured soft targets +50 ± 13 Elo over chosen-action ones, §C.3), used to order and prune the depth-2 expansion; optionally a Gumbel-style completed-Q improvement target (§A.5) | Speculative. Would buy depth — the real AlphaZero lever — but `FINDINGS:2050` says depth is worth nothing *with this evaluator*, and Gumbel's guarantee holds only "when action-values are correctly evaluated", which v26ts showed ours are not | High | Only after #1 changes what the evaluator knows. Not before |

Two things deliberately **not** on the list, with reasons:

- **More search depth at play time.** Measured, negative, repeatedly (`docs/FINDINGS.md:2050`).
- **Bigger/wider net.** Measured, negative, while posting the best held-out loss on record
  (`docs/FINDINGS.md:2277`), and the project is simulation-bound by design decision
  (`CLAUDE.md`, "We are simulation-bound, not GPU-bound").

One closing note on the sequencing. Item 0 is first because it is nearly free and it is the only
thing that can tell you whether the honest answer to the professor is "yes, more examples" or "no,
better examples". Item 1 is the one the repo's own final open question names, and it is the only
item that changes the *kind* of loop this is.
