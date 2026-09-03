# Catan RL

A search-based agent for 4-player Settlers of Catan that beats Catanatron's `AlphaBetaPlayer`, and a static
site to play against it and replay bot games.

**Headline result (2026-09-03):** `v40` — depth-2 expectimax over a learned win-probability net — wins
**55.2% [52.1%, 58.3%]** of 1,000 games against three `AlphaBetaPlayer`s (symmetry 25%, AlphaBeta against
itself 26.3%). The net was trained by expert iteration on rollout-labelled child states; measurements and negative results
are in [`docs/FINDINGS.md`](docs/FINDINGS.md). The paper-protocol tournament
(Xenou et al., EUMAS 2018) and the roadmap for real jSettlers / thesis-MCTS opponents are in
[`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## How it works

- **Rules engine:** [Catanatron](https://github.com/bcollazo/catanatron) (pinned fork with rule fixes) for the
  Python side; a step-for-step Rust port in [`catan_engine/`](catan_engine/) (PyO3 for training, WebAssembly
  for the site). `test_env.py` replays Python-played games through the Rust engine as its correctness oracle.
- **Player:** AlphaBeta's depth-2 expectimax search with its hand heuristic replaced by a 403k-parameter MLP
  (`value_net.py`) that predicts P(win), final victory points per seat, and turns remaining.
- **Training loop:** `gen_games.py` → `train_value.py` → `soup.py` → gate (`scripts/run_exit.sh`).
- **Site:** [`web/`](web/), live at https://owenwang.dev/settlers_of_catan_rl/ — play against the bots in the browser, step through bot-vs-bot games with
  win-probability timelines, action rankings and feature attributions.

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

Rules: the deviations found in the audit (`docs/AUDIT-rules.md`), including catanatron issue #378, are fixed in
the pinned fork and in the Rust engine, and player-to-player trading follows the official rules with one house
rule (an offer everyone rejected or the offerer cancelled cannot be repeated that turn). Bots trade through a 1-ply
policy over their own evaluator; the searches never branch over offers.
