//! catan_engine: catanatron's rules, encoder, heuristic and expectimax expansion in Rust.
//! Feature `python` (default) exposes the PyO3 module used by training; feature `wasm`
//! exposes the browser API used by the site. The core modules depend on neither.

pub mod actions;
pub mod apply;
pub mod arena;
pub mod base_topology;
pub mod board;
pub mod drrl;
pub mod encode;
pub mod heuristic;
pub mod map;
pub mod mapgen;
pub mod mcts;
pub mod jsettler;
pub mod search;
pub mod state;
pub mod trade;
pub mod valuenet;

#[cfg(feature = "python")]
mod python;

// Search and rollouts clone small Vec-heavy states at every tree node under 8 rayon threads; glibc
// malloc/free was ~40% of generation (perf, docs/PLAN-gen-speed.md 2026-09-22). Not for wasm.
#[cfg(feature = "python")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(feature = "wasm")]
pub mod wasm;
