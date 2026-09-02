//! Python boundary. Actions cross as canonical tuples (type, a, b, c) with
//! -1 padding; see rust_bridge.py for the Python side.

mod actions;
mod apply;
mod arena;
mod board;
mod encode;
mod heuristic;
mod map;
mod search;
mod state;

use std::sync::Arc;

use numpy::ndarray::Array2;
use numpy::{IntoPyArray, PyArray1, PyArray2, PyReadonlyArray1, PyReadwriteArray2};
use numpy::ndarray::Array3;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

use actions::Action;
use arena::{ArenaGame, Recorder, Seat, K_SIB};
use rayon::prelude::*;
use encode::Layout;
use map::{Map, Port, Tile};
use search::Search;
use state::{Player, Prompt, State};

type Canon = (String, i32, i32, i32);

fn to_canon(a: Action) -> Canon {
    match a {
        Action::Roll => ("ROLL".into(), -1, -1, -1),
        Action::MoveRobber { tile, victim } => ("MOVE_ROBBER".into(), tile as i32, victim as i32, -1),
        Action::Discard(r) => ("DISCARD_RESOURCE".into(), r as i32, -1, -1),
        Action::BuildRoad(e) => ("BUILD_ROAD".into(), e as i32, -1, -1),
        Action::BuildSettlement(n) => ("BUILD_SETTLEMENT".into(), n as i32, -1, -1),
        Action::BuildCity(n) => ("BUILD_CITY".into(), n as i32, -1, -1),
        Action::BuyDev => ("BUY_DEVELOPMENT_CARD".into(), -1, -1, -1),
        Action::PlayKnight => ("PLAY_KNIGHT_CARD".into(), -1, -1, -1),
        Action::PlayYop(a, b) => ("PLAY_YEAR_OF_PLENTY".into(), a as i32, b as i32, -1),
        Action::PlayMonopoly(r) => ("PLAY_MONOPOLY".into(), r as i32, -1, -1),
        Action::PlayRoadBuilding => ("PLAY_ROAD_BUILDING".into(), -1, -1, -1),
        Action::MaritimeTrade { give, rate, get } => ("MARITIME_TRADE".into(), give as i32, rate as i32, get as i32),
        Action::EndTurn => ("END_TURN".into(), -1, -1, -1),
    }
}

fn from_canon(c: &Canon) -> PyResult<Action> {
    let (t, a, b, d) = (c.0.as_str(), c.1, c.2, c.3);
    Ok(match t {
        "ROLL" => Action::Roll,
        "MOVE_ROBBER" => Action::MoveRobber { tile: a as u8, victim: b as i8 },
        "DISCARD_RESOURCE" => Action::Discard(a as u8),
        "BUILD_ROAD" => Action::BuildRoad(a as u8),
        "BUILD_SETTLEMENT" => Action::BuildSettlement(a as u8),
        "BUILD_CITY" => Action::BuildCity(a as u8),
        "BUY_DEVELOPMENT_CARD" => Action::BuyDev,
        "PLAY_KNIGHT_CARD" => Action::PlayKnight,
        "PLAY_YEAR_OF_PLENTY" => Action::PlayYop(a as u8, b as i8),
        "PLAY_MONOPOLY" => Action::PlayMonopoly(a as u8),
        "PLAY_ROAD_BUILDING" => Action::PlayRoadBuilding,
        "MARITIME_TRADE" => Action::MaritimeTrade { give: a as u8, rate: b as u8, get: d as u8 },
        "END_TURN" => Action::EndTurn,
        _ => return Err(PyValueError::new_err(format!("unknown action type {t}"))),
    })
}

fn prompt_str(p: Prompt) -> &'static str {
    match p {
        Prompt::InitialSettlement => "BUILD_INITIAL_SETTLEMENT",
        Prompt::InitialRoad => "BUILD_INITIAL_ROAD",
        Prompt::PlayTurn => "PLAY_TURN",
        Prompt::Discard => "DISCARD",
        Prompt::MoveRobber => "MOVE_ROBBER",
    }
}

fn prompt_from(s: &str) -> PyResult<Prompt> {
    Ok(match s {
        "BUILD_INITIAL_SETTLEMENT" => Prompt::InitialSettlement,
        "BUILD_INITIAL_ROAD" => Prompt::InitialRoad,
        "PLAY_TURN" => Prompt::PlayTurn,
        "DISCARD" => Prompt::Discard,
        "MOVE_ROBBER" => Prompt::MoveRobber,
        _ => return Err(PyValueError::new_err(format!("unsupported prompt {s} (trading is out of scope)"))),
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
        Ok(d)
    }

    fn playable_actions(&self) -> Vec<Canon> {
        self.inner.playable_actions().into_iter().map(to_canon).collect()
    }

    #[pyo3(signature = (action, result=None))]
    fn apply(&mut self, action: Canon, result: Option<(i32, i32)>) -> PyResult<(i32, i32)> {
        let a = from_canon(&action)?;
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
        let a = from_canon(&action)?;
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
            let a = from_canon(c)?;
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
    #[pyo3(signature = (layout, depth=2, sample_p=0.0, rank_p=0.0, sib_p=0.0, keep_log=false, rab_depth=2, max_leaves=0, ts_p=0.0, own_turn=false))]
    fn new(layout: &PyLayout, depth: u32, sample_p: f64, rank_p: f64, sib_p: f64, keep_log: bool, rab_depth: u32, max_leaves: usize, ts_p: f64, own_turn: bool) -> PyArena {
        PyArena { layout: layout.inner.clone(), depth, rab_depth, max_leaves, ts_p, own_turn, sample_p, rank_p, sib_p, keep_log, games: vec![], last_ms: (0.0, 0.0) }
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
            rec: Recorder::new(seed, self.sample_p, self.rank_p, self.sib_p, self.ts_p),
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
            let log = g.log.map(|l| l.into_iter().map(|(a, o)| (to_canon(a), o)).collect());
            let snap = if self.keep_log { Some(PyState { inner: g.state.clone(), search: None }.snapshot(py)?) } else { None };
            let vps: Vec<i32> = g.state.players.iter().map(|p| p.actual_vp).collect();
            out.push((g.id, g.state.winner(), g.state.num_turns, vps, d, log, snap));
        }
        Ok(out)
    }
}

#[pyfunction]
fn action_types() -> Vec<&'static str> {
    vec!["ROLL", "MOVE_ROBBER", "DISCARD_RESOURCE", "BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "BUY_DEVELOPMENT_CARD", "PLAY_KNIGHT_CARD", "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_ROAD_BUILDING", "MARITIME_TRADE", "END_TURN"]
}

#[pymodule]
fn catan_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyMap>()?;
    m.add_class::<PyLayout>()?;
    m.add_class::<PyState>()?;
    m.add_class::<PyArena>()?;
    m.add_function(wrap_pyfunction!(action_types, m)?)?;
    Ok(())
}
