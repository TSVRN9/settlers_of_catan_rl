//! Rust-driven game loop. Many games advance in lockstep; every value-net
//! decision parks its expanded leaves, Python scores all parked leaves in one
//! forward, and `advance` resumes each game from the backed-up choice. The
//! sampler mirrors gen_games.StateSampler one-for-one (docs/FINDINGS.md).

use crate::actions::Action;
use crate::apply::Outcome;
use crate::encode::Layout;
use crate::jsettler::brain::Jsettler;
use crate::jsettler::dm::Params as JsParams;
use crate::jsettler::geom::NODE_JS_ROT0;
use crate::mcts::Mcts;
use crate::trade::Eval;
use crate::search::Search;
use crate::state::State;
use crate::valuenet::ValueNet;
use std::sync::Arc;

pub const K_SIB: usize = 6;
pub const K_TS: usize = 5; // children per recorded search tree (plus the root)
pub const TURNS_LIMIT: i32 = 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Seat {
    Vnet,
    Rab,
    RabDepth(u8),  // AlphaBeta's exact expectimax at this depth (rab3 measured +7.6 pts over rab, FINDINGS)
    Jsettler(bool), // the jSettlers robot port (jsettler/brain.rs), SMART params if true else FAST: a non-base_fn trader
    Uct(u32, u16, bool), // the thesis UCT agent (mcts.rs, random playouts, base_fn trades): playouts, exploration c x 100, dev-card resample
    CpuNet(u8),    // depth-2 expectimax over pool net k on the CPU (decide_vnet), net-judged trades: lineage / self-play seats
}

/// Actions whose child state is fully determined (gen_games.DETERMINISTIC +
/// a robber move with no victim).
pub fn deterministic(a: Action) -> bool {
    !matches!(a, Action::Roll | Action::BuyDev) && !matches!(a, Action::MoveRobber { victim, .. } if victim >= 0)
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// gen_games.StateSampler: samples, AlphaBeta chosen-vs-other pairs, sibling sets.
pub struct Recorder {
    rng: u64, // own stream, so recording never perturbs the game's chance outcomes
    sample_p: f64,
    rank_p: f64,
    sib_p: f64,
    ts_p: f64,
    roll_p: f64,
    roll_m: u32,
    roll_depth: u32, // 2 = pruned depth-2 policy (decide_rollout); 1 = decide_heuristic(1) (experiment)
    net: Option<Arc<ValueNet>>, // rollout policy = this net at one ply (decide_net_rollout) instead of base_fn
    net_own: bool,              // ... for the labeled decider's own moves only; the other seats stay rab (label = P(win) vs rab, 4x fewer net decisions)
    net_buf: Vec<f32>,          // its leaf buffer, recycled across playout decisions
    pub xs: Vec<f32>,
    pub colors: Vec<u8>,
    pub turns: Vec<i32>,
    pub rank_c: Vec<f32>,
    pub rank_o: Vec<f32>,
    pub sib_x: Vec<f32>,
    pub sib_v: Vec<f64>,
    pub sib_n: Vec<i8>,
    pub sib_isp0: Vec<bool>,
    pub ts_x: Vec<f32>, // search-value distillation: root + up to K_TS deterministic children of a value-net decision, decider's perspective
    pub ts_v: Vec<f64>, // ... each with its backed-up expectimax value (P(decider wins)), a soft target (docs/FINDINGS.md, TreeStrap-lite)
    pub ro_x: Vec<f32>, // rollout-labeled children of a decision (any seat), decider's perspective
    pub ro_v: Vec<f64>, // ... fraction of roll_m rab-vs-rab rollouts from that child the decider won: a value target that owes nothing to the net
    pub ro_n: Vec<i8>,  // children recorded per labeled decision (consecutive rows), for sibling-ranking losses
}

impl Recorder {
    pub fn new(seed: u64, sample_p: f64, rank_p: f64, sib_p: f64, ts_p: f64, roll_p: f64, roll_m: u32, roll_depth: u32, net: Option<Arc<ValueNet>>, net_own: bool) -> Recorder {
        Recorder { rng: seed ^ 0xA5A5_5A5A_1234_8765, sample_p, rank_p, sib_p, ts_p, roll_p, roll_m, roll_depth, net, net_own, net_buf: vec![], xs: vec![], colors: vec![], turns: vec![], rank_c: vec![], rank_o: vec![], sib_x: vec![], sib_v: vec![], sib_n: vec![], sib_isp0: vec![], ts_x: vec![], ts_v: vec![], ro_x: vec![], ro_v: vec![], ro_n: vec![] }
    }

    /// One playout from `s` by the rollout policy (rab-vs-rab, or the net at one ply when `net` is
    /// set; own RNG stream, the game's chance outcomes are untouched). 1 if `p0` won, 0 otherwise
    /// (incl. turn limit).
    fn rollout(&mut self, mut s: State, p0: usize, layout: &Layout) -> f64 {
        s.rng = splitmix(&mut self.rng);
        while s.winner() < 0 && s.num_turns < TURNS_LIMIT {
            let acts = s.search_actions();
            let a = if acts.len() == 1 {
                acts[0]
            } else if let Some(net) = self.net.as_ref().filter(|_| !self.net_own || s.current_player == p0) {
                s.decide_net_rollout(net, layout, &mut self.net_buf).unwrap_or(acts[0])
            } else if self.roll_depth == 1 {
                s.decide_heuristic(1).unwrap_or(acts[0])
            } else {
                s.decide_rollout().unwrap_or(acts[0])
            };
            if s.apply(a, None).is_err() {
                return 0.0;
            }
        }
        (s.winner() == p0 as i8) as u8 as f64
    }

    /// With probability roll_p at a decision with >= 2 deterministic children:
    /// up to K_SIB random children, each labeled with the decider's win
    /// fraction over roll_m rollouts (docs/FINDINGS.md 2026-09-02 evening:
    /// every target derived from the net's own search regressed; this one is
    /// the value of the AlphaBeta continuation, measured).
    fn record_rollouts(&mut self, s: &State, layout: &Layout) {
        let acts: Vec<Action> = s.search_actions().into_iter().filter(|&a| deterministic(a)).collect();
        if acts.len() < 2 {
            return;
        }
        let k = acts.len().min(K_SIB);
        let acts = self.sample(acts, k);
        let p0 = s.current_player;
        let mut row = Vec::with_capacity(layout.n_features);
        let mut kept = 0i8;
        for a in acts {
            let mut c = s.clone_light();
            if c.apply(a, None).is_err() {
                continue;
            }
            kept += 1;
            let mut wins = 0.0;
            for _ in 0..self.roll_m {
                wins += self.rollout(c.clone_light(), p0, layout);
            }
            row.clear();
            self.encode(&c, p0, layout, &mut row);
            self.ro_x.extend_from_slice(&row);
            self.ro_v.push(wins / self.roll_m as f64);
        }
        if kept > 0 {
            self.ro_n.push(kept);
        }
    }

    /// With probability ts_p: the root state (value = the search's root value)
    /// and up to K_TS random deterministic children (value = that child's
    /// expectation), all encoded from the decider's perspective.
    pub fn record_tree(&mut self, s: &State, root_v: f64, evs: &[(Action, f64)], layout: &Layout) {
        if self.ts_p <= 0.0 || self.rand() >= self.ts_p {
            return;
        }
        let p0 = s.current_player;
        let mut row = Vec::with_capacity(layout.n_features);
        self.encode(s, p0, layout, &mut row);
        self.ts_x.extend_from_slice(&row);
        self.ts_v.push(root_v);
        let det: Vec<(Action, f64)> = evs.iter().copied().filter(|(a, _)| deterministic(*a)).collect();
        let k = det.len().min(K_TS);
        for (a, v) in self.sample(det, k) {
            let mut c = s.clone_light();
            if c.apply(a, None).is_err() {
                continue;
            }
            row.clear();
            self.encode(&c, p0, layout, &mut row);
            self.ts_x.extend_from_slice(&row);
            self.ts_v.push(v);
        }
    }

    fn rand(&mut self) -> f64 {
        (splitmix(&mut self.rng) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, n: usize) -> usize {
        (splitmix(&mut self.rng) % n as u64) as usize
    }

    /// Partial Fisher-Yates: k distinct items of v, in draw order.
    fn sample<T: Copy>(&mut self, mut v: Vec<T>, k: usize) -> Vec<T> {
        for i in 0..k {
            let j = i + self.below(v.len() - i);
            v.swap(i, j);
        }
        v.truncate(k);
        v
    }

    fn encode(&self, s: &State, p0: usize, layout: &Layout, into: &mut Vec<f32>) {
        let start = into.len();
        into.extend_from_slice(&s.map.static_template);
        s.encode_into(p0, layout, &mut into[start..start + layout.n_features]);
    }

    /// Called once per tick with the state *before* `action` is applied.
    pub fn step(&mut self, s: &State, action: Action, seat: Seat, layout: &Layout) {
        if self.rand() < self.sample_p {
            let c = self.below(s.n);
            let mut row = Vec::with_capacity(layout.n_features);
            self.encode(s, c, layout, &mut row);
            self.xs.extend_from_slice(&row);
            self.colors.push(c as u8);
            self.turns.push(s.num_turns);
        }
        if self.rank_p > 0.0 && self.rand() < self.rank_p && seat == Seat::Rab {
            self.record_pair(s, action, layout);
        }
        if self.sib_p > 0.0 && self.rand() < self.sib_p {
            self.record_siblings(s, action, seat == Seat::Vnet && deterministic(action), layout);
        }
        if self.roll_p > 0.0 && self.rand() < self.roll_p {
            self.record_rollouts(s, layout);
        }
    }

    fn record_pair(&mut self, s: &State, action: Action, layout: &Layout) {
        if !deterministic(action) {
            return;
        }
        let others: Vec<Action> = s.search_actions().into_iter().filter(|&a| a != action && deterministic(a)).collect();
        if others.is_empty() {
            return;
        }
        let other = others[self.below(others.len())];
        let p0 = s.current_player;
        let mut sc = s.clone_light();
        let mut so = s.clone_light();
        if sc.apply(action, None).is_err() || so.apply(other, None).is_err() {
            return;
        }
        let mut xc = Vec::new();
        let mut xo = Vec::new();
        self.encode(&sc, p0, layout, &mut xc);
        self.encode(&so, p0, layout, &mut xo);
        self.rank_c.extend_from_slice(&xc);
        self.rank_o.extend_from_slice(&xo);
    }

    fn record_siblings(&mut self, s: &State, action: Action, self_play: bool, layout: &Layout) {
        let mut acts: Vec<Action> = s.search_actions().into_iter().filter(|&a| deterministic(a)).collect();
        if acts.len() < 2 {
            return;
        }
        if acts.len() > K_SIB {
            acts = if self_play {
                let mut v = self.sample(acts.into_iter().filter(|&a| a != action).collect(), K_SIB - 1);
                v.push(action);
                v
            } else {
                self.sample(acts, K_SIB)
            };
        }
        let p0 = if self_play { s.current_player } else { self.below(s.n) };
        let nf = layout.n_features;
        let mut rows: Vec<f32> = Vec::with_capacity(K_SIB * nf);
        let mut vals: Vec<f64> = Vec::new();
        let mut kept: Vec<Action> = Vec::new();
        for &a in &acts {
            let mut c = s.clone_light();
            if c.apply(a, None).is_err() {
                continue;
            }
            self.encode(&c, p0, layout, &mut rows);
            vals.push(c.base_fn(p0));
            kept.push(a);
        }
        if kept.len() < 2 {
            return;
        }
        if self_play {
            let Some(chosen) = kept.iter().position(|&a| a == action) else { return };
            vals = vec![0.0; kept.len()];
            vals[chosen] = 1.0;
        }
        rows.resize(K_SIB * nf, 0.0);
        vals.resize(K_SIB, f64::NAN);
        self.sib_x.extend_from_slice(&rows);
        self.sib_v.extend_from_slice(&vals);
        self.sib_n.push(kept.len() as i8);
        self.sib_isp0.push(p0 == s.current_player);
    }
}

pub struct ArenaGame {
    pub id: i32,
    pub state: State,
    pub seats: [Seat; 4],
    pub vnet_depth: u32,
    pub rab_depth: u32, // opponents stay at AlphaBeta's depth 2 while the net searches deeper
    pub max_leaves: usize, // per-decision leaf cap for depth > 2 (search.rs), 0 = unlimited
    pub own_turn: bool,    // search.rs expand_into: depth counts own actions only
    pub tau: f64,          // search.rs backup: soft-min temperature at opponent nodes (0 = exact min)
    pub prune: Option<(Arc<ValueNet>, usize)>, // search.rs expand_into: top-k replies at opponent nodes by this net
    pub mcts: Option<Box<(Mcts, Arc<ValueNet>)>>, // the value-net seat's post-roll main phase goes to net-valued UCT (mcts.rs search_net)
    pub pool_nets: Arc<Vec<Arc<ValueNet>>>, // Seat::CpuNet(k) plays pool_nets[k]
    pub jsettlers: [Option<Box<Jsettler>>; 4], // Seat::Jsettler brains, created on the seat's first decision (boxed: games are moved every step)
    pub uct: Box<Mcts>,                          // Seat::Uct (thesis UCT, one per game)
    pub trade_net: Option<(Arc<ValueNet>, bool)>, // the value-net seat trades with this net (trade.rs), partners predicted with base_fn unless .1
    pub pending: Option<Search>,
    pub leaf_buf: Vec<f32>, // recycled between decisions
    pub offset: usize,
    pub rec: Recorder,
    pub log: Option<Vec<(Action, Outcome)>>,
    pub done: bool,
}

impl ArenaGame {
    fn tick(&mut self, action: Action, layout: &Layout) {
        let seat = self.seats[self.state.current_player];
        self.rec.step(&self.state, action, seat, layout);
        let out = self.state.apply(action, None).expect("arena applied an illegal action");
        if let Some(log) = &mut self.log {
            log.push((action, out));
        }
    }

    /// Resume from the scored leaves (if parked), then play until the game
    /// ends or a value-net seat needs a forward.
    pub fn advance(&mut self, layout: &Layout, values: &[f64]) {
        if let Some(search) = self.pending.take() {
            let mut v = values[self.offset..self.offset + search.n_leaves].to_vec();
            for &(i, x) in &search.fixed {
                v[i] = x;
            }
            let (best, root_v, evs) = search.backup_full(&v, self.tau);
            self.rec.record_tree(&self.state, root_v, &evs, layout);
            let action = best.unwrap_or_else(|| self.state.playable_actions()[0]);
            self.tick(action, layout);
        }
        loop {
            if self.state.winner() >= 0 || self.state.num_turns >= TURNS_LIMIT {
                self.done = true;
                return;
            }
            let p = self.state.current_player;
            // Pool seats decide everything themselves, trades included.
            let pool_action = match self.seats[p] {
                Seat::Jsettler(smart) => {
                    let (map, n, seed) = (self.state.map.clone(), self.state.n, self.id as u64 ^ (p as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
                    let params = if smart { JsParams::SMART } else { JsParams::FAST };
                    self.jsettlers[p].get_or_insert_with(|| Box::new(Jsettler::new(map, n, p, params, seed, NODE_JS_ROT0))).decide(&self.state)
                }
                Seat::Uct(sims, c100, resample) => {
                    self.uct.sims = sims;
                    self.uct.c = c100 as f64 / 100.0;
                    self.uct.resample = resample;
                    self.uct.decide(&self.state)
                }
                Seat::RabDepth(d) => {
                    let acts = self.state.search_actions();
                    self.state.trade_action(&Eval::Heuristic).or_else(|| if acts.len() == 1 { Some(acts[0]) } else { self.state.decide_heuristic(d as u32) })
                }
                Seat::CpuNet(k) => {
                    let net = &self.pool_nets[k as usize];
                    self.state.trade_action(&Eval::NetVsHeuristic(net, layout)).or_else(|| self.state.decide_vnet(net, layout, 2, 0, false).action)
                }
                Seat::Vnet | Seat::Rab => None,
            };
            if !matches!(self.seats[p], Seat::Vnet | Seat::Rab) {
                let a = pool_action.unwrap_or_else(|| self.state.playable_actions()[0]);
                self.tick(a, layout);
                continue;
            }
            let acts = self.state.search_actions();
            // Trade prompts and offers go through the 1-ply policy; both seats use the heuristic
            // evaluator here (the arena scores value-net leaves in Python, batched, and trade
            // decisions are not batched -- ponytail: park trade candidates like leaves if it matters).
            let eval = match (&self.trade_net, self.seats[p]) {
                (Some((net, true)), Seat::Vnet) => Eval::Net(net, layout),
                (Some((net, false)), Seat::Vnet) => Eval::NetVsHeuristic(net, layout),
                _ => Eval::Heuristic,
            };
            if let Some(a) = self.state.trade_action(&eval) {
                self.tick(a, layout);
                continue;
            }
            if acts.len() == 1 {
                self.tick(acts[0], layout);
                continue;
            }
            match self.seats[p] {
                Seat::RabDepth(_) | Seat::Jsettler(_) | Seat::Uct(..) | Seat::CpuNet(_) => unreachable!("pool seats decided above"),
                Seat::Rab => {
                    let a = self.state.decide_heuristic(self.rab_depth).unwrap_or(acts[0]);
                    self.tick(a, layout);
                }
                Seat::Vnet if self.mcts.is_some() && Mcts::owns(&self.state, p) => {
                    let (m, net) = &mut **self.mcts.as_mut().unwrap();
                    let a = m.search_net(&self.state, net, layout).unwrap_or(acts[0]);
                    self.tick(a, layout);
                }
                Seat::Vnet => {
                    self.pending = Some(self.state.expand_into(self.vnet_depth, p, layout, std::mem::take(&mut self.leaf_buf), self.max_leaves, self.own_turn, self.prune.as_ref().map(|(n, k)| (&**n, *k))));
                    return;
                }
            }
        }
    }
}
