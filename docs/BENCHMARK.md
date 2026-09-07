# Benchmark: the EUMAS 2018 protocol, and the road to the paper's real opponents and its agent

Reference: K. Xenou, G. Chalkiadakis, S. Afantenos, *Deep Reinforcement Learning in Strategic Board Game
Environments*, EUMAS 2018 (hal-02124411). Their DRRL agent handled only trade offers/replies inside jSettlers and was
evaluated two ways:

- **Fig. 3a — pool tournaments.** Five agents (DRRL, jSettler, UCT, BUCT, VPI); five 4-player tournaments of 20
  games, each leaving one agent out, so every agent played 80 games; metric = win ratio. DRRL 31%, jSettler 21%,
  VPI 22%, BUCT 26%, UCT 23%.
- **Fig. 3b — vs 3x jSettler.** DRRL 45% over 20 games (56% = 17/30 after 30 sequential games); the pre-trained DRL
  agent of Cuayáhuitl et al. it cites: 53.36%.

## Phase 1 (done): the protocol on catanatron's roster

`tournament.py` runs the Fig. 3a protocol. Differences from the paper, all deliberate: 100 games per tournament
instead of 20 (Wilson intervals of about ±5 points instead of ±10), seats permuted per game from the seed, and the
pool is what exists in Python today:

| role in the paper | here | why |
|---|---|---|
| DRRL (the learned agent) | `vnet:checkpoints_value/v40.pt` — depth-2 expectimax over the learned win-probability net | our agent |
| jSettler (state-of-the-art hand heuristic) | catanatron `AlphaBetaPlayer` (depth-2 search over `base_fn`) | the strongest shipped heuristic; the M4 gate |
| UCT | catanatron `MCTSPlayer(num_simulations=100)` | the only MCTS in the roster; 100 simulations ≈ 25 s/game, 10x the default |
| BUCT / VPI | `ValueFunctionPlayer` (1-ply greedy over `base_fn`), `WeightedRandomPlayer` | no Bayesian MCTS exists here; these bracket the field from below |

Excluded: `GreedyPlayoutsPlayer` (34 s/game at 5 playouts and it prints to stdout). Timing (2 games each, three
`ValueFunctionPlayer` opponents): `mcts` 2.3 s/game, `mcts30` 8.0 s, `gp5` 34.3 s, `ab` 1.0 s. A 12-game check
confirmed the value-net player wins from every seat colour (it had only ever been evaluated at Blue).

Results: see the table below (filled in from `docs/benchmark/paper_protocol.json` when the run finishes) and the
site's Results page. The Fig. 3b analogue is the existing headline: **v40 552/1000 = 55.2% [52.1, 58.3] vs 3x
`AlphaBetaPlayer`** (docs/FINDINGS.md 2026-09-03).

| agent | games | wins | win ratio | 95% CI | mean VP | T0 (no vnet(v40)) | T1 (no ab) | T2 (no mcts100) | T3 (no vf) | T4 (no wr) |
|---|---|---|---|---|---|---|---|---|---|---|
| vnet(v40) | 400 | 288 | 72.0% | [67.4, 76.2] | 9.07 | – | 83/100 | 70/100 | 71/100 | 64/100 |
| ab | 400 | 129 | 32.2% | [27.9, 37.0] | 7.07 | 61/100 | – | 21/100 | 29/100 | 18/100 |
| mcts100 | 400 | 0 | 0.0% | [0.0, 1.0] | 2.50 | 0/100 | 0/100 | – | 0/100 | 0/100 |
| vf | 400 | 83 | 20.8% | [17.1, 25.0] | 6.36 | 39/100 | 17/100 | 9/100 | – | 18/100 |
| wr | 400 | 0 | 0.0% | [0.0, 1.0] | 2.67 | 0/100 | 0/100 | 0/100 | 0/100 | – |

500 games, 2811 s wall-clock on 7 workers, 39.1 s/game on average, 0 games without a winner. Seeds 1000000–1000499, tournament k uses seeds 1000000+100k…; `uv run python tournament.py --games 100` reproduces it.

Read against the paper's Fig. 3a (DRRL 31%, jSettler 21%, VPI 22%, BUCT 26%, UCT 23%): our learned agent's win ratio is 72.0% [67.4, 76.2] in a pool where the hand-heuristic search (the jSettler analogue) gets 32.2% and catanatron's MCTS player, with random playouts, 0.0%. The MCTS number says more about random-playout MCTS on Catan's branching factor than about search in general — the paper's own MCTS agents also trailed jSettler — and is the reason Phase 3 implements the thesis agents instead of scaling this one.

Domestic trading was added to both engines after this run (docs/FINDINGS.md 2026-09-03, trading entry); v40 scores
58.3% [52.7, 63.8] over 300 games vs 3x trading AlphaBeta. The table above was measured without trading and has not
been re-run yet.

## Phase A (done 2026-09-07): the paper's own agent, DRRL, reproduced

What DRRL is (Sect. 3-4 of the paper): a **trade-only** layer over a stock jSettler. 72 actions = 70 offers (give 1-2
cards, get 1) + accept + reject; one network per action, LSTM -> linear head -> Q^i; input = the 161-int state of
Table 1 plus the previous chosen Q fed back; online SGD at every trade decision (lr 0.0023, no replay, no target
net); reward r = dVP*k if dVP > 0 else -VP*k with k = 0.01; weights fresh every game (Fig. 3a/3b) or kept across 30
games (the 56% number). Everything else is the jSettler's decision.

`catan_engine/src/drrl.rs` is that agent; `value_net.make_player("drrl")` runs it over the Rust depth-2 heuristic
search (the jSettler's role until Phase B); the site's `drrl` bot is the same code through `wasm.rs`. Choices the
paper leaves open, as implemented:

| open point | paper | here |
|---|---|---|
| input width | 161 (jSettlers' 7x7 hex grid, 80 edges) | 154 = 5 hand + 19 tiles + 54 nodes + 72 edges + robber + turns + VP + Q-hat |
| feature scale | raw integers | each divided by its Table 1 domain max |
| "LSTM layer ... 72 independent LSTM units" | unspecified size | one LSTM cell per action, hidden = input width (154), plus theta^i in R^154 |
| output "normalised by softmax to [0,1]" | softmax on a scalar is 1 | sigmoid |
| gamma | unspecified | 0.9 |
| gradient through time | unspecified | one step (a TF1 session with fed-back state); hidden state held constant |
| which heads update | Alg. 1 updates every i with the same r | every head toward the same target r + gamma * max over the legal heads |
| init | theta truncated normal | all weights truncated normal (|z| <= 2), sigma 0.1, biases 0 |
| exploration | none (argmax) | none |
| counter-offers | a reply may be a new offer | the engine's replies are accept/reject; offers are made on the player's own turn, at most 3 per turn |
| decisions per game | "at most about 70" | about 100 (offers + every reply) |

Cost: 13.7 M weights per seat (55 MB), about 15 ms per decision in Python/Rust and 20 ms in wasm; a game with one
DRRL seat runs in 1.3 s against three `rab`. At the paper's reward scale the TD error is ~1e-4, so a single SGD step
at lr 0.0023 moves a head's estimate by less than f32 resolution: within one game the agent is, in effect, its
initial weights plus a handful of large-error steps. This is what the paper describes ("alternated among 3 or 4
actions") and is recorded here rather than corrected.

Results (this engine, DRRL over the heuristic base, fresh weights per game, `evaluate.py --player drrl --opponent
alpha_beta --games 300 --seed 0`): **24/300 = 8.0% [5.4, 11.6] vs 3x trading AlphaBeta** (the base alone: `rab` alone 76/300 = 25.3% [20.7, 30.5], same seeds).
The trade layer costs its base most of its wins: with effectively untrained heads DRRL accepts 30% of the offers it
receives (246 of 833 over 20 games vs 3x `rab`) while only 7% of its own ~35 offers per game are taken, and every
offer a 1-ply AlphaBeta makes is favourable to the offerer by construction, so DRRL's seat bleeds cards all game. The paper's opponents were jSettlers, whose offers come from their own build plan, not from a
valuation of the responder's hand; the Phase B runs are the test of whether the paper's 45% depends on that.

### Phase A follow-up (2026-09-07): the paper's literal readings, measured one by one

The 8.0% / 12.0% above use the readings in the table. Re-reading the paper (the HAL manuscript, the only
version on disk; Xenou's TU Crete thesis is on ANAC negotiation, not DRRL) gives four points where the
text supports a different, more literal implementation than `drrl` takes. Each is a one-letter flag on the
token (`drrl:blcw` = all four), so they can be measured alone and together:

| flag | the paper says | `drrl` does | the flag does |
|---|---|---|---|
| `b` | Eq. 5: phi_j(s_t) = (1 - sigmoid(s_j)) phi_j(s_{t-1}) + sigmoid(s_j) tanh(s_j), applied per state variable; the network's only parameters are the theta^i | a real LSTM cell per action (the user's choice), scaled inputs | the weightless Eq. 5 recurrence on the raw integer features; theta^i (154 weights per head) is all that trains |
| `l` | Algorithm 1: at time t, SGD on every Q^i(s_t) toward r + gamma Q-hat, where Q-hat is the input (the previous step's chosen value), then argmax | the standard one-step TD update: the previous state's heads move toward r + gamma max over the legal heads now | the current state's heads move toward r_t + gamma Q-hat_{t-1} before the action is chosen (line 11 re-evaluates) |
| `c` | "accept, reject, or make a counter-offer"; "rarely accepting ... it would rather counter-offer" | replies are accept/reject | a reply's legal set is accept, reject and every affordable offer; an offer head wins = a counter-offer (through the bridge as a JSettlers counter-offer to the offerer; the engine cannot express it and rejects instead) |
| `w` | theta "initialized with a truncated normal distribution" (TensorFlow's default sigma is 1), LSTM defaults | sigma 0.1 everywhere | theta sigma 1, glorot-uniform LSTM kernel, forget bias 1 |

Arena screen, each variant vs 3x `rab`, 300 games, seeds 0.., seat order per seed (`docs/benchmark/drrl_variants.txt`):

| variant | win ratio | | variant | win ratio |
|---|---|---|---|---|
| `drrl` | 8.0% [5.4, 11.6] | | `drrl:bl` | 7.3% [4.9, 10.9] |
| `drrl:b` | 7.0% [4.6, 10.5] | | `drrl:lw` | 8.3% [5.7, 12.0] |
| `drrl:l` | 8.0% [5.4, 11.6] | | `drrl:blw` | 7.3% [4.9, 10.9] |
| `drrl:c` | 10.7% [7.7, 14.7] | | `drrl:lcw` | 9.3% [6.5, 13.2] |
| `drrl:w` | 9.0% [6.3, 12.8] | | `drrl:blcw` | 10.7% [7.7, 14.7] |

Through the bridge, the paper's own setting (DRRL deciding only trades over a stock jSettler, 3 stock jSettlers
as opponents, default mix, 100 games each):

| series | win ratio | mean VP |
|---|---|---|
| `drrl` (the table's readings; from Phase B) | 12.0% [7.0, 19.8] | 6.58 |
| `drrl:c` | 16.0% [10.1, 24.4] | 6.73 |
| `drrl:lcw` | 12.0% [7.0, 19.8] | 6.37 |
| `drrl:blcw` (all four literal readings) | 5.0% [2.2, 11.2] | 6.30 |
| `drrl+` over 30 sequential games (from Phase B) | 10.0% [5.5, 17.4] | 6.52 |
| `drrl+:blcw` over 30 sequential games | 20.0% [9.5, 37.3] | 6.57 |
| `drrl+:c` over 30 sequential games | 6.7% [1.8, 21.3] | 5.80 |

Reading: none of the literal readings, alone or together, moves DRRL toward the paper's 45%. `l` alone changes
nothing measurable because, at the paper's reward scale, neither update rule moves the weights within a game
(`drrl` and `drrl:l` win the same 24 seeds). Counter-offers (`c`) are the one reading that matters, +3 to +4
points on both arenas, which fits the paper's remark that its agent countered rather than accepted; the
weightless basis (`b`) makes the agent 10x cheaper and no better, and with everything literal it is the
weakest of all. The gap to the paper is not in the network or the update; the remaining candidates are the
opponents' replies (the paper's jSettlers accepted enough of DRRL's 10-40 offers per game to matter; here the
stock brain accepts 7% of them) and the paper's 20-game sample (45% = 9/20, whose 95% interval is
[26%, 66%]).

## Phase B (done 2026-09-07): real jSettlers through a Java bridge

Facts checked 2026-09-03/07: JSettlers2 (github.com/jdmonin/JSettlers2, GPL-3) release 2.6.10 ships
`jsettlers-2.6.10-full.tar.gz` (jars + sources); gradle is not needed, `javac --release 17 -cp` against
`JSettlersServer-2.6.10.jar` is the whole build. A robot client the server starts in its own JVM
(`-Djsettlers.bots.start3p=1,<class>`) is seated like a built-in bot; bots-only games run in 20-40 s with
`jsettlers.bots.fast_pause_percent=1`. The built-in robot is `soc.robot` (27 files, 22,847 lines: SOCRobotBrain 5.5k,
SOCPlayerTracker 4.2k, SOCRobotDM 3.4k, SOCRobotNegotiator 2.7k, OpeningBuildStrategy 1.1k, SOCBuildingSpeedEstimate
1.1k). The server hands `robot N` bots `ROBOT_PARAMS_SMARTER` (SMART_STRATEGY) and `droid N` bots
`ROBOT_PARAMS_DEFAULT` (FAST_STRATEGY), 30% of `jsettlers.startrobots` being droids; `SOCRobotBrain` exposes every
decision as a `protected` hook or a strategy object.

What was built:

- `jsettlers/BridgeClient.java`, `BridgeBrain.java` (GPL-3): a `SOCRobotBrain` whose decisions come from our decision
  server over a pipe, in two modes. `full`: opening placements, roll-or-knight, the main-phase action (a build becomes
  a one-piece plan the stock brain requests; dev cards, bank trades and offers are sent directly and the brain
  re-plans), robber hex and victim, discards, monopoly / year-of-plenty picks, replies to offers. `trades`: only
  offers and replies (never counter-offers), the stock brain plays the rest: the paper's DRRL-over-jSettler setup.
  `Launch.java` pins every built-in to smart or fast (`MIX=smart|fast`). `jsettlers/run.sh build | play`.
- `jsettlers_server.py`: rebuilds a catanatron `Game` from the client's view of `SOCGame` at every decision and asks
  any `value_net.make_player` token, so `vnet:<path>`, `ab`, `rab`, `drrl`, `drrl+` (weights kept across games) all
  play unchanged; replies in JSettlers terms. `jsettlers_board.py` maps JSettlers' classic-board coordinates onto
  catanatron's BASE template by geometry (the port ring is three-fold symmetric, so three rotations fit; any is a
  valid board). `--selfcheck` sends 103 positions from catanatron games through the client's view and back and
  compares the Rust state spec field by field; `tools/jsettlers_results.py` tabulates the result files.
- Deviations, all in `jsettlers_server.py`: opponents' unknown resource cards are spread over the resources they
  produce, their hidden dev cards count as knights, their VP are the public ones, the dev deck is a seeded shuffle of
  the unseen cards, the bank is 19 minus every card in hand; JSettlers responders may counter-offer, ours accept or
  reject; the bridge repeats no offer within a turn (the engine's spent-offer rule); in `full` mode the stock brain
  only asks for a plan with more than one card in hand, so a dev card held with an otherwise empty hand waits a turn.

Runs: `PORT=<p> MIX=<mix> jsettlers/run.sh play 100 <mode> <token> docs/benchmark/jsettlers_<series>.txt`, one server
per series, one bridge bot among four built-ins (`jsettlers.bots.percent3p=25` seats it in every game). Results:

100 bots-only games per series, 2026-09-07, `jsettlers.bots.fast_pause_percent=2`, five servers at a time; default
mix = the server's own 1 fast + 3 smart robots per 4-bot pool, `smart` / `fast` = every built-in pinned to that
parameter set. (An earlier pass of the same series ran with a rebuild-order bug, roads continuing past an enemy
settlement, and with ten servers plus a tournament on eight cores; it is superseded by this one.)

| series | games | wins | win ratio | 95% CI | mean VP | opponents seen |
|---|---|---|---|---|---|---|
| jsettlers_buct_full_default | 100 | 30 | 30.0% | [21.9, 39.6] | 8.10 | droid, robot |
| jsettlers_drrl_full_default | 100 | 9 | 9.0% | [4.8, 16.2] | 6.05 | droid, robot |
| jsettlers_drrl_trades_default | 100 | 12 | 12.0% | [7.0, 19.8] | 6.58 | droid, robot |
| jsettlers_drrlpersist_trades_default | 100 | 10 | 10.0% | [5.5, 17.4] | 6.52 | droid, robot |
| jsettlers_rab_full_default | 100 | 20 | 20.0% | [13.3, 28.9] | 7.34 | droid, robot |
| jsettlers_uct_full_default | 100 | 34 | 34.0% | [25.5, 43.7] | 7.88 | droid, robot |
| jsettlers_v40_full_default | 100 | 44 | 44.0% | [34.7, 53.8] | 8.12 | droid, robot |
| jsettlers_v40_full_fast | 100 | 48 | 48.0% | [38.5, 57.7] | 8.10 | droid, robot |
| jsettlers_v40_full_smart | 100 | 34 | 34.0% | [25.5, 43.7] | 7.91 | droid, robot |
| jsettlers_vpi_full_default | 100 | 10 | 10.0% | [5.5, 17.4] | 7.00 | droid, robot |

Read against the paper: our search agent wins 44.0% [34.7, 53.8] of its games against three stock jSettlers
(48.0% against all-fast, 34.0% against all-smart), where the paper's pre-trained DRL agent reached 53.36% and its
DRRL 45% / 56%; the Rust heuristic alone wins 20.0%, so the value net adds about 24 points over its own base against
this opponent. DRRL reproduced over the real jSettler wins 12.0% [7.0, 19.8] fresh per game and 10.0% [5.5, 17.4]
with weights kept across the 100 sequential games, against the paper's 45% and 56% (20-30 game numbers, so [25, 67]
and [38, 73] as intervals); DRRL over the Rust heuristic 9.0%. A stock jSettler seat is a 25% baseline by
construction, so the DRRL reproduction sits well below a stock jSettler, and the persisted weights do not help. The
thesis MCTS agents through the bridge: UCT 34.0%, BUCT 30.0%, VPI 10.0% (thesis: 9%, 14%, 17% at its 15 s budget;
see Phase D). Incidents over the 1,000 games: 1 forced turn-end, 1 rejected build, 13 duplicate bank trades (the
stock brain re-plans on a not-yet-updated hand when the server is slow; the duplicate is refused and play goes on).

## Phase D (done 2026-09-07): the thesis MCTS agents, so the pool matches the paper's

The agents come from E. Karamalegos, *Monte Carlo tree search in the Settlers of Catan strategy game* (TU Crete 2016,
DOI 10.26233/heallink.tuc.66891, CC-BY; the earlier K. Panousis thesis, DOI 10.26233/heallink.tuc.18113, is the
trade-less agent it improves on). The PDF sits behind the library's Anubis challenge; it was read through the
browser on 2026-09-07. No source code was published.

Settings, as the thesis states them: action set = build city / settlement / road, buy dev card, empty action, one
node per action and spot, with bank/port trades folded into the legal set; player trades are JSettlers' own
negotiator, run before the search; tree policies UCT (C_p = 1/sqrt 2, unvisited = infinity, ties random), BUCT
(Tesauro's second rule, mean + sqrt(2 ln N) * sigma over Dirichlet posteriors), VPI (myopic value of perfect
information over Dirichlet posteriors sampled through Gamma draws, choose max E[q] + VPI); playouts uniformly random
over the same action set for every player, dice from the 2d6 CDF, until 10 VP or a round cut-off of c rounds
(c in {5, 10, 15, 30}, max(3, c - r) for real round r <= 20, max(3, c/2) after; 10 was best); reward = every
player's VP scaled to [0, 1], plus a dev-card value estimate from the remaining-knights odds; backups add the reward
(UCT) or a Dirichlet count (BUCT, VPI); budget 15 s per decision (UCT 3,000-10,000 playouts, BUCT 2,000-9,500, VPI
500-3,000); robber, monopoly, road-building, discards and the STAC initial placement are JSettlers' or Dobre &
Lascarides' code. Results vs 3 JSettlers at depth 10 over 100 seeded games: UCT 9%, BUCT 11-14%, VPI 17%; against 3
random players UCT 72-74%, JSettlers 90%.

`catan_engine/src/mcts.rs` is that agent on this engine: the tree over the agent's own post-roll turn, random
playouts to the round cut-off (c = 10), the three selection rules, the VP reward; budgets are playout counts at the
thesis' midpoints (UCT/BUCT 5,000, VPI 1,500; ~0.25 s per decision here, 120 applied actions per playout). Tokens
`uct`, `buct`, `vpi` (`uct2000` = 2,000 playouts); wasm bots of the same names. Deviations: the engine is fully
observable, so the playouts see opponents' hands; every prompt the search does not own (initial placement,
roll-or-knight, robber, discard, offers and replies) goes to the heuristic bot and the 1-ply trade policy; dev
cards are played by the search itself and valued by the playout rather than the thesis' knight estimate; BUCT's
interior nodes use their own Dirichlet rather than the extremum distribution.

Runs: the paper's exact pool on the Rust arena (`tournament.py --pool drrl,rab,uct,buct,vpi` with `rab` as the
jSettler stand-in until Phase E; Fig. 3a: DRRL 31%, jSettler 21%, VPI 22%, BUCT 26%, UCT 23%) and the same pool
plus v40 (every 4-subset); each MCTS agent vs 3 jSettlers through the bridge (`full=uct` etc.; thesis 9 / 14 / 17%).

Results on the Rust arena (`uv run python tournament.py --pool drrl,rab,uct,buct,vpi --games 100`, 500 games in
1,235 s on 7 workers, seeds 1000000-1000499, 0 games without a winner):

| agent | games | wins | win ratio | 95% CI | mean VP | T0 (no vpi) | T1 (no buct) | T2 (no uct) | T3 (no rab) | T4 (no drrl) |
|---|---|---|---|---|---|---|---|---|---|---|
| drrl | 400 | 31 | 7.8% | [5.5, 10.8] | 5.22 | 6/100 | 8/100 | 7/100 | 10/100 | – |
| rab | 400 | 112 | 28.0% | [23.8, 32.6] | 7.19 | 24/100 | 26/100 | 35/100 | – | 27/100 |
| uct | 400 | 181 | 45.2% | [40.4, 50.1] | 8.05 | 44/100 | 54/100 | – | 40/100 | 43/100 |
| buct | 400 | 129 | 32.2% | [27.9, 37.0] | 7.72 | 26/100 | – | 44/100 | 36/100 | 23/100 |
| vpi | 400 | 47 | 11.8% | [9.0, 15.3] | 6.66 | – | 12/100 | 14/100 | 14/100 | 7/100 |

The paper's Fig. 3a had DRRL 31%, jSettler 21%, VPI 22%, BUCT 26%, UCT 23%. Here UCT beats the heuristic search
outright and BUCT edges it, VPI trails both, and DRRL is last: the MCTS ordering is the reverse of the thesis'
(VPI > BUCT > UCT vs 3 JSettlers). Open question, to check with `vpi5000` (equal budgets): whether the inversion
is the playout budget (VPI runs 1,500 playouts to UCT's 5,000, as in the thesis' own counts), the Dirichlet
prior of one count per VP value, or this engine's much cheaper playouts favouring the plain average.

The same pool with v40 added, every 4-subset (`--pool vnet:checkpoints_value/v40.pt,drrl,rab,uct,buct,vpi --games 40`,
15 lineups, 600 games in 2,517 s on 2 workers):

| agent | games | wins | win ratio | 95% CI | mean VP | T0 (no buct+vpi) | T1 (no uct+vpi) | T2 (no uct+buct) | T3 (no rab+vpi) | T4 (no rab+buct) | T5 (no rab+uct) | T6 (no drrl+vpi) | T7 (no drrl+buct) | T8 (no drrl+uct) | T9 (no drrl+rab) | T10 (no vnet(v40)+vpi) | T11 (no vnet(v40)+buct) | T12 (no vnet(v40)+uct) | T13 (no vnet(v40)+rab) | T14 (no vnet(v40)+drrl) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vnet(v40) | 400 | 183 | 45.8% | [40.9, 50.6] | 8.00 | 22/40 | 18/40 | 22/40 | 16/40 | 18/40 | 20/40 | 14/40 | 12/40 | 22/40 | 19/40 | – | – | – | – | – |
| drrl | 400 | 21 | 5.2% | [3.5, 7.9] | 5.14 | 2/40 | 1/40 | 2/40 | 2/40 | 1/40 | 1/40 | – | – | – | – | 3/40 | 5/40 | 2/40 | 2/40 | – |
| rab | 400 | 110 | 27.5% | [23.4, 32.1] | 7.17 | 7/40 | 13/40 | 10/40 | – | – | – | 9/40 | 14/40 | 9/40 | – | 15/40 | 6/40 | 19/40 | – | 8/40 |
| uct | 400 | 143 | 35.8% | [31.2, 40.6] | 7.83 | 9/40 | – | – | 14/40 | 17/40 | – | 8/40 | 11/40 | – | 13/40 | 9/40 | 29/40 | – | 14/40 | 19/40 |
| buct | 400 | 111 | 27.8% | [23.6, 32.3] | 7.60 | – | 8/40 | – | 8/40 | – | 15/40 | 9/40 | – | 8/40 | 7/40 | 13/40 | – | 16/40 | 18/40 | 9/40 |
| vpi | 400 | 32 | 8.0% | [5.7, 11.1] | 6.46 | – | – | 6/40 | – | 4/40 | 4/40 | – | 3/40 | 1/40 | 1/40 | – | 0/40 | 3/40 | 6/40 | 4/40 |

Each MCTS agent vs 3 stock jSettlers through the bridge (Phase B table): UCT 34.0% [25.5, 43.7], BUCT 30.0% [21.9,
39.6], VPI 10.0% [5.5, 17.4], against the thesis' 9%, 14%, 17%. UCT and BUCT are far stronger here than in the
thesis (cheaper playouts buy the same counts against a fully observable state; the thesis' 15 s budget in JSettlers
bought the same numbers but its agent was one JSettlers client among four), VPI is in the thesis' range but at the
bottom of ours instead of the top. Budget is not the reason: `vpi5000` (VPI at UCT's 5,000 playouts, same pool, 500 games, `paper_pool_vpi5000.json`)
wins 11.0% [8.3, 14.4] against 11.8% at 1,500. What remains to try is the Dirichlet prior (one count per VP value is
11 pseudo-counts pulling every young node to 0.5) and the sampled myopic gain against Dearden's closed form.

## Phase E (2026-09-07): `jsettler.rs`, the jSettler on the site

The JSettlers 2.6.10 robot is ported module by module to `catan_engine/src/jsettler/`
(`bse` building-speed estimates, `geom` the classic board's coordinates, `jcoll` the Java collection
orders that decide ties, `player` legal/potential sets and longest-road paths, `tracker` possible pieces and
ETAs, `opening` the initial placement, `dm` the build plan, `negotiator` offers and replies, `brain` the turn
flow with the robber, discard and monopoly strategies). Tokens `jsrobot` (SMART_STRATEGY, "robot N"),
`jsdroid` (FAST_STRATEGY, "droid N"), `jsettler` = `jsrobot`; the site's bots of the same names.

The oracle is the bridge's log mode with the strategy pinned (`JAVA_OPTS="-Dbridge.strategy=smart
-Dbridge.oracle=data/jsettlers_oracle_smart" jsettlers/run.sh play 40 log rab ...`): every piece the
client's trackers see, in server order, then at every stock-brain hook the decision taken, the trackers'
ETAs, the planning bot's potential sets, each tracker's possible pieces and the decision maker's favourite
pieces with their scores. `tools/jsettlers_oracle.py` replays the pieces through the port and compares:

| quantity | port | match |
|---|---|---|
| building ETAs from now (fast) | `bse.rs` | 100% (5808 + 2842 fast-strategy) |
| planInitialSettlements, planSecondSettlement, planInitRoad | `opening.rs` | 100% (76 + 76 + 152) |
| potential settlements and roads of the planning bot | `player.rs` | 100% (331 + 327) |
| longest-road, largest-army and win-game ETA, all seats | `tracker.rs` | 100% (13k+) |
| possible settlements (with necessary-road counts), roads, cities, all seats | `tracker.rs` | 100% (1308) |
| the build plan, smart strategy | `dm.rs` | 100% (307), favourite settlement / city / road and their scores 100% |
| the build plan, fast strategy | `dm.rs` | 100% (867) |
| replies to offers (considerOffer2) | `negotiator.rs` | 397 / 400 |
| offers made (makeOffer), with the client's trade messages replayed into its bookkeeping | `negotiator.rs` | 293 / 325 (the rest: the offer simulations read opponents' hands, which the Java client sees as unknown cards and the port sees exactly) |

Java behaviours a clean reimplementation would miss, all reproduced: at the first regular turn
`SOCGame.updateAtGameFirstTurn` clears every player's potential settlements, which only come back through
new roads (a jSettler builds a road before its first settlement); `SOCRobotDM.getDevCardScore` recomputes the
real trackers with an extra VP card in the planner's hand and never recomputes after, so every plan is made
with the planner's own win ETA one card better than it is; the smart strategy's road scoring takes the road
ETA from the ship column (an inverted type test); `SOCPossibleSettlement.updateSpeedup` is commented out, so
settlement speedups are always zero; tracker copies relink necessary roads and conflicts but drop threats;
temporary pieces leave the players' longest-road paths as they recomputed them, restored by the decision
maker at two points only; `HashSet<Integer>` and `Hashtable` iteration orders decide the strict argmaxes.

Deviations of the port, recorded: the engine's trade round has no counter-offers, so a reply the Java would
counter is a rejection here (the Java counters far more than it accepts); the port sees opponents' hands and
dev cards (the Java client sees unknown cards), which the negotiator's simulations of the other players'
plans use; rejections of other players' offers are not observed (`recordResourcesFromRejectAlt`); the
Java's unseeded random choices (robber fallback, discards without a plan) use the engine's seeded stream.

Results (100 games unless noted; win ratios with 95% Wilson intervals):

| series | win ratio |
|---|---|
| `jsrobot` vs 3x `rab`, arena, 300 games, no negotiator | 16.7% [12.9, 21.3] |
| `jsdroid` vs 3x `rab`, arena, 300 games, no negotiator | 11.7% [8.5, 15.8] |
| `jsrobot` vs 3x `rab`, arena, 300 games | 25.7% [21.1, 30.9] |
| `jsdroid` vs 3x `rab`, arena, 300 games | 15.7% [12.0, 20.2] |
| `jsrobot` vs 3 stock jSettlers through the bridge (full mode, default mix), 97 games | 32.0% [23.5, 41.8] |
| the same with the negotiator off, 97 games | 16.5% [10.4, 25.1] |

A stock jSettler in that seat wins about 25% (four equals); the port with its negotiator is inside that range
and the one without is not: the negotiator is what the paper says it is, the jSettler's edge.

The paper's exact pool on the Rust arena at last (`tournament.py --pool drrl,jsrobot,uct,buct,vpi --games 100`,
`docs/benchmark/paper_pool_jsrobot.json`), against Fig. 3a:

| agent | here | paper |
|---|---|---|
| DRRL | 9.0% [6.6, 12.2] | 31% |
| jSettler (`jsrobot`) | 20.8% [17.1, 25.0] | 21% |
| UCT | 47.2% [42.4, 52.1] | 23% |
| BUCT | 34.5% [30.0, 39.3] | 26% |
| VPI | 13.5% [10.5, 17.2] | 22% |

The jSettler lands on the paper's number; the MCTS agents (fully observable engine, playouts at Rust speed)
and DRRL (Phase A) are where they were in the Phase D pool.

### The plan (2026-09-07)
Port the decision core of `soc.robot` to `catan_engine/src/jsettler/`, validated module by module against the
Phase B passthrough log, then end to end (the port through the bridge vs 3 Java jSettlers should score ~25%,
indistinguishable from a fourth jSettler; then vs `ab` and v40 on the Rust arena). Scenario/ship/`SC_*` code is
dropped throughout; `SOCPlayerTracker`'s incremental bookkeeping (~1.5k lines of add/undo/cancel) is replaced by a
rebuild from `State` at each decision.

1. `bse.rs` <- `SOCBuildingSpeedEstimate` + `SOCNumberProbabilities` (1.1k): rolls per resource, ETA from
   nothing/now, fast and accurate variants. Oracle: logged `building_etas`.
2. `tracker.rs` <- `SOCPlayerTracker` (4.2k -> ~1.5k): possible roads/settlements/cities with necessary-road chains,
   threats, LR/LA ETAs, `win_game_eta`. Oracle: logged `win_game_eta[]`.
3. `opening.rs` <- `OpeningBuildStrategy` (1.1k). Oracle: logged initial placements.
4. `dm.rs` <- `SOCRobotDM` (3.4k): `plan_stuff` FAST then SMART, settlement scoring, `dev_card_score`,
   `resource_choices`, `should_play_knight_for_la`; `SOCRobotParameters` for `droid` / `robot`.
5. `brain.rs` <- the decision parts of `SOCRobotBrain` (~1k of 5.5k) + `RobberStrategy`, `DiscardStrategy`,
   `MonopolyStrategy`; RNG injected from `State` so the site is deterministic per seed.
6. `negotiator.rs` <- `SOCRobotNegotiator` (2.7k): `make_offer`, `consider_offer2`, bank offers, isSelling /
   wantsAnotherOffer bookkeeping as per-seat state. Counter-offer -> reject (engine gap, recorded).
7. Tokens `jsettler` / `jsdroid` / `jsrobot`; wasm bot `jsettler`.

Alternative second opinion on "MCTS": StacSettlers (github.com/ruflab/StacSettlers, GPL; Edinburgh) ships Java
MCTS agents (`sorinMD/MCTS`, MIT) and a bulk `Simulation` harness; runnable against the Phase B bridge in a day once
that exists, not before.
