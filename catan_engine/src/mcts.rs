//! The thesis MCTS agents (E. Karamalegos, *Monte Carlo tree search in the "Settlers of Catan" strategy
//! game*, TU Crete 2016; the UCT / BUCT / VPI opponents of the EUMAS 2018 paper), on this engine.
//! docs/BENCHMARK.md Phase D has the settings as read from the thesis; what is implemented:
//!
//! - the tree is the agent's own turn after the roll: a node is one action, children are the legal
//!   actions of the state it leads to (builds, dev cards, bank trades, "empty action" = END_TURN);
//!   the turn's end, or a prompt the search does not own, is a leaf;
//! - playouts are uniformly random over every player's legal actions (offers excluded), dice from the
//!   state's own RNG, until someone wins or the thesis' round cut-off: max(3, c - r) rounds for real
//!   round r <= 20, max(3, c / 2) after (c = 10 was best);
//! - the reward is the agent's VP scaled to [0, 1]; UCT backs up its mean, BUCT and VPI count it in a
//!   Dirichlet over the 11 VP values (prior 1 each) whose mean and variance drive the selection rules:
//!   UCT mean + 2 C_p sqrt(2 ln N / n) with C_p = 1 / sqrt 2; BUCT mean + sqrt(2 ln N) sigma (Tesauro's
//!   second rule); VPI mean + myopic value of perfect information, the integral sampled through Gamma
//!   draws (Dearden, Friedman & Russell 1998);
//! - the budget is a playout count at the midpoints of what the thesis' 15 s wall clock bought (UCT
//!   3,000-10,000 playouts, BUCT 2,000-9,500, VPI 500-3,000); the final move is the child with the best mean.
//!
//! Every other decision (initial placement, roll-or-knight, robber, discard, offers and replies) goes
//! to the heuristic bot, the thesis having handed those to JSettlers' own code. Deviations: the engine is
//! fully observable (opponents' hands are visible to the playouts); BUCT's interior nodes use their own
//! Dirichlet rather than the extremum distribution; dev cards are played by the search itself rather than
//! by JSettlers' strategies and their value comes from the playout, not the thesis' knight estimate.

use crate::actions::Action;
use crate::state::{Prompt, State};
use crate::trade::Eval;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    Uct,
    Buct,
    Vpi,
}

impl Policy {
    pub fn parse(s: &str) -> Option<Policy> {
        match s {
            "uct" => Some(Policy::Uct),
            "buct" => Some(Policy::Buct),
            "vpi" => Some(Policy::Vpi),
            _ => None,
        }
    }

    /// The midpoints of the thesis' playout counts at its 15 s budget (this engine does them in ~0.3 s).
    pub fn default_sims(self) -> u32 {
        match self {
            Policy::Uct | Policy::Buct => 5000,
            Policy::Vpi => 1500,
        }
    }
}

const K: usize = 11; // reward categories: 0..=10 VP
const VPI_SAMPLES: usize = 16;

struct Node {
    state: State,
    action: Option<Action>,
    untried: Vec<Action>,
    children: Vec<usize>,
    n: u32,
    sum: f64,
    alpha: [f64; K],
}

pub struct Mcts {
    pub policy: Policy,
    pub sims: u32,
    pub cutoff: u32,
    rng: u64,
    pub playouts: u64,
    pub steps: u64, // actions applied inside playouts, for budget checks
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn uniform(x: &mut u64) -> f64 {
    (splitmix(x) >> 11) as f64 / (1u64 << 53) as f64
}

/// Gamma(shape >= 1, 1) by Marsaglia & Tsang.
fn gamma(shape: f64, rng: &mut u64) -> f64 {
    let d = shape - 1.0 / 3.0;
    let c = 1.0 / (9.0 * d).sqrt();
    loop {
        let (u1, u2) = (uniform(rng).max(1e-12), uniform(rng));
        let z = (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos();
        let v = (1.0 + c * z).powi(3);
        if v <= 0.0 {
            continue;
        }
        let u = uniform(rng).max(1e-12);
        if u.ln() < 0.5 * z * z + d - d * v + d * v.ln() {
            return d * v;
        }
    }
}

impl Node {
    fn mean(&self) -> f64 {
        if self.n == 0 { 0.0 } else { self.sum / self.n as f64 }
    }

    /// Mean and variance of the expected reward under the node's Dirichlet posterior.
    fn dirichlet(&self) -> (f64, f64) {
        let total: f64 = self.alpha.iter().sum();
        let (mut m1, mut m2) = (0.0, 0.0);
        for (i, a) in self.alpha.iter().enumerate() {
            let v = i as f64 / 10.0;
            m1 += a * v;
            m2 += a * v * v;
        }
        let mu = m1 / total;
        ((mu), ((m2 / total - mu * mu) / (total + 1.0)).max(0.0))
    }

    fn sample(&self, rng: &mut u64) -> f64 {
        let mut theta = [0f64; K];
        let mut total = 0.0;
        for (t, a) in theta.iter_mut().zip(&self.alpha) {
            *t = gamma(*a, rng);
            total += *t;
        }
        theta.iter().enumerate().map(|(i, t)| t / total * i as f64 / 10.0).sum()
    }
}

impl Mcts {
    pub fn new(policy: Policy, sims: u32, cutoff: u32, seed: u64) -> Mcts {
        Mcts { policy, sims, cutoff, rng: seed ^ 0x3C75_2016_0DEA_D0CE, playouts: 0, steps: 0 }
    }

    /// The search owns a decision when it is the agent's post-roll main phase.
    fn owns(s: &State, p0: usize) -> bool {
        s.current_player == p0 && s.prompt == Prompt::PlayTurn && s.players[p0].has_rolled && !s.is_resolving_trade && s.winner() < 0
    }

    fn make_node(s: State, action: Option<Action>, p0: usize, rng: &mut u64) -> Node {
        let mut untried = if Mcts::owns(&s, p0) { s.search_actions() } else { vec![] };
        // expand in random order (the thesis picks untried actions arbitrarily)
        for i in (1..untried.len()).rev() {
            let j = (splitmix(rng) % (i as u64 + 1)) as usize;
            untried.swap(i, j);
        }
        Node { state: s, action, untried, children: vec![], n: 0, sum: 0.0, alpha: [1.0; K] }
    }

    fn rounds(&self, s: &State) -> u32 {
        let r = s.num_turns as u32 / s.n as u32;
        if r <= 20 { self.cutoff.saturating_sub(r).max(3) } else { (self.cutoff / 2).max(3) }
    }

    /// Uniformly random play to a win or the round cut-off; the agent's VP in [0, 1].
    fn playout(&mut self, mut s: State, p0: usize, rounds: u32) -> f64 {
        s.rng = splitmix(&mut self.rng);
        let end = s.num_turns + (rounds * s.n as u32) as i32;
        let mut steps = 0;
        while s.winner() < 0 && s.num_turns < end && steps < 5000 {
            let acts = s.search_actions();
            if acts.is_empty() {
                break;
            }
            let a = acts[(s.next_u64() % acts.len() as u64) as usize];
            if s.apply(a, None).is_err() {
                break;
            }
            steps += 1;
        }
        self.playouts += 1;
        self.steps += steps;
        (s.players[p0].actual_vp.clamp(0, 10) as f64) / 10.0
    }

    fn select(&mut self, nodes: &[Node], parent: usize) -> usize {
        let kids = &nodes[parent].children;
        let ln_n = (nodes[parent].n.max(1) as f64).ln();
        match self.policy {
            Policy::Uct => best_by(kids, |c| nodes[c].mean() + 2.0 * (ln_n / nodes[c].n.max(1) as f64).sqrt(), &mut self.rng),
            Policy::Buct => best_by(
                kids,
                |c| {
                    let (mu, var) = nodes[c].dirichlet();
                    mu + (2.0 * ln_n).sqrt() * var.sqrt()
                },
                &mut self.rng,
            ),
            Policy::Vpi => {
                let mus: Vec<f64> = kids.iter().map(|&c| nodes[c].dirichlet().0).collect();
                let mut order: Vec<usize> = (0..kids.len()).collect();
                order.sort_by(|&a, &b| mus[b].partial_cmp(&mus[a]).unwrap_or(std::cmp::Ordering::Equal));
                let (best, second) = (order[0], if order.len() > 1 { mus[order[1]] } else { mus[order[0]] });
                let scores: Vec<f64> = kids
                    .iter()
                    .enumerate()
                    .map(|(i, &c)| {
                        let mut gain = 0.0;
                        for _ in 0..VPI_SAMPLES {
                            let x = nodes[c].sample(&mut self.rng);
                            gain += if i == best { (second - x).max(0.0) } else { (x - mus[best]).max(0.0) };
                        }
                        mus[i] + gain / VPI_SAMPLES as f64
                    })
                    .collect();
                best_by(&(0..kids.len()).collect::<Vec<_>>(), |i| scores[i], &mut self.rng).pipe(|i| kids[i])
            }
        }
    }

    /// The agent's action for its post-roll main phase, or None when the search does not own the prompt.
    pub fn search(&mut self, s: &State) -> Option<Action> {
        let p0 = s.current_player;
        if !Mcts::owns(s, p0) {
            return None;
        }
        let rounds = self.rounds(s);
        let mut nodes = vec![Mcts::make_node(s.clone(), None, p0, &mut self.rng)];
        if nodes[0].untried.len() == 1 {
            return nodes[0].untried.pop();
        }
        for _ in 0..self.sims {
            let mut path = vec![0usize];
            let mut cur = 0usize;
            loop {
                if let Some(a) = nodes[cur].untried.pop() {
                    let mut t = nodes[cur].state.clone();
                    t.rng = splitmix(&mut self.rng);
                    if t.apply(a, None).is_err() {
                        continue;
                    }
                    let child = Mcts::make_node(t, Some(a), p0, &mut self.rng);
                    nodes.push(child);
                    let id = nodes.len() - 1;
                    nodes[cur].children.push(id);
                    path.push(id);
                    break;
                }
                if nodes[cur].children.is_empty() {
                    break;
                }
                cur = self.select(&nodes, cur);
                path.push(cur);
            }
            let leaf = *path.last().unwrap();
            let reward = self.playout(nodes[leaf].state.clone(), p0, rounds);
            let cat = ((reward * 10.0).round() as usize).min(K - 1);
            for &id in &path {
                let node = &mut nodes[id];
                node.n += 1;
                node.sum += reward;
                node.alpha[cat] += 1.0;
            }
        }
        let root = &nodes[0];
        if root.children.is_empty() {
            return None;
        }
        let best = match self.policy {
            Policy::Uct => best_by(&root.children, |c| nodes[c].mean(), &mut self.rng),
            _ => best_by(&root.children, |c| nodes[c].dirichlet().0, &mut self.rng),
        };
        nodes[best].action
    }

    /// The whole player: the search on its prompt, the 1-ply trade policy and the heuristic search elsewhere.
    pub fn decide(&mut self, s: &State) -> Option<Action> {
        s.decide_with_trades(&Eval::Heuristic, |s| self.search(s).or_else(|| s.decide_heuristic(2)))
    }
}

/// argmax with random tie-breaking, as the thesis does for equal UCT values.
fn best_by(items: &[usize], mut f: impl FnMut(usize) -> f64, rng: &mut u64) -> usize {
    let mut best = items[0];
    let mut best_v = f64::NEG_INFINITY;
    let mut ties = 0u64;
    for &c in items {
        let v = f(c);
        if v > best_v {
            best = c;
            best_v = v;
            ties = 1;
        } else if v == best_v {
            ties += 1;
            if splitmix(rng) % ties == 0 {
                best = c;
            }
        }
    }
    best
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl Pipe for usize {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;
    use crate::map::Map;
    use std::sync::Arc;

    /// Every policy returns a legal main-phase action, the Dirichlet moments are sane, and a game
    /// with an MCTS seat runs to a winner against heuristic seats.
    #[test]
    fn thesis_agents_play() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(7, &layout)), 4, 3, 10);
        while s.initial_phase {
            let a = s.decide_heuristic(1).unwrap();
            s.apply(a, None).unwrap();
        }
        s.apply(Action::Roll, Some((3, 3))).unwrap();
        s.players[s.current_player].hand = [2, 2, 1, 1, 0];
        for policy in [Policy::Uct, Policy::Buct, Policy::Vpi] {
            let mut m = Mcts::new(policy, policy.default_sims(), 10, 1);
            let t0 = std::time::Instant::now();
            let a = m.search(&s).expect("a post-roll decision");
            eprintln!("{policy:?}: {} playouts, {:.0} steps each, in {:.0} ms -> {a:?}", m.playouts, m.steps as f64 / m.playouts as f64, t0.elapsed().as_secs_f64() * 1e3);
            assert!(s.search_actions().contains(&a), "{policy:?} chose {a:?}");
            assert!(m.playouts >= policy.default_sims() as u64);
        }
        let mut node = Node { state: s.clone(), action: None, untried: vec![], children: vec![], n: 0, sum: 0.0, alpha: [1.0; K] };
        node.alpha[10] += 9.0;
        let (mu, var) = node.dirichlet();
        assert!(mu > 0.7 && var > 0.0 && var < 0.05, "{mu} {var}");
        let mut m = Mcts::new(Policy::Uct, 30, 10, 2);
        let mut steps = 0;
        while s.winner() < 0 && steps < 3000 {
            let a = if s.current_player == 0 { m.decide(&s) } else { s.decide_with_trades(&Eval::Heuristic, |s| s.decide_heuristic(1)) };
            s.apply(a.expect("an action"), None).unwrap();
            steps += 1;
        }
        assert!(s.winner() >= 0, "no winner after {steps} steps");
    }
}
