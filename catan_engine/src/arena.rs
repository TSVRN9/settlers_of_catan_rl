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
use crate::state::{Prompt, State};
use crate::valuenet::{argmax_first, one_ply_ev, ValueNet, N_HEADS};
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

/// One net rollout (`Recorder::rollout`) as a resumable task: it parks at each net decision so the decisions of
/// every playout in flight can be scored in one batched forward (the dense layers on another device). Its seed is
/// drawn at spawn in the order the inline rollouts drew theirs, so the labels are the same.
pub struct RollTask {
    s: State,
    p0: usize,
    child: usize,                                                 // the ro_v slot its win is added to
    parked: Option<Parked>,
}

enum Parked {
    Ply(Vec<Action>, Vec<(usize, f64, f64)>, Action), // one-ply net policy: pruned actions, their leaves, the fallback
    Tree(Search, Action),                             // the depth-2 search player's tree (net_depth 2), the fallback
}

/// gen_games.StateSampler: samples, AlphaBeta chosen-vs-other pairs, sibling sets.
pub struct Recorder {
    rng: u64, // own stream, so recording never perturbs the game's chance outcomes
    pub all_seats: bool, // a sampled tick records the state from every seat, not one random seat
    pub net_depth: u32,  // the net rollout policy searches this deep: 1 = one ply (decide_net_rollout), 2 = the depth-2 player
    pub crn: bool,       // sibling rollouts share their replicates' seeds (common random numbers, RESEARCH-SIGNAL §3.1)
    tree_buf: Vec<half::f16>,
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
    pub park: bool,             // net rollouts become tasks parked at every net decision, stepped once per arena step
    pub tasks: Vec<RollTask>,   // ... live, in spawn order
    pub h0: Vec<half::f16>,     // ... the parked decisions' first-layer rows (ValueNet::layer0_from) in fp16, in task order
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
        Recorder { rng: seed ^ 0xA5A5_5A5A_1234_8765, sample_p, rank_p, sib_p, ts_p, roll_p, roll_m, roll_depth, net, net_own, net_buf: vec![], park: false, all_seats: false, net_depth: 1, crn: false, tree_buf: vec![], tasks: vec![], h0: vec![], xs: vec![], colors: vec![], turns: vec![], rank_c: vec![], rank_o: vec![], sib_x: vec![], sib_v: vec![], sib_n: vec![], sib_isp0: vec![], ts_x: vec![], ts_v: vec![], ro_x: vec![], ro_v: vec![], ro_n: vec![] }
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
                if self.net_depth == 2 {
                    s.decide_vnet(net, layout, 2, 0, false).action.unwrap_or(acts[0])
                } else {
                    s.decide_net_rollout(net, layout, &mut self.net_buf).unwrap_or(acts[0])
                }
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

    /// Resumes every parked task from its leaves' win logits (`logits`, rows in park order), then plays every task
    /// to its next net decision (parked again, rows appended to `h0`) or to its end (win added to its ro_v slot).
    pub fn advance_rollouts(&mut self, layout: &Layout, logits: &[f32]) {
        let Some(net) = self.net.clone() else { return };
        self.h0.clear();
        let mut k = 0;
        for mut t in std::mem::take(&mut self.tasks) {
            let next = t.parked.take().map(|p| match p {
                Parked::Ply(acts, leaves, fallback) => {
                    let ev = one_ply_ev(acts.len(), &leaves, |j| logits[k + j]);
                    k += leaves.len();
                    argmax_first(&ev).map_or(fallback, |i| acts[i])
                }
                Parked::Tree(sr, fallback) => {
                    let n = sr.n_leaves;
                    let mut v: Vec<f64> = logits[k..k + n].iter().map(|&z| crate::valuenet::sigmoid(z as f64)).collect();
                    for &(i, x) in &sr.fixed {
                        v[i] = x;
                    }
                    k += n;
                    sr.backup(&v, 0.0).0.unwrap_or(fallback)
                }
            });
            match self.play_task(&mut t, next, &net, layout) {
                Some(win) => self.ro_v[t.child] += win,
                None => self.tasks.push(t),
            }
        }
        debug_assert_eq!(k, logits.len());
        if self.h0.capacity() > 4 * self.h0.len().max(1 << 18) {
            self.h0.shrink_to(2 * self.h0.len()); // a step's burst of spawned playouts must not pin its size for the game
        }
    }

    /// `rollout`'s loop from `next` (the resumed decision, if any): Some(1 or 0) at the end, None once parked.
    fn play_task(&mut self, t: &mut RollTask, mut next: Option<Action>, net: &Arc<ValueNet>, layout: &Layout) -> Option<f64> {
        loop {
            let a = match next.take() {
                Some(a) => a,
                None => {
                    if t.s.winner() >= 0 || t.s.num_turns >= TURNS_LIMIT {
                        return Some((t.s.winner() == t.p0 as i8) as u8 as f64);
                    }
                    let acts = t.s.search_actions();
                    if acts.len() == 1 {
                        acts[0]
                    } else if (!self.net_own || t.s.current_player == t.p0) && self.net_depth == 2 {
                        // the search player's own depth-2 tree, its leaves streamed through layer 1 (search.rs expand_hidden)
                        let mut sr = t.s.expand_hidden(2, t.s.current_player, layout, net, std::mem::take(&mut self.tree_buf), 0, false, None);
                        let sink = sr.sink.take().expect("expand_hidden leaves a sink");
                        self.h0.extend_from_slice(&sink.out);
                        self.tree_buf = sink.out;
                        t.parked = Some(Parked::Tree(sr, acts[0]));
                        return None;
                    } else if !self.net_own || t.s.current_player == t.p0 {
                        let (pacts, leaves) = t.s.net_rollout_park(net, layout, &mut self.net_buf, &mut self.h0);
                        if pacts.is_empty() {
                            acts[0]
                        } else {
                            t.parked = Some(Parked::Ply(pacts, leaves, acts[0]));
                            return None;
                        }
                    } else if self.roll_depth == 1 {
                        t.s.decide_heuristic(1).unwrap_or(acts[0])
                    } else {
                        t.s.decide_rollout().unwrap_or(acts[0])
                    }
                }
            };
            if t.s.apply(a, None).is_err() {
                return Some(0.0);
            }
        }
    }

    pub fn hidden_width(&self) -> Option<usize> {
        self.net.as_ref().map(|n| n.hidden_width())
    }

    pub fn h0_rows(&self) -> usize {
        self.net.as_ref().map_or(0, |n| self.h0.len() / n.hidden_width())
    }

    /// The parked rows' win logits on this thread (the CPU backend, ROLL_PARK=1), from the fp16 rows. With f32 rows
    /// this was bitwise the inline rollouts' forward (verified 2026-09-24, docs/RESEARCH-HARDWARE.md).
    pub fn cpu_logits(&self) -> Vec<f32> {
        let Some(net) = &self.net else { return vec![] };
        let h0: Vec<f32> = self.h0.iter().map(|x| x.to_f32()).collect();
        net.hidden_heads(&h0, h0.len() / net.hidden_width()).chunks(N_HEADS).map(|h| h[0]).collect()
    }

    /// Parked rollouts: every task is done, turn the win counts into fractions.
    pub fn finish(&mut self) {
        if self.park && self.net.is_some() {
            for v in &mut self.ro_v {
                *v /= self.roll_m as f64;
            }
        }
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
        // crn: replicate j of every sibling plays from the same seed, so sibling differences carry less dice noise
        let shared: Vec<u64> = if self.crn { (0..self.roll_m).map(|_| splitmix(&mut self.rng)).collect() } else { vec![] };
        for a in acts {
            let mut c = s.clone_light();
            if c.apply(a, None).is_err() {
                continue;
            }
            kept += 1;
            let mut wins = 0.0;
            if self.park && self.net.is_some() {
                for j in 0..self.roll_m as usize {
                    let mut t = c.clone_light();
                    t.rng = if self.crn { shared[j] } else { splitmix(&mut self.rng) }; // rollout()'s draw, in its order
                    self.tasks.push(RollTask { s: t, p0, child: self.ro_v.len(), parked: None });
                }
            } else {
                for _ in 0..self.roll_m {
                    wins += self.rollout(c.clone_light(), p0, layout);
                }
                wins /= self.roll_m as f64;
            }
            row.clear();
            self.encode(&c, p0, layout, &mut row);
            self.ro_x.extend_from_slice(&row);
            self.ro_v.push(wins); // parked: the win count so far, divided by roll_m in finish()
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
            let seats = if self.all_seats { 0..s.n } else { let c = self.below(s.n); c..c + 1 };
            for c in seats {
                let mut row = Vec::with_capacity(layout.n_features);
                self.encode(s, c, layout, &mut row);
                self.xs.extend_from_slice(&row);
                self.colors.push(c as u8);
                self.turns.push(s.num_turns);
            }
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
    pub pool_park: bool,                 // Seat::CpuNet searches park for the arena's NPU pass (PyArena pool_npu) instead of the CPU forward
    pub pool_pending: Option<(u8, Search)>, // ... a parked one: the pool net and its expanded tree
    pub leaf_buf: Vec<f32>, // recycled between decisions
    pub leaf_vals: Vec<f64>,      // the parked search's leaf values when the engine scored them (PyArena leaf_npu), else empty
    pub leaf_h: Vec<half::f16>,   // ... its NPU input rows (hidden-only or full width), recycled
    pub leaf_ref: Vec<f64>,                  // LEAF_CHECK: the same leaves by the exact CPU forward
    pub leaf_sink_net: Option<Arc<ValueNet>>, // Seat::Vnet trees stream leaves through this net's layer 1 (search.rs expand_hidden)
    /// A value-net seat's offer decision (trade.rs best_offer) parked in two stages: its rows ride the step's leaf
    /// NPU pass like the search's (2026-09-25: -8% CPU, -3% wall at 1,024 games in flight; slower at 96).
    pub trade_park: Option<TradePark>,
    pub trade_h: Vec<half::f16>, // the parked stage's hidden rows (row 0: the current hand)
    pub trade_vals: Vec<f64>,    // ... their P(win), filled by the step
    pub trade_skip: bool,        // the offer stages ran for this state and made no offer: search now
    pub park_trades: bool,       // park the offer stages at all (pays only with ~1,000 games in flight; slower at ~100)
    pub trade_search: usize,     // > 0: up to this many acceptable offers become root children of the search instead
                                 // of being decided 1-ply (trades inside the search, docs/PLAN-plateau.md #2)
    /// Dice luck per seat (docs/RESEARCH-SIGNAL.md §3.2, backgammon's luck adjustment): at every roll the 11 post-roll
    /// states are scored from each seat, as hidden rows riding the step's leaf NPU pass (nothing waits on them);
    /// finished() emits each X row's luck from its tick to the end, a control variate with mean exactly zero.
    pub luck_net: Option<Arc<ValueNet>>,
    pub luck_h: Vec<half::f16>,    // rows not yet scored: n seats x 11 sums per roll
    pub luck_logits: Vec<f32>,     // scored rows, in roll order
    pub luck_rolls: Vec<(u32, u8)>, // per roll: X rows recorded up to and including its tick, the realized sum // Seat::Vnet trees stream leaves through this net's layer 0 (search.rs expand_hidden)       // LEAF_CHECK: the same leaves by the exact CPU forward (flip-rate measurement only)
    pub offset: usize,
    pub rec: Recorder,
    pub log: Option<Vec<(Action, Outcome)>>,
    pub done: bool,
}

pub enum TradePark {
    Candidates(Vec<bool>),           // offer_candidates' hands scored; its affordable bundles
    Exact(f64, Vec<(usize, usize)>), // the shortlist's exact hands scored; the base value and the shortlist
}

impl ArenaGame {
    /// Park the current hand (row 0) and `hands` of the current player as hidden rows for the step's NPU pass.
    fn park_trade(&mut self, hands: &[[i32; 5]], layout: &Layout, park: TradePark) {
        let net = self.leaf_sink_net.clone().unwrap();
        let p = self.state.current_player;
        let root = self.state.encoded(p, layout);
        let mut sink = net.leaf_sink(&root, &self.state.map.static_template, std::mem::take(&mut self.trade_h));
        sink.out.clear();
        sink.push_delta(&mut vec![]);
        for h in hands {
            sink.push_delta(&mut self.state.hand_delta(p, layout, h));
        }
        self.trade_h = sink.out;
        self.trade_park = Some(park);
    }

    /// Resume a parked offer decision from `trade_vals`: park the exact stage, make the offer, or fall through to
    /// the search (`trade_skip`). Returns true when the game parked again.
    fn resume_trade(&mut self, layout: &Layout) -> bool {
        let Some(tp) = self.trade_park.take() else { return false };
        let vals = std::mem::take(&mut self.trade_vals);
        let (base, rest) = (vals[0], &vals[1..]);
        match tp {
            TradePark::Candidates(affordable) => {
                let short = self.state.offer_shortlist(base, rest, &affordable);
                if short.is_empty() {
                    self.trade_skip = true;
                    return false;
                }
                let hands = self.state.shortlist_hands(&short);
                self.park_trade(&hands, layout, TradePark::Exact(base, short));
                true
            }
            TradePark::Exact(base0, short) if self.trade_search > 0 => {
                // the best acceptable offers searched against the ordinary moves (trade.rs offer_children_from)
                let net = self.trade_net.as_ref().unwrap().0.clone();
                let p = self.state.current_player;
                let extra = self.state.offer_children_from(base0, &short, rest, &Eval::NetVsHeuristic(&*net, layout), self.trade_search);
                if extra.is_empty() {
                    self.trade_skip = true;
                    return false;
                }
                let sink_net = self.leaf_sink_net.clone().unwrap();
                let prune = self.prune.as_ref().map(|(n, k)| (&**n, *k));
                self.pending = Some(self.state.expand_hidden_with(self.vnet_depth, p, layout, &sink_net, std::mem::take(&mut self.leaf_h), self.max_leaves, self.own_turn, prune, extra));
                true
            }
            TradePark::Exact(base0, short) => {
                let net = self.trade_net.as_ref().unwrap().0.clone();
                match self.state.offer_pick(base0, &short, rest, &Eval::NetVsHeuristic(&*net, layout)) {
                    Some((a, _)) => self.tick(a, layout),
                    None => self.trade_skip = true,
                }
                false
            }
        }
    }

    /// A parked pool-net search from its leaves' win logits: decide_vnet's backup, then the move.
    pub fn resume_pool(&mut self, logits: &[f32], layout: &Layout) {
        let (_, search) = self.pool_pending.take().expect("no parked pool search");
        let mut values: Vec<f64> = logits.iter().map(|&z| crate::valuenet::sigmoid(z as f64)).collect();
        for &(i, v) in &search.fixed {
            values[i] = v;
        }
        let action = search.backup_full(&values, 0.0).0.unwrap_or_else(|| self.state.playable_actions()[0]);
        self.tick(action, layout);
    }

    /// Hidden rows of the 11 post-roll states from every seat (seat-major, sums 2..12), before the roll is applied.
    fn luck_rows(&mut self, layout: &Layout) {
        let net = self.luck_net.clone().unwrap();
        let nf = layout.n_features;
        let posts: Vec<State> = (2..=12)
            .map(|r: i32| {
                let mut t = self.state.clone_light();
                let _ = t.apply(Action::Roll, Some((r / 2, (r + 1) / 2)));
                t
            })
            .collect();
        let mut xs = vec![0f32; 11 * nf];
        for c in 0..self.state.n {
            for (i, t) in posts.iter().enumerate() {
                let row = &mut xs[i * nf..(i + 1) * nf];
                row.copy_from_slice(&self.state.map.static_template);
                t.encode_into(c, layout, row);
            }
            let h0 = &mut self.luck_h;
            net.layer0_from(&self.state.encoded(c, layout), &xs, 11, |h| {
                let start = h0.len();
                h0.resize(start + h.len(), half::f16::ZERO);
                crate::valuenet::to_f16_into(&mut h0[start..], h);
            });
        }
    }

    /// Each X row's dice luck for its seat, summed over the rolls from its tick to the end:
    /// luck = V(realized) - sum_s p(s) V(s) per roll (None when luck is off).
    pub fn luck_per_row(&self) -> Option<Vec<f32>> {
        self.luck_net.as_ref()?;
        let n = self.state.n;
        assert_eq!(self.luck_logits.len(), self.luck_rolls.len() * n * 11, "unscored luck rows at the end of a game");
        let prob = &self.state.map.number_prob;
        let per_roll: Vec<Vec<f64>> = self
            .luck_rolls
            .iter()
            .enumerate()
            .map(|(j, &(_, r))| {
                (0..n)
                    .map(|c| {
                        let v = |sum: usize| crate::valuenet::sigmoid(self.luck_logits[(j * n + c) * 11 + sum - 2] as f64);
                        v(r as usize) - (2..=12).map(|sum| prob[sum] * v(sum)).sum::<f64>()
                    })
                    .collect()
            })
            .collect();
        // suffix[j][c]: luck of rolls j.. ; row i takes the first roll whose tick is at or after its own
        let mut suffix = vec![vec![0f64; n]; per_roll.len() + 1];
        for j in (0..per_roll.len()).rev() {
            for c in 0..n {
                suffix[j][c] = suffix[j + 1][c] + per_roll[j][c];
            }
        }
        let mut j = 0;
        Some(
            self.rec
                .colors
                .iter()
                .enumerate()
                .map(|(i, &c)| {
                    while j < self.luck_rolls.len() && (self.luck_rolls[j].0 as usize) <= i {
                        j += 1;
                    }
                    suffix[j][c as usize] as f32
                })
                .collect(),
        )
    }

    pub fn over(&self) -> bool {
        self.state.winner() >= 0 || self.state.num_turns >= TURNS_LIMIT
    }

    fn tick(&mut self, action: Action, layout: &Layout) {
        let seat = self.seats[self.state.current_player];
        self.rec.step(&self.state, action, seat, layout);
        let luck = action == Action::Roll && self.luck_net.is_some();
        if luck {
            self.luck_rows(layout);
        }
        let out = self.state.apply(action, None).expect("arena applied an illegal action");
        if luck {
            self.luck_rolls.push((self.rec.colors.len() as u32, (out.0 + out.1) as u8));
        }
        if let Some(log) = &mut self.log {
            log.push((action, out));
        }
    }

    /// Resume from the scored leaves (if parked), then play until the game
    /// ends or a value-net seat needs a forward.
    pub fn advance(&mut self, layout: &Layout, values: &[f64]) {
        if let Some(search) = self.pending.take() {
            let own = std::mem::take(&mut self.leaf_vals);
            let mut v = if own.is_empty() { values[self.offset..self.offset + search.n_leaves].to_vec() } else { own };
            for &(i, x) in &search.fixed {
                v[i] = x;
            }
            let (best, root_v, evs) = search.backup_full(&v, self.tau);
            self.rec.record_tree(&self.state, root_v, &evs, layout);
            let action = best.unwrap_or_else(|| self.state.playable_actions()[0]);
            self.tick(action, layout);
        }
        if self.resume_trade(layout) {
            return;
        }
        loop {
            if self.over() {
                return; // done once its parked rollouts finish too (PyArena::step)
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
                Seat::CpuNet(k) if self.pool_park => {
                    let net = &self.pool_nets[k as usize];
                    match self.state.trade_action(&Eval::NetVsHeuristic(net, layout)) {
                        Some(a) => Some(a),
                        None => {
                            let acts = self.state.playable_actions();
                            if acts.len() == 1 {
                                Some(acts[0])
                            } else {
                                // decide_vnet's tree, scored by the NPU in PyArena::step, resumed by resume_pool
                                self.pool_pending = Some((k, self.state.expand(2, p, layout, 0, false)));
                                return;
                            }
                        }
                    }
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
            // Offers of a net-trading value-net seat park with the leaves when the engine scores them (two NPU passes:
            // candidates, then the shortlist exactly); replies and confirmations stay on the CPU (a few rows each).
            let parked = (self.park_trades || self.trade_search > 0) && self.leaf_sink_net.is_some() && matches!(self.trade_net, Some((_, false))) && self.seats[p] == Seat::Vnet && self.state.prompt == Prompt::PlayTurn;
            if parked {
                if !std::mem::take(&mut self.trade_skip) {
                    if let Some((hands, affordable)) = self.state.offer_candidates() {
                        self.park_trade(&hands, layout, TradePark::Candidates(affordable));
                        return;
                    }
                }
            } else if let Some(a) = self.state.trade_action(&eval) {
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
                    let prune = self.prune.as_ref().map(|(n, k)| (&**n, *k));
                    self.pending = Some(match &self.leaf_sink_net {
                        Some(net) => self.state.expand_hidden(self.vnet_depth, p, layout, net, std::mem::take(&mut self.leaf_h), self.max_leaves, self.own_turn, prune),
                        None => self.state.expand_into(self.vnet_depth, p, layout, std::mem::take(&mut self.leaf_buf), self.max_leaves, self.own_turn, prune),
                    });
                    return;
                }
            }
        }
    }
}
