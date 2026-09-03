# Benchmark: the EUMAS 2018 protocol, and the road to the paper's real opponents

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

## Phase 2 (planned, ~1 week): real jSettlers, the literal Fig. 3b number

Facts checked 2026-09-03: JSettlers2 (github.com/jdmonin/JSettlers2, GPL-3) is at release 2.6.10 / main 2.7.00.
Bots are plain TCP clients (`DataOutputStream.writeUTF` frames of `<type>|field|...`); non-Java clients are
explicitly supported (`doc/Readme.developer.md`, "Network Communication and interop with other versions or
languages"). A client that sends `SOCImARobot` with the server's cookie (`-Djsettlers.bots.cookie=...`) is seated
like a built-in bot; bots-only games run in ~2 minutes with `jsettlers.bots.fast_pause_percent=1` and can be driven
in bulk with `jsettlers.bots.botgames.total/parallel/gametypes`. The built-in robot lives in `soc.robot` (27 files,
22,969 lines: SOCRobotBrain 5.6k, SOCPlayerTracker 4.2k, SOCRobotDM 3.4k, SOCRobotNegotiator 2.7k,
OpeningBuildStrategy 1.1k, SOCBuildingSpeedEstimate 1.1k) with "fast" (`droid N`) and "smart" (`robot N`) parameter
sets; the 7 default bots are a mix. No Python or Rust port of that robot, and no Catanatron bridge, exists anywhere.

1. Vendor `JSettlers2` (release 2.6.10) under `vendor/` (gitignored) and fetch the two theses (below) into
   `docs/papers/`.
2. `jsettlers/` (Java, GPL-compatible because it links JSettlers): a `SOCRobotClient`/`SOCRobotBrain` subclass
   modelled on `soc.robot.sample3p`. JSettlers keeps doing state tracking and protocol handling; at each decision
   point (initial placement, play-turn, discard, robber move, trade reply = always reject) it serialises `SOCGame`
   to the engine's state spec and asks a local decision server.
3. Decision server = the Rust engine as a small process (`catan_engine` bin or `serve` feature): JSON state in,
   canonical action out, via `decide_vnet` / `decide_heuristic`. No torch and no Python in the loop — the value net
   already lives in Rust (`catan_engine/src/valuenet.rs`). Board mapping is a one-off table from JSettlers'
   classic 4-player hex/node/edge coordinates to the engine's node ids; JSettlers' port positions differ from
   catanatron's template, which `Map::new` (arbitrary tiles/ports) already accepts — build the `Map` from the
   JSettlers layout, not from the template.
4. Rule gaps to record, not fix: JSettlers robots offer trades (we reject; the paper's DRRL did the opposite);
   `jsettlers.bots.timeout.turn` must exceed our search time.
5. Runs: headless server with 3 built-ins (pin names for a fast-only and a smart-only series, plus the default
   mix), our client connected with the cookie, `botgames.total=100` per series; parse `SOCGameStats` or the game
   DB for wins. Report v40 vs 3x jSettler next to DRRL 45%/56% and DRL 53.36%.
6. Long-term, for the site: port the decision core of `soc.robot` (SOCRobotDM + SOCBuildingSpeedEstimate +
   SOCPlayerTracker + OpeningBuildStrategy, ~10k Java lines, no negotiator/chat) to a `jsettler.rs` bot; it then
   compiles to WASM like everything else. Estimate 3-4 weeks; validate by playing the port against the Java
   original through the Phase 2 bridge.

## Phase 3 (planned, ~1 week): the thesis MCTS agents, so the pool matches the paper's

The agents come from E. Karamalegos, *Monte Carlo tree search in the Settlers of Catan strategy game* (TU Crete,
DOI 10.26233/heallink.tuc.66891; also K. Panousis, *Real-time planning and learning in the Settlers of Catan
strategy game*, DOI 10.26233/heallink.tuc.18113). Both PDFs are public on dias.library.tuc.gr behind an Anubis
JS challenge (fetch with a browser). No source code was published. From the abstracts: three tree policies — UCT,
Bayesian UCT, and VPI (Dearden, Friedman & Russell 1998) — under the full rule set with a simple negotiation
scheme, delegating tasks the search does not cover (e.g. dev cards) to jSettlers; VPI scored best even at far
fewer simulations; an alternative human-like initial placement helped.

1. Read the Karamalegos thesis for the exact settings: simulation budget, playout depth/policy, what is delegated,
   trade scheme, initial-placement variant.
2. `catan_engine/src/mcts.rs` on the existing engine (chance handled by sampling `apply(action, None)`; note the
   engine is fully observable, so opponents' hands are visible — a deviation from the thesis' jSettlers setting):
   - **UCT**: UCB1 tree policy, random playouts to the end (or depth cap + `base_fn` leaf value if the thesis did
     that), win backups per seat.
   - **BUCT**: Bayesian UCT (Tesauro, Rajan & Das 2010): Gaussian value posteriors per node, selection by
     mean + c·σ (or Thompson), posterior backups.
   - **VPI**: Bayesian Q-learning at the root (Dearden et al. 1998): normal-gamma posteriors over Q(s,a) updated
     from playout returns, action choice by value of perfect information; "training" is the online posterior update
     across a game (and across games if the thesis persisted it).
   Delegated decisions go to the heuristic bot.
3. Expose as `make_player` tokens `uct`, `buct`, `vpi` (via `rust_bridge`) and as wasm `decide` bots so they appear
   on the site; tune budgets to the paper's wall-clock per decision.
4. Re-run `tournament.py` with the pool `v40, ab-or-jsettlers, uct, buct, vpi` — the paper's exact pool shape —
   and add the table here and to the site.

Alternative second opinion on "MCTS": StacSettlers (github.com/ruflab/StacSettlers, GPL; Edinburgh) ships Java
MCTS agents (`sorinMD/MCTS`, MIT) and a bulk `Simulation` harness; runnable against the Phase 2 bridge in a day once
that exists, not before.
