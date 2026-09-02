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

    pub fn expand(&self, depth: u32, p0: usize, layout: &Layout) -> Search {
        let mut search = Search { n_features: layout.n_features, leaves: Vec::new(), fixed: Vec::new(), n_leaves: 0, root: Node { maximizing: true, children: vec![] } };
        let root = self.expand_node(depth, p0, layout, &mut search);
        match root {
            Child::Node(n) => search.root = *n,
            Child::Leaf(_) => {}
        }
        search
    }

    fn expand_node(&self, depth: u32, p0: usize, layout: &Layout, search: &mut Search) -> Child {
        let winner = self.winner();
        if depth == 0 || winner >= 0 {
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
        let maximizing = self.current_player == p0;
        let actions = self.playable_actions();
        let children = actions
            .into_iter()
            .map(|a| {
                let outs = self.outcomes(a).into_iter().map(|(s, p)| (p, s.expand_node(depth - 1, p0, layout, search))).collect();
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
