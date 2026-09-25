//! catan_env.Encoder.encode + value_net.encode_for_value, feature for feature.
//! Index tables come from Python's `catan_env.LAYOUT` (see rust_bridge.layout_spec).

use crate::state::*;
use crate::map::{NUM_EDGES, NUM_NODES};

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
        self.encode_board_into(p0, layout, out);
        self.encode_rest_into(p0, layout, out);
    }

    /// The features that depend only on the pieces and the robber (the costly part: production, buildable nodes,
    /// reachable production). A search leaf whose board equals its root's reuses the root's (valuenet.rs LeafSink).
    pub fn encode_board_into(&self, p0: usize, layout: &Layout, out: &mut [f32]) {
        let ix = |i: i32| i as usize;
        out[ix(layout.robber_idx[self.robber as usize])] = 1.0;
        let eb = ix(layout.extra_base);
        for i in 0..self.n {
            let seat = (p0 + i) % self.n;
            let pl = &self.players[seat];
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
            let reach = self.reachable_production(seat);
            out[eb + i * 5] = self.production_score(seat) as f32;
            out[eb + i * 5 + 1] = reach[0] as f32;
            out[eb + i * 5 + 2] = reach[1] as f32;
            out[eb + i * 5 + 3] = reach[2] as f32;
            out[eb + i * 5 + 4] = self.num_tiles(seat) as f32;
        }
    }

    /// Everything `encode_board_into` doesn't write: scalars, hands, cards, bank, prompt, turn, hand synergy.
    pub fn encode_rest_into(&self, p0: usize, layout: &Layout, out: &mut [f32]) {
        let ix = |i: i32| i as usize;
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
        out[ix(layout.extra_base) + 20] = self.hand_synergy(p0) as f32;
    }

    /// Every position `encode_rest_into` can write for an `n`-seat game, ascending: a leaf on its root's board can
    /// differ from the root only here (valuenet.rs `LeafSink::push_brow` scans these instead of all 1,051).
    pub fn rest_indices(layout: &Layout, n: usize) -> Vec<u32> {
        let mut v: Vec<i32> = Vec::new();
        v.extend(&layout.player_scalar_idx[..n * 8]);
        v.extend(&layout.dev_played_idx[..n * 4]);
        v.extend(&layout.num_resources_idx[..n]);
        v.extend(&layout.num_devs_idx[..n]);
        v.push(layout.p0_actual_vps_idx);
        v.extend(&layout.p0_resource_in_hand_idx);
        v.extend(&layout.p0_dev_in_hand_idx);
        v.push(layout.p0_has_played_dev_idx);
        v.extend(&layout.bank_resource_idx);
        v.extend([layout.bank_dev_cards_idx, layout.is_discarding_idx, layout.is_moving_robber_idx, layout.extra_base + 20]);
        v.extend((0..n as i32).map(|r| layout.turn_base + r));
        let mut v: Vec<u32> = v.into_iter().map(|i| i as u32).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// What the board features depend on: the robber, node owners and cities, road owners.
    pub fn board_key(&self) -> Vec<u8> {
        let mut k = Vec::with_capacity(1 + 2 * NUM_NODES + NUM_EDGES);
        k.push(self.robber);
        k.extend(self.owner.iter().map(|&o| o as u8));
        k.extend(self.is_city.iter().map(|&c| c as u8));
        k.extend(self.road_owner.iter().map(|&o| o as u8));
        k
    }

    /// `board_key() == key` without building it.
    pub fn board_is(&self, key: &[u8]) -> bool {
        key[0] == self.robber
            && self.owner.iter().zip(&key[1..]).all(|(&o, &k)| o as u8 == k)
            && self.is_city.iter().zip(&key[1 + NUM_NODES..]).all(|(&c, &k)| c as u8 == k)
            && self.road_owner.iter().zip(&key[1 + 2 * NUM_NODES..]).all(|(&o, &k)| o as u8 == k)
    }

    /// The features `encode_into(p, ..)` would change if the current player `p` held `hand` instead (a domestic trade
    /// moves nothing else): (index, value) for the hand counts, the hand size and hand_synergy, in PlayTurn.
    pub fn hand_delta(&self, p: usize, layout: &Layout, hand: &[i32; 5]) -> Vec<(u32, f32)> {
        debug_assert!(p == self.current_player && self.prompt == Prompt::PlayTurn, "is_discarding would read the hand too");
        let mut d: Vec<(u32, f32)> = (0..5).map(|r| (layout.p0_resource_in_hand_idx[r] as u32, hand[r] as f32)).collect();
        d.push((layout.num_resources_idx[0] as u32, hand.iter().sum::<i32>() as f32));
        d.push((layout.extra_base as u32 + 20, crate::heuristic::hand_synergy_of(hand) as f32));
        d
    }

    /// `encode_into(p, ..)` of this state with `hand` for the current player `p`, from its own encoding `x0`.
    pub fn encode_hand(&self, p: usize, layout: &Layout, x0: &[f32], hand: &[i32; 5], out: &mut [f32]) {
        out.copy_from_slice(x0);
        for (i, v) in self.hand_delta(p, layout, hand) {
            out[i as usize] = v;
        }
    }
}
