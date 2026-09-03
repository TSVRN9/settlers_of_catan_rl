//! Mirror of catanatron.state.State + models.board.Board, compact.

use std::sync::Arc;

use crate::map::{Map, NUM_EDGES, NUM_NODES};

pub const WOOD: usize = 0;
pub const BRICK: usize = 1;
pub const SHEEP: usize = 2;
pub const WHEAT: usize = 3;
pub const ORE: usize = 4;

pub const KNIGHT: usize = 0;
pub const YEAR_OF_PLENTY: usize = 1;
pub const MONOPOLY: usize = 2;
pub const ROAD_BUILDING: usize = 3;
pub const VICTORY_POINT: usize = 4;

pub const ROAD_COST: [i32; 5] = [1, 1, 0, 0, 0];
pub const SETTLEMENT_COST: [i32; 5] = [1, 1, 1, 1, 0];
pub const CITY_COST: [i32; 5] = [0, 0, 0, 2, 3];
pub const DEV_COST: [i32; 5] = [0, 0, 1, 1, 1];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Prompt {
    InitialSettlement,
    InitialRoad,
    PlayTurn,
    Discard,
    MoveRobber,
}

#[derive(Clone, Debug, Default)]
pub struct Player {
    pub hand: [i32; 5],
    pub devs: [i32; 5],
    pub played: [i32; 5],
    pub owned_at_start: [bool; 5],
    pub vp: i32,
    pub actual_vp: i32,
    pub roads_available: i32,
    pub settlements_available: i32,
    pub cities_available: i32,
    pub has_road: bool,
    pub has_army: bool,
    pub has_rolled: bool,
    pub has_played_dev: bool,
    pub longest_road_length: i32,
    // buildings_by_color, order-preserving like the Python lists
    pub settlements: Vec<u8>,
    pub cities: Vec<u8>,
    pub roads: Vec<u8>, // edge idx
}

#[derive(Clone)]
pub struct State {
    pub map: Arc<Map>,
    pub n: usize,
    pub players: Vec<Player>,
    pub bank: [i32; 5],
    pub dev_deck: Vec<u8>, // pop() takes the last, like the Python list
    // board
    pub owner: [i8; NUM_NODES],
    pub is_city: [bool; NUM_NODES],
    pub road_owner: [i8; NUM_EDGES],
    pub components: Vec<Vec<u64>>, // per player, list of node bitsets (order matters)
    pub buildable: u64,             // board_buildable_ids
    pub road_lengths: [i32; 4],
    pub road_color: i8,
    pub road_length: i32,
    pub robber: u8, // tile id
    // turn bookkeeping
    pub current_player: usize,
    pub current_turn: usize,
    pub prompt: Prompt,
    pub initial_phase: bool,
    pub is_discarding: bool,
    pub discard_counts: [i32; 4],
    pub is_moving_knight: bool,
    pub is_road_building: bool,
    pub free_roads: i32,
    pub num_turns: i32,
    pub discard_limit: i32,
    pub vps_to_win: i32,
    pub friendly_robber: bool,
    pub rng: u64,
}

impl State {
    /// catanatron's initial state (State.__init__ + Board): empty board, bank 19 x 5, the 25-card dev deck
    /// shuffled with the state's own RNG, robber on the desert, seat 0 to place first.
    pub fn new(map: Arc<Map>, n: usize, seed: u64, vps_to_win: i32) -> State {
        let players = (0..n).map(|_| Player { roads_available: 15, settlements_available: 5, cities_available: 4, ..Default::default() }).collect();
        let mut dev_deck: Vec<u8> = Vec::with_capacity(25);
        for (card, count) in [(KNIGHT, 14), (YEAR_OF_PLENTY, 2), (ROAD_BUILDING, 2), (MONOPOLY, 2), (VICTORY_POINT, 5)] {
            dev_deck.extend(std::iter::repeat(card as u8).take(count));
        }
        let robber = map.tiles.iter().position(|t| t.resource < 0).expect("a BASE map has a desert") as u8;
        let mut s = State {
            map,
            n,
            players,
            bank: [19; 5],
            dev_deck,
            owner: [-1; NUM_NODES],
            is_city: [false; NUM_NODES],
            road_owner: [-1; NUM_EDGES],
            components: vec![vec![]; n],
            buildable: (1u64 << NUM_NODES) - 1,
            road_lengths: [0; 4],
            road_color: -1,
            road_length: 0,
            robber,
            current_player: 0,
            current_turn: 0,
            prompt: Prompt::InitialSettlement,
            initial_phase: true,
            is_discarding: false,
            discard_counts: [0; 4],
            is_moving_knight: false,
            is_road_building: false,
            free_roads: 0,
            num_turns: 0,
            discard_limit: 7,
            vps_to_win,
            friendly_robber: false,
            rng: seed,
        };
        for i in (1..s.dev_deck.len()).rev() {
            let j = s.rand_below(i as u64 + 1) as usize;
            s.dev_deck.swap(i, j);
        }
        s
    }

    /// Official rule: a player wins on their own turn (current_turn, not the
    /// player deciding a discard or robber move). Mirrors the pinned fork.
    pub fn winner(&self) -> i8 {
        let t = self.current_turn;
        if self.players[t].actual_vp >= self.vps_to_win {
            t as i8
        } else {
            -1
        }
    }

    #[inline]
    pub fn num_resources(&self, p: usize) -> i32 {
        self.players[p].hand.iter().sum()
    }

    #[inline]
    pub fn hand_contains(&self, p: usize, cost: &[i32; 5]) -> bool {
        let h = &self.players[p].hand;
        (0..5).all(|i| h[i] >= cost[i])
    }

    pub fn can_play_dev(&self, p: usize, card: usize) -> bool {
        let pl = &self.players[p];
        !pl.has_played_dev && pl.devs[card] >= 1 && pl.owned_at_start[card]
    }

    pub fn can_afford_dev(&self, p: usize) -> bool {
        let h = &self.players[p].hand;
        h[SHEEP] >= 1 && h[WHEAT] >= 1 && h[ORE] >= 1
    }

    // ---- tiny RNG (splitmix64) for unpinned stochastic actions ----
    pub fn next_u64(&mut self) -> u64 {
        self.rng = self.rng.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    pub fn rand_below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}
