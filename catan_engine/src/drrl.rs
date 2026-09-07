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
//!
//! [`Variant`] switches on the readings `drrl` does not take, so each can be measured on its own.

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

/// Readings of the paper that the default agent does not take, one letter each (docs/BENCHMARK.md Phase A):
/// `b` the literal Eq. 5 basis (a weightless gated recurrence on the raw integer features, theta the only
/// weights), `l` the literal Algorithm 1 update (the current state's heads regressed toward
/// r_t + gamma * Q-hat_{t-1} before the action is chosen), `c` counter-offers (a reply may be any
/// affordable offer; the engine cannot counter, so the caller turns it into a reject there), `w`
/// TensorFlow's default initialisers (theta truncated normal sigma 1, glorot-uniform LSTM kernel, forget
/// bias 1).
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Variant {
    pub basis: bool,
    pub literal: bool,
    pub counter: bool,
    pub tf_init: bool,
}

impl Variant {
    pub fn parse(flags: &str) -> Result<Variant, String> {
        let mut v = Variant::default();
        for ch in flags.chars() {
            match ch {
                'b' => v.basis = true,
                'l' => v.literal = true,
                'c' => v.counter = true,
                'w' => v.tf_init = true,
                _ => return Err(format!("unknown drrl variant flag {ch:?} (b, l, c, w)")),
            }
        }
        Ok(v)
    }
}

/// Eq. 7: the VP gained this step times k, else minus the VP held times k.
fn reward(vp: i32, prev_vp: i32) -> f32 {
    let dvp = vp - prev_vp;
    if dvp > 0 { dvp as f32 * K } else { -(vp as f32) * K }
}

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
    /// Eq. 5 literally: phi_j = (1 - sigmoid(s_j)) * phi_j(t-1) + sigmoid(s_j) * tanh(s_j), no weights.
    fn basis_from(&self, x: &[f32], h_prev: &[f32]) -> Cache {
        let h: Vec<f32> = x.iter().zip(h_prev).map(|(&v, &p)| (1.0 - sigmoid(v)) * p + sigmoid(v) * v.tanh()).collect();
        let q = sigmoid(h.iter().zip(&self.theta).map(|(a, b)| a * b).sum());
        Cache { h_prev: h_prev.to_vec(), c_prev: vec![], gates: vec![], c: vec![], h, q }
    }

    fn forward_from(&self, hidden: usize, x: &[f32], h_prev: &[f32], c_prev: &[f32]) -> Cache {
        if self.w.is_empty() {
            return self.basis_from(x, h_prev);
        }
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
        if self.w.is_empty() {
            return; // the Eq. 5 basis has nothing else to train
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
    pub variant: Variant,
    cells: Vec<Cell>,
    offers: Vec<([u8; 5], [u8; 5])>,
    q_hat: f32,
    prev: Option<Prev>,
    prev_vp: Option<i32>,
    turn: i32,
    offers_this_turn: u32,
    pub steps: u64,
    rng: u64,
}

impl Drrl {
    pub fn new(seed: u64, hidden: usize, variant: Variant) -> Drrl {
        let hidden = if variant.basis { N_IN } else { hidden };
        let mut d = Drrl { hidden, variant, cells: vec![], offers: offers(), q_hat: 0.0, prev: None, prev_vp: None, turn: -1, offers_this_turn: 0, steps: 0, rng: seed ^ 0xD1CE_5EED_2018_0EA5 };
        let width = N_IN + hidden;
        let theta_sigma = if variant.tf_init { 1.0 } else { 0.1 };
        let glorot = (6.0 / (width + 4 * hidden) as f32).sqrt();
        for _ in 0..N_ACTIONS {
            let (w, mut b) = if variant.basis {
                (vec![], vec![])
            } else if variant.tf_init {
                ((0..4 * hidden * width).map(|_| (2.0 * d.uniform() - 1.0) * glorot).collect(), vec![0.0; 4 * hidden])
            } else {
                ((0..4 * hidden * width).map(|_| d.trunc_normal(0.1)).collect(), vec![0.0; 4 * hidden])
            };
            if variant.tf_init && !variant.basis {
                b[hidden..2 * hidden].iter_mut().for_each(|v| *v = 1.0); // forget bias
            }
            let theta = (0..hidden).map(|_| d.trunc_normal(theta_sigma)).collect();
            d.cells.push(Cell { w, b, theta, h: vec![0.0; hidden], c: vec![0.0; hidden] });
        }
        d
    }

    /// Uniform in [0, 1) from a splitmix64 stream.
    fn uniform(&mut self) -> f32 {
        self.rng = self.rng.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        (((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64) as f32
    }

    /// Truncated normal (|z| <= 2) times sigma.
    fn trunc_normal(&mut self, sigma: f32) -> f32 {
        loop {
            let u = [self.uniform() as f64, self.uniform() as f64];
            let z = (-2.0 * (1.0 - u[0]).ln()).sqrt() * (std::f64::consts::TAU * u[1]).cos();
            if z.abs() <= 2.0 {
                return sigma * z as f32;
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
        self.prev_vp = None;
        self.turn = -1;
        self.offers_this_turn = 0;
    }

    /// Table 1 from the current player's seat, each feature scaled by its domain max (raw integers, as the
    /// paper fed them, under the `b` variant), plus the previous Q-hat.
    pub fn encode(&self, s: &State) -> Vec<f32> {
        let p = s.current_player;
        let mut x = Vec::with_capacity(N_IN);
        let raw = self.variant.basis;
        let mut push = |v: f32, max: f32| x.push(if raw { v } else { v / max });
        for &h in &s.players[p].hand {
            push(h as f32, 10.0);
        }
        let code = |t: usize| if s.map.tiles[t].resource < 0 { 0.0 } else { (s.map.tiles[t].resource + 1) as f32 };
        for t in 0..s.map.tiles.len() {
            push(code(t), 5.0);
        }
        for (&o, &city) in s.owner.iter().zip(&s.is_city) {
            push(if o < 0 { 0.0 } else { ((if o as usize == p { 3 } else { 1 }) + city as i32) as f32 }, 4.0);
        }
        for &o in &s.road_owner {
            push(if o < 0 { 0.0 } else if o as usize == p { 2.0 } else { 1.0 }, 2.0);
        }
        push(code(s.robber as usize), 5.0);
        push(s.num_turns.min(100) as f32, 100.0);
        push(s.players[p].actual_vp as f32, 10.0);
        push(self.q_hat, 1.0);
        debug_assert_eq!(x.len(), N_IN);
        x
    }

    /// The offers the current player can afford (spent ones excluded on the player's own turn).
    fn affordable(&self, s: &State, skip_spent: bool) -> Vec<usize> {
        let hand = s.players[s.current_player].hand;
        (0..70)
            .filter(|&i| {
                let (give, get) = &self.offers[i];
                (0..5).all(|r| hand[r] >= give[r] as i32) && !(skip_spent && s.spent_offers.contains(&offer_key(give, get)))
            })
            .collect()
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
                if self.variant.counter {
                    v.extend(self.affordable(s, false));
                }
                v
            }
            Prompt::PlayTurn if s.players[p].has_rolled && !s.is_road_building && !s.is_resolving_trade && self.offers_this_turn < MAX_OFFERS_PER_TURN => {
                let mut v = self.affordable(s, true);
                v.push(REJECT);
                v
            }
            _ => vec![],
        }
    }

    /// The trade decision for the current player, learning from the previous one on the way; None
    /// means "not a trade decision" or "no offer": the base bot decides. Under the `c` variant a reply
    /// may be an `OfferTrade` (a counter-offer); callers on an engine that cannot counter reject instead.
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
        let mut caches: Vec<Cache> = self.cells.iter_mut().map(|c| c.forward(hidden, &x)).collect();
        let vp = s.players[s.current_player].actual_vp;
        if self.variant.literal {
            // Algorithm 1 as written: every head at s_t is regressed toward r_t + gamma * Q-hat_{t-1}
            // (the fed-back estimate is the bootstrap), then re-evaluated before the argmax (line 11)
            let target = reward(vp, self.prev_vp.unwrap_or(vp)) + GAMMA * self.q_hat;
            for (cell, k) in self.cells.iter_mut().zip(caches.iter_mut()) {
                cell.sgd(hidden, &x, k, target);
                let again = cell.forward_from(hidden, &x, &k.h_prev, &k.c_prev);
                cell.h.clone_from(&again.h);
                cell.c.clone_from(&again.c);
                *k = again;
            }
        } else if let Some(prev) = self.prev.take() {
            let target = reward(vp, prev.vp) + GAMMA * legal.iter().map(|&i| caches[i].q).fold(f32::MIN, f32::max);
            for (cell, k) in self.cells.iter_mut().zip(&prev.caches) {
                cell.sgd(hidden, &prev.x, k, target);
            }
        }
        self.prev_vp = Some(vp);
        let best = legal.iter().copied().fold(legal[0], |b, i| if caches[i].q > caches[b].q { i } else { b });
        self.q_hat = caches[best].q;
        if !self.variant.literal {
            self.prev = Some(Prev { x, vp, caches });
        }
        self.steps += 1;
        match (s.prompt, best) {
            (Prompt::DecideTrade, ACCEPT) => Some(Action::AcceptTrade),
            (Prompt::DecideTrade, REJECT) => Some(Action::RejectTrade),
            (_, REJECT) => None,
            _ => {
                if s.prompt == Prompt::PlayTurn {
                    self.offers_this_turn += 1;
                }
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
        let mut d = Drrl::new(7, 32, Variant::default());
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
        let mut e = Drrl::new(9, 32, Variant::default());
        e.load(&w).unwrap();
        assert_eq!(e.weights(), w);
    }

    /// The literal readings: the Eq. 5 basis has theta only, the Algorithm 1 update moves the current
    /// heads toward the fed-back target before acting, a reply may be a counter-offer.
    #[test]
    fn drrl_variants_step() {
        assert!(Variant::parse("x").is_err());
        let v = Variant::parse("blcw").unwrap();
        assert_eq!(v, Variant { basis: true, literal: true, counter: true, tf_init: true });
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(5, &layout)), 4, 1, 10);
        while s.initial_phase {
            let a = s.playable_actions()[0];
            s.apply(a, None).unwrap();
        }
        s.apply(Action::Roll, Some((2, 3))).unwrap();
        let p = s.current_player;
        s.players[p].hand = [2, 2, 0, 1, 1];
        let mut d = Drrl::new(7, 32, v);
        assert_eq!(d.hidden, N_IN);
        assert_eq!(d.weights().len(), N_ACTIONS * N_IN);
        assert!(d.encode(&s).iter().any(|&f| f > 1.0), "basis variant feeds raw integers");
        let before = d.weights();
        let a = d.trade_action(&s);
        assert!(d.weights() != before, "the literal update trains before acting");
        if let Some(a) = a {
            s.apply(a, None).unwrap();
            // the responders: a counter-offer is a legal head, and comes back as an OfferTrade
            let seat = s.current_player;
            s.players[seat].hand = [3, 3, 3, 3, 3];
            let mut e = Drrl::new(3, 32, Variant::parse("c").unwrap());
            assert!(e.legal(&s).len() > 2);
            let reply = e.trade_action(&s).unwrap();
            assert!(matches!(reply, Action::AcceptTrade | Action::RejectTrade | Action::OfferTrade { .. }));
            while s.prompt == Prompt::DecideTrade {
                s.apply(Action::RejectTrade, None).unwrap();
            }
        }
        d.trade_action(&s);
        assert_eq!(d.steps, 2);
    }
}
