//! catanatron.players.value.base_fn (DEFAULT_WEIGHTS) and an exact depth-d
//! expectimax over it: a fast AlphaBeta-like opponent for data generation.
//! Not bit-identical to Python's AlphaBetaPlayer (whose chance nodes re-roll
//! at random, see FINDINGS); evaluation against the shipped AlphaBeta stays
//! in Python.

use crate::actions::Action;
use crate::state::*;

const TRANSLATE_VARIETY: f64 = 4.0;
const PROBA_POINT: f64 = 2.778 / 100.0;

impl State {
    fn effective_production(&self, p: usize) -> [f64; 5] {
        let mut out = [0f64; 5];
        for r in 0..5 {
            let pl = &self.players[p];
            let mut prod = 0.0;
            for &n in &pl.settlements {
                prod += self.node_production(n, r);
            }
            for &n in &pl.cities {
                prod += 2.0 * self.node_production(n, r);
            }
            out[r] = prod;
        }
        out
    }

    /// Sum over resources of node production (robber ignored, like
    /// CatanMap.node_production) for `nodes`.
    fn count_production(&self, nodes: u64) -> f64 {
        let mut total = 0.0;
        for n in 0..54u8 {
            if nodes & (1u64 << n) == 0 {
                continue;
            }
            for &tid in &self.map.node_tiles[n as usize] {
                let t = &self.map.tiles[tid as usize];
                if t.resource >= 0 {
                    total += self.map.number_prob[t.number as usize];
                }
            }
        }
        total
    }

    /// reachability_features level 1 for p, summed over resources.
    fn reachable_production_1(&self, p: usize) -> f64 {
        let pl = &self.players[p];
        let mut owned_or_buildable = self.buildable; // board_buildable_ids
        for &n in pl.settlements.iter().chain(pl.cities.iter()) {
            owned_or_buildable |= 1u64 << n;
        }
        let mut zero = 0u64;
        for &c in &self.components[p] {
            zero |= c;
        }
        let mut level1 = zero;
        for n in 0..54u8 {
            if zero & (1u64 << n) == 0 || self.is_enemy_node(n, p) {
                continue;
            }
            for &v in &self.map.neighbors[n as usize] {
                let e = self.map.edge(n, v);
                let ro = self.road_owner[e as usize];
                if ro < 0 || ro as usize == p {
                    level1 |= 1u64 << v;
                }
            }
        }
        self.count_production(owned_or_buildable & level1)
    }

    /// base_fn(DEFAULT_WEIGHTS)(game, p0_color)
    pub fn base_fn(&self, p0: usize) -> f64 {
        let pl = &self.players[p0];
        let our = self.effective_production(p0);
        let p1 = (p0 + 1) % self.n; // "P1": the next seat, as in value.py
        let enemy = self.effective_production(p1);
        let prod_sum: f64 = our.iter().sum();
        let variety = our.iter().filter(|&&x| x != 0.0).count() as f64 * TRANSLATE_VARIETY * PROBA_POINT;
        let production = prod_sum + variety;
        let enemy_production: f64 = enemy.iter().sum();

        let reach1 = self.reachable_production_1(p0);

        let h = &pl.hand;
        let d_city = ((2 - h[WHEAT]).max(0) + (3 - h[ORE]).max(0)) as f64 / 5.0;
        let d_settle = ((1 - h[WHEAT]).max(0) + (1 - h[SHEEP]).max(0) + (1 - h[BRICK]).max(0) + (1 - h[WOOD]).max(0)) as f64 / 4.0;
        let hand_synergy = (2.0 - d_city - d_settle) / 2.0;
        let num_in_hand: i32 = h.iter().sum();
        let discard_penalty = if num_in_hand > 7 { -5.0 } else { 0.0 };

        let mut tiles = 0u32;
        for &n in pl.settlements.iter().chain(pl.cities.iter()) {
            for &tid in &self.map.node_tiles[n as usize] {
                tiles |= 1 << tid;
            }
        }
        let num_tiles = tiles.count_ones() as f64;
        let num_buildable = self.buildable_node_ids(p0, false).len() as f64;
        let longest_road_factor = if num_buildable == 0.0 { 10.0 } else { 0.1 };
        let num_devs: i32 = pl.devs.iter().sum();

        pl.vp as f64 * 3e14
            + production * 1e8
            + enemy_production * -1e8
            + reach1 * 1e4
            + hand_synergy * 1e2
            + num_buildable * 1e3
            + num_tiles * 1.0
            + num_in_hand as f64 * 1.0
            + discard_penalty
            + pl.longest_road_length as f64 * longest_road_factor
            + num_devs as f64 * 10.0
            + pl.played[KNIGHT] as f64 * 10.1
    }

    fn expectimax(&self, depth: u32, p0: usize) -> (Option<Action>, f64) {
        if depth == 0 || self.winner() >= 0 {
            return (None, self.base_fn(p0));
        }
        let maximizing = self.current_player == p0;
        let mut best: Option<Action> = None;
        let mut best_v = if maximizing { f64::NEG_INFINITY } else { f64::INFINITY };
        for a in self.playable_actions() {
            let ev: f64 = self.outcomes(a).iter().map(|(s, p)| p * s.expectimax(depth - 1, p0).1).sum();
            if (maximizing && ev > best_v) || (!maximizing && ev < best_v) {
                best = Some(a);
                best_v = ev;
            }
        }
        (best, best_v)
    }

    /// AlphaBetaPlayer.decide with exact chance nodes and no cutoffs.
    pub fn decide_heuristic(&self, depth: u32) -> Option<Action> {
        let actions = self.playable_actions();
        if actions.len() == 1 {
            return Some(actions[0]);
        }
        self.expectimax(depth, self.current_player).0
    }
}
