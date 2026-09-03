//! catan_engine: catanatron's rules, encoder, heuristic and expectimax expansion in Rust.
//! Feature `python` (default) exposes the PyO3 module used by training; feature `wasm`
//! exposes the browser API used by the site. The core modules depend on neither.

pub mod actions;
pub mod apply;
pub mod arena;
pub mod base_topology;
pub mod board;
pub mod encode;
pub mod heuristic;
pub mod map;
pub mod mapgen;
pub mod search;
pub mod state;
pub mod valuenet;

#[cfg(feature = "python")]
mod python;

#[cfg(feature = "wasm")]
pub mod wasm;
