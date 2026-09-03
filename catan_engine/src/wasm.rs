//! Browser API (feature `wasm`). One `Engine` per game; JSON strings in and out so the JS side
//! has exactly one shape to learn: actions are canonical arrays `[type, a, b, c]`.

use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::actions::{from_canon, to_canon, Action, Canon};
use crate::apply::Outcome;
use crate::encode::Layout;
use crate::map::Map;
use crate::state::{Prompt, State};
use crate::trade::Eval;
use crate::valuenet::{sigmoid, ValueNet, N_HEADS};

static LAYOUT: OnceLock<Arc<Layout>> = OnceLock::new();

fn layout() -> Arc<Layout> {
    LAYOUT.get_or_init(|| Arc::new(serde_json::from_str(include_str!("base_layout.json")).expect("base_layout.json"))).clone()
}

fn canon_json(a: Action) -> Value {
    let (t, x, y, z) = to_canon(a);
    json!([t, x, y, z])
}

fn canon_from_json(v: &Value) -> Result<Action, String> {
    let arr = v.as_array().ok_or("action must be an array [type, a, b, c]")?;
    let t = arr.first().and_then(|t| t.as_str()).ok_or("action[0] must be the type string")?.to_string();
    let num = |i: usize| arr.get(i).and_then(|x| x.as_i64()).unwrap_or(-1) as i32;
    let c: Canon = (t, num(1), num(2), num(3));
    from_canon(&c)
}

fn prompt_name(p: Prompt) -> &'static str {
    match p {
        Prompt::InitialSettlement => "BUILD_INITIAL_SETTLEMENT",
        Prompt::InitialRoad => "BUILD_INITIAL_ROAD",
        Prompt::PlayTurn => "PLAY_TURN",
        Prompt::Discard => "DISCARD",
        Prompt::MoveRobber => "MOVE_ROBBER",
        Prompt::DecideTrade => "DECIDE_TRADE",
        Prompt::DecideAcceptees => "DECIDE_ACCEPTEES",
    }
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub struct Engine {
    state: State,
    seed: u32,
    n: usize,
    log: Vec<(Action, Outcome)>,
    net: Option<Arc<ValueNet>>,
    bot_rng: u64,
}

#[wasm_bindgen]
impl Engine {
    /// A fresh `n`-player game on a random BASE board from `seed`.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, n: usize) -> Engine {
        let layout = layout();
        let map = Arc::new(Map::generate(seed as u64, &layout));
        let state = State::new(map, n, (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5851_F42D_4C95_7F2D, 10);
        Engine { state, seed, n, log: vec![], net: None, bot_rng: seed as u64 ^ 0xA5A5_5A5A_1234_8765 }
    }

    /// Rebuild a game from `record()` output, replaying the first `steps` logged actions (or all if `steps` < 0).
    pub fn replay(record: &str, steps: i32) -> Result<Engine, JsValue> {
        let v: Value = serde_json::from_str(record).map_err(err)?;
        let seed = v["seed"].as_u64().ok_or("record.seed")? as u32;
        let n = v["n"].as_u64().unwrap_or(4) as usize;
        let mut e = Engine::new(seed, n);
        let log = v["log"].as_array().ok_or("record.log")?;
        let take = if steps < 0 { log.len() } else { (steps as usize).min(log.len()) };
        for entry in &log[..take] {
            let a = canon_from_json(&entry[0])?;
            let o = (entry[1][0].as_i64().unwrap_or(-1) as i32, entry[1][1].as_i64().unwrap_or(-1) as i32);
            e.state.apply(a, Some(o)).map_err(err)?;
            e.log.push((a, o));
        }
        Ok(e)
    }

    /// Load exported value-net weights (tools/export_valuenet.py) so the `vnet` bot and the analysis calls work.
    pub fn load_net(&mut self, bytes: &[u8], hidden: usize) -> Result<(), JsValue> {
        let net = ValueNet::from_bytes(bytes, layout().n_features, hidden, N_HEADS).map_err(err)?;
        self.net = Some(Arc::new(net));
        Ok(())
    }

    pub fn has_net(&self) -> bool {
        self.net.is_some()
    }

    pub fn seed(&self) -> u32 {
        self.seed
    }

    pub fn winner(&self) -> i32 {
        self.state.winner() as i32
    }

    pub fn current_player(&self) -> usize {
        self.state.current_player
    }

    pub fn num_turns(&self) -> i32 {
        self.state.num_turns
    }

    pub fn steps(&self) -> usize {
        self.log.len()
    }

    /// The board: tiles (resource, number), ports (resource, nodes), robber start. Static for the game.
    pub fn map_json(&self) -> String {
        let m = &self.state.map;
        json!({
            "tiles": m.tiles.iter().enumerate().map(|(i, t)| json!({"id": i, "resource": t.resource, "number": t.number, "nodes": t.nodes})).collect::<Vec<_>>(),
            "ports": m.ports.iter().enumerate().map(|(i, p)| json!({"id": i, "resource": p.resource, "nodes": p.nodes})).collect::<Vec<_>>(),
            "edges": m.edges,
        })
        .to_string()
    }

    /// Everything the UI renders for the current position.
    pub fn view(&self) -> String {
        let s = &self.state;
        let players: Vec<Value> = s
            .players
            .iter()
            .map(|p| {
                json!({
                    "hand": p.hand, "devs": p.devs, "played": p.played, "vp": p.vp, "actual_vp": p.actual_vp,
                    "roads_available": p.roads_available, "settlements_available": p.settlements_available, "cities_available": p.cities_available,
                    "has_road": p.has_road, "has_army": p.has_army, "has_rolled": p.has_rolled, "has_played_dev": p.has_played_dev,
                    "longest_road_length": p.longest_road_length, "settlements": p.settlements, "cities": p.cities, "roads": p.roads,
                })
            })
            .collect();
        json!({
            "n": s.n, "players": players, "bank": s.bank, "dev_deck": s.dev_deck.len(),
            "owner": s.owner.to_vec(), "is_city": s.is_city.to_vec(), "road_owner": s.road_owner.to_vec(),
            "road_color": s.road_color, "road_length": s.road_length, "robber": s.robber,
            "current_player": s.current_player, "current_turn": s.current_turn, "prompt": prompt_name(s.prompt),
            "initial_phase": s.initial_phase, "is_discarding": s.is_discarding, "discard_counts": s.discard_counts.to_vec(),
            "is_moving_knight": s.is_moving_knight, "is_road_building": s.is_road_building, "free_roads": s.free_roads,
            "num_turns": s.num_turns, "winner": s.winner(), "steps": self.log.len(),
            "is_resolving_trade": s.is_resolving_trade, "current_trade": s.current_trade.to_vec(), "acceptees": s.acceptees[..s.n].to_vec(),
            "spent_offers": s.spent_offers,
        })
        .to_string()
    }

    /// Legal actions for the current player as canonical arrays.
    pub fn legal_actions(&self) -> String {
        Value::Array(self.state.playable_actions().into_iter().map(canon_json).collect()).to_string()
    }

    /// Apply a canonical action; stochastic outcomes are drawn from the game's RNG. Returns the outcome `[a, b]`.
    pub fn apply(&mut self, action: &str) -> Result<String, JsValue> {
        let v: Value = serde_json::from_str(action).map_err(err)?;
        let a = canon_from_json(&v).map_err(err)?;
        let o = self.state.apply(a, None).map_err(err)?;
        self.log.push((a, o));
        Ok(json!([o.0, o.1]).to_string())
    }

    /// Ask a bot for the current decision without applying it.
    /// bot: "random" | "heuristic" (AlphaBeta's evaluator, exact expectimax) | "vnet" (value-net search).
    /// Returns {action, value, root: [[action, ev], ...], leaves}.
    pub fn decide(&mut self, bot: &str, depth: u32) -> Result<String, JsValue> {
        let actions = self.state.playable_actions();
        if actions.is_empty() {
            return Err(err("no legal actions"));
        }
        // Trade prompts and worthwhile offers: the 1-ply policy with the bot's own evaluator.
        let policy = match bot {
            "heuristic" => self.state.trade_action(&Eval::Heuristic),
            "vnet" => {
                let net = self.net.as_ref().ok_or_else(|| err("load_net() first"))?;
                self.state.trade_action(&Eval::Net(net, &layout()))
            }
            _ => None,
        };
        if let Some(a) = policy {
            return Ok(json!({"action": canon_json(a), "value": Value::Null, "root": [], "leaves": 0, "trade": true}).to_string());
        }
        let actions = self.state.search_actions();
        let (action, value, root, leaves) = match bot {
            "random" => {
                self.bot_rng = self.bot_rng.wrapping_add(0x9E3779B97F4A7C15);
                let mut z = self.bot_rng;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
                let i = ((z ^ (z >> 31)) % actions.len() as u64) as usize;
                (Some(actions[i]), f64::NAN, vec![], 0)
            }
            "heuristic" => {
                let (a, v, root) = self.state.decide_heuristic_full(depth.max(1));
                (a, v, root, 0)
            }
            "vnet" => {
                let net = self.net.as_ref().ok_or_else(|| err("load_net() first"))?;
                let d = self.state.decide_vnet(net, &layout(), depth.max(1), 20000, false);
                (d.action, d.value, d.root, d.leaves)
            }
            _ => return Err(err(format!("unknown bot {bot}"))),
        };
        let action = action.unwrap_or(actions[0]);
        let root: Vec<Value> = root.into_iter().map(|(a, v)| json!([canon_json(a), if v.is_finite() { json!(v) } else { Value::Null }])).collect();
        Ok(json!({"action": canon_json(action), "value": if value.is_finite() { json!(value) } else { Value::Null }, "root": root, "leaves": leaves}).to_string())
    }

    /// The value net's forecast from `seat`'s perspective: {win, vps: [4], turns_left}.
    pub fn evaluate(&self, seat: usize) -> Result<String, JsValue> {
        let net = self.net.as_ref().ok_or_else(|| err("load_net() first"))?;
        let s = &self.state;
        let w = s.winner();
        if w >= 0 {
            let vps: Vec<f64> = (0..s.n).map(|i| s.players[(seat + i) % s.n].actual_vp as f64).collect();
            return Ok(json!({"win": (w as usize == seat) as u8 as f64, "vps": vps, "turns_left": 0.0}).to_string());
        }
        let h = net.heads(&s.encoded(seat, &layout()));
        let vps: Vec<f64> = (1..5).map(|i| (h[i] as f64) * 10.0).collect();
        Ok(json!({"win": sigmoid(h[0] as f64), "vps": vps, "turns_left": (h[5] as f64) * 100.0}).to_string())
    }

    /// evaluate() for every seat, as an array.
    pub fn evaluate_all(&self) -> Result<String, JsValue> {
        let mut out = Vec::with_capacity(self.n);
        for seat in 0..self.n {
            let v: Value = serde_json::from_str(&self.evaluate(seat)?).map_err(err)?;
            out.push(v);
        }
        Ok(Value::Array(out).to_string())
    }

    /// Leave-one-group-out attribution of P(win) for `seat`: [{group, seat, delta}] (seat is relative to
    /// the evaluated player; -1 = global).
    pub fn attribution(&self, seat: usize) -> Result<String, JsValue> {
        let net = self.net.as_ref().ok_or_else(|| err("load_net() first"))?;
        let rows: Vec<Value> = self.state.attribution(net, &layout(), seat).into_iter().map(|(g, s, d)| json!({"group": g, "seat": s, "delta": d})).collect();
        Ok(Value::Array(rows).to_string())
    }

    /// {seed, n, log: [[action, [a, b]], ...]} — enough to reproduce the game exactly (see replay()).
    pub fn record(&self) -> String {
        json!({"seed": self.seed, "n": self.n, "log": self.log.iter().map(|(a, o)| json!([canon_json(*a), [o.0, o.1]])).collect::<Vec<_>>()}).to_string()
    }
}
