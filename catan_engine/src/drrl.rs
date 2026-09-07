//! DRRL: the agent of Xenou, Chalkiadakis & Afantenos, "Deep Reinforcement Learning in Strategic
//! Board Game Environments" (EUMAS 2018), reproduced. A trade-only layer: 72 actions (70 offers of
//! 1-2 cards for 1 card, accept, reject), one LSTM cell + linear head per action, trained online by
//! SGD on a one-step TD error at every trade decision, weights fresh each game. Every other
//! decision belongs to the base bot (the jSettler in the paper; here the heuristic search, or the
//! jSettler through the bridge).
//!
//! Choices the paper leaves open, all recorded in docs/BENCHMARK.md: input is Table 1 on this
//! engine's 19 tiles / 54 nodes / 72 edges plus the fed-back Q-hat (154; the paper's 161 pads to
//! jSettlers' 7x7 grid), features scaled by their domain max, sigmoid output (the paper's "softmax"
//! on a scalar), gamma 0.9, truncated BPTT of one step (a TF1 session with fed-back state), every
//! head updated toward the same target (Alg. 1 lines 7-11), hidden = input width, truncated-normal
//! init sigma 0.1, greedy action choice, at most 3 offers per turn.

use crate::actions::{offer_key, Action, TRADE_BUNDLES};
use crate::state::{Prompt, State};

pub const N_ACTIONS: usize = 72;
pub const ACCEPT: usize = 70;
pub const REJECT: usize = 71; // on the player's own turn: make no offer
pub const N_IN: usize = 5 + 19 + 54 + 72 + 3 + 1;
pub const LR: f32 = 0.0023;
pub const GAMMA: f32 = 0.9;
pub const K: f32 = 0.01;
pub const MAX_OFFERS_PER_TURN: u32 = 3;

/// The paper's 70 offers: each 1- or 2-card bundle for one card of a resource it does not contain.
pub fn offers() -> Vec<([u8; 5], [u8; 5])> {
    let mut out = Vec::with_capacity(70);
    for give in TRADE_BUNDLES.iter() {
        for r in 0..5 {
            if give[r] == 0 {
                let mut get = [0u8; 5];
                get[r] = 1;
                out.push((*give, get));
            }
        }
    }
    debug_assert_eq!(out.len(), 70);
    out
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

struct Cell {
    w: Vec<f32>, // 4H x (N_IN + H), row-major; rows = i, f, g, o gates
    b: Vec<f32>, // 4H
    theta: Vec<f32>, // H
    h: Vec<f32>,
    c: Vec<f32>,
}

/// One forward pass of one cell, kept for the SGD step at the next decision.
struct Cache {
    h_prev: Vec<f32>,
    c_prev: Vec<f32>,
    gates: Vec<f32>, // post-activation i, f, g, o
    c: Vec<f32>,
    h: Vec<f32>,
    q: f32,
}

impl Cell {
    fn forward_from(&self, hidden: usize, x: &[f32], h_prev: &[f32], c_prev: &[f32]) -> Cache {
        let width = N_IN + hidden;
        let mut gates = vec![0f32; 4 * hidden];
        for (r, g) in gates.iter_mut().enumerate() {
            let row = &self.w[r * width..(r + 1) * width];
            let mut z = self.b[r];
            for (a, b) in row[..N_IN].iter().zip(x) {
                z += a * b;
            }
            for (a, b) in row[N_IN..].iter().zip(h_prev) {
                z += a * b;
            }
            *g = if r / hidden == 2 { z.tanh() } else { sigmoid(z) };
        }
        let (i, f, g, o) = (&gates[..hidden], &gates[hidden..2 * hidden], &gates[2 * hidden..3 * hidden], &gates[3 * hidden..]);
        let c: Vec<f32> = (0..hidden).map(|j| f[j] * c_prev[j] + i[j] * g[j]).collect();
        let h: Vec<f32> = (0..hidden).map(|j| o[j] * c[j].tanh()).collect();
        let q = sigmoid(h.iter().zip(&self.theta).map(|(a, b)| a * b).sum());
        Cache { h_prev: h_prev.to_vec(), c_prev: c_prev.to_vec(), gates, c, h, q }
    }

    fn forward(&mut self, hidden: usize, x: &[f32]) -> Cache {
        let cache = self.forward_from(hidden, x, &self.h, &self.c);
        self.h.clone_from(&cache.h);
        self.c.clone_from(&cache.c);
        cache
    }

    /// One SGD step on (q - target)^2 / 2 through the cached step, hidden state held constant.
    fn sgd(&mut self, hidden: usize, x: &[f32], k: &Cache, target: f32) {
        let width = N_IN + hidden;
        let dzq = (k.q - target) * k.q * (1.0 - k.q);
        let dh: Vec<f32> = self.theta.iter().map(|t| dzq * t).collect();
        for j in 0..hidden {
            self.theta[j] -= LR * dzq * k.h[j];
        }
        let (i, f, g, o) = (&k.gates[..hidden], &k.gates[hidden..2 * hidden], &k.gates[2 * hidden..3 * hidden], &k.gates[3 * hidden..]);
        let mut dz = vec![0f32; 4 * hidden];
        for j in 0..hidden {
            let tc = k.c[j].tanh();
            let dc = dh[j] * o[j] * (1.0 - tc * tc);
            dz[j] = dc * g[j] * i[j] * (1.0 - i[j]);
            dz[hidden + j] = dc * k.c_prev[j] * f[j] * (1.0 - f[j]);
            dz[2 * hidden + j] = dc * i[j] * (1.0 - g[j] * g[j]);
            dz[3 * hidden + j] = dh[j] * tc * o[j] * (1.0 - o[j]);
        }
        for (r, &d) in dz.iter().enumerate() {
            if d == 0.0 {
                continue;
            }
            let step = LR * d;
            self.b[r] -= step;
            let row = &mut self.w[r * width..(r + 1) * width];
            for (wv, xv) in row[..N_IN].iter_mut().zip(x) {
                *wv -= step * xv;
            }
            for (wv, hv) in row[N_IN..].iter_mut().zip(&k.h_prev) {
                *wv -= step * hv;
            }
        }
    }
}

struct Prev {
    x: Vec<f32>,
    vp: i32,
    caches: Vec<Cache>,
}

pub struct Drrl {
    pub hidden: usize,
    cells: Vec<Cell>,
    offers: Vec<([u8; 5], [u8; 5])>,
    q_hat: f32,
    prev: Option<Prev>,
    turn: i32,
    offers_this_turn: u32,
    pub steps: u64,
    rng: u64,
}

impl Drrl {
    pub fn new(seed: u64, hidden: usize) -> Drrl {
        let mut d = Drrl { hidden, cells: vec![], offers: offers(), q_hat: 0.0, prev: None, turn: -1, offers_this_turn: 0, steps: 0, rng: seed ^ 0xD1CE_5EED_2018_0EA5 };
        let width = N_IN + hidden;
        for _ in 0..N_ACTIONS {
            let w = (0..4 * hidden * width).map(|_| d.trunc_normal()).collect();
            let theta = (0..hidden).map(|_| d.trunc_normal()).collect();
            d.cells.push(Cell { w, b: vec![0.0; 4 * hidden], theta, h: vec![0.0; hidden], c: vec![0.0; hidden] });
        }
        d
    }

    /// Truncated normal (|z| <= 2), sigma 0.1, from a splitmix64 stream.
    fn trunc_normal(&mut self) -> f32 {
        loop {
            let mut u = [0f64; 2];
            for v in u.iter_mut() {
                self.rng = self.rng.wrapping_add(0x9E3779B97F4A7C15);
                let mut z = self.rng;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
                *v = ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64;
            }
            let z = (-2.0 * (1.0 - u[0]).ln()).sqrt() * (std::f64::consts::TAU * u[1]).cos();
            if z.abs() <= 2.0 {
                return 0.1 * z as f32;
            }
        }
    }

    /// Keep the weights, forget the game: the paper's "train across a series of games" setting.
    pub fn new_game(&mut self) {
        for c in &mut self.cells {
            c.h.iter_mut().for_each(|v| *v = 0.0);
            c.c.iter_mut().for_each(|v| *v = 0.0);
        }
        self.q_hat = 0.0;
        self.prev = None;
        self.turn = -1;
        self.offers_this_turn = 0;
    }

    /// Table 1 from the current player's seat, scaled by domain max, plus the previous Q-hat.
    pub fn encode(&self, s: &State) -> Vec<f32> {
        let p = s.current_player;
        let mut x = Vec::with_capacity(N_IN);
        x.extend(s.players[p].hand.iter().map(|&h| h as f32 / 10.0));
        let code = |t: usize| if s.map.tiles[t].resource < 0 { 0.0 } else { (s.map.tiles[t].resource + 1) as f32 / 5.0 };
        x.extend((0..s.map.tiles.len()).map(code));
        x.extend(s.owner.iter().zip(&s.is_city).map(|(&o, &city)| {
            if o < 0 { 0.0 } else { ((if o as usize == p { 3 } else { 1 }) + city as i32) as f32 / 4.0 }
        }));
        x.extend(s.road_owner.iter().map(|&o| if o < 0 { 0.0 } else if o as usize == p { 1.0 } else { 0.5 }));
        x.push(code(s.robber as usize));
        x.push(s.num_turns.min(100) as f32 / 100.0);
        x.push(s.players[p].actual_vp as f32 / 10.0);
        x.push(self.q_hat);
        debug_assert_eq!(x.len(), N_IN);
        x
    }

    /// Heads the agent may pick now; empty when the decision is not a trade decision.
    pub fn legal(&self, s: &State) -> Vec<usize> {
        let p = s.current_player;
        match s.prompt {
            Prompt::DecideTrade => {
                let mut v = vec![REJECT];
                if s.can_accept_offer(p) {
                    v.push(ACCEPT);
                }
                v
            }
            Prompt::PlayTurn if s.players[p].has_rolled && !s.is_road_building && !s.is_resolving_trade && self.offers_this_turn < MAX_OFFERS_PER_TURN => {
                let hand = s.players[p].hand;
                let mut v: Vec<usize> = (0..70)
                    .filter(|&i| {
                        let (give, get) = &self.offers[i];
                        (0..5).all(|r| hand[r] >= give[r] as i32) && !s.spent_offers.contains(&offer_key(give, get))
                    })
                    .collect();
                v.push(REJECT);
                v
            }
            _ => vec![],
        }
    }

    /// The trade decision for the current player, learning from the previous one on the way; None
    /// means "not a trade decision" or "no offer": the base bot decides.
    pub fn trade_action(&mut self, s: &State) -> Option<Action> {
        let legal = self.legal(s);
        if legal.is_empty() {
            return None;
        }
        if s.num_turns != self.turn {
            self.turn = s.num_turns;
            self.offers_this_turn = 0;
        }
        let x = self.encode(s);
        let hidden = self.hidden;
        let caches: Vec<Cache> = self.cells.iter_mut().map(|c| c.forward(hidden, &x)).collect();
        let vp = s.players[s.current_player].actual_vp;
        if let Some(prev) = self.prev.take() {
            let dvp = vp - prev.vp;
            let r = if dvp > 0 { dvp as f32 * K } else { -(vp as f32) * K };
            let target = r + GAMMA * legal.iter().map(|&i| caches[i].q).fold(f32::MIN, f32::max);
            for (cell, k) in self.cells.iter_mut().zip(&prev.caches) {
                cell.sgd(hidden, &prev.x, k, target);
            }
        }
        let best = legal.iter().copied().fold(legal[0], |b, i| if caches[i].q > caches[b].q { i } else { b });
        self.q_hat = caches[best].q;
        self.prev = Some(Prev { x, vp, caches });
        self.steps += 1;
        match s.prompt {
            Prompt::DecideTrade => Some(if best == ACCEPT { Action::AcceptTrade } else { Action::RejectTrade }),
            _ if best == REJECT => None,
            _ => {
                self.offers_this_turn += 1;
                let (give, get) = self.offers[best];
                Some(Action::OfferTrade { give, get })
            }
        }
    }

    /// All weights (w, b, theta per cell), for the persisted-across-games variant.
    pub fn weights(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for c in &self.cells {
            out.extend_from_slice(&c.w);
            out.extend_from_slice(&c.b);
            out.extend_from_slice(&c.theta);
        }
        out
    }

    pub fn load(&mut self, data: &[f32]) -> Result<(), String> {
        let per = self.cells[0].w.len() + self.cells[0].b.len() + self.hidden;
        if data.len() != per * N_ACTIONS {
            return Err(format!("drrl blob has {} floats, expected {} for hidden {}", data.len(), per * N_ACTIONS, self.hidden));
        }
        for (i, c) in self.cells.iter_mut().enumerate() {
            let mut off = i * per;
            for buf in [&mut c.w, &mut c.b, &mut c.theta] {
                let n = buf.len();
                buf.copy_from_slice(&data[off..off + n]);
                off += n;
            }
        }
        self.new_game();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;
    use crate::map::Map;
    use std::sync::Arc;

    /// A fresh agent picks a legal head, its offer is one the engine accepts, the next decision's
    /// SGD step moves every head's previous estimate toward the shared target, and the head count
    /// matches the paper's 72.
    #[test]
    fn drrl_learns_a_step() {
        assert_eq!(offers().len(), 70);
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(5, &layout)), 4, 1, 10);
        while s.initial_phase {
            let a = s.playable_actions()[0];
            s.apply(a, None).unwrap();
        }
        s.apply(Action::Roll, Some((2, 3))).unwrap();
        let p = s.current_player;
        s.players[p].hand = [2, 2, 0, 1, 1];
        let mut d = Drrl::new(7, 32);
        assert_eq!(d.encode(&s).len(), N_IN);
        let legal = d.legal(&s);
        assert!(legal.len() > 1 && legal.contains(&REJECT));
        let first = d.trade_action(&s);
        if let Some(a) = first {
            assert!(s.playable_actions().contains(&a), "{a:?} not playable");
            s.apply(a, None).unwrap();
            while s.prompt == Prompt::DecideTrade {
                s.apply(Action::RejectTrade, None).unwrap();
            }
        }
        // the pending step, trained toward a target far from its estimate: every head must move
        // toward it (at the paper's reward scale the true step is below f32 resolution, so the
        // check drives the backprop directly)
        let prev = d.prev.take().unwrap();
        for (cell, k) in d.cells.iter_mut().zip(&prev.caches) {
            let target = if k.q < 0.5 { 1.0 } else { 0.0 };
            cell.sgd(32, &prev.x, k, target);
            let q_new = cell.forward_from(32, &prev.x, &k.h_prev, &k.c_prev).q;
            assert!((q_new - target).abs() < (k.q - target).abs(), "head did not move toward target: {} -> {q_new} vs {target}", k.q);
        }
        s.players[p].actual_vp += 1;
        d.prev = Some(prev);
        d.trade_action(&s);
        assert_eq!(d.steps, 2);
        let w = d.weights();
        let mut e = Drrl::new(9, 32);
        e.load(&w).unwrap();
        assert_eq!(e.weights(), w);
    }
}
