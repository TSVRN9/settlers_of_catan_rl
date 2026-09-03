# Catan RL

A search-based agent for 4-player Settlers of Catan that beats Catanatron's `AlphaBetaPlayer`, plus a
static website where you can play against it and watch it think.

**Headline result (2026-09-03):** `v40` — depth-2 expectimax over a learned win-probability net — wins
**55.2% [52.1%, 58.3%]** of 1,000 games against three `AlphaBetaPlayer`s (symmetry 25%, AlphaBeta against
itself 26.3%). The net was trained by expert iteration on rollout-labelled child states; the full story, every
number, and every dead end are in [`docs/FINDINGS.md`](docs/FINDINGS.md). The paper-protocol tournament
(Xenou et al., EUMAS 2018) and the roadmap for real jSettlers / thesis-MCTS opponents are in
[`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## How it works

- **Rules engine:** [Catanatron](https://github.com/bcollazo/catanatron) (pinned fork with rule fixes) for the
  Python side; a step-for-step Rust port in [`catan_engine/`](catan_engine/) (PyO3 for training, WebAssembly
  for the site). `test_env.py` replays Python-played games through the Rust engine as its correctness oracle.
- **Player:** AlphaBeta's depth-2 expectimax search with its hand heuristic replaced by a 403k-parameter MLP
  (`value_net.py`) that predicts P(win), final victory points per seat, and turns remaining.
- **Training loop:** `gen_games.py` → `train_value.py` → `soup.py` → gate (`scripts/run_exit.sh`).
- **Site:** [`web/`](web/), live at https://owenwang.dev/settlers_of_catan_rl/ — play against the bots in the browser, step through bot-vs-bot games, and see
  win-probability timelines, action rankings, feature attributions and the search tree.

## Setup

Python 3.12, [`uv`](https://docs.astral.sh/uv/), Rust stable.

```bash
uv sync
uv run maturin develop --release -m catan_engine/Cargo.toml   # build the engine into the venv
uv run python test_env.py                                     # invariants + replay oracle
uv run python evaluate.py --player vnet:checkpoints_value/v40.pt --opponent alpha_beta --games 100
uv run python tournament.py --games 100                       # paper-protocol tournament
```

Website (needs Node 20+, pnpm, `wasm-pack`, the `wasm32-unknown-unknown` target):

```bash
cd web && pnpm install && pnpm dev
```

Deployed from `.github/workflows/pages.yml` to GitHub Pages on every push to `main`.

## Layout

| Path | What |
|---|---|
| `catan_env.py`, `value_net.py`, `rust_bridge.py`, `arena.py` | encoder, value net + search players, Python/Rust boundary, batched Rust game loop |
| `gen_games.py`, `train_value.py`, `soup.py`, `evaluate.py`, `tournament.py` | the expert-iteration loop and evaluation |
| `catan_engine/` | Rust rules engine, encoder, expectimax expansion, heuristic, value net, wasm API |
| `web/` | the static site |
| `scripts/` | loop drivers (`run_exit.sh`) |
| `legacy/ppo/` | the PPO / self-play era, dormant since M4 |
| `bench/` | micro-benchmarks behind the numbers in `docs/FINDINGS.md` |
| `docs/` | `FINDINGS.md` (read first), `HANDOFF.md`, `BENCHMARK.md`, `RUST-ENGINE.md`, `AUDIT-rules.md` |

Rule caveats: no player-to-player trading (Catanatron simplification), and Catanatron issue #378 (a road with
both ends capped by enemy settlements can be under-counted for Longest Road) is mirrored deliberately so the
two engines stay step-for-step identical.
