//! `jsettler`: the JSettlers 2.6.10 robot (soc.robot, GPL-3, Robert S. Thomas / Jeremy D. Monin) ported
//! to this engine so the site and the arena can seat a jSettler (docs/BENCHMARK.md Phase E). Module by
//! module, each checked against the bridge's log-mode oracle (`jsettlers/run.sh play N log ...`,
//! `tools/jsettlers_oracle.py`): the trackers are rebuilt from a `State` at each decision instead of
//! replicating the Java's incremental bookkeeping.

pub mod bse;
pub mod geom;
pub mod jcoll;
pub mod opening;
pub mod dm;
pub mod brain;
pub mod negotiator;
pub mod view;
pub mod player;
pub mod tracker;
