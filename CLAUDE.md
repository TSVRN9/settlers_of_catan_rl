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
  observation encoder (239 µs). All inference goes through `inference_server.py`, which
  batches to ≥256. This is the whole reason the architecture looks like it does.
  The M4 search player (`value_net.py`) is the measured exception: its leaves are
  batched per decision, and the number to beat there is AlphaBeta's own 80 µs/leaf
  heuristic, not the encoder.
- **We are simulation-bound, not GPU-bound.** Optimize CPU-side observation encoding.
  Reaching for a bigger net or more GPU is almost always the wrong move.
- **Don't re-benchmark the baseline.** Every number is measured and recorded in
  `docs/FINDINGS.md`. Read it first.

## Current direction (M4, 2026-09-01)

Beat AlphaBeta by keeping its depth-2 expectimax search and replacing its hand
heuristic with a learned win-probability net (`value_net.py`, `gen_games.py`,
`train_value.py`), iterated expert-iteration style. PPO/self-play code is dormant, not
deleted. See `docs/FINDINGS.md` "M4 reframed" before touching training.

## Docs

- `docs/FINDINGS.md` — measured performance baseline + Catanatron API notes. Read first.
- `docs/HANDOFF.md` — milestone-by-milestone implementation instructions.
- `docs/RUST-ENGINE.md` — evaluated and **deferred**. Don't reopen the "rewrite it in Rust"
  question from scratch; the analysis and the triggers that would change the verdict are
  there. Re-read it after M1 reports throughput.

## Conventions

- The agent is always `Color.BLUE` (the env asserts enemies don't collide with it).
- Keep the layout flat. No package scaffolding until it earns it.
- Non-trivial logic leaves one runnable `assert`-based check behind. No test frameworks.
