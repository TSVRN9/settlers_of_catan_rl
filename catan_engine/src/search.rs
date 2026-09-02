//! Depth-d expectimax expansion with pinned chance outcomes
//! (value_net.ValueNetPlayer._expand / expand_outcomes), leaves encoded in
//! one flat matrix so Python can score them in a single forward pass.

use crate::actions::Action;
use crate::encode::Layout;
use crate::state::*;

pub enum Child {
    Leaf(usize),
    Node(Box<Node>),
}

pub struct Node {
    pub maximizing: bool,
    pub children: Vec<(Action, Vec<(f64, Child)>)>,
}

pub struct Search {
    pub n_features: usize,
    pub leaves: Vec<f32>,          // n_leaves x n_features (terminal leaves are zero rows)
    pub fixed: Vec<(usize, f64)>,  // terminal leaves with exact values
    pub n_leaves: usize,
    pub root: Node,
    cap: usize,
    overflow: bool,
    own_turn: bool,
}

impl State {
    /// action -> [(state, proba)], the exact expectation over dice / drawn
    /// card / stolen resource. Impossible imagined outcomes leave the copy
    /// unexecuted, like catanatron's execute_spectrum.
    pub fn outcomes(&self, action: Action) -> Vec<(State, f64)> {
        match action {
            Action::Roll => (2..=12)
                .map(|roll: i32| {
                    let dice = (roll / 2, (roll + 1) / 2);
                    let mut s = self.clone();
                    let _ = s.apply(action, Some(dice));
                    (s, self.map.number_prob[roll as usize])
                })
                .collect(),
            Action::BuyDev => {
                let mut counts = [0i32; 5];
                for &c in &self.dev_deck {
                    counts[c as usize] += 1;
                }
                for i in 0..self.n {
                    if i != self.current_player {
                        for c in 0..5 {
                            counts[c] += self.players[i].devs[c];
                        }
                    }
                }
                let total: i32 = counts.iter().sum();
                (0..5)
                    .filter(|&c| counts[c] > 0)
                    .map(|c| {
                        let mut s = self.clone();
                        let _ = s.apply(action, Some((c as i32, -1)));
                        (s, counts[c] as f64 / total as f64)
                    })
                    .collect()
            }
            Action::MoveRobber { victim, .. } if victim >= 0 && self.num_resources(victim as usize) > 0 => (0..5)
                .map(|r| {
                    let mut s = self.clone();
                    let _ = s.apply(action, Some((r, -1)));
                    (s, 0.2)
                })
                .collect(),
            _ => {
                let mut s = self.clone();
                let _ = s.apply(action, None);
                vec![(s, 1.0)]
            }
        }
    }

    pub fn expand(&self, depth: u32, p0: usize, layout: &Layout, max_leaves: usize, own_turn: bool) -> Search {
        self.expand_into(depth, p0, layout, Vec::new(), max_leaves, own_turn)
    }

    /// `expand` writing leaves into a reused buffer (the arena expands every
    /// step; fresh multi-MB Vecs page-fault each time). `max_leaves` (0 =
    /// unlimited) caps a tree deeper than 2: when it overflows, the expansion
    /// is abandoned and redone one ply shallower. Depth-3 leaf counts are
    /// extremely skewed -- 8% of decisions hold 95% of the leaves (up to
    /// 430k rows, 1.8 GB) -- so the cap buys ~20x memory and time for 8%
    /// of decisions at depth 2 (docs/FINDINGS.md). Depth-2 trees are never
    /// capped, so depth-2 play is unchanged whatever the cap.
    ///
    /// `own_turn`: depth counts only p0's own actions; an opponent's decision
    /// node is a leaf (never min'ed over -- measured: paranoid depth 3 scored
    /// 24.9% vs 30.7% for depth 2, the min over a noisy net's estimates of
    /// 10-15 replies biases every end-turn branch low), and an end-turn branch
    /// always finishes with the opponent's ROLL chance node so the leaf is the
    /// post-roll state whatever depth remains.
    pub fn expand_into(&self, depth: u32, p0: usize, layout: &Layout, mut buf: Vec<f32>, max_leaves: usize, own_turn: bool) -> Search {
        buf.clear();
        let cap = if max_leaves == 0 || depth <= 2 { usize::MAX } else { max_leaves };
        let mut search = Search { n_features: layout.n_features, leaves: buf, fixed: Vec::new(), n_leaves: 0, root: Node { maximizing: true, children: vec![] }, cap, overflow: false, own_turn };
        let root = self.expand_node(depth, p0, layout, &mut search);
        if search.overflow {
            return self.expand_into(depth - 1, p0, layout, search.leaves, max_leaves, own_turn);
        }
        match root {
            Child::Node(n) => search.root = *n,
            Child::Leaf(_) => {}
        }
        search
    }

    fn expand_node(&self, depth: u32, p0: usize, layout: &Layout, search: &mut Search) -> Child {
        if search.overflow || search.n_leaves >= search.cap {
            search.overflow = true;
            return Child::Leaf(0);
        }
        let winner = self.winner();
        let maximizing = self.current_player == p0;
        let actions = self.playable_actions();
        let roll_only = actions.len() == 1 && actions[0] == Action::Roll;
        let stop = if search.own_turn {
            winner >= 0 || (maximizing && depth == 0) || (!maximizing && !roll_only)
        } else {
            depth == 0 || winner >= 0
        };
        if stop {
            let idx = search.n_leaves;
            search.n_leaves += 1;
            let start = search.leaves.len();
            search.leaves.extend_from_slice(&self.map.static_template);
            if winner >= 0 {
                search.fixed.push((idx, (winner as usize == p0) as u8 as f64));
            } else {
                self.encode_into(p0, layout, &mut search.leaves[start..start + layout.n_features]);
            }
            return Child::Leaf(idx);
        }
        let next = if search.own_turn && !maximizing { depth } else { depth - 1 }; // an opponent's roll costs no own-action depth
        let children = actions
            .into_iter()
            .map(|a| {
                let outs = self.outcomes(a).into_iter().map(|(s, p)| (p, s.expand_node(next, p0, layout, search))).collect();
                (a, outs)
            })
            .collect();
        Child::Node(Box::new(Node { maximizing, children }))
    }
}

impl Search {
    pub fn backup(&self, values: &[f64]) -> (Option<Action>, f64) {
        backup_node(&self.root, values)
    }

    /// backup() plus every root child's expectation: (action, E[value]) --
    /// the search-value distillation targets (arena.rs Recorder::record_tree).
    pub fn backup_full(&self, values: &[f64]) -> (Option<Action>, f64, Vec<(Action, f64)>) {
        let evs: Vec<(Action, f64)> = self.root.children.iter().map(|(a, outs)| (*a, outs.iter().map(|(p, c)| p * backup_child(c, values)).sum())).collect();
        let (best, best_v) = backup_node(&self.root, values);
        (best, best_v, evs)
    }
}

fn backup_child(child: &Child, values: &[f64]) -> f64 {
    match child {
        Child::Leaf(i) => values[*i],
        Child::Node(n) => backup_node(n, values).1,
    }
}

fn backup_node(node: &Node, values: &[f64]) -> (Option<Action>, f64) {
    let mut best: Option<Action> = None;
    let mut best_v = if node.maximizing { f64::NEG_INFINITY } else { f64::INFINITY };
    for (a, outs) in &node.children {
        let ev: f64 = outs.iter().map(|(p, c)| p * backup_child(c, values)).sum();
        let better = if node.maximizing { ev > best_v } else { ev < best_v };
        if better {
            best = Some(*a);
            best_v = ev;
        }
    }
    (best, best_v)
}
