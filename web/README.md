# Catan RL — the site

Play against the bots and step through bot-vs-bot games, entirely in the browser. React 19 + Vite + Tailwind v4,
no other runtime dependency (motion is the View Transitions API, `docs/UI-REWRITE.md` "The laws"); the rules engine, both searches and the value net are the Rust crate in `../catan_engine` compiled with
`wasm-pack` (`wasm` feature, no PyO3) and run in a Web Worker.

```bash
pnpm install
pnpm build:wasm      # needs rustup target wasm32-unknown-unknown + wasm-pack; writes src/engine/ (gitignored)
pnpm dev             # http://localhost:5173
pnpm build           # wasm + tsc + vite -> dist/
pnpm smoke           # node tools/smoke.mjs: full game + replay through the wasm engine
```

Model weights: `public/models/v40.bin` (+ `.json`) from `uv run python tools/export_valuenet.py checkpoints_value/v40.pt v40`.
Board constants: `src/data/topology.json` from `uv run python tools/dump_engine_consts.py`.
Benchmark table: `src/data/benchmark.json` is a copy of `docs/benchmark/paper_protocol.json`.

Inference runs as plain Rust loops compiled with `-C target-feature=+simd128` (the worker logs ms per decision in the
decision panel). If that ever proves too slow, the leaf matrix the search produces is a flat `f32` array, so
scoring it with ONNX Runtime Web from the worker is a contained change; the search itself would not move.

Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` (`VITE_BASE=/<repo>/`).
