# Plan: paper-protocol benchmark, repo cleanup + reorganisation, static Catan simulator/viewer

## Context

The M4 gate is met: `checkpoints_value/v40.pt` (depth-2 expectimax over a learned win-probability net) beats
3x Catanatron `AlphaBetaPlayer` at 55.2% [52.1, 58.3] over 1,000 games. The expert-iteration loop has finished
(`run_exit.pid` is stale, no processes running). Three things are wanted now:

1. **Benchmark** the bot the way Xenou, Chalkiadakis & Afantenos (EUMAS 2018, `paper.pdf`) benchmarked DRRL:
   a pool of 5 agents, five 4-player tournaments (each leaves one agent out, so every agent plays 4 of them),
   win ratio per agent as the metric (their Fig. 3a), plus a run against 3 copies of the standard heuristic
   (Fig. 3b: DRRL 45% / 56% after 30 games, the DRL agent of Cuayáhuitl et al. 53.36%). Their opponents were
   the jSettlers robot and three unpublished MCTS agents (UCT, BUCT, VPI) from a TU Crete thesis. The user wants
   the protocol run now against what exists (Catanatron roster) **and a concrete plan** to integrate real
   jSettlers and to recreate the thesis MCTS agents, with the long-term goal of shipping those as browser bots.
2. **Clean up** the 208 GB checkout (199 GB is regenerable training shards) and organise the repository.
3. **Ship a static website** (GitHub Pages) where people play against the bots and step through bot-vs-bot
   games with interpretability panels. Everything runs in the browser: the Rust engine compiles to WebAssembly
   and the value net is a 403k-parameter MLP.

Decisions already taken by the user: Catanatron roster now + jSettlers/MCTS plan; 100 games per tournament;
delete all of `data/`; new public GitHub repo pushed by me; pnpm + full-fat framework OK (tailwind, zag.js
suggested); reorganise the repo as a whole.

Facts that shape the design (from exploration):
- `catan_engine/src/*.rs` core is pyo3-free; only `lib.rs` touches pyo3/numpy/rayon. `search.rs` uses
  `std::time::Instant` (panics on wasm32) for profiling only. RNG is an embedded splitmix64 (`state.rs:123`),
  WASM-safe. No serde. No map constructor in Rust: `Map::new` takes tiles/ports/static_template/neighbors
  from Python (`rust_bridge.py:36-63`); `State::from_spec` takes a 40-key dict.
- Catanatron BASE map: node ids come from a fixed template traversal (stable across boards); only tile
  resources and port resources are shuffled; numbers use the official spiral. The static template is just
  per-tile PROBA + resource one-hots and per-port one-hots (`catan_env.py:199-221`).
- v40 = `Linear(1051,256) ReLU Linear(256,256) ReLU Linear(256,256) ReLU Linear(256,6)` + `mask` buffer
  (zeroes 206 tile/port one-hots) + `alpha` (unused, prior off). Heads: win logit, 4 final-VP, turns left.
- `evaluate.py` only supports "agent at BLUE vs 3 identical opponents"; `gen_games.py --lineup` is the only
  mixed-seat entry point. `value_net.make_player` tokens: `ab`, `abN`, `rab`, `rsab`, `vf`, `wr`, `vnet:path`.
- Catanatron 3.3.0 players available: `AlphaBetaPlayer`, `SameTurnAlphaBetaPlayer`, `MCTSPlayer(num_simulations=10)`,
  `GreedyPlayoutsPlayer(num_playouts=25)`, `ValueFunctionPlayer`, `VictoryPointPlayer`, `WeightedRandomPlayer`,
  `RandomPlayer`. No web UI is bundled (flask extras absent). Player-to-player trading is not reachable in
  Catanatron or the Rust engine.
- Cleanup facts: `catan_engine/target/` (264 files, 83 MB) is committed; `data/` 199 GB; PPO checkpoint dirs
  2.3 GB of which 4 files are cited in FINDINGS; `checkpoints_value/` has 176 unreferenced `.pt` (286 MB);
  `~/.cache/uv` 12 GB (no hardlinks into `.venv`), `~/.cache/pip` 2.3 GB. `gh` is logged in as TSVRN9; no
  remote yet; branch is `master`. Rust + Node 25 present; `wasm32` target and `wasm-pack` not installed.

## Step 0 — record the design, fix git hygiene

- Save this plan as `docs/superpowers/specs/2026-09-03-benchmark-cleanup-website-design.md` (brainstorming
  skill convention) and commit it.
- `catan_engine/.gitignore` = `target/`; `git rm -r --cached catan_engine/target`; root `.gitignore` gains
  `.mypy_cache/ .ruff_cache/ docs/papers/ web/node_modules/ web/dist/ web/src/engine/` ; commit.
- `git branch -m master main` (matches the environment's stated main branch and Pages defaults).

## Part B — cleanup and reorganisation (do first: it frees the disk the other parts need)

Deletions (all outside git except the target/ untracking above):
- `rm -rf data/` (199 GB). `rm -rf checkpoints checkpoints_v2 checkpoints_mixed` (unloadable 1002-dim PPO
  nets). Thin `checkpoints_500k` to `model_500k_gate_71pct.zip`, `checkpoints_augobs` to
  `ppo_catan_2699991_steps.zip` + `final_model.zip`, `checkpoints_selfplay` to `final_model.zip`; keep
  `checkpoints_bc/bc_model.zip` (default arg of `train.py`/`self_play.py`).
- `checkpoints_value/`: delete `*_s[0-9].pt` (110 soup members), `it31*`, `it32rk*`, `wide512*`, `smoke*`,
  `rank_smoke*`, `sib_*`, `abl_*`, `iso_*` (keep `abl35.pt`, every `vNN.pt`, all `.log`/`.sh`, `best.txt`);
  delete stale `run_exit.pid`.
- `rm -rf .mypy_cache .ruff_cache __pycache__`; `cargo clean --manifest-path catan_engine/Cargo.toml`
  (venv `.so` is an independent copy, verified); `uv cache clean`; `rm -rf ~/.cache/pip`.
- Expected: ~190 GB reclaimed in the repo, ~14 GB in caches. Report `du -sh` before/after.

Reorganisation (git mv, imports patched, docs/CLAUDE.md paths updated):
```
README.md                      new: what/why, headline result, how to run, link to the site
CLAUDE.md                      updated layout + build commands (python ext and wasm)
pyproject.toml uv.lock .python-version
catan_engine/                  Rust crate; features `python` (default) and `wasm`
catan_env.py value_net.py rust_bridge.py fast_copy.py arena.py gen_games.py train_value.py soup.py
evaluate.py tournament.py test_env.py                       live M4 code stays flat at root
scripts/run_exit.sh                                          loop driver (path updated in CLAUDE.md/FINDINGS)
legacy/ppo/{self_play,train,train_bc,inference_server,bench_env}.py, run_it0.sh
                               dormant PPO era; 2-line sys.path shim at top of each; README.md one-liner
bench/                         unchanged
docs/                          FINDINGS.md HANDOFF.md RUST-ENGINE.md AUDIT-rules.md PLAN-gen-speed.md
docs/BENCHMARK.md              new: paper-protocol results + jSettlers/MCTS roadmap
docs/papers/xenou2018-drrl.pdf paper.pdf moved here, gitignored (third-party PDF)
docs/superpowers/specs/        this design
web/                           the site (Part C)
.github/workflows/pages.yml    build + deploy
```
`test_env.py:442` imports `self_play` — point it at `legacy/ppo` via the same shim. `train_bc.py` imports
`train` — unchanged inside `legacy/ppo`. Run `uv run python test_env.py` after the move (must still pass the
replay oracle), then commit "reorganise repo".

## Part C — Rust engine additions (shared by the benchmark oracle, the site, and future bots)

Files: `catan_engine/Cargo.toml`, `src/lib.rs`, new `src/mapgen.rs`, `src/valuenet.rs`, `src/wasm.rs`,
generated `src/base_topology.json` + `src/base_layout.json`, small edits in `search.rs`, `state.rs`, `encode.rs`.

1. **Features.** `[features] default=["python"]; python=["pyo3","numpy","rayon"]; wasm=["wasm-bindgen","serde","serde_json"]`
   with the three python deps `optional = true`. `lib.rs` keeps the python boundary under
   `#[cfg(feature="python")]`; `#[cfg(feature="wasm")] mod wasm;`. In `search.rs` replace `Instant` with a
   `fn now_ns()` that returns 0 on `target_arch="wasm32"`. `maturin develop --release -m catan_engine/Cargo.toml`
   keeps working unchanged; `test_env.py` replay oracle must still pass.
2. **Board generation in Rust** (`mapgen.rs`). One-off Python script `tools/dump_engine_consts.py` writes
   `base_topology.json` (per BASE tile: cube coordinate, 6 node ids in NodeRef order; per port id: direction,
   tile coordinate, 2 node ids; `STATIC_GRAPH` neighbour order per node; the 3:1/resource port multiset;
   tile resource multiset; `BASE_NUMBERS_IN_SPIRAL_ORDER` + spiral tile order) and `base_layout.json` (the
   existing `rust_bridge.layout` spec **plus** `tile_static_idx` and `port_static_idx` so Rust can fill the
   static template itself). `Map::generate(seed, layout) -> Map` shuffles tile resources and port resources
   with splitmix (Fisher-Yates), places numbers by the official spiral, fills `static_template` exactly as
   `Encoder._refresh_static_template` does. `Map::new` stays for the Python path.
3. **Initial state.** `State::new(map, n, seed, vps_to_win=10)`: Catanatron defaults (bank 19x5, dev deck
   14/5/2/2/2 shuffled with the state RNG, 15/5/4 pieces, robber on the desert, prompt InitialSettlement,
   discard_limit 7, friendly_robber false). Oracle check in `test_env.py`: build a Catanatron `Game` whose
   `initialize_tiles(shuffled_*_param=...)` uses the Rust-generated assignments, `state_spec` it, and assert
   it equals the Rust `snapshot()` modulo dev-deck order and rng.
4. **Serialisation.** `#[derive(Serialize)]` on `State`/`Player` (+ a `view()` struct with map tiles/ports,
   robber, roads, buildings, prompt, current player, legal actions with human labels). Game record =
   `{seed, seats, log: [(action, outcome)]}`; `State::replay(record)` uses the existing pinned `apply`.
5. **Value net in Rust** (`valuenet.rs`). `tools/export_valuenet.py` writes `web/public/models/v40.bin`
   (little-endian f32: mask, W0,b0,W1,b1,W2,b2,W3,b3) + `v40.json` (shapes, sha). `ValueNet::forward_batch
   (&[f32], n) -> Vec<[f32;6]>` plain loops (leaf matrix ~279x1051 avg, worst 2,208: tens of ms in wasm).
   `decide_vnet(state, net, depth) -> (action, root_evs)` reuses `expand`/`backup_full`. Parity check:
   the export script also dumps 8 random `(obs, heads)` pairs; a Rust unit test asserts max abs diff < 1e-4.
   Decision (user, after weighing ONNX Runtime Web and candle): hand-written forward, compiled with
   `-C target-feature=+simd128` for the wasm build (`.cargo/config.toml` or `RUSTFLAGS` in the build script)
   so LLVM vectorises the loops; the worker logs ms/decision. Upgrade path if measured latency is poor:
   the leaf matrix is a flat f32 array, so ONNX Runtime Web can score it from the worker without touching
   the search; note this in `web/README.md`.
6. **wasm API** (`wasm.rs`, wasm-bindgen, JSON in/out via serde_json strings — one shape, no bindings zoo):
   `Engine::new(seed)`, `view() -> json`, `legal_actions() -> json`, `apply(action_json) -> outcome`,
   `decide(bot: "random"|"heuristic"|"vnet", depth)`, `analyse(seat) -> {heads, root_evs(if decision),
   group_attributions}`, `record() -> json`, `Engine::replay(record_json)`. `group_attributions` = Δ win-prob
   when zeroing a feature group (own hand, own production, own buildings, own roads, own dev cards, each
   opponent's production/buildings, robber, bank) — ~12 extra forwards. Build:
   `wasm-pack build catan_engine --target web --no-default-features --features wasm --out-dir ../web/src/engine`.
   Runnable check: `web/tools/smoke.mjs` loads the wasm in Node, plays heuristic-vs-vnet to a winner, asserts
   replay reproduces the final view.

## Part A — benchmark

### A1. Executable now: `tournament.py` (new, ~150 lines; reuses `value_net.make_player`, `evaluate.wilson_interval`)

- Extend `make_player` tokens: `mcts[N]` → `MCTSPlayer(num_simulations=N)`, `gp[N]` → `GreedyPlayoutsPlayer`,
  `vp` → `VictoryPointPlayer`, `rand` → `RandomPlayer`, `stab` → `SameTurnAlphaBetaPlayer`.
- CLI: `--pool` (5 tokens, default `vnet:checkpoints_value/v40.pt,ab,mcts,vf,wr`), `--games` per tournament
  (100), `--seed`, `--jobs 7`, `--out docs/benchmark/<name>.json`. Tournament k = pool minus agent k; each game
  seats the 4 agents in a seed-derived random order (paper: "chosen randomly and in random order"); Catanatron
  `Game(players, seed)`; spawn `mp.Pool` like `evaluate.py`. Output: per-agent wins/games/win ratio/Wilson CI,
  per-tournament table, mean final VP, s/game; JSON + a markdown table. Fig. 3b analogue = the existing
  1,000-game v40 vs 3x AB result (55.2%), quoted next to DRRL 45%/56% and DRL 53.36% vs 3x jSettlers.
- Before the full run: 3-game timing of `mcts10`, `mcts50`, `gp5` and a 12-game check that `vnet` wins at
  every seat colour (it has only ever been evaluated at BLUE). Pick the strongest MCTS setting that keeps
  a 100-game tournament under ~40 min on 7 cores; record the choice.
- Launch the 500-game run detached (`setsid nohup … > docs/benchmark/run.log`), memory-capped like
  `run_exit.sh`, and hand monitoring to a subagent; results go to `docs/BENCHMARK.md`, a FINDINGS entry, and
  `web/src/data/benchmark.json` for the site's Results page.

### A2. Roadmap: real jSettlers and the thesis MCTS agents (`docs/BENCHMARK.md`, written now; execution is follow-on work)

Facts (verified in the research pass): JSettlers2 is GPL-3, release 2.6.10, main at 2.7.00. Bots are plain
TCP clients (Java `writeUTF` frames of `<type>|field|...`), non-Java clients are explicitly supported
(`doc/Readme.developer.md`), and a robot-cookie client (`jsettlers.bots.cookie`) gets seated with the built-in
bots; bots-only games run ~2 min with `jsettlers.bots.fast_pause_percent=1` and can be driven in bulk with
`jsettlers.bots.botgames.*`. The built-in robot is `soc.robot` (27 files, 22,969 lines; SOCRobotBrain 5.6k,
SOCPlayerTracker 4.2k, SOCRobotDM 3.4k, SOCRobotNegotiator 2.7k, OpeningBuildStrategy 1.1k,
SOCBuildingSpeedEstimate 1.1k) with "fast" (`droid N`) and "smart" (`robot N`) parameter sets. No Python or
Rust port or Catanatron bridge exists anywhere. The two theses are public PDFs on dias.library.tuc.gr (behind
an Anubis JS challenge, so fetch them with the browser): Karamalegos DOI 10.26233/heallink.tuc.66891,
Panousis DOI 10.26233/heallink.tuc.18113; no source code was published. StacSettlers (Edinburgh, GPL) ships
Java MCTS agents (`sorinMD/MCTS`, MIT) and a bulk `Simulation` harness but no Python client.

**Phase 2 — real jSettlers (about one week; the literal Fig. 3b number)**
1. Fetch both thesis PDFs and the JSettlers source into `docs/papers/` and `vendor/JSettlers2` (gitignored).
2. `jsettlers/` (new, Java, GPL-compatible since it links JSettlers): a `SOCRobotClient`/`SOCRobotBrain`
   subclass modelled on `soc.robot.sample3p`. It keeps JSettlers' own state tracking and protocol handling,
   and at every decision point (initial placement, play-turn, discard, robber, trade reply = always reject)
   serialises `SOCGame` to the engine's state spec (JSON) and asks a local decision server.
3. Decision server = the Rust engine as a small CLI/socket process (`catan_engine` gains a `serve` feature or
   a tiny bin): JSON state in, action out, using `decide_vnet`/`decide_heuristic`. No torch, no Python in the
   loop; the value net already lives in Rust (Part C.5). Board mapping: a one-off table from JSettlers classic
   4-player hex/node/edge coordinates to the engine's node ids; port positions differ from Catanatron's
   template, which `Map::new` (arbitrary tiles/ports) already tolerates — build the `Map` from the JSettlers
   layout, not from a template.
4. Rule gaps to record, not fix: JSettlers robots offer trades (we reject; DRRL in the paper did the opposite),
   JSettlers' Longest Road has no #378 quirk, turn timeouts (`jsettlers.bots.timeout.turn`) must exceed our
   search time.
5. Runs: headless server with 3 built-ins (pin names for a fast-only and a smart-only series, plus the mixed
   default), our client connected with the cookie, `botgames.total=100` per series; parse `SOCGameStats` /
   the server's game DB for wins. Report v40 vs 3x jSettlers next to DRRL 45%/56% and DRL 53.36%.
6. Long-term, for the site: port the decision core of `soc.robot` (SOCRobotDM + SOCBuildingSpeedEstimate +
   SOCPlayerTracker + OpeningBuildStrategy, ~10k Java lines, no negotiator/chat) to a `jsettler.rs` bot, then
   it compiles to WASM like everything else. Estimate 3-4 weeks; validate by playing the Rust port against the
   Java original through the Phase 2 bridge.

**Phase 3 — the thesis MCTS agents (about one week; makes the pool identical to the paper's)**
1. Read the Karamalegos thesis for the exact settings: simulation budget, playout depth/policy, which
   decisions are delegated to jSettlers logic (dev cards, trading), trade scheme, initial placement variant.
2. `catan_engine/src/mcts.rs` on the existing engine (chance handled by sampling `apply(action, None)`;
   the engine's state is fully observable, so opponents' hands are visible — note this as a deviation from
   the thesis' jSettlers setting):
   - **UCT**: UCB1 tree policy, random playouts to the end (or depth cap + `base_fn` leaf value if the thesis
     did that), win backups per seat.
   - **BUCT**: Bayesian UCT (Tesauro, Rajan & Das 2010): Gaussian value posteriors per node, selection by
     mean + c·σ (or Thompson), posterior backups.
   - **VPI**: Bayesian Q-learning at the root (Dearden, Friedman & Russell 1998): normal-gamma posteriors over
     Q(s,a) updated from playout returns, action choice by value of perfect information; "training" is the
     online posterior update across a game (and across games, if the thesis persisted it).
   Delegated decisions (whatever the thesis handed to jSettlers) go to the heuristic bot.
3. Expose as `make_player` tokens `uct`, `buct`, `vpi` (via `rust_bridge`) and as wasm `decide` bots so they
   appear on the site's bot list; tune budgets to the paper's wall-clock per decision.
4. Re-run `tournament.py` with pool `v40, ab-or-jsettlers, uct, buct, vpi` (the paper's exact pool shape) and
   add the table to `docs/BENCHMARK.md` and the site's Results page.

Alternative for a second opinion on "MCTS": StacSettlers' `sorinMD/MCTS` agents are runnable in Java against
the Phase 2 bridge with its `Simulation` harness; worth a day once Phase 2 exists, not before.

Deliverable of this pass: `docs/BENCHMARK.md` with the Phase 1 results and Phases 2-3 written as above with
file-level tasks, so either can start cold. Phases 2-3 are not executed in this pass.

## Part C (cont.) — the website `web/`

Stack: pnpm, Vite 6, React 19 + TypeScript, Tailwind v4, zag.js (`@zag-js/react` + `tabs`, `dialog`,
`slider`, `menu`, `tooltip`, `select`, `tree-view`, `toggle-group`), `vite-plugin-wasm` + top-level-await,
one Web Worker owning the wasm `Engine` (bots and analysis never block the UI). No chart lib: the timeline
and bar charts are small hand-written SVG components. Hash routes `#/play`, `#/watch`, `#/results`, `#/about`;
watch state encoded in the URL (`seed`, `lineup`, `step`) so games are shareable.

Layout:
```
web/package.json vite.config.ts tsconfig.json tailwind.css index.html
web/src/engine/          wasm-pack output (gitignored, built in CI)
web/src/worker.ts        Engine in a worker: new/replay/apply/decide/analyse; message types in engine.ts
web/src/board/Board.tsx  SVG hex board (19 tiles, 54 nodes, 72 edges, ports, robber, pieces), click targets
                          for legal build actions, heat overlay from root EVs
web/src/play/            Play page: human seat + 3 chosen bots, action bar (roll, end turn, buy dev, play card,
                          maritime trade dialog, discard dialog, robber victim menu), optional "coach" overlay
web/src/watch/           Watch page: lineup picker, run-to-end in worker, scrubber (zag slider) + step/auto-play,
                          per-step Analysis drawer
web/src/analysis/        WinProbTimeline (4 lines), Forecast (final VP + turns left), DecisionPanel (root actions
                          sorted by EV, chosen vs heuristic's pick, hover→board highlight), Attribution (tornado of
                          group Δ), SearchTree (zag tree-view over action→outcome→leaf value)
web/src/results/         Results page from data/benchmark.json + the FINDINGS headline; About: rules caveats
                          (no player trading, catanatron #378 longest-road quirk), links, citations
web/public/models/v40.bin v40.json
web/tools/smoke.mjs      the runnable check
```
Bots offered: Random, Heuristic search (AlphaBeta port, depth 1/2), Value-net search v40 (depth 1/2).
Human play at any seat; bot turns run in the worker with a small delay so moves are readable; forced
single-action decisions auto-advance. Theme-aware (light/dark), keyboard-usable scrubber, mobile layout
(board scales, panels stack).

CI/deploy: `.github/workflows/pages.yml` — checkout, `dtolnay/rust-toolchain` + `wasm32-unknown-unknown`,
install `wasm-pack`, pnpm install, `pnpm build` (runs wasm-pack then vite with `base: '/<repo>/'`), upload
`web/dist`, `actions/deploy-pages`. Repo: `gh repo create TSVRN9/settlers_of_catan_rl --public --source=. --push`,
enable Pages (source: GitHub Actions) with `gh api`, wait for the workflow, open the live URL in Chrome and
play a few moves to verify.

## Execution order

1. Step 0 + Part B (cleanup, reorg, README) → commit.
2. Part C engine work (features, mapgen, State::new, serde, valuenet, wasm) → rebuild python ext →
   `uv run python test_env.py` green → commit.
3. Part A1: `tournament.py`, timing runs, seat check → launch the 500-game run detached; subagent monitors.
4. Website build-out while the benchmark runs; local `pnpm build` + `smoke.mjs`; workflow; create repo, push,
   enable Pages, verify in browser.
5. When the run finishes: `docs/BENCHMARK.md` results section + FINDINGS entry + `benchmark.json` → push.
6. Memory notes: benchmark protocol/result, site URL, repo layout change.

## Verification

- `uv run python test_env.py` passes after the reorg and after every engine change (replay oracle).
- `cargo test --manifest-path catan_engine/Cargo.toml --no-default-features --features wasm` (mapgen invariants,
  valuenet parity) and `node web/tools/smoke.mjs` (full game + replay in wasm).
- `tournament.py --games 2` smoke, then the full run's JSON has 500 games and 5x400 agent-games.
- Pages workflow green; live site plays a full human-vs-bots game and steps through a watch game with all
  analysis panels populated; checked in Chrome.
- `du -sh` before/after for the cleanup; `git status` clean; `git ls-files | grep -c target` = 0.
