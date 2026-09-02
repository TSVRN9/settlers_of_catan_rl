//! Rust-driven game loop. Many games advance in lockstep; every value-net
//! decision parks its expanded leaves, Python scores all parked leaves in one
//! forward, and `advance` resumes each game from the backed-up choice. The
//! sampler mirrors gen_games.StateSampler one-for-one (docs/FINDINGS.md).

use crate::actions::Action;
use crate::apply::Outcome;
use crate::encode::Layout;
use crate::search::Search;
use crate::state::State;

pub const K_SIB: usize = 6;
pub const TURNS_LIMIT: i32 = 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Seat {
    Vnet,
    Rab,
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
    pub xs: Vec<f32>,
    pub colors: Vec<u8>,
    pub turns: Vec<i32>,
    pub rank_c: Vec<f32>,
    pub rank_o: Vec<f32>,
    pub sib_x: Vec<f32>,
    pub sib_v: Vec<f64>,
    pub sib_n: Vec<i8>,
    pub sib_isp0: Vec<bool>,
}

impl Recorder {
    pub fn new(seed: u64, sample_p: f64, rank_p: f64, sib_p: f64) -> Recorder {
        Recorder { rng: seed ^ 0xA5A5_5A5A_1234_8765, sample_p, rank_p, sib_p, xs: vec![], colors: vec![], turns: vec![], rank_c: vec![], rank_o: vec![], sib_x: vec![], sib_v: vec![], sib_n: vec![], sib_isp0: vec![] }
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
    }

    fn record_pair(&mut self, s: &State, action: Action, layout: &Layout) {
        if !deterministic(action) {
            return;
        }
        let others: Vec<Action> = s.playable_actions().into_iter().filter(|&a| a != action && deterministic(a)).collect();
        if others.is_empty() {
            return;
        }
        let other = others[self.below(others.len())];
        let p0 = s.current_player;
        let mut sc = s.clone();
        let mut so = s.clone();
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
        let mut acts: Vec<Action> = s.playable_actions().into_iter().filter(|&a| deterministic(a)).collect();
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
            let mut c = s.clone();
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
    pub depth: u32,
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
            let action = search.backup(&v).0.unwrap_or_else(|| self.state.playable_actions()[0]);
            self.tick(action, layout);
        }
        loop {
            if self.state.winner() >= 0 || self.state.num_turns >= TURNS_LIMIT {
                self.done = true;
                return;
            }
            let acts = self.state.playable_actions();
            let p = self.state.current_player;
            if acts.len() == 1 {
                self.tick(acts[0], layout);
                continue;
            }
            match self.seats[p] {
                Seat::Rab => {
                    let a = self.state.decide_heuristic(self.depth).unwrap_or(acts[0]);
                    self.tick(a, layout);
                }
                Seat::Vnet => {
                    self.pending = Some(self.state.expand_into(self.depth, p, layout, std::mem::take(&mut self.leaf_buf)));
                    return;
                }
            }
        }
    }
}
