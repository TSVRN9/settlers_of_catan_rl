//! Python boundary (feature `python`). Actions cross as canonical tuples (type, a, b, c) with
//! -1 padding; see rust_bridge.py for the Python side.


use std::sync::Arc;

use numpy::ndarray::Array2;
use numpy::{IntoPyArray, PyArray1, PyArray2, PyReadonlyArray1, PyReadwriteArray2};
use numpy::ndarray::Array3;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

use crate::actions::{from_canon, to_canon, Canon};
use crate::arena::{ArenaGame, Recorder, Seat, K_SIB};
use crate::drrl::{Drrl, Variant as DrrlVariant, N_IN as DRRL_N_IN};
use crate::mcts::{Mcts, Policy};
use rayon::prelude::*;
use crate::encode::Layout;
use crate::map::{Map, Port, Tile};
use crate::search::Search;
use crate::state::{Player, Prompt, State};
use crate::trade::Eval;
use crate::valuenet::{ValueNet, N_HEADS};

fn prompt_str(p: Prompt) -> &'static str {
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

fn prompt_from(s: &str) -> PyResult<Prompt> {
    Ok(match s {
        "BUILD_INITIAL_SETTLEMENT" => Prompt::InitialSettlement,
        "BUILD_INITIAL_ROAD" => Prompt::InitialRoad,
        "PLAY_TURN" => Prompt::PlayTurn,
        "DISCARD" => Prompt::Discard,
        "MOVE_ROBBER" => Prompt::MoveRobber,
        "DECIDE_TRADE" => Prompt::DecideTrade,
        "DECIDE_ACCEPTEES" => Prompt::DecideAcceptees,
        _ => return Err(PyValueError::new_err(format!("unsupported prompt {s}"))),
    })
}

fn bits(mask: u64) -> Vec<i32> {
    (0..64i32).filter(|n| mask & (1u64 << n) != 0).collect()
}

fn ints(v: &[u8]) -> Vec<i32> {
    v.iter().map(|&x| x as i32).collect()
}

fn mask(nodes: &[u8]) -> u64 {
    nodes.iter().fold(0u64, |m, &n| m | (1u64 << n))
}

#[pyclass(name = "Map")]
struct PyMap {
    inner: Arc<Map>,
}

#[pymethods]
impl PyMap {
    #[new]
    fn new(tiles: Vec<(i8, u8, [u8; 6])>, ports: Vec<(i8, u8, u8)>, static_template: Vec<f32>, neighbors: Vec<Vec<u8>>) -> PyMap {
        let tiles = tiles.into_iter().map(|(resource, number, nodes)| Tile { resource, number, nodes }).collect();
        let ports = ports.into_iter().map(|(resource, a, b)| Port { resource, nodes: [a, b] }).collect();
        PyMap { inner: Arc::new(Map::new(tiles, ports, static_template, neighbors)) }
    }

    fn edges(&self) -> Vec<(u8, u8)> {
        self.inner.edges.clone()
    }

    /// A random BASE board generated in Rust (mapgen.rs): tile/port resources shuffled by `seed`,
    /// numbers in the official spiral, static template filled from `layout`.
    #[staticmethod]
    fn generate(layout: &PyLayout, seed: u64) -> PyMap {
        PyMap { inner: Arc::new(Map::generate(seed, &layout.inner)) }
    }

    /// (resource or -1, number or 0) per tile id.
    fn tiles(&self) -> Vec<(i8, u8)> {
        self.inner.tiles.iter().map(|t| (t.resource, t.number)).collect()
    }

    /// (resource or -1, node a, node b) per port id.
    fn ports(&self) -> Vec<(i8, u8, u8)> {
        self.inner.ports.iter().map(|p| (p.resource, p.nodes[0], p.nodes[1])).collect()
    }

    fn static_template(&self) -> Vec<f32> {
        self.inner.static_template.clone()
    }
}

#[pyclass(name = "Layout")]
struct PyLayout {
    inner: Arc<Layout>,
}

#[pymethods]
impl PyLayout {
    #[new]
    fn new(spec: &Bound<'_, PyDict>) -> PyResult<PyLayout> {
        let get = |k: &str| -> PyResult<Vec<i32>> { spec.get_item(k)?.ok_or_else(|| PyValueError::new_err(format!("layout missing {k}")))?.extract() };
        let get1 = |k: &str| -> PyResult<i32> { spec.get_item(k)?.ok_or_else(|| PyValueError::new_err(format!("layout missing {k}")))?.extract() };
        Ok(PyLayout {
            inner: Arc::new(Layout {
                n_features: get1("n_features")? as usize,
                robber_idx: get("robber_idx")?,
                node_idx: get("node_idx")?,
                edge_idx: get("edge_idx")?,
                player_scalar_idx: get("player_scalar_idx")?,
                dev_played_idx: get("dev_played_idx")?,
                num_resources_idx: get("num_resources_idx")?,
                num_devs_idx: get("num_devs_idx")?,
                production_idx: get("production_idx")?,
                buildable_nodes_idx: get("buildable_nodes_idx")?,
                p0_actual_vps_idx: get1("p0_actual_vps_idx")?,
                p0_resource_in_hand_idx: get("p0_resource_in_hand_idx")?,
                p0_dev_in_hand_idx: get("p0_dev_in_hand_idx")?,
                p0_has_played_dev_idx: get1("p0_has_played_dev_idx")?,
                bank_resource_idx: get("bank_resource_idx")?,
                bank_dev_cards_idx: get1("bank_dev_cards_idx")?,
                is_discarding_idx: get1("is_discarding_idx")?,
                is_moving_robber_idx: get1("is_moving_robber_idx")?,
                turn_base: get1("turn_base")?,
                extra_base: get1("extra_base")?,
                tile_proba_idx: get("tile_proba_idx")?,
                tile_is_idx: get("tile_is_idx")?,
                port_is_idx: get("port_is_idx")?,
            }),
        })
    }
}

#[pyclass(name = "State")]
struct PyState {
    inner: State,
    search: Option<Search>,
}

fn d_get<'py, T: FromPyObject<'py>>(d: &Bound<'py, PyDict>, k: &str) -> PyResult<T> {
    d.get_item(k)?.ok_or_else(|| PyValueError::new_err(format!("spec missing {k}")))?.extract()
}

#[pymethods]
impl PyState {
    /// A fresh game on `map` (state.rs State::new): catanatron's initial state with the dev deck shuffled by `seed`.
    #[staticmethod]
    #[pyo3(signature = (map, n=4, seed=0, vps_to_win=10))]
    fn new_game(map: &PyMap, n: usize, seed: u64, vps_to_win: i32) -> PyState {
        PyState { inner: State::new(map.inner.clone(), n, seed, vps_to_win), search: None }
    }

    #[staticmethod]
    fn from_spec(map: &PyMap, spec: &Bound<'_, PyDict>) -> PyResult<PyState> {
        let n: usize = d_get(spec, "n")?;
        let hand: Vec<[i32; 5]> = d_get(spec, "hand")?;
        let devs: Vec<[i32; 5]> = d_get(spec, "devs")?;
        let played: Vec<[i32; 5]> = d_get(spec, "played")?;
        let owned: Vec<[bool; 5]> = d_get(spec, "owned_at_start")?;
        let vp: Vec<i32> = d_get(spec, "vp")?;
        let actual_vp: Vec<i32> = d_get(spec, "actual_vp")?;
        let roads_available: Vec<i32> = d_get(spec, "roads_available")?;
        let settlements_available: Vec<i32> = d_get(spec, "settlements_available")?;
        let cities_available: Vec<i32> = d_get(spec, "cities_available")?;
        let has_road: Vec<bool> = d_get(spec, "has_road")?;
        let has_army: Vec<bool> = d_get(spec, "has_army")?;
        let has_rolled: Vec<bool> = d_get(spec, "has_rolled")?;
        let has_played_dev: Vec<bool> = d_get(spec, "has_played_dev")?;
        let lrl: Vec<i32> = d_get(spec, "longest_road_length")?;
        let settlements: Vec<Vec<u8>> = d_get(spec, "settlements")?;
        let cities: Vec<Vec<u8>> = d_get(spec, "cities")?;
        let roads: Vec<Vec<u8>> = d_get(spec, "roads")?;
        let players = (0..n)
            .map(|i| Player {
                hand: hand[i],
                devs: devs[i],
                played: played[i],
                owned_at_start: owned[i],
                vp: vp[i],
                actual_vp: actual_vp[i],
                roads_available: roads_available[i],
                settlements_available: settlements_available[i],
                cities_available: cities_available[i],
                has_road: has_road[i],
                has_army: has_army[i],
                has_rolled: has_rolled[i],
                has_played_dev: has_played_dev[i],
                longest_road_length: lrl[i],
                settlements: settlements[i].clone(),
                cities: cities[i].clone(),
                roads: roads[i].clone(),
            })
            .collect();
        let owner_v: Vec<i8> = d_get(spec, "owner")?;
        let is_city_v: Vec<bool> = d_get(spec, "is_city")?;
        let road_owner_v: Vec<i8> = d_get(spec, "road_owner")?;
        let mut owner = [-1i8; 54];
        let mut is_city = [false; 54];
        let mut road_owner = [-1i8; 72];
        owner.copy_from_slice(&owner_v);
        is_city.copy_from_slice(&is_city_v);
        road_owner.copy_from_slice(&road_owner_v);
        let components_v: Vec<Vec<Vec<u8>>> = d_get(spec, "components")?;
        let components = components_v.iter().map(|cs| cs.iter().map(|c| mask(c)).collect()).collect();
        let buildable_v: Vec<u8> = d_get(spec, "buildable")?;
        let rl: Vec<i32> = d_get(spec, "road_lengths")?;
        let mut road_lengths = [0i32; 4];
        road_lengths[..n].copy_from_slice(&rl[..n]);
        let dc: Vec<i32> = d_get(spec, "discard_counts")?;
        let mut discard_counts = [0i32; 4];
        discard_counts[..n].copy_from_slice(&dc[..n]);
        let bank_v: Vec<i32> = d_get(spec, "bank")?;
        let mut bank = [0i32; 5];
        bank.copy_from_slice(&bank_v);
        let prompt: String = d_get(spec, "prompt")?;
        let seed: u64 = spec.get_item("seed")?.map(|v| v.extract()).transpose()?.unwrap_or(0x1234_5678);
        let ct: Vec<i32> = d_get(spec, "current_trade")?;
        let mut current_trade = [0i32; 11];
        current_trade.copy_from_slice(&ct);
        let acc: Vec<bool> = d_get(spec, "acceptees")?;
        let mut acceptees = [false; 4];
        acceptees[..n].copy_from_slice(&acc[..n]);
        let spent: Vec<Vec<u8>> = d_get(spec, "spent_offers")?;
        let spent_offers = spent.iter().map(|o| { let mut k = [0u8; 10]; k.copy_from_slice(o); k }).collect();
        Ok(PyState {
            inner: State {
                map: map.inner.clone(),
                n,
                players,
                bank,
                dev_deck: d_get(spec, "dev_deck")?,
                owner,
                is_city,
                road_owner,
                components,
                buildable: mask(&buildable_v),
                road_lengths,
                road_color: d_get(spec, "road_color")?,
                road_length: d_get(spec, "road_length")?,
                robber: d_get(spec, "robber")?,
                current_player: d_get(spec, "current_player")?,
                current_turn: d_get(spec, "current_turn")?,
                prompt: prompt_from(&prompt)?,
                initial_phase: d_get(spec, "initial_phase")?,
                is_discarding: d_get(spec, "is_discarding")?,
                discard_counts,
                is_moving_knight: d_get(spec, "is_moving_knight")?,
                is_road_building: d_get(spec, "is_road_building")?,
                free_roads: d_get(spec, "free_roads")?,
                num_turns: d_get(spec, "num_turns")?,
                discard_limit: d_get(spec, "discard_limit")?,
                vps_to_win: d_get(spec, "vps_to_win")?,
                friendly_robber: d_get(spec, "friendly_robber")?,
                is_resolving_trade: d_get(spec, "is_resolving_trade")?,
                current_trade,
                acceptees,
                spent_offers,
                pieces: Vec::new(),
                events: Vec::new(),
                rng: seed,
            },
            search: None,
        })
    }

    fn snapshot<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let s = &self.inner;
        let d = PyDict::new(py);
        let n = s.n;
        d.set_item("n", n)?;
        d.set_item("hand", s.players.iter().map(|p| p.hand).collect::<Vec<_>>())?;
        d.set_item("devs", s.players.iter().map(|p| p.devs).collect::<Vec<_>>())?;
        d.set_item("played", s.players.iter().map(|p| p.played).collect::<Vec<_>>())?;
        d.set_item("owned_at_start", s.players.iter().map(|p| p.owned_at_start).collect::<Vec<_>>())?;
        d.set_item("vp", s.players.iter().map(|p| p.vp).collect::<Vec<_>>())?;
        d.set_item("actual_vp", s.players.iter().map(|p| p.actual_vp).collect::<Vec<_>>())?;
        d.set_item("roads_available", s.players.iter().map(|p| p.roads_available).collect::<Vec<_>>())?;
        d.set_item("settlements_available", s.players.iter().map(|p| p.settlements_available).collect::<Vec<_>>())?;
        d.set_item("cities_available", s.players.iter().map(|p| p.cities_available).collect::<Vec<_>>())?;
        d.set_item("has_road", s.players.iter().map(|p| p.has_road).collect::<Vec<_>>())?;
        d.set_item("has_army", s.players.iter().map(|p| p.has_army).collect::<Vec<_>>())?;
        d.set_item("has_rolled", s.players.iter().map(|p| p.has_rolled).collect::<Vec<_>>())?;
        d.set_item("has_played_dev", s.players.iter().map(|p| p.has_played_dev).collect::<Vec<_>>())?;
        d.set_item("longest_road_length", s.players.iter().map(|p| p.longest_road_length).collect::<Vec<_>>())?;
        d.set_item("settlements", s.players.iter().map(|p| ints(&p.settlements)).collect::<Vec<_>>())?;
        d.set_item("cities", s.players.iter().map(|p| ints(&p.cities)).collect::<Vec<_>>())?;
        d.set_item("roads", s.players.iter().map(|p| ints(&p.roads)).collect::<Vec<_>>())?;
        d.set_item("bank", s.bank)?;
        d.set_item("dev_deck", ints(&s.dev_deck))?;
        d.set_item("owner", s.owner.to_vec())?;
        d.set_item("is_city", s.is_city.to_vec())?;
        d.set_item("road_owner", s.road_owner.to_vec())?;
        d.set_item("components", s.components.iter().map(|cs| cs.iter().map(|&c| bits(c)).collect::<Vec<_>>()).collect::<Vec<_>>())?;
        d.set_item("buildable", bits(s.buildable))?;
        d.set_item("road_lengths", s.road_lengths[..n].to_vec())?;
        d.set_item("road_color", s.road_color)?;
        d.set_item("road_length", s.road_length)?;
        d.set_item("robber", s.robber)?;
        d.set_item("current_player", s.current_player)?;
        d.set_item("current_turn", s.current_turn)?;
        d.set_item("prompt", prompt_str(s.prompt))?;
        d.set_item("initial_phase", s.initial_phase)?;
        d.set_item("is_discarding", s.is_discarding)?;
        d.set_item("discard_counts", s.discard_counts[..n].to_vec())?;
        d.set_item("is_moving_knight", s.is_moving_knight)?;
        d.set_item("is_road_building", s.is_road_building)?;
        d.set_item("free_roads", s.free_roads)?;
        d.set_item("num_turns", s.num_turns)?;
        d.set_item("discard_limit", s.discard_limit)?;
        d.set_item("vps_to_win", s.vps_to_win)?;
        d.set_item("friendly_robber", s.friendly_robber)?;
        d.set_item("is_resolving_trade", s.is_resolving_trade)?;
        d.set_item("current_trade", s.current_trade.to_vec())?;
        d.set_item("acceptees", s.acceptees[..n].to_vec())?;
        d.set_item("spent_offers", s.spent_offers.iter().map(|o| ints(o)).collect::<Vec<_>>())?;
        Ok(d)
    }

    fn playable_actions(&self) -> Vec<Canon> {
        self.inner.playable_actions().into_iter().map(to_canon).collect()
    }

    #[pyo3(signature = (action, result=None))]
    fn apply(&mut self, action: Canon, result: Option<(i32, i32)>) -> PyResult<(i32, i32)> {
        let a = from_canon(&action).map_err(PyValueError::new_err)?;
        self.inner.apply(a, result).map_err(PyValueError::new_err)
    }

    fn copy(&self) -> PyState {
        PyState { inner: self.inner.clone(), search: None }
    }

    fn winner(&self) -> i8 {
        self.inner.winner()
    }

    fn current_player(&self) -> usize {
        self.inner.current_player
    }

    fn num_turns(&self) -> i32 {
        self.inner.num_turns
    }

    fn encode<'py>(&self, py: Python<'py>, layout: &PyLayout, p0: usize) -> Bound<'py, PyArray1<f32>> {
        let mut out = self.inner.map.static_template.clone();
        self.inner.encode_into(p0, &layout.inner, &mut out);
        out.into_pyarray(py)
    }

    /// Expands the depth-d tree; returns the leaf feature matrix (n_leaves x
    /// n_features) with terminal leaves as zero rows, plus [(idx, value)] for
    /// those. Call backup(values) afterwards.
    #[pyo3(signature = (layout, depth, p0, max_leaves=0, own_turn=false))]
    fn expand<'py>(&mut self, py: Python<'py>, layout: &PyLayout, depth: u32, p0: usize, max_leaves: usize, own_turn: bool) -> PyResult<(Bound<'py, PyArray2<f32>>, Vec<(usize, f64)>)> {
        let search = self.inner.expand(depth, p0, &layout.inner, max_leaves, own_turn);
        let nf = search.n_features;
        let n = search.n_leaves;
        let arr = Array2::from_shape_vec((n, nf), search.leaves.clone())
            .map_err(|e| PyValueError::new_err(e.to_string()))?
            .into_pyarray(py);
        let fixed = search.fixed.clone();
        self.search = Some(search);
        Ok((arr, fixed))
    }

    fn backup(&self, values: PyReadonlyArray1<f64>) -> PyResult<(Option<Canon>, f64)> {
        let search = self.search.as_ref().ok_or_else(|| PyValueError::new_err("call expand() first"))?;
        let v = values.as_slice()?;
        let (a, val) = search.backup(v);
        Ok((a.map(to_canon), val))
    }

    /// Encoding (perspective p0) of the state after `action`, or None if the
    /// action can't be applied. Stochastic actions draw from the state's RNG.
    fn child_encoding<'py>(&self, py: Python<'py>, layout: &PyLayout, action: Canon, p0: usize) -> PyResult<Option<Bound<'py, PyArray1<f32>>>> {
        let a = from_canon(&action).map_err(PyValueError::new_err)?;
        let mut s = self.inner.clone();
        if s.apply(a, None).is_err() {
            return Ok(None);
        }
        let mut out = s.map.static_template.clone();
        s.encode_into(p0, &layout.inner, &mut out);
        Ok(Some(out.into_pyarray(py)))
    }

    /// For each given (deterministic) action: the child's encoding from p0's
    /// perspective and base_fn(p0) of the child. Unapplicable actions are skipped.
    fn children<'py>(&self, py: Python<'py>, layout: &PyLayout, actions: Vec<Canon>, p0: usize) -> PyResult<(Bound<'py, PyArray2<f32>>, Vec<f64>, Vec<usize>)> {
        let nf = layout.inner.n_features;
        let mut rows: Vec<f32> = Vec::new();
        let mut vals = Vec::new();
        let mut kept = Vec::new();
        for (i, c) in actions.iter().enumerate() {
            let a = from_canon(c).map_err(PyValueError::new_err)?;
            let mut s = self.inner.clone();
            if s.apply(a, None).is_err() {
                continue;
            }
            let start = rows.len();
            rows.extend_from_slice(&s.map.static_template);
            s.encode_into(p0, &layout.inner, &mut rows[start..start + nf]);
            vals.push(s.base_fn(p0));
            kept.push(i);
        }
        let n = kept.len();
        let arr = Array2::from_shape_vec((n, nf), rows).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py);
        Ok((arr, vals, kept))
    }

    /// base_fn(DEFAULT_WEIGHTS) from seat p0's perspective.
    fn base_fn(&self, p0: usize) -> f64 {
        self.inner.base_fn(p0)
    }

    /// AlphaBeta-style decision (exact expectimax over base_fn) for the current player.
    fn decide_heuristic(&self, depth: u32) -> Option<Canon> {
        self.inner.decide_heuristic(depth).map(to_canon)
    }

    /// The rollout policy: depth-2 expectimax over the pruned action lists (heuristic.rs rollout_actions).
    fn decide_rollout(&self) -> Option<Canon> {
        self.inner.decide_rollout().map(to_canon)
    }

    fn smooth_base_fn(&self, p0: usize) -> f64 {
        self.inner.smooth_base_fn(p0)
    }

    /// Same search over the smooth stand-in evaluator (value_net.smooth_heuristic).
    fn decide_smooth(&self, depth: u32) -> Option<Canon> {
        self.inner.decide_smooth(depth).map(to_canon)
    }

    fn leaf_count(&self) -> usize {
        self.search.as_ref().map(|s| s.n_leaves).unwrap_or(0)
    }

    /// The 1-ply trade policy (trade.rs): a reply / confirmation / worthwhile offer, or None when the
    /// search should decide. `net` = a ValueNet for the value-net player, None for base_fn.
    #[pyo3(signature = (layout, net=None))]
    fn trade_action(&self, layout: &PyLayout, net: Option<&PyValueNet>) -> Option<Canon> {
        let eval = match net {
            Some(n) => Eval::Net(&n.inner, &layout.inner),
            None => Eval::Heuristic,
        };
        self.inner.trade_action(&eval).map(to_canon)
    }

    /// playable_actions minus domestic trade offers (what the searches branch over).
    fn search_actions(&self) -> Vec<Canon> {
        self.inner.search_actions().into_iter().map(to_canon).collect()
    }
}

/// value_net.ValueNet weights in Rust (tools/export_valuenet.py layout), for the trade policy.
#[pyclass(name = "ValueNet")]
struct PyValueNet {
    inner: ValueNet,
}

#[pymethods]
impl PyValueNet {
    #[new]
    fn new(bytes: Vec<u8>, n_features: usize, hidden: usize) -> PyResult<PyValueNet> {
        Ok(PyValueNet { inner: ValueNet::from_bytes(&bytes, n_features, hidden, N_HEADS).map_err(PyValueError::new_err)? })
    }

    fn win_prob(&self, state: &PyState, layout: &PyLayout, p0: usize) -> f64 {
        self.inner.win_prob(&state.inner.encoded(p0, &layout.inner))
    }
}


/// Many games in lockstep, one leaf matrix per step (arena.py drives it).
#[pyclass(name = "Arena")]
struct PyArena {
    layout: Arc<Layout>,
    depth: u32,
    rab_depth: u32,
    max_leaves: usize,
    ts_p: f64,
    own_turn: bool,
    roll_p: f64,
    roll_m: u32,
    roll_depth: u32,
    sample_p: f64,
    rank_p: f64,
    sib_p: f64,
    keep_log: bool,
    games: Vec<ArenaGame>,
    last_ms: (f64, f64), // (parallel advance, parallel fill) of the last step
}

#[pymethods]
impl PyArena {
    #[new]
    #[pyo3(signature = (layout, depth=2, sample_p=0.0, rank_p=0.0, sib_p=0.0, keep_log=false, rab_depth=2, max_leaves=0, ts_p=0.0, own_turn=false, roll_p=0.0, roll_m=4, roll_depth=2))]
    fn new(layout: &PyLayout, depth: u32, sample_p: f64, rank_p: f64, sib_p: f64, keep_log: bool, rab_depth: u32, max_leaves: usize, ts_p: f64, own_turn: bool, roll_p: f64, roll_m: u32, roll_depth: u32) -> PyArena {
        PyArena { layout: layout.inner.clone(), depth, rab_depth, max_leaves, ts_p, own_turn, roll_p, roll_m, roll_depth, sample_p, rank_p, sib_p, keep_log, games: vec![], last_ms: (0.0, 0.0) }
    }

    /// seats[i]: 0 = value net, 1 = Rust AlphaBeta, for the player at seat index i.
    fn add(&mut self, state: &PyState, seats: [u8; 4], seed: u64, game_id: i32) {
        let mut st = state.inner.clone();
        st.rng = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5851_F42D_4C95_7F2D;
        let seats = seats.map(|s| if s == 0 { Seat::Vnet } else { Seat::Rab });
        self.games.push(ArenaGame {
            id: game_id,
            state: st,
            seats,
            vnet_depth: self.depth,
            rab_depth: self.rab_depth,
            max_leaves: self.max_leaves,
            own_turn: self.own_turn,
            pending: None,
            leaf_buf: Vec::new(),
            offset: 0,
            rec: Recorder::new(seed, self.sample_p, self.rank_p, self.sib_p, self.ts_p, self.roll_p, self.roll_m, self.roll_depth),
            log: if self.keep_log { Some(vec![]) } else { None },
            done: false,
        });
    }

    fn in_flight(&self) -> usize {
        self.games.len()
    }

    fn last_ms(&self) -> (f64, f64) {
        self.last_ms
    }

    /// Resume every parked game from `values` (one per row of the buffer the
    /// last fill() wrote), advance all games in parallel, and return
    /// (total leaf rows now parked, games parked). Call fill() next.
    #[pyo3(signature = (values=None))]
    fn step(&mut self, py: Python<'_>, values: Option<PyReadonlyArray1<f64>>) -> PyResult<(usize, usize)> {
        let vals: Vec<f64> = match values {
            Some(v) => v.as_slice()?.to_vec(),
            None => vec![],
        };
        let layout = self.layout.clone();
        let games = &mut self.games;
        let (rows, n_pending, ms) = py.allow_threads(move || {
            let t0 = std::time::Instant::now();
            games.par_iter_mut().for_each(|g| g.advance(&layout, &vals));
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            let rows: usize = games.iter().filter_map(|g| g.pending.as_ref()).map(|s| s.n_leaves).sum();
            let n_pending = games.iter().filter(|g| g.pending.is_some()).count();
            (rows, n_pending, ms)
        });
        self.last_ms.0 = ms;
        Ok((rows, n_pending))
    }

    /// Copies every parked game's leaves into `buf[:rows]` (rows from step())
    /// in parallel and records each game's row offset. `buf` is reused across
    /// steps, so nothing is allocated or page-faulted per step.
    fn fill(&mut self, py: Python<'_>, mut buf: PyReadwriteArray2<f32>) -> PyResult<usize> {
        let nf = self.layout.n_features;
        let rows: usize = self.games.iter().filter_map(|g| g.pending.as_ref()).map(|s| s.n_leaves).sum();
        let (cap, width) = buf.as_array().dim();
        if width != nf || cap < rows {
            return Err(PyValueError::new_err(format!("fill buffer must be at least ({rows}, {nf})")));
        }
        let mut rest: &mut [f32] = buf.as_slice_mut()?;
        let mut jobs: Vec<(&mut ArenaGame, &mut [f32])> = Vec::new();
        let mut off = 0usize;
        for g in self.games.iter_mut() {
            let n = match g.pending.as_ref() {
                Some(s) => s.n_leaves,
                None => continue,
            };
            let (dst, tail) = rest.split_at_mut(n * nf);
            rest = tail;
            g.offset = off;
            off += n;
            jobs.push((g, dst));
        }
        let t0 = std::time::Instant::now();
        py.allow_threads(move || {
            jobs.into_par_iter().for_each(|(g, dst)| {
                let s = g.pending.as_mut().unwrap();
                dst.copy_from_slice(&s.leaves);
                let mut v = std::mem::take(&mut s.leaves); // backup only needs the tree + fixed values
                let used = v.len();
                v.clear();
                if v.capacity() > 4 * used {
                    v.shrink_to(2 * used); // one huge expansion must not pin ~10 MB per game for the rest of the game
                }
                g.leaf_buf = v;
            });
        });
        self.last_ms.1 = t0.elapsed().as_secs_f64() * 1e3;
        Ok(rows)
    }

    /// Drains finished games: (game_id, winner_seat or -1, num_turns, actual_vp
    /// per seat, recorded arrays, log [(action, outcome)] if kept, final snapshot).
    fn finished<'py>(&mut self, py: Python<'py>) -> PyResult<Vec<(i32, i8, i32, Vec<i32>, Bound<'py, PyDict>, Option<Vec<(Canon, (i32, i32))>>, Option<Bound<'py, PyDict>>)>> {
        let nf = self.layout.n_features;
        let (done, live): (Vec<ArenaGame>, Vec<ArenaGame>) = std::mem::take(&mut self.games).into_iter().partition(|g| g.done);
        self.games = live;
        let mut out = Vec::with_capacity(done.len());
        for g in done {
            let r = g.rec;
            let d = PyDict::new(py);
            let n = r.colors.len();
            d.set_item("X", Array2::from_shape_vec((n, nf), r.xs).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("color", r.colors)?;
            d.set_item("turn", r.turns)?;
            let m = r.rank_c.len() / nf;
            d.set_item("rank_c", Array2::from_shape_vec((m, nf), r.rank_c).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("rank_o", Array2::from_shape_vec((m, nf), r.rank_o).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            let k = r.sib_n.len();
            d.set_item("sib_x", Array3::from_shape_vec((k, K_SIB, nf), r.sib_x).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("sib_v", Array2::from_shape_vec((k, K_SIB), r.sib_v).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("sib_n", r.sib_n)?;
            d.set_item("sib_isp0", r.sib_isp0)?;
            let t = r.ts_v.len();
            d.set_item("ts_x", Array2::from_shape_vec((t, nf), r.ts_x).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("ts_v", r.ts_v)?;
            let q = r.ro_v.len();
            d.set_item("ro_x", Array2::from_shape_vec((q, nf), r.ro_x).map_err(|e| PyValueError::new_err(e.to_string()))?.into_pyarray(py))?;
            d.set_item("ro_v", r.ro_v)?;
            d.set_item("ro_n", r.ro_n)?;
            let log = g.log.map(|l| l.into_iter().map(|(a, o)| (to_canon(a), o)).collect());
            let snap = if self.keep_log { Some(PyState { inner: g.state.clone(), search: None }.snapshot(py)?) } else { None };
            let vps: Vec<i32> = g.state.players.iter().map(|p| p.actual_vp).collect();
            out.push((g.id, g.state.winner(), g.state.num_turns, vps, d, log, snap));
        }
        Ok(out)
    }
}

/// (leaves, ms encoding, ms generating children, ms total) of every expansion on the calling thread since the
/// last call (rayon workers keep their own counters; the arena sums them in step()).
#[pyfunction]
fn prof() -> (u64, f64, f64, f64) {
    let (l, e, c, t) = crate::search::PROF.with(|p| p.replace((0, 0, 0, 0)));
    (l, e as f64 / 1e6, c as f64 / 1e6, t as f64 / 1e6)
}

#[pyfunction]
fn action_types() -> Vec<&'static str> {
    vec!["ROLL", "MOVE_ROBBER", "DISCARD_RESOURCE", "BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "BUY_DEVELOPMENT_CARD", "PLAY_KNIGHT_CARD", "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_ROAD_BUILDING", "MARITIME_TRADE", "END_TURN"]
}

/// The paper's DRRL trade layer (drrl.rs): one instance per seat per game; `trade_action` learns from
/// the previous decision and returns an offer / reply, or None when the base bot should decide.
/// jsettler::bse for seat `pn` of `state`, for the oracle check (tools/jsettlers_oracle.py): rolls per
/// resource (engine order), then the road/settlement/city/card/ship ETAs from now (fast), from nothing
/// (fast, limit 40) and from now (accurate).
#[pyfunction]
fn jsettler_bse(state: &PyState, pn: usize) -> (Vec<i32>, Vec<i32>, Vec<i32>, Vec<i32>) {
    use crate::jsettler::bse::{Bse, Ports};
    let s = &state.inner;
    let b = Bse::of(s, pn, None);
    let ports = Ports::of(s, pn);
    let have = s.players[pn].hand;
    (b.rolls_per_resource.to_vec(), b.from_now_fast(&have, &ports).to_vec(), b.from_nothing_fast(&ports, 40).to_vec(), b.from_now_accurate(&have, &ports).to_vec())
}

/// jsettler::tracker::Trackers for the oracle check: fed the logged piece events, asked for the ETAs.
/// JSettlers-ordered 6-vectors per seat (CLAY, ORE, SHEEP, WHEAT, WOOD, UNKNOWN) -> engine-ordered Views.
fn views_from_js(views: Vec<Vec<i32>>) -> PyResult<crate::jsettler::view::Views> {
    use crate::jsettler::negotiator::js;
    let mut out = crate::jsettler::view::Views::new(views.len());
    for (seat, v) in views.iter().enumerate() {
        if v.len() != 6 {
            return Err(PyValueError::new_err("each view has 6 counts: CLAY, ORE, SHEEP, WHEAT, WOOD, UNKNOWN"));
        }
        for t in 1..=5 {
            out.0[seat][js(t)] = v[t - 1];
        }
        out.0[seat][5] = v[5];
    }
    Ok(out)
}

fn game_info(lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>) -> crate::jsettler::tracker::GameInfo {
    crate::jsettler::tracker::GameInfo {
        lr_player: if lr_player < 0 { None } else { Some(lr_player as usize) },
        la_player: if la_player < 0 { None } else { Some(la_player as usize) },
        knights,
        knight_cards_old,
        knight_cards_new,
        dev_cards_left,
        total_vp,
        vp_winner: 10,
    }
}

#[pyclass(name = "JsTrackers")]
struct PyTrackers {
    inner: crate::jsettler::tracker::Trackers,
    openings: Vec<crate::jsettler::opening::Opening>,
    dms: Vec<Option<crate::jsettler::dm::Dm>>,
    negotiators: Vec<Option<crate::jsettler::negotiator::Negotiator>>,
}

#[pymethods]
impl PyTrackers {
    /// `node_js`: JSettlers node coord per catanatron node id (the board's rotation).
    #[new]
    fn new(state: &PyState, node_js: Vec<u16>) -> PyResult<PyTrackers> {
        let arr: [u16; crate::map::NUM_NODES] = node_js.try_into().map_err(|_| PyValueError::new_err("node_js needs 54 coords"))?;
        let n = state.inner.n;
        Ok(PyTrackers { inner: crate::jsettler::tracker::Trackers::new(state.inner.map.clone(), n, arr), openings: vec![Default::default(); n], dms: vec![None; n], negotiators: (0..n).map(|_| None).collect() })
    }

    /// OpeningBuildStrategy for one seat: the first settlement node.
    fn plan_initial_settlements(&mut self, pn: usize) -> i32 {
        self.openings[pn].plan_initial_settlements(&self.inner, pn)
    }

    fn plan_second_settlement(&mut self, pn: usize) -> i32 {
        self.openings[pn].plan_second_settlement(&self.inner, pn)
    }

    /// The initial road edge (JSettlers edge coord) after the seat's last settlement.
    fn plan_init_road(&mut self, pn: usize, game_state: i32, current: usize, first_player: usize) -> i32 {
        let turn = crate::jsettler::opening::Turn { game_state, current, first_player };
        self.openings[pn].plan_init_road(&self.inner, pn, &turn)
    }

    /// kind 0 road, 1 settlement, 2 city; coord in JSettlers coords; initial = during initial placement.
    fn on_piece(&mut self, kind: u8, pn: usize, coord: i32, initial: bool) {
        self.inner.on_piece(kind, pn, coord, initial)
    }

    /// Regular play has started (the game state left the START states).
    fn first_turn(&mut self) {
        self.inner.first_turn()
    }

    /// updateWinGameETAs with the client's view (pieces from the trackers, the rest given).
    /// Returns (winGameEta, longestRoadEta, largestArmyEta, roadsToGo) per seat.
    #[allow(clippy::too_many_arguments)]
    fn etas(&mut self, lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>) -> (Vec<i32>, Vec<i32>, Vec<i32>, Vec<i32>) {
        let info = game_info(lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp);
        self.inner.update_win_game_etas(&info);
        let t = &self.inner.trackers;
        (t.iter().map(|x| x.win_game_eta).collect(), t.iter().map(|x| x.longest_road_eta).collect(), t.iter().map(|x| x.largest_army_eta).collect(), t.iter().map(|x| x.roads_to_go).collect())
    }

    /// A new turn for the negotiator of one seat: resetIsSelling, resetOffersMade, resetTargetPieces.
    #[pyo3(signature = (pn, state, smart, views=None))]
    fn new_turn(&mut self, pn: usize, state: &PyState, smart: bool, views: Option<Vec<Vec<i32>>>) -> PyResult<()> {
        use crate::jsettler::dm::Params;
        let n = self.inner.players.len();
        let neg = self.negotiators[pn].get_or_insert_with(|| crate::jsettler::negotiator::Negotiator::new(pn, n, if smart { Params::SMART } else { Params::FAST }));
        if let Some(v) = views {
            neg.views = views_from_js(v)?;
        }
        neg.reset_is_selling(&state.inner);
        neg.reset_offers_made();
        neg.reset_target_pieces();
        Ok(())
    }

    /// SOCRobotNegotiator.considerOffer2 for `receiver` on an offer from `from` (JSettlers-ordered
    /// give/get counts): 0 reject, 1 accept, 2 counter.
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (receiver, smart, state, lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp, from, give, get, views=None))]
    fn consider_offer(&mut self, receiver: usize, smart: bool, state: &PyState, lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>, from: usize, give: Vec<i32>, get: Vec<i32>, views: Option<Vec<Vec<i32>>>) -> PyResult<i32> {
        use crate::jsettler::dm::Params;
        use crate::jsettler::negotiator::{Negotiator, Offer, Set};
        let info = game_info(lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp);
        let n = self.inner.players.len();
        let neg = self.negotiators[receiver].get_or_insert_with(|| Negotiator::new(receiver, n, if smart { Params::SMART } else { Params::FAST }));
        if let Some(v) = views {
            neg.views = views_from_js(v)?;
        }
        let mut g = Set::default();
        let mut r = Set::default();
        for t in 1..=5 {
            g.0[t] = give[t - 1];
            r.0[t] = get[t - 1];
        }
        let offer = Offer { from, to: (0..n).map(|q| q != from).collect(), give: g, get: r };
        neg.record_resources_from_offer(&offer);
        Ok(neg.consider_offer2(&mut self.inner, &state.inner, &info, &offer, receiver))
    }

    /// SOCRobotNegotiator.makeOffer for `pn` toward its target piece (from the last plan): the offer's
    /// JSettlers-ordered give and get counts, or None.
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (pn, smart, state, lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp, views=None))]
    fn make_offer(&mut self, pn: usize, smart: bool, state: &PyState, lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>, views: Option<Vec<Vec<i32>>>) -> PyResult<Option<(Vec<i32>, Vec<i32>)>> {
        use crate::jsettler::dm::Params;
        use crate::jsettler::negotiator::Negotiator;
        let info = game_info(lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp);
        let n = self.inner.players.len();
        let neg = self.negotiators[pn].get_or_insert_with(|| Negotiator::new(pn, n, if smart { Params::SMART } else { Params::FAST }));
        if let Some(v) = views {
            neg.views = views_from_js(v)?;
        }
        let Some(target) = neg.target_pieces[pn] else { return Ok(None) };
        let Some(o) = neg.make_offer(&mut self.inner, &state.inner, &info, target, None) else { return Ok(None) };
        neg.reset_wants_another_offer();
        Ok(Some((o.give.0[1..].to_vec(), o.get.0[1..].to_vec())))
    }

    /// SOCRobotNegotiator.makeCounterOffer for `pn` answering an offer (from, JSettlers-ordered give/get):
    /// the counter's JSettlers-ordered give and get counts, or None.
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (pn, smart, state, lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp, from, give, get, views=None))]
    fn make_counter_offer(&mut self, pn: usize, smart: bool, state: &PyState, lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>, from: usize, give: Vec<i32>, get: Vec<i32>, views: Option<Vec<Vec<i32>>>) -> PyResult<Option<(Vec<i32>, Vec<i32>)>> {
        use crate::jsettler::dm::Params;
        use crate::jsettler::negotiator::{Negotiator, Set};
        let info = game_info(lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp);
        let n = self.inner.players.len();
        let neg = self.negotiators[pn].get_or_insert_with(|| Negotiator::new(pn, n, if smart { Params::SMART } else { Params::FAST }));
        if let Some(v) = views {
            neg.views = views_from_js(v)?;
        }
        let mut g = Set::default();
        for t in 1..=5 {
            g.0[t] = give[t - 1];
        }
        let _ = (from, get);
        let Some(target) = neg.target_piece(&mut self.inner, &state.inner, &info, pn) else { return Ok(None) };
        let Some(o) = neg.make_offer(&mut self.inner, &state.inner, &info, target, Some(&g)) else { return Ok(None) };
        Ok(Some((o.give.0[1..].to_vec(), o.get.0[1..].to_vec())))
    }

    /// A trade message for one seat's negotiator: kind "offer" (another player's offer: from, give, get,
    /// to), "reject" (rejector of our offer: give/get are ours), "made" (everyone rejected our offer: it
    /// joins offersMade) or "noresponse" (our offer timed out). Counts are JSettlers-ordered.
    #[allow(clippy::too_many_arguments)]
    fn trade_event(&mut self, pn: usize, smart: bool, kind: &str, from: usize, give: Vec<i32>, get: Vec<i32>, to: Vec<bool>) {
        use crate::jsettler::dm::Params;
        use crate::jsettler::negotiator::{Negotiator, Offer, Set};
        let n = self.inner.players.len();
        let neg = self.negotiators[pn].get_or_insert_with(|| Negotiator::new(pn, n, if smart { Params::SMART } else { Params::FAST }));
        let mut g = Set::default();
        let mut r = Set::default();
        for t in 1..=5 {
            g.0[t] = give[t - 1];
            r.0[t] = get[t - 1];
        }
        let to = if to.len() == n { to } else { (0..n).map(|q| q != from).collect() };
        let offer = Offer { from, to, give: g, get: r };
        match kind {
            "offer" => neg.record_resources_from_offer(&offer),
            "reject" => neg.record_resources_from_reject(from, &offer),
            "rejectalt" => neg.record_resources_from_reject_alt(from, &offer),
            "made" => neg.add_to_offers_made(g, r),
            "noresponse" => neg.record_resources_from_no_response(&offer),
            _ => {}
        }
    }

    /// The trackers' ETAs as they stand (no recomputation): (winGameEta, longestRoadEta, largestArmyEta).
    fn stored_etas(&self) -> (Vec<i32>, Vec<i32>, Vec<i32>) {
        let t = &self.inner.trackers;
        (t.iter().map(|x| x.win_game_eta).collect(), t.iter().map(|x| x.longest_road_eta).collect(), t.iter().map(|x| x.largest_army_eta).collect())
    }

    /// The last plan's favourite settlement, city, road (coord, score) and card score for one seat.
    fn favorites(&self, pn: usize) -> (Option<(i32, f32)>, Option<(i32, f32)>, Option<(i32, f32)>, Option<f32>) {
        self.dms[pn].as_ref().map(|d| d.favorites()).unwrap_or((None, None, None, None))
    }

    /// SOCRobotDM.planStuff for one seat: the plan in build order as (type, coord) with the Java's
    /// type codes (road 0, settlement 1, city 2, card -2). `resources` in engine order.
    #[allow(clippy::too_many_arguments)]
    fn plan(&mut self, pn: usize, smart: bool, lr_player: i32, la_player: i32, knights: Vec<i32>, knight_cards_old: Vec<i32>, knight_cards_new: Vec<i32>, dev_cards_left: i32, total_vp: Vec<i32>, resources: Vec<i32>, has_played_dev_card: bool, roads_card_playable: bool, for_special_building: bool) -> Vec<(i32, i32)> {
        use crate::jsettler::dm::{Dm, Params, Piece, PlanInput};
        let info = game_info(lr_player, la_player, knights, knight_cards_old, knight_cards_new, dev_cards_left, total_vp);
        let dm = self.dms[pn].get_or_insert_with(|| Dm::new(if smart { Params::SMART } else { Params::FAST }, pn));
        dm.plan.clear();
        let mut res = [0; 5];
        res.copy_from_slice(&resources[..5]);
        dm.plan_stuff(&mut self.inner, &PlanInput { info: &info, resources: res, has_played_dev_card, roads_card_playable, for_special_building });
        let first = dm.plan_in_order().first().copied();
        let neg = self.negotiators[pn].get_or_insert_with(|| crate::jsettler::negotiator::Negotiator::new(pn, self.inner.players.len(), if smart { Params::SMART } else { Params::FAST }));
        neg.target_pieces[pn] = first; // SOCRobotBrain.planBuilding -> negotiator.setTargetPiece
        dm.plan_in_order()
            .into_iter()
            .map(|p| match p {
                Piece::Road(c) => (0, c),
                Piece::Settlement(c) => (1, c),
                Piece::City(c) => (2, c),
                Piece::Card => (-2, 0),
            })
            .collect()
    }

    /// One seat's potential settlements and roads (SOCPlayer's sets), for the oracle check.
    fn potentials(&self, pn: usize) -> (Vec<i32>, Vec<i32>) {
        let p = &self.inner.players[pn];
        (p.potential_settlements.iter().copied().collect(), p.potential_roads.iter().copied().collect())
    }

    /// The possible settlements (coord, necessary road count) and roads of one seat, for debugging.
    fn possibles(&self, pn: usize) -> (Vec<(i32, i32)>, Vec<(i32, i32)>, Vec<i32>) {
        let t = &self.inner.trackers[pn];
        (t.possible_settlements.values().map(|p| (p.coord, p.n_necessary)).collect(), t.possible_roads.values().map(|p| (p.coord, p.n_necessary)).collect(), t.possible_cities.keys().copied().collect())
    }
}

/// jsettler::brain::Jsettler: the ported JSettlers robot as a player on this engine.
#[pyclass(name = "Jsettler")]
struct PyJsettler {
    inner: crate::jsettler::brain::Jsettler,
}

#[pymethods]
impl PyJsettler {
    /// `smart`: SOCRobotDM.SMART_STRATEGY ("robot N") else FAST ("droid N"); `node_js`: JSettlers node
    /// coord per catanatron node id when the board is a bridge board (default: the BASE template).
    #[new]
    #[pyo3(signature = (state, pn, smart, seed, node_js=None))]
    fn new(state: &PyState, pn: usize, smart: bool, seed: u64, node_js: Option<Vec<u16>>) -> PyResult<PyJsettler> {
        use crate::jsettler::dm::Params;
        let arr: [u16; crate::map::NUM_NODES] = match node_js {
            Some(v) => v.try_into().map_err(|_| PyValueError::new_err("node_js needs 54 coords"))?,
            None => crate::jsettler::geom::NODE_JS_ROT0,
        };
        Ok(PyJsettler { inner: crate::jsettler::brain::Jsettler::new(state.inner.map.clone(), state.inner.n, pn, if smart { Params::SMART } else { Params::FAST }, seed, arr) })
    }

    /// A piece the trackers have not seen: kind 0 road / 1 settlement / 2 city, seat, engine node or
    /// edge id, during initial placement. Only needed when the state carries no piece log (a state
    /// rebuilt from Python).
    fn observe(&mut self, kind: u8, pn: usize, coord: u8, initial: bool) {
        self.inner.observe(kind, pn, coord, initial)
    }

    /// The same with a JSettlers coordinate (the bridge's piece log).
    fn observe_js(&mut self, kind: u8, pn: usize, coord: i32, initial: bool) {
        self.inner.tr.on_piece(kind, pn, coord, initial)
    }

    /// The client's SOCPlayer.getResources() per seat, JSettlers order (CLAY, ORE, SHEEP, WHEAT, WOOD,
    /// UNKNOWN), for a state rebuilt from a client that saw the game (the bridge).
    fn set_views(&mut self, views: Vec<Vec<i32>>) -> PyResult<()> {
        self.inner.set_views(views_from_js(views)?);
        Ok(())
    }

    /// A trade message the client saw: kind "offer" (from, give, get, to) or "reject" / "accept"
    /// (`from` = the answering seat). Counts JSettlers-ordered (CLAY, ORE, SHEEP, WHEAT, WOOD).
    fn trade_event(&mut self, kind: &str, from: usize, give: Vec<i32>, get: Vec<i32>, to: Vec<bool>) -> PyResult<()> {
        use crate::jsettler::negotiator::js;
        if give.len() != 5 || get.len() != 5 {
            return Err(PyValueError::new_err("give and get have 5 counts"));
        }
        let mut g = [0i32; 5];
        let mut r = [0i32; 5];
        for t in 1..=5 {
            g[js(t)] = give[t - 1];
            r[js(t)] = get[t - 1];
        }
        self.inner.trade_event(kind, from, g, r, to);
        Ok(())
    }

    fn decide(&mut self, state: &PyState) -> Option<Canon> {
        self.inner.decide(&state.inner).map(to_canon)
    }
}

#[pyclass(name = "Drrl")]
struct PyDrrl {
    inner: Drrl,
}

#[pymethods]
impl PyDrrl {
    #[new]
    /// `variant`: letters from drrl.rs `Variant` (b basis, l literal update, c counter-offers, w TF init).
    #[pyo3(signature = (seed, hidden=DRRL_N_IN, variant=""))]
    fn new(seed: u64, hidden: usize, variant: &str) -> PyResult<PyDrrl> {
        Ok(PyDrrl { inner: Drrl::new(seed, hidden, DrrlVariant::parse(variant).map_err(PyValueError::new_err)?) })
    }

    fn trade_action(&mut self, state: &PyState) -> Option<Canon> {
        self.inner.trade_action(&state.inner).map(to_canon)
    }

    /// Keep the weights, clear the game memory (the paper's 30-game setting).
    fn new_game(&mut self) {
        self.inner.new_game()
    }

    fn weights(&self) -> Vec<f32> {
        self.inner.weights()
    }

    fn load(&mut self, data: Vec<f32>) -> PyResult<()> {
        self.inner.load(&data).map_err(PyValueError::new_err)
    }

    fn steps(&self) -> u64 {
        self.inner.steps
    }
}

/// The thesis MCTS agents (mcts.rs): `policy` = uct | buct | vpi, `sims` playouts per decision (None = the
/// policy's default), `cutoff` = the round cut-off c. `decide` is the whole player (trades and the heuristic
/// search on the prompts the search does not own).
#[pyclass(name = "Mcts")]
struct PyMcts {
    inner: Mcts,
}

#[pymethods]
impl PyMcts {
    #[new]
    #[pyo3(signature = (policy, sims=None, cutoff=10, seed=0))]
    fn new(policy: &str, sims: Option<u32>, cutoff: u32, seed: u64) -> PyResult<PyMcts> {
        let p = Policy::parse(policy).ok_or_else(|| PyValueError::new_err(format!("unknown policy {policy}")))?;
        Ok(PyMcts { inner: Mcts::new(p, sims.unwrap_or(p.default_sims()), cutoff, seed) })
    }

    fn decide(&mut self, state: &PyState) -> Option<Canon> {
        self.inner.decide(&state.inner).map(to_canon)
    }

    fn playouts(&self) -> u64 {
        self.inner.playouts
    }
}

#[pymodule]
fn catan_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyMap>()?;
    m.add_class::<PyLayout>()?;
    m.add_class::<PyState>()?;
    m.add_class::<PyArena>()?;
    m.add_class::<PyValueNet>()?;
    m.add_class::<PyDrrl>()?;
    m.add_class::<PyTrackers>()?;
    m.add_class::<PyJsettler>()?;
    m.add_function(wrap_pyfunction!(jsettler_bse, m)?)?;
    m.add("DRRL_N_IN", DRRL_N_IN)?;
    m.add_class::<PyMcts>()?;
    m.add_function(wrap_pyfunction!(action_types, m)?)?;
    m.add_function(wrap_pyfunction!(prof, m)?)?;
    Ok(())
}
