# Research: human Catan data, low-volume learning, and the Catan AI literature

Survey written 2026-09-21. Scope: three questions — (1) does a usable corpus of human Catan
play exist, (2) if not, what actually works when expert data is scarce, (3) what the prior
art reports and whether any of it beats what this repo already measured.

**Reading rule for this file.** Every number is attributed. Anything marked **UNVERIFIED**
was seen only in a search snippet or a secondary summary and the primary source was not
fetched — treat it as a lead, not a fact. Nothing here was re-benchmarked; the numbers for
*this* project are quoted from `docs/FINDINGS.md` and `docs/BENCHMARK.md`.

---

## 1. Human Catan play data: what exists

### The one-line answer

One real, downloadable, licensed corpus of human Catan play with full state+action traces
exists: **STAC**, 45-60 games from an Edinburgh student league in 2011-2012. Everything else
is bot games, dice statistics, speech transcripts, or a scrape that is offline and
ToS-encumbered. **There is no large public human Catan dataset.**

For scale: the STAC corpus is **60 games / 14,496 recorded human actions**. This project's
arena generates 4,000 games in ~285 s — about **14 games/s** (FINDINGS 2026-09-02), i.e.
**60 games ≈ 4 seconds of arena generation**. Counted in decisions rather than games the
ratio is the same order: a 4,000-game round records ~150 labelled samples per game
(~600,000), so the entire published human record of Catan is about **2%** of one
iteration's training data.

### STAC (Edinburgh / IRIT) — real, downloadable, human, tiny

- Project page: <https://www.irit.fr/STAC/corpus.html> (HTTP 200, no login).
- **Verified by download on 2026-09-21.** `stac-situated-2018-05-04.zip` (13.5 MB, HTTP 200)
  contains **45 `.soclog` files** — and these are the genuine JSettlers server message log,
  not annotated chat. Message counts in one pilot game:
  `SOCPlayerElement` 1,221, `SOCGameTextMsg` 975, `SOCGameState` 233, `SOCResourceCount` 164,
  `SOCPutPiece` 58, `SOCDiceResult` 67, `SOCMoveRobber` 32, `SOCMakeOffer` 30. Winner lines
  present (`>>> Tomm has won the game with 10 points.`).
- **Exact hidden hands are in the log.** Verified line:
  `GAME-TEXT-MESSAGE:[game=pilot01|player=rennoc1|...|clay=2|ore=0|sheep=0|wheat=2|wood=0|unknown=0|knights=0|roads=[104,120]|settlements=[105,137]|cities=[]|dev-cards=0|text=...]`.
  So a full state reconstruction is possible, for every seat, at every chat turn.
- **Licence: CC BY-NC-SA 4.0.** Non-commercial. Relevant if anything trained on it ships.
- **A second, more convenient form:** `database/human.sql` in
  <https://github.com/ruflab/StacSettlers> (GPL-3), a 22.2 MB Postgres dump — **verified by
  download**: 60 `gameactions_N` / `obsgamestates_N` / `extgamestates_N` tables,
  **14,496 action rows, 14,430 observed-state rows, 60 games, 33 distinct players, 11
  leagues**. Pre-extracted state/action rows with engineered features. The dump's own licence
  is not separately stated (GPL-3 repo, STAC-derived data) — **UNVERIFIED**.
- **Players: human, and not experts.** All seat records parsed by the sweep carry
  `robotFlag=false`. Skill is Edinburgh students in organised leagues; the pilot log contains
  `"so anyone else played this before?"` and `"Yes, a little... but I was never good at it."`
  There are **no skill ratings or Elo anywhere in the release**.
- **Rules caveat:** these are JSettlers games with a chat interface, so JSettlers' trade and
  chat semantics, not catanatron's and not colonist.io's.
- Corpus counts disagree across sources: the IRIT page and the zip say 45 games; the LREC
  2016 paper (<https://aclanthology.org/L16-1432.pdf>) says 59 collected / 36 fully annotated
  at that release; the StacSettlers dump has 60. Treat "45-60" as the range.
- The original collection paper (Afantenos et al., *Developing a corpus of strategic
  conversation in The Settlers of Catan*,
  <https://homepages.inf.ed.ac.uk/alex/papers/gamnlp.pdf>, fetched and read) confirms the
  design: a modified JSettlers with a chat interface, an online league at
  `settlers.inf.ed.ac.uk` (**now dead — DNS failure**), and explicitly *"The state of the game
  is recorded and aligned with players' conversations, which allows theorists and annotators
  to access the players' hands"*. At writing time they had ~40 games and planned "hundreds";
  that plan was never realised in a public release.
- **Effort to use: low.** Direct download, no registration; the work is a JSettlers-protocol
  parser, and this repo already has `jsettlers_board.py` mapping JSettlers coordinates onto
  catanatron's BASE template plus a `--selfcheck` path that round-trips 103 positions. The
  parsing cost is the lowest it will ever be for this project specifically.

### colonist.io — no legitimate route

- **No official API or replay export found.** Colonist's own 2024 summary blog
  (<https://blog.colonist.io/colonist-io-2024-summary/>) claims 45.2M games in 2024 and 600 GB
  of stored data, with no research or data-sharing programme mentioned.
- **The ToS forbids exactly this use.** Verified verbatim by direct fetch of
  <https://colonist.io/terms> (last updated April 30, 2026):
  - *"Scraping, crawling, or indexing any portion of the Service, including but not limited to
    user profiles, game replays, leaderboards, or game statistics, using any robot, spider,
    automated device, or manual process."*
  - *"Accessing or using the Service's internal APIs, private endpoints, or data structures in
    any manner other than through the standard user interface provided by the Company, unless
    explicitly authorized in writing by the Company."*
  - *"Using any Content or data from the Service to train, develop, or improve any artificial
    intelligence (AI) models, machine learning algorithms, or automated decision-making
    systems without the Company's express prior written authorization."*

  The last clause is decisive on its own: training on colonist data needs written permission,
  scrape or no scrape.
- **The one advertised large corpus is offline.**
  <https://github.com/OrgadYron/catan_43k_games_dataset> documents "43,947 anonymized Catan
  games from Colonist.io", ~175k player instances, ~6.9 GB of per-game JSON with
  `eventHistory.events`. **Verified 2026-09-21: the repo contains only markdown (HTTP 200),
  the GitHub API reports zero releases, the README's download link
  `github.com/Catan-data/dataset/releases/latest` returns HTTP 404, and the `Catan-data` org
  has zero public repos.** Skill distribution: not stated anywhere — **UNVERIFIED**. Even if
  the files surfaced, the ToS clauses above apply.
- Community tooling exists but is not a dataset: `ColonyHistorian`
  (<https://github.com/lemeryfertitta/ColonyHistorian>) saves your own games as JSON;
  `Rastipunk/colonist-card-tracker` intercepts the game WebSocket and has an opt-in uploader.
  These are collection mechanisms, not published corpora.
- No Kaggle or HuggingFace colonist dataset exists (HF dataset API search for "colonist" and
  "settlers" returned nothing relevant).
- **Someone has already asked, and was refused.** The Stanford CS230 team
  (<http://cs230.stanford.edu/projects_fall_2021/reports/103176936.pdf>, fetched) write that
  they *"attempted to contact the developers of numerous popular online versions of Catan,
  such as Catan Universe and Colonist.io, to perchance use their existing API"* and that
  *"the developers of these third party APIs were unwilling to share their source code nor
  had available labeled data"*. That is the only documented attempt found, and it failed.

### Catan Universe — no

No API, replay export or dataset. ToS (<https://catanuniverse.com/en/terms-of-use/>) bars
"software permitting data mining" and access by anything other than a browser or the official
client. No third-party dumps found.

### JSettlers / JSettlers2 — format, not data

`.soclog` is JSettlers' own debug save format, which is why STAC is in it. **No published
archive of human JSettlers games was found** beyond STAC. Bot-vs-bot logs exist from third
parties (below). Whether nand.net hosts an archive: **UNVERIFIED** (not checked).

### Catanatron — a dataset *generator*, bots only

`catanatron-play --num 100 --output <path> --output-format json` produces datasets; the repo
publishes none, and everything it produces is bot play. Nothing here is human data.

### Bot corpora that exist (listed so nobody mistakes them for human data)

- OSF, *Adversarial Search & Deep Learning for Strategic Settlement Placement in the Settlers
  of Catan* (<https://osf.io/mb4q5/>, public; `datasets.zip` ~1.69 GB). Its own abstract says
  the work *"does not make use of any human-generated data corpus"* — JSettlers bot games.
  Snippet claim of 2,000,000 simulated `.soclog` games: **UNVERIFIED**.
- StacSettlers' `simulation_games` tables and `simu-example.soclog`: bot games.
- `ruflab/soc` (<https://github.com/ruflab/soc>): bot-generated trajectories for language
  grounding.

### Speech, statistics and images (not play traces)

- **DinG** (<https://arxiv.org/abs/2207.12162>, Boritchev & Amblard, LREC 2022). Verified from
  the PDF: **10 recordings**, ~70 min average (40 min to 1h44m), French, manual transcription,
  CC BY-SA 4.0, distributed at
  `https://gitlab.inria.fr/semagramme-public-projects/resources/ding/` as numbered `.txt`
  files. **Speech only — no board state or move data.** The paper states *"Most of the players
  we recorded for DinG never played Catan before."* The GitLab URL sits behind an Anubis
  challenge, so the file listing itself is **UNVERIFIED** (it resolves rather than 404s).
- Kaggle: `lumins/settlers-of-catan-games` (50 games from playcatan.com, 2014, ~5 KB,
  CC BY-NC-SA 4.0) records starting positions, dice distributions and post-game statistics —
  **not a move trace**; `thedevastator/...` is a re-post of the same 50 games;
  `koftezz/thesettlersofcatan` is one person's notes. The rest are board photos and dice
  images.
- HuggingFace "Catan" datasets are LLM-generated SFT data (`g8967/catan-sft-dataset` 1,000
  examples; `VVantim/catan-sft-data` 2,668 with a `meta_model` column) or synthetic images.

### Board Game Arena, tournaments, streams

BGA has a licensed Catan (<https://en.boardgamearena.com/news?id=606>), but **no BGA Catan
replay dataset was found**; the public BGA replay parsers and the `liamdj/bga-replays` HF
dataset cover other games only. BGA's ToS stance on scraping: **UNVERIFIED** (page would not
load). No tournament or ranked-ladder archive found. Twitch/YouTube replay datasets: **not
searched — UNVERIFIED**.

### What is explicitly NOT available

- No large public human corpus, at any skill level, in any format.
- No skill/Elo labels on any human Catan source found.
- No legitimate route to colonist.io or Catan Universe data.
- No human JSettlers archive outside STAC.
- No expert human trade-outcome dataset — the thing that would be most useful here.

---

## 2. Learning efficiently from low-volume expert data

### The framing correction first

The question as posed ("if there is no big human dataset, how do we learn from a small
one?") assumes this project is data-starved. It is not. `gen_games.py --lineup
rab,rab,rab,rab` runs at **34.6 games/s on 7 workers** (FINDINGS, 2026-09-01 late) and the
arena at 16.8 games/s with a net in the loop; a 4,000-game round costs ~285 s. The loop is
**saturated, not undertrained**: rounds 36-45 are flat at 56-60% vs `rab` (FINDINGS,
2026-09-03).

So the entire sample-efficiency toolbox — offline RL, BC warm-starts, augmentation — is
aimed at a constraint this project does not have. What a human corpus could supply is a
*different objective*, not more samples: what humans value in a trade, how they open, how
they model opponents. Worth stating plainly, because it changes which of the listed methods
are worth anything here.

Several of the requested methods are **already measured dead in this repo**, at matched
rigor. Re-proposing them would be a regression:

| Method | Where it was tried | Result |
|---|---|---|
| Behaviour cloning as warm start | FINDINGS 2026-09-01, "BC-from-VFP: representation is not the bottleneck" | BC of VFP: 96% vs 3x WeightedRandom but **7.8% vs 3x VFP**. Self-play PPO from the BC init: 9.0%. The net can *represent* the teacher and still not play at its level. |
| Listwise / sibling-ranking imitation of the expert's choice | FINDINGS 2026-09-01 late, `v1_interim` | Held-out pair accuracy 0.79, and **3.8% [1.5, 9.4] vs 3x AB** — no better than v0's 6.0%. Top-1 agreement with `base_fn` went 22% → 35%; the player did not move. |
| Distilling the *agent's own* depth-2 choice into its 1-ply ranking (self-DAgger) | FINDINGS 2026-09-02, iteration 9 | **20.7%** vs 3x `rab`, against 25.2% with those labels dropped and 29.1% without that round's data at all. Actively harmful. |
| Outcome (win/loss) regression as the training target | FINDINGS 2026-09-03, loss-mix ablation | full recipe 30.1% → **rollout values only 53.0%**. One bit per game shared by ~150 correlated states drags the evaluator away from good play. |
| Auxiliary heads | same ablation | "no aux heads" 36.0% vs rollout-only 53.0%. |

### Method by method, against this project

**Behaviour cloning / imitation warm-start then RL.** Standard, and the canonical
board-game instance is AlphaGo's supervised policy network, trained on human expert games
before RL ([Silver et al., *Nature* 2016](https://www.nature.com/articles/nature16961)).
The mechanism that makes it pay there is that the SL net is a **policy prior for the
search**, not an evaluator. This repo has no policy head at all — its search enumerates all
~230 leaves exhaustively. That is the gap worth noting: BC of a *value* was tried and
failed; BC of a *policy prior* has never been tried here because there is no prior to train.
See the ranked list.

**DAgger** ([Ross, Gordon & Bagnell, AISTATS 2011](https://proceedings.mlr.press/v15/ross11a.html))
fixes imitation's exposure bias by querying the expert on states the *learner* visits. This
project already runs the search-flavoured version of exactly that: expert iteration
([Anthony, Tian & Barber, NeurIPS 2017](https://proceedings.neurips.cc/paper/2017/hash/d8e1344e27a5b08cdfd5d027d9b8d6de-Abstract.html))
is DAgger with a search as the queryable expert, and `gen_games.py` + `train_value.py` is
that loop. With a *human* expert there is nothing to query — DAgger's whole premise
(interactive expert access) fails on a fixed log. On a fixed corpus DAgger degenerates to BC.

**Offline RL (CQL, IQL).**
[CQL](https://proceedings.neurips.cc/paper/2020/hash/0d2b2061826a5df3221116a5085a6052-Abstract.html)
(Kumar, Zhou, Tucker & Levine, NeurIPS 2020) and
[IQL](https://arxiv.org/abs/2110.06169) (Kostrikov, Nair & Levine, ICLR 2022) both exist to
solve one problem: you cannot query the environment, so you must avoid over-estimating
out-of-distribution actions. This project queries the environment 34 times a second and can
*execute* every legal action exactly (`expand_outcomes` pins chance). The core difficulty
these methods address does not arise. IQL's expectile regression on V is the one idea that
transfers in principle — it learns a value without evaluating unseen actions — and it is
strictly less informative here than the rollout labels already in use. **Low value; do not
build.**

**Inverse RL / preference learning.** IRL recovers a reward from demonstrations. Catan's
reward is not unknown: it is "reach 10 VP first", already exact, already the training
signal's ancestor. IRL is the right tool when you want to imitate *style* — an agent that
plays like a human, or a human-plausible trading partner for the site's bots — not when you
want a stronger player. Preference learning (pairwise "which of these two positions is
better") is more interesting, because it targets the ranking problem the repo diagnosed at
iteration 0 ("a calibrated win-probability is not the same thing as a ranking of siblings").
But the repo already tried supplying the ranking directly from `base_fn` and from its own
search, and both failed. Human preferences would be a third, noisier teacher of the same
signal. **Low value.**

**Data augmentation by board symmetry.** Two separate symmetries, and one of them is
already free:

- *Colour/seat permutation.* Already quotiented out. `catan_engine/src/encode.rs`
  `encode_into(p0, ...)` writes every per-player block at `seat = (p0 + i) % n` and the
  turn one-hot at `rel = (cur + n - p0) % n`. The encoding is perspective-relative by
  construction, so rotating who is "me" produces the *same* feature vector for the same
  relative position — there is no augmentation left to do.
- *Board rotation/reflection.* The BASE hex board has D6 geometry, so a rotated/reflected
  relabelling of nodes, edges and tiles is a genuine distinct sample. This is real
  augmentation — and it buys **data**, which is the resource this project has in surplus.
  It also interacts badly with the memorization fix: the static tile/port one-hots are
  masked at the net's input precisely because they fingerprint a map (FINDINGS, "The value
  net memorizes games"), so the features augmentation would perturb are partly not seen.
  **Skip.**

**A search player as synthetic expert.** This is not a proposal; it is what the project
already does. The rollout labels are AlphaBeta-continuation values, and FINDINGS names the
resulting ceiling itself: *"rollout labels are AlphaBeta-continuation values, which cap what
the net can learn about its own (now stronger) play — a net-in-the-loop rollout policy is
the natural next lever."* That is the strongest live idea in this whole survey and it came
from the repo, not the literature. The literature's contribution is a name and a caution:
**TreeStrap** ([Veness, Silver, Uther & Blair, NeurIPS
2009](https://proceedings.neurips.cc/paper/2009/file/389bc7bb1e1c2a5e7e147703232a88f6-Paper.pdf))
updates the evaluator toward the search's value at *every interior node*, not just the root,
and learned master-level chess from random weights by self-play alone. Note carefully that
this is **not** what iteration 9 did: iteration 9 distilled the search's *argmax* (a
classification label) into the 1-ply ranking and it hurt. TreeStrap regresses on the search's
*values*. Whether that distinction survives contact with this engine is an experiment, not a
known.

**Reward shaping.** Tried in the PPO era (`vp_shaped_reward`, FINDINGS M2) and confirmed to
telescope correctly; it did not move the gate, and the current pipeline is not policy-gradient
at all, so there is no reward to shape. **N/A.**

**Auxiliary tasks / representation learning.** Measured negative in the loss-mix ablation
above (aux heads cost ~17 points of proxy win rate against rollout-only). The one
representation change that *did* pay was hand-built, not learned: appending `base_fn`'s own
terms (production score, reachability at 0/1/2 roads) to the encoding, after the diagnostic
showed the net "cannot see where a road leads" (FINDINGS 2026-09-01 late, Fix 1). That is the
pattern worth repeating — diagnose a specific blindness, add the specific feature — rather
than generic SSL objectives.

**Catan-specific.** The part of this agent that is *least* trained is trading, and the code
says so exactly. `catan_engine/src/actions.rs:133` `search_actions()` **filters
`Action::OfferTrade` out of the search entirely** ("searching offers is out of the question
— each offer branches into every opponent's reply", `trade.rs` header). Offers are chosen by
a 1-ply additive decomposition in `trade.rs`, which *does* use the value net as its
evaluator (`Eval::Net`) — but because offers never enter `search_actions()`, they never
appear in `record_rollouts`' sampled children either, so **no trade decision has ever
carried a training label**. The net evaluates hands after a hypothetical trade; nothing has
ever told it whether the trade was a good idea. That is a genuine, un-probed hole, and it is
the single place where human data would carry information no
self-play run produces, because trade is the one genuinely multi-agent, partly-social
decision in the game — and it is exactly what the STAC corpus and the Guhe & Lascarides line
of work studied. If any human corpus turns out to be usable, trading is where to spend it.

---

## 3. The Catan AI literature

Read the win-rate column carefully: **the seating differs between papers and it changes what
the number means.** A 1-vs-3 result has a 25% parity baseline; a 1-vs-1 result has 50%. Two
of the most-quoted "beats the baseline" results in this field (Gendre & Kaneko, HexMachina)
are 2-player.

| Work | Method | Opponent & seating | Reported result | Code |
|---|---|---|---|---|
| Pfeiffer 2004 | Hierarchical RL + model trees, self-play, with hand heuristics on top | the author (3 agents vs 1 human), 10 games per policy | best (heuristic-guided) policy **wins 2 of 10**; agents average 8 VP | no |
| Szita, Chaslot & Spronck 2010 | MCTS in a **perfect-information** variant | 3 jSettlers | **27%** at 1k sims, **49%** at 10k sims — *secondary source* | no |
| Guhe & Lascarides 2014 | Hand-modified JSettlers strategy, tuned against a human corpus | 3 stock jSettlers, 10,000-game sims | **43%** | no |
| Cuayáhuitl, Keizer & Lemon 2015 | Deep RL for the *trade/dialogue* layer only | 3 bots | **53%**; a supervised player trained on a dialogue corpus: **27%** | no |
| Dobre & Lascarides 2018 | POMCP + action-type rollouts + preferences mined from **60 human games** | tournament vs other agents, 40k sims | **53.65%** vs POMCP's 47.94%; ablation without preferences ≈ 25% | [MIT](https://github.com/sorinMD/MCTS) |
| Xenou, Chalkiadakis & Afantenos 2018 (DRRL) | Online DQN+LSTM over a jSettler, trade decisions only | 3 jSettlers | **45%** (20 games) / **56%** (30 sequential) | no |
| Karamalegos 2016 (TU Crete thesis) | UCT / BUCT / VPI MCTS in JSettlers, 15 s per decision | 3 jSettlers, 100 games | UCT **9%**, BUCT **11-14%**, VPI **17%** | no |
| Gendre & Kaneko 2020 | Cross-dimensional CNN, pure self-play, **no trading**, **2 players** | 1 jsettler (1v1) | **56.5%** after ~5 weeks / 30k training steps | UNVERIFIED |
| Driss & Cazenave (Deep Catan) | CNN + PUCT + Expert Iteration | their own UCT (self-defined baseline) | UCTNet **240/400 = 60%** vs UCT | UNVERIFIED |
| settlers-rl (2023, community) | PPO, factored conditional action heads, tile attention, ~450M decisions, ~1 month on 32 cores + RTX 3090 | self-play only | plateaus; forward search wins **47/100** vs the final policy. Author: *"it still doesn't feel close to the standard of a good human player"* | yes |
| Belle et al. 2025 (HexMachina) | LLM multi-agent system that *writes and evolves Python player code*, in Catanatron | 1 AlphaBeta, **2-player** games, 10 runs × 100 games | **54.1% [51, 57]** vs AlphaBeta's 51.0% [48, 54]; 8.2 VP | promised, no URL found |
| **This project (v40)** | depth-2 exact expectimax over a learned win-probability net, expert iteration with rollout labels | **3x AlphaBeta, 4-player**, 1,000 games | **55.2% [52.1, 58.3]** (parity 25%) | this repo |

### Notes that matter, work by work

**Pfeiffer 2004** ([slides, Semantic
Scholar](https://pdfs.semanticscholar.org/86de/ecd0e8b2afff1aa5907ee4648b2fb59f888e.pdf),
CGAIDE 2004, fetched). The earliest Catan RL. The finding that survived is negative: pure
self-play RL was *worse* than RL guided by hand heuristics, and the best agent still lost 8
of 10 to one human. Not reproducible, and the baseline (one person) is not a benchmark.

**Szita, Chaslot & Spronck 2010**
([Springer](https://link.springer.com/chapter/10.1007/978-3-642-12993-3_3), ACG 2009, LNCS
6048). **Paywalled — the primary was not fetched, so the numbers above are UNVERIFIED at the
primary.** They are quoted from Gendre & Kaneko 2020 §2.3, which this survey *did* fetch:
*"27% winrate with 1000 simulations, and 49% winrate with 10000 simulations, when playing
against 3 jsettlers. However, their method cannot be applicable in the original, i.e.,
imperfect information, rule."* The perfect-information caveat is the reason this repo's own
UCT port (Phase D, 45.2% in the paper pool) is not directly comparable either — `mcts.rs`
also runs on a fully observable engine, which `docs/BENCHMARK.md` already records as a
deviation.

**Guhe & Lascarides 2014**, *Game strategies for The Settlers of Catan*
([PDF](https://homepages.inf.ed.ac.uk/alex/papers/cig2014_gs.pdf), CIG 2014, fetched). Their
agent wins **43%** against 3 stock JSettlers over 10,000-game simulations, and corpus
analysis shows it also moved *closer* to human behaviour. Two things worth carrying:

1. Their number is the strongest jSettler-relative result in this table, and it comes from
   **hand-tuning a symbolic agent**, not learning. v40's 45.0% [35.6, 54.8] vs 3 stock
   jSettlers (`docs/BENCHMARK.md` Phase F) sits in the same band with a far wider interval
   (100 games vs 10,000).
2. Their framing of *why* a symbolic model matters is the argument for a policy prior:
   *"a symbolic model can provide a prior distribution over which next move is likely to be
   optimal, and this is critical to the success of using current machine learning techniques
   on complex games."* They also note that Pfeiffer and Szita both *depended* on a decent
   prior strategy, which is the same conclusion FINDINGS reached from the other direction.

**Cuayáhuitl, Keizer & Lemon 2015** ([arXiv 1511.08099](https://arxiv.org/abs/1511.08099),
abstract fetched). Deep RL on the trade/dialogue layer: **53% vs 3 bots**, and — the line that
matters for Q1/Q2 — *"a supervised player trained on a dialogue corpus in this setting
achieved only 27%."* **This is a direct, published instance of imitating human Catan data
losing to self-play RL on the same task.** This is the 53.36% that Xenou et al. cite.

**Dobre & Lascarides 2018**, *POMCP with Human Preferences in Settlers of Catan*
([AIIDE 2018 PDF](https://ojs.aaai.org/index.php/AIIDE/article/download/13014/12862),
fetched). **The single most relevant paper in this survey.** It uses the *same* 60-game STAC
corpus from Q1 and states the case explicitly: *"we show that learning from human data is
beneficial even if the amount and quality of the data available is very low — in our case, we
had only 60 games rather than millions."* What they extract is not a policy to imitate but a
**distribution over action *types*, used to bias POMCP's forward sampling**. Results
(Table 2, tournament style): POMCP-TS-CR **40.70 / 49.00 / 52.65 / 53.65%** at 10k/20k/30k/40k
simulations against plain POMCP's 33.45 / 42.23 / 44.5 / 47.94%. Ablated without preferences,
it cannot beat 25%. They also tried the obvious alternative — a DNN policy trained
supervised on the same data, used as the PUCT prior (`POMCP-NN`) — and it was **weaker and
slower**. Their earlier *Exploiting Action Categories in Learning Complex Games* (IntelliSys
2017) reports the same idea in a **4-player** setting against 3 Stac agents on the full game:
**53.37% at 50k rollouts, but only 43% with trading disabled**; and *Online learning and
mining human play* (CIG 2015) seeds a flat-UCB opening from the human corpus for **30.43%**
against 28.74% unseeded, on a 25% baseline. **Both of those are from the literature sweep and
were not fetched at the primary — UNVERIFIED**; they point the same way as the AIIDE 2018
table above, and the trading delta is a second argument for ranked item #4. Code is MIT at
<https://github.com/sorinMD/MCTS> (code only, no corpus); the
Catan harness is `StacSettlers`.

**Xenou et al. 2018 (DRRL)** — already reproduced in this repo. `docs/BENCHMARK.md` Phase A
records the outcome honestly: **8.0% [5.4, 11.6]** vs 3x trading AlphaBeta on our engine and
**12.0% [7.0, 19.8]** in the paper's own setting through the Java bridge, against the paper's
45%. Four literal re-readings of the paper were measured individually and none closes the
gap. Nothing in this survey changes that verdict; the most likely explanation remains the
paper's 20-game sample (45% = 9/20, interval [26, 66]).

**Gendre & Kaneko 2020** ([arXiv 2008.07079](https://arxiv.org/abs/2008.07079), PDF fetched).
Cross-dimensional NN — 2D board convolutions and scalar features exchanging information each
layer — trained by pure self-play with no domain knowledge. **56.5% against jsettler, but
1-vs-1, with trading disabled**, after ~5 weeks (30,000 training steps of 1,000×64
experiences). Their own words: *"we also limit the number of players to two instead of three
or more"* and *"our agents do not learn trading — refusing all offers and never initiating
negotiation — due to the limitation in our computational resources."* So the headline is a
50%-parity result in a reduced game. Two of their ablations are directly useful anyway:
removing the policy-activity loss made training unstable, and training only against a fixed
strong opponent overfitted and played *worse* against jsettler than self-play against varied
opponents did.

**Driss & Cazenave, Deep Catan**
([PDF](https://www.lamsade.dauphine.fr/~cazenave/papers/DeepCatanEvo.pdf), fetched). CNN +
PUCT + Expert Iteration — architecturally the closest published thing to what this repo is
doing, and the paper already in FINDINGS' prior-art list. Verified result: **UCTNet won
240/400 = 60% against UCT**, and the second network beat the first at 58%. Evaluated only
against **their own MCTS**, never against jSettlers or a published baseline, so the number
does not place them on any shared scale.

**settlers-rl** (<https://settlers-rl.github.io/>, fetched). Already in FINDINGS' prior art
and still the best public deep-RL attempt: PPO, factored conditional action heads, attention
over tiles, ~450M decisions, ~1 month on 32 cores + a 3090. Two things confirmed from the
write-up: evaluation is **self-play only** (no comparison to Catanatron players or humans),
and their forward search wins **47/100** against the final policy — i.e. search at test time
roughly matches the trained policy rather than dominating it.

**Belle et al. 2025, HexMachina / "Agents of Change"**
([arXiv 2506.04651](https://arxiv.org/abs/2506.04651), v2 HTML fetched;
[OpenReview](https://openreview.net/forum?id=V0Fb4pwhS4)). An LLM multi-agent system that
discovers the Catanatron API, then evolves a *compiled Python player* through code refinement
and simulation. The evolved player is **hand-written heuristic code, not search** —
phase-aware priorities, shallow rollouts, production-diversity and robber heuristics — and it
reaches **54.1% [51, 57]** against AlphaBeta. Crucially the setup is *"2-player, 10-point
Catan games"*, 1v1, AlphaBeta at depth 2 with a 20 s decision cap — and the paper itself
notes AlphaBeta *in self-play scores 51% "by construction"*, so the reported margin over the
baseline is about **3 points**, not 54-vs-25. It is the closest published comparison
to this project's target and **it is a weaker result than v40's**, which beats three
AlphaBetas at once from a 25% baseline. Worth knowing about, not worth chasing.

**Catanatron** itself (<https://github.com/bcollazo/catanatron>) ships the roster this repo
gates against. Its published ladder
(`documentation/advanced/making-catanatron-stronger.md`, fetched verbatim) is **1v1 and very
small-n**, which is worth knowing before quoting it:

| Player | Win rate in 1v1 | n |
|---|---|---|
| AlphaBeta(n=2) | 80% vs ValueFunction | 25 |
| ValueFunction | 90% vs GreedyPlayouts(n=25) | 25 |
| GreedyPlayouts(n=25) | 100% vs MCTS(n=100) | 25 |
| MCTS(n=100) | 60% vs WeightedRandom | 15 |

The doc's only claim about the top is *"The best bot right now is Alpha Beta Search with a
hand-crafted value function."* It says **nothing about depth 3** — a secondary claim that the
Catanatron blog reports depth 3 playing worse than depth 2 was **not verified here** and is
**UNVERIFIED**. (This repo measured its own version of that: depth-3 AB 25.7% [14.2, 42.1]
vs depth-2, FINDINGS.)

### The number nobody in this literature reports: strength against ranked humans

Every win rate above is bot-vs-bot. Two attempts put a Catanatron-class search agent onto
colonist.io, and they are the only human-relative calibration found:

- **Piszczek, BSc thesis, Leiden 2025**
  (<https://theses.liacs.nl/pdf/2024-2025-PiszczekWWiktor.pdf>, fetched). A Catanatron-driven
  search agent, reading the board by screen scraping, played **40 ranked 4-player games** on
  colonist.io: *"The bot reached the rank of bronze 2, rating of 1196... The agent had a win
  rate of 12.5% and collected on average 5.66 points out of 10."* The top-rated human at the
  time was 1982. A tuned variant reached 1234 / **15%** / 6.36 VP; a chat-persuasion variant
  managed 9.1% over 22 games. **Parity in a 4-player game is 25%, so this agent is well
  below an average ranked human.** Caveats: n=40 (Wilson [5.5, 26.1] on 5/40), their own
  value function rather than catanatron's AlphaBeta as shipped, and screen-scraping error.
  Also note that running a bot on colonist.io is itself against the ToS quoted in Q1.
- **Stanford CS230 2021** (same PDF as above, fetched): *"We had our model play 50 games
  against bots on colonist.io, and we were able to win 16 games, a 32 percent win rate."*
  **Against colonist's bots, not humans** — worth stating, because this result is easy to
  misread as a human benchmark.

Taken together, the honest reading is that this project's v40 — and the whole published
field — has never been measured against strong human play, and the one noisy datapoint that
exists suggests a search agent of roughly Catanatron-AlphaBeta class lands **below** average
ranked-human strength. settlers-rl's author reached the same conclusion informally after
~450M decisions of PPO.

**Thomas 2003** (Northwestern PhD, the origin of the jSettlers robot) and any 2023-2026
AlphaZero-style Catan attempt beyond the above: **not verified in this sweep.** An arXiv API
query for `all:"Settlers of Catan"` returned exactly three game-relevant papers (HexMachina,
Cuayáhuitl 2015, and — for Catan as a *dialogue* domain — DinG), and a broader `all:Catan`
query added only Gendre & Kaneko. **There is no recent arXiv AlphaZero-for-Catan paper.**

---

## What this project should actually try, ranked

Ranking rule: a finding earns a slot only if it beats or sharpens the project's own stated
open lever — *"rollout labels are AlphaBeta-continuation values, which cap what the net can
learn about its own (now stronger) play — a net-in-the-loop rollout policy is the natural
next lever"* (FINDINGS 2026-09-03). Nothing that re-proposes a lever FINDINGS already killed
appears here.

**Context that should colour all of it:** the only published measurement of a
Catanatron-class search agent against *ranked humans* is 12.5-15% over 40 games on
colonist.io, against a 25% parity baseline (Q3). v40 beats every bot it has been pointed at,
and there is no evidence anywhere in this literature that that means it would beat good
humans. The headroom is real; the ranking below is about how to spend it.

### 1. Net-in-the-loop rollouts — the repo's own lever, and the code confirms the ceiling

`catan_engine/src/arena.rs:74`: the rollout that produces every training label calls
`decide_rollout()`, which is `heuristic.rs:167` `expectimax_rollout(depth, ...)` **over
`base_fn`**. So every value target answers "what fraction of `rab`-vs-`rab` continuations
from this child does the decider win". v40 beats `rab` 58-60% of the time. **The labels are a
weaker player's estimate of the position than the agent consuming them** — a policy
evaluation of `rab`, not of v40. That is the textbook expert-iteration failure mode (Anthony
et al. 2017: the expert must outclass the apprentice, or the loop has nothing left to teach),
and it explains the flat line at rounds 36-45 more directly than capacity or data.

Cheapest experiment: `Recorder` already carries `roll_depth` with a documented experimental
setting (`1` = `decide_heuristic(1)`). Add a net-driven rollout policy as a third setting and
run one round through the existing head-to-head-on-fresh-seeds protocol. A 1-ply net greedy
is the cheap version; `trade.rs`'s `Eval::Net` shows the plumbing exists.

**Risk, stated:** iteration 9 showed self-labeling can hurt — but it self-labeled the
*argmax* (a classification label). This changes the *rollout policy* behind a Monte-Carlo
value. Different object. The ±2.8-pt proxy gate is exactly the instrument that caught
iteration 9, so the downside is one round.

### 2. A prior over action *types* for the search — and start with the cheap tabular one

This is the one structural piece the agent lacks: an exhaustive depth-2 enumeration with no
prior at all. Depth 3 already blows up to a p95 of 160k leaves with a 20,000-leaf cap bolted
on (FINDINGS 2026-09-02 evening) — precisely the regime a prior exists to fix.

The Catan-specific evidence is unusually direct. **Dobre & Lascarides (AIIDE 2018)** got
**+6 points** (POMCP 47.94% → POMCP-TS-CR 53.65% at 40k sims) by biasing POMCP's forward
sampling with a distribution over **action types**, mined from **60** human games — and the
ablation without it cannot beat 25%. The same paper tried the version most people would reach
for first, a **supervised DNN policy as the PUCT prior**, and reports it **weaker and
slower** than the simple MLE type distribution.

**So the thing to build is a tabular/MLE distribution over action types, biasing which
children the search expands. Nothing neural.** That is the whole of the recommendation, and
it is small enough to try in an afternoon.

*Only if that pays* is a neural policy head worth opening. Reading for that later decision,
not for this build: [Gumbel MuZero (Danihelka et al., ICLR
2022)](https://openreview.net/forum?id=bERaNdoegnO), designed for *few* simulations and
giving monotone policy improvement without visiting every root action; and [Grill et al.,
ICML 2020](https://proceedings.mlr.press/v119/grill20a.html), for why a
visit-count/value-weighted target behaves differently from the naive argmax distillation that
iteration 9 tried.

**Caveat:** M4 exists because reactive policies capped at 79% / 9% here. A prior *inside* the
search is a different object from a policy that plays on its own. That distinction is the bet.

### 3. TreeStrap-style value targets at interior nodes

[Veness, Silver, Uther & Blair, NeurIPS
2009](https://proceedings.neurips.cc/paper/2009/file/389bc7bb1e1c2a5e7e147703232a88f6-Paper.pdf)
— regress the evaluator on the search's own value at *every* interior node, not just a
rollout from a sampled child. It learned master-level chess from random weights by self-play
alone. The tree is already expanded and `record_tree` already samples `K_TS = 5` children
with their values, so this is a denser signal from data the arena already produces. Ranked
below #1 and #2 because it shares iteration 9's self-reference risk and adds no new mechanism.

### 4. Give the trade policy a training signal — it currently has none

`catan_engine/src/actions.rs:133` `search_actions()` filters `Action::OfferTrade` out of the
search entirely, so offers never appear in `record_rollouts`' sampled children and **no trade
decision has ever carried a label**. The net scores hands after a hypothetical trade; nothing
has ever told it whether the trade was a good idea. Scale of the prize: the jSettler port
went from 16.7% to 25.7% vs 3x `rab` purely by switching its negotiator on
(`docs/BENCHMARK.md` Phase E). The minimal version needs no human data — record rollout
labels for offers and replies the way every other decision gets them, sampling to bound the
branching.

### 5. If human data is used at all, use STAC on trading, as type-level preferences

STAC is 60 games, CC BY-NC-SA 4.0, full `.soclog` traces with exact hands (Q1). Two facts
should set expectations: Dobre & Lascarides got real value out of *exactly this corpus* by
extracting type-level preferences; and Cuayáhuitl et al. 2015 got **27%** from a player
trained supervised on a human Catan dialogue corpus versus **53%** from RL on the same task.
So: mine it for priors over *what kind of trade to attempt*, never clone it as a policy.
Practical note — this repo already has `jsettlers_board.py` mapping JSettlers coordinates
onto catanatron's BASE template with a 103-position `--selfcheck`, so the parsing cost here is
lower than it would be for almost anyone else. The licence is non-commercial.

### Explicitly not recommended

- **Offline RL (CQL/IQL), BC warm-start, IRL, preference learning.** Aimed at a data
  constraint this project does not have; the imitation variants are measured dead in FINDINGS
  (BC-from-VFP 7.8% vs 3x VFP; `v1_interim` 3.8% vs 3x AB) and lost to RL in Catan in the
  published record too.
- **Colour-permutation augmentation.** Already quotiented out by the perspective-relative
  encoder (`encode.rs:70`).
- **Board rotation/reflection augmentation.** A real symmetry, but it buys data, which is in
  surplus, and the static tile features it would permute are masked at the net's input anyway.
- **Deeper search with the current evaluator.** Measured: depth-3 AB 25.7% [14.2, 42.1] vs
  depth-2, and every deeper/reshaped tree scored *below* depth 2 with the same net.
- **Bigger net / more epochs / more GPU.** CLAUDE.md's standing constraint; the width sweep
  found nothing above 128.
- **Chasing HexMachina's 54%.** It is a 2-player, 1-vs-1 result against a 50% parity
  baseline. v40 already beats three AlphaBetas at once from 25%.
