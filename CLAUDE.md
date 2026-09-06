# Catan RL

RL agent for 4-player Settlers of Catan. Target: beat Catanatron's `AlphaBetaPlayer`.
Reuses the [Catanatron](https://github.com/bcollazo/catanatron) rules engine; the gym
layer, observation encoder, and training loop are ours.

## Setup

Python **3.12** (3.14 does not resolve `torch+xpu`). Package manager is `uv`.

```bash
uv sync
uv run python -c "import torch; print(torch.xpu.is_available())"   # must print True
```

`test_env.py` and the other scripts arrive with M1 — see `docs/HANDOFF.md`.

## Hard-won constraints — read before changing anything

- **`torch.optim.Adam(foreach=True)` (the default) crashes the Arc iGPU** with
  `UR_RESULT_ERROR_DEVICE_LOST`. Always pass `foreach=False`. See `docs/FINDINGS.md`.
- **Never call the policy at batch 1.** Batch-1 inference (245 µs) costs more than the
  observation encoder (239 µs). All inference goes through `legacy/ppo/inference_server.py`, which
  batches to ≥256. This is the whole reason the architecture looks like it does.
  The M4 search player (`value_net.py`) is the measured exception: its leaves are
  batched per decision, and the number to beat there is AlphaBeta's own 80 µs/leaf
  heuristic, not the encoder.
- **We are simulation-bound, not GPU-bound.** Optimize CPU-side observation encoding.
  Reaching for a bigger net or more GPU is almost always the wrong move.
- **XPU memory is host RAM and the caching allocator hoards it.** Forwards with varying batch sizes reserved
  4-6 GB for <0.5 GB used and OOM-killed the box. `arena.py` pads forwards to `ROW_BUCKET` rows and sets
  `PYTORCH_ALLOC_CONF=expandable_segments:True`; keep both. Every long stage runs under `scripts/run_exit.sh`'s
  `systemd-run` memory cap; stop the loop with `kill $(cat checkpoints_value/run_exit.pid)`, never `pkill -f`.
- **Don't re-benchmark the baseline.** Every number is measured and recorded in
  `docs/FINDINGS.md`. Read it first.

## Rust engine (`catan_engine/`)

The rules engine, encoder, and search expansion are ported to Rust (PyO3). Build it into
the venv after any change to `catan_engine/src`:

```bash
uv run maturin develop --release -m catan_engine/Cargo.toml
```

The site builds the same crate for the browser (`wasm` feature, no pyo3): `cd web && pnpm build`
(runs `wasm-pack build ../catan_engine --target web --no-default-features --features wasm`).

`test_env.py` replays Python-played games through it and requires a step-for-step match;
that replay oracle is the port's correctness argument — never edit the engine without it.
`rust_bridge.py` is the Python side of the boundary.

## Current direction (M4, 2026-09-01)

Beat AlphaBeta by keeping its depth-2 expectimax search and replacing its hand
heuristic with a learned win-probability net (`value_net.py`, `gen_games.py`,
`train_value.py`), iterated expert-iteration style. PPO/self-play code is dormant, not
deleted. See `docs/FINDINGS.md` "M4 reframed" before touching training.

## Docs

- `docs/FINDINGS.md` — measured performance baseline + Catanatron API notes. Read first.
- `docs/BENCHMARK.md` — the EUMAS 2018 tournament protocol (`tournament.py`), its results, and the jSettlers / thesis-MCTS roadmap.
- `docs/HANDOFF.md` — milestone-by-milestone implementation instructions.
- `docs/UI-REWRITE.md` — the front-end rewrite: architecture, milestones, and the
  design canvas that is its visual spec (generated from `web/design/`).
- `docs/RUST-ENGINE.md` — evaluated and **deferred**. Don't reopen the "rewrite it in Rust"
  question from scratch; the analysis and the triggers that would change the verdict are
  there. Re-read it after M1 reports throughput.

## Layout

- Root: the live M4 code, flat (`catan_env.py`, `value_net.py`, `rust_bridge.py`, `arena.py`, `gen_games.py`,
  `train_value.py`, `soup.py`, `evaluate.py`, `tournament.py`, `test_env.py`).
- `catan_engine/` Rust engine (features `python` default, `wasm` for the site). `scripts/` loop drivers.
- `legacy/ppo/` the dormant PPO/self-play era (M1-M3), runnable via sys.path shims. `bench/` micro-benchmarks.
- `web/` the static site (React + Vite + Tailwind + zag.js, engine via wasm-pack). `docs/` findings and plans.
- Training artefacts (`checkpoints*/`, `data/`) and `docs/papers/` are gitignored.

## Conventions

- The agent is always `Color.BLUE` in the gym env (it asserts enemies don't collide with it); the search
  players (`value_net.make_player`) play any seat.
- Keep new Python flat at the root unless it is a separate deliverable (`web/`, `legacy/`).
- Non-trivial logic leaves one runnable `assert`-based check behind. No test frameworks.
- **UI copy labels; it does not narrate.** No caption explaining what a panel is for, why a
  feature is interesting, or how a reading was computed — that is the house style of an
  AI-written site and it gets cut on sight. A caption earns its place only where the UI
  cannot show the thing itself (a legend for a colour encoding, a unit), and then it is one
  short clause. Methodology belongs in comments and `docs/FINDINGS.md`.
