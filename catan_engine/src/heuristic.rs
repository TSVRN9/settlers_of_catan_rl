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
    pub fn effective_production(&self, p: usize) -> [f64; 5] {
        let mut out = [0f64; 5];
        let pl = &self.players[p];
        for &n in &pl.settlements {
            self.add_node_production(n, 1.0, &mut out);
        }
        for &n in &pl.cities {
            self.add_node_production(n, 2.0, &mut out);
        }
        out
    }

    /// Sum over resources of node production (robber ignored, like
    /// CatanMap.node_production) for `nodes`.
    fn count_production(&self, mut nodes: u64) -> f64 {
        let mut total = 0.0;
        while nodes != 0 {
            let n = nodes.trailing_zeros() as usize;
            nodes &= nodes - 1;
            total += self.map.node_prod_sum[n];
        }
        total
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

        let reach1 = self.reachable_production(p0)[1];

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
        let num_buildable = self.num_buildable_nodes(p0) as f64;
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

    /// Action list for the rollout policy (arena.rs Recorder::rollout): the
    /// same depth-2 expectimax over base_fn as decide_heuristic, minus moves
    /// it never picks. Depth-2 leaf counts have a heavy tail (median 22,
    /// mean 459, docs/PLAN-gen-speed.md) driven by robber and trade states:
    /// - MOVE_ROBBER only onto tiles touching an enemy building (a robber on
    ///   an empty or own-only tile cannot improve base_fn's enemy-production
    ///   term and can only hurt one's own);
    /// - MARITIME_TRADE at the second ply (a trade not followed by a build
    ///   within the horizon cannot pay off; the generator already emits each
    ///   trade at its best port rate, so catanatron's 3:1-vs-4:1 prune is moot).
    /// Only the rollout policy uses this; `rab` seats and gates stay exact.
    fn rollout_actions(&self, second_ply: bool) -> Vec<Action> {
        let p = self.current_player;
        let acts = self.playable_actions();
        let mut enemy_tiles = 0u32;
        for i in 0..self.n {
            if i == p {
                continue;
            }
            for &n in self.players[i].settlements.iter().chain(self.players[i].cities.iter()) {
                for &tid in &self.map.node_tiles[n as usize] {
                    enemy_tiles |= 1 << tid;
                }
            }
        }
        let kept: Vec<Action> = acts
            .iter()
            .copied()
            .filter(|a| match *a {
                Action::MoveRobber { tile, .. } => enemy_tiles & (1 << tile) != 0,
                Action::MaritimeTrade { .. } => !second_ply,
                _ => true,
            })
            .collect();
        if kept.is_empty() { acts } else { kept }
    }

    fn expectimax_rollout(&self, depth: u32, p0: usize) -> (Option<Action>, f64) {
        if depth == 0 || self.winner() >= 0 {
            return (None, self.base_fn(p0));
        }
        let maximizing = self.current_player == p0;
        let mut best: Option<Action> = None;
        let mut best_v = if maximizing { f64::NEG_INFINITY } else { f64::INFINITY };
        for a in self.rollout_actions(depth == 1) {
            let ev: f64 = self.outcomes(a).iter().map(|(s, p)| p * s.expectimax_rollout(depth - 1, p0).1).sum();
            if (maximizing && ev > best_v) || (!maximizing && ev < best_v) {
                best = Some(a);
                best_v = ev;
            }
        }
        (best, best_v)
    }

    /// decide_heuristic(2) over the pruned action lists (rollouts only); robber
    /// prompts search one ply (a 7-roll state otherwise expands ~30 robber
    /// moves x 5 steal outcomes x the whole post-roll action list: half of all
    /// rollout leaves, and what one builds afterwards barely depends on the tile).
    pub fn decide_rollout(&self) -> Option<Action> {
        let actions = self.playable_actions();
        if actions.len() == 1 {
            return Some(actions[0]);
        }
        let depth = match self.prompt {
            Prompt::MoveRobber => 1,
            _ => 2,
        };
        self.expectimax_rollout(depth, self.current_player).0
    }

    /// decide_heuristic plus every root action's expectation (for the site's decision panel).
    pub fn decide_heuristic_full(&self, depth: u32) -> (Option<Action>, f64, Vec<(Action, f64)>) {
        let actions = self.playable_actions();
        if actions.len() == 1 {
            return (Some(actions[0]), f64::NAN, vec![]);
        }
        let p0 = self.current_player;
        let root: Vec<(Action, f64)> = actions
            .into_iter()
            .map(|a| (a, self.outcomes(a).iter().map(|(s, p)| p * s.expectimax(depth.saturating_sub(1), p0).1).sum()))
            .collect();
        let best = root.iter().cloned().fold(None, |acc: Option<(Action, f64)>, (a, v)| match acc {
            Some((_, bv)) if bv >= v => acc,
            _ => Some((a, v)),
        });
        (best.map(|b| b.0), best.map(|b| b.1).unwrap_or(f64::NAN), root)
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

impl State {
    /// reachability_features levels 0..=2 for p, each summed over resources.
    pub fn reachable_production(&self, p: usize) -> [f64; 3] {
        let pl = &self.players[p];
        let mut owned_or_buildable = self.buildable;
        for &n in pl.settlements.iter().chain(pl.cities.iter()) {
            owned_or_buildable |= 1u64 << n;
        }
        let mut zero = 0u64;
        for &c in &self.components[p] {
            zero |= c;
        }
        let mut out = [0f64; 3];
        out[0] = self.count_production(owned_or_buildable & zero);
        let mut last = zero;
        for level in 1..=2 {
            let mut nodes = last;
            let mut bits = last; // iterate set bits only (the component is ~5-15 nodes, not 54)
            while bits != 0 {
                let n = bits.trailing_zeros() as u8;
                bits &= bits - 1;
                if self.is_enemy_node(n, p) {
                    continue;
                }
                for &v in &self.map.neighbors[n as usize] {
                    let ro = self.road_owner[self.map.edge(n, v) as usize];
                    if ro < 0 || ro as usize == p {
                        nodes |= 1u64 << v;
                    }
                }
            }
            out[level] = self.count_production(owned_or_buildable & nodes);
            last = nodes;
        }
        out
    }

    /// base_fn's production term for p (effective production sum + variety).
    pub fn production_score(&self, p: usize) -> f64 {
        let our = self.effective_production(p);
        let prod_sum: f64 = our.iter().sum();
        prod_sum + our.iter().filter(|&&x| x != 0.0).count() as f64 * TRANSLATE_VARIETY * PROBA_POINT
    }

    pub fn num_tiles(&self, p: usize) -> f64 {
        let pl = &self.players[p];
        let mut tiles = 0u32;
        for &n in pl.settlements.iter().chain(pl.cities.iter()) {
            for &tid in &self.map.node_tiles[n as usize] {
                tiles |= 1 << tid;
            }
        }
        tiles.count_ones() as f64
    }

    pub fn hand_synergy(&self, p: usize) -> f64 {
        let h = &self.players[p].hand;
        let d_city = ((2 - h[WHEAT]).max(0) + (3 - h[ORE]).max(0)) as f64 / 5.0;
        let d_settle = ((1 - h[WHEAT]).max(0) + (1 - h[SHEEP]).max(0) + (1 - h[BRICK]).max(0) + (1 - h[WOOD]).max(0)) as f64 / 4.0;
        (2.0 - d_city - d_settle) / 2.0
    }
}

impl State {
    /// A smooth stand-in for base_fn: same terms, same priority order, weight
    /// ratios of ~3-10 between levels instead of ~1e6, so a bounded network
    /// can represent it (value_net.smooth_heuristic mirrors this in torch).
    pub fn smooth_base_fn(&self, p0: usize) -> f64 {
        let pl = &self.players[p0];
        let p1 = (p0 + 1) % self.n;
        let reach = self.reachable_production(p0);
        let num_in_hand: i32 = pl.hand.iter().sum();
        let num_buildable = self.num_buildable_nodes(p0) as f64;
        let lr_factor = if num_buildable == 0.0 { 1.0 } else { 0.1 };
        let num_devs: i32 = pl.devs.iter().sum();
        10.0 * pl.vp as f64
            + 3.0 * self.production_score(p0)
            - 3.0 * self.production_score(p1)
            + 1.0 * reach[1]
            + 0.5 * self.hand_synergy(p0)
            + 0.1 * num_buildable
            + 0.02 * self.num_tiles(p0)
            + 0.02 * num_in_hand as f64
            - (if num_in_hand > 7 { 0.1 } else { 0.0 })
            + 0.1 * lr_factor * pl.longest_road_length as f64
            + 0.05 * num_devs as f64
            + 0.05 * pl.played[KNIGHT] as f64
    }

    fn expectimax_smooth(&self, depth: u32, p0: usize) -> (Option<Action>, f64) {
        if depth == 0 || self.winner() >= 0 {
            return (None, self.smooth_base_fn(p0));
        }
        let maximizing = self.current_player == p0;
        let mut best: Option<Action> = None;
        let mut best_v = if maximizing { f64::NEG_INFINITY } else { f64::INFINITY };
        for a in self.playable_actions() {
            let ev: f64 = self.outcomes(a).iter().map(|(s, p)| p * s.expectimax_smooth(depth - 1, p0).1).sum();
            if (maximizing && ev > best_v) || (!maximizing && ev < best_v) {
                best = Some(a);
                best_v = ev;
            }
        }
        (best, best_v)
    }

    pub fn decide_smooth(&self, depth: u32) -> Option<Action> {
        let actions = self.playable_actions();
        if actions.len() == 1 {
            return Some(actions[0]);
        }
        self.expectimax_smooth(depth, self.current_player).0
    }
}
