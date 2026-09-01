# Baseline benchmarks

These produced every number in `docs/FINDINGS.md`. Re-run only if hardware, driver,
Catanatron version, or power profile (`powerprofilesctl get`) changes — **do not
re-derive the baseline as routine work.**

| Script | Measures |
|---|---|
| `bench1_engine.py [n]` | raw 4p engine throughput (decisions/s, games/s) |
| `bench2_features.py` | `create_sample_vector` cost, gym env step rate |
| `bench3_torch.py` | CPU vs XPU inference + training across batch sizes |
| `bench4_bots.py` | baseline bot speed (Random/Weighted/Value/AlphaBeta) + encoder profile |
| `bench5_xpu_optimizers.py` | isolates the Adam `foreach=True` XPU crash — **this one resets the GPU on purpose** |
| `bench6_engine_internals.py` | engine profile, replay-oracle check, search cost — evidence for `docs/RUST-ENGINE.md` |
| `bench7_ipc_transport.py` | `inference_server.py`'s IPC transport in isolation (Queue vs shared memory), single-pair and 7-worker-contended — evidence for `docs/FINDINGS.md`'s "contention, not pickling" finding |

`bench3_torch.py` uses `Adam(foreach=False)` so it does not trip the crash. If you revert
that, the training section will kill the GPU (`UR_RESULT_ERROR_DEVICE_LOST`) and every
later call reports `OUT_OF_DEVICE_MEMORY` — that is the known bug, not a broken machine.

Needs the M0 environment: run with `uv run python bench/bench1_engine.py`.

`bench4_bots.py` and `bench6_engine_internals.py` each take ~3 min (AlphaBeta and MCTS are
slow by design).

`bench6` **asserts** that `ActionRecord.result` captures every stochastic outcome. If that
assertion ever fails, replay-based differential testing against a reimplementation is unsafe
and `docs/RUST-ENGINE.md`'s core premise is void — do not ignore it.

Note: `bench2_features.py` measures the **2-player** env (`Catanatron-v0` default). Our
config is 4-player — see `docs/FINDINGS.md` for both.
