//! catan_env.Encoder.encode + value_net.encode_for_value, feature for feature.
//! Index tables come from Python's `catan_env.LAYOUT` (see rust_bridge.layout_spec).

use crate::state::*;

#[cfg_attr(feature = "wasm", derive(serde::Deserialize))]
pub struct Layout {
    pub n_features: usize,
    pub robber_idx: Vec<i32>,            // [19]
    pub node_idx: Vec<i32>,              // [4][54][2] flattened, kind 0 = settlement, 1 = city
    pub edge_idx: Vec<i32>,              // [4][72]
    pub player_scalar_idx: Vec<i32>,     // [4][8]
    pub dev_played_idx: Vec<i32>,        // [4][4]  KNIGHT, YOP, MONOPOLY, ROAD_BUILDING
    pub num_resources_idx: Vec<i32>,     // [4]
    pub num_devs_idx: Vec<i32>,          // [4]
    pub production_idx: Vec<i32>,        // [4][5]
    pub buildable_nodes_idx: Vec<i32>,   // [4]
    pub p0_actual_vps_idx: i32,
    pub p0_resource_in_hand_idx: Vec<i32>, // [5]
    pub p0_dev_in_hand_idx: Vec<i32>,      // [5]
    pub p0_has_played_dev_idx: i32,
    pub bank_resource_idx: Vec<i32>,     // [5]
    pub bank_dev_cards_idx: i32,
    pub is_discarding_idx: i32,
    pub is_moving_robber_idx: i32,
    pub turn_base: i32,
    /// Start of the heuristic-summary block (EXTRA_BASE in value_net.py):
    /// per relative player i: production_score, reach0, reach1, reach2, num_tiles (5 x 4),
    /// then p0's hand_synergy. These are base_fn's own terms, so the net can
    /// represent AlphaBeta's ordering without raw (map-fingerprinting) tile features.
    pub extra_base: i32,
    // static (per-map) features, so mapgen.rs can fill the template without catanatron
    pub tile_proba_idx: Vec<i32>, // [19]
    pub tile_is_idx: Vec<i32>,    // [19][6] WOOD, BRICK, SHEEP, WHEAT, ORE, DESERT (-1 = no such feature)
    pub port_is_idx: Vec<i32>,    // [9][6]  WOOD, BRICK, SHEEP, WHEAT, ORE, THREE_TO_ONE
}

const PLAYABLE_DEVS: [usize; 4] = [KNIGHT, YEAR_OF_PLENTY, MONOPOLY, ROAD_BUILDING];

impl State {
    #[allow(dead_code)]
    pub fn node_production(&self, node: u8, r: usize) -> f64 {
        let mut s = self.map.node_prod[node as usize][r];
        let rt = &self.map.tiles[self.robber as usize];
        if rt.resource == r as i8 && rt.nodes.contains(&node) {
            s -= self.map.tile_prob[self.robber as usize];
        }
        s
    }

    /// out[r] += mult * production of `node` for every resource (robbed tile excluded).
    #[inline]
    pub fn add_node_production(&self, node: u8, mult: f64, out: &mut [f64; 5]) {
        let np = &self.map.node_prod[node as usize];
        for r in 0..5 {
            out[r] += mult * np[r];
        }
        let rt = &self.map.tiles[self.robber as usize];
        if rt.resource >= 0 && rt.nodes.contains(&node) {
            out[rt.resource as usize] -= mult * self.map.tile_prob[self.robber as usize];
        }
    }

    /// Writes the full feature vector for perspective `p0` into `out`
    /// (len == layout.n_features). `out` must start as the map's static template.
    pub fn encode_into(&self, p0: usize, layout: &Layout, out: &mut [f32]) {
        let ix = |i: i32| i as usize;
        out[ix(layout.robber_idx[self.robber as usize])] = 1.0;
        for i in 0..self.n {
            let seat = (p0 + i) % self.n;
            let pl = &self.players[seat];
            let sc = &layout.player_scalar_idx[i * 8..i * 8 + 8];
            out[ix(sc[0])] = pl.vp as f32;
            out[ix(sc[1])] = pl.has_army as u8 as f32;
            out[ix(sc[2])] = pl.has_road as u8 as f32;
            out[ix(sc[3])] = pl.roads_available as f32;
            out[ix(sc[4])] = pl.settlements_available as f32;
            out[ix(sc[5])] = pl.cities_available as f32;
            out[ix(sc[6])] = pl.has_rolled as u8 as f32;
            out[ix(sc[7])] = pl.longest_road_length as f32;
            for (k, &card) in PLAYABLE_DEVS.iter().enumerate() {
                out[ix(layout.dev_played_idx[i * 4 + k])] = pl.played[card] as f32;
            }
            out[ix(layout.num_resources_idx[i])] = pl.hand.iter().sum::<i32>() as f32;
            out[ix(layout.num_devs_idx[i])] = pl.devs.iter().sum::<i32>() as f32;
            for &n in &pl.settlements {
                out[ix(layout.node_idx[(i * 54 + n as usize) * 2])] = 1.0;
            }
            for &n in &pl.cities {
                out[ix(layout.node_idx[(i * 54 + n as usize) * 2 + 1])] = 1.0;
            }
            for &e in &pl.roads {
                out[ix(layout.edge_idx[i * 72 + e as usize])] = 1.0;
            }
            let prod = self.effective_production(seat);
            for r in 0..5 {
                out[ix(layout.production_idx[i * 5 + r])] = prod[r] as f32;
            }
            out[ix(layout.buildable_nodes_idx[i])] = self.num_buildable_nodes(seat) as f32;
            if i == 0 {
                out[ix(layout.p0_actual_vps_idx)] = pl.actual_vp as f32;
                for r in 0..5 {
                    out[ix(layout.p0_resource_in_hand_idx[r])] = pl.hand[r] as f32;
                }
                for c in 0..5 {
                    out[ix(layout.p0_dev_in_hand_idx[c])] = pl.devs[c] as f32;
                }
                out[ix(layout.p0_has_played_dev_idx)] = pl.has_played_dev as u8 as f32;
            }
        }
        for r in 0..5 {
            out[ix(layout.bank_resource_idx[r])] = self.bank[r] as f32;
        }
        out[ix(layout.bank_dev_cards_idx)] = self.dev_deck.len() as f32;
        let cur = self.current_player;
        let discarding = self.prompt == Prompt::Discard && self.discard_counts[cur] > 0 && self.num_resources(cur) > 0;
        out[ix(layout.is_discarding_idx)] = discarding as u8 as f32;
        out[ix(layout.is_moving_robber_idx)] = (self.prompt == Prompt::MoveRobber) as u8 as f32;
        let rel = (cur + self.n - p0) % self.n;
        out[ix(layout.turn_base) + rel] = 1.0;
        let eb = ix(layout.extra_base);
        for i in 0..self.n {
            let seat = (p0 + i) % self.n;
            let reach = self.reachable_production(seat);
            out[eb + i * 5] = self.production_score(seat) as f32;
            out[eb + i * 5 + 1] = reach[0] as f32;
            out[eb + i * 5 + 2] = reach[1] as f32;
            out[eb + i * 5 + 3] = reach[2] as f32;
            out[eb + i * 5 + 4] = self.num_tiles(seat) as f32;
        }
        out[eb + 20] = self.hand_synergy(p0) as f32;
    }
}
