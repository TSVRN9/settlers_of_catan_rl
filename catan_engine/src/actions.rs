//! Action type + move generation (catanatron.models.actions).

use crate::state::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Action {
    Roll,
    MoveRobber { tile: u8, victim: i8 },
    Discard(u8),
    BuildRoad(u8),
    BuildSettlement(u8),
    BuildCity(u8),
    BuyDev,
    PlayKnight,
    PlayYop(u8, i8), // second = -1 for a single card
    PlayMonopoly(u8),
    PlayRoadBuilding,
    MaritimeTrade { give: u8, rate: u8, get: u8 },
    EndTurn,
}

/// Canonical tuple form (type, a, b, c) with -1 padding: the shape actions take across the Python
/// boundary (rust_bridge.py) and, as a JSON array, across the wasm boundary.
pub type Canon = (String, i32, i32, i32);

pub fn to_canon(a: Action) -> Canon {
    match a {
        Action::Roll => ("ROLL".into(), -1, -1, -1),
        Action::MoveRobber { tile, victim } => ("MOVE_ROBBER".into(), tile as i32, victim as i32, -1),
        Action::Discard(r) => ("DISCARD_RESOURCE".into(), r as i32, -1, -1),
        Action::BuildRoad(e) => ("BUILD_ROAD".into(), e as i32, -1, -1),
        Action::BuildSettlement(n) => ("BUILD_SETTLEMENT".into(), n as i32, -1, -1),
        Action::BuildCity(n) => ("BUILD_CITY".into(), n as i32, -1, -1),
        Action::BuyDev => ("BUY_DEVELOPMENT_CARD".into(), -1, -1, -1),
        Action::PlayKnight => ("PLAY_KNIGHT_CARD".into(), -1, -1, -1),
        Action::PlayYop(a, b) => ("PLAY_YEAR_OF_PLENTY".into(), a as i32, b as i32, -1),
        Action::PlayMonopoly(r) => ("PLAY_MONOPOLY".into(), r as i32, -1, -1),
        Action::PlayRoadBuilding => ("PLAY_ROAD_BUILDING".into(), -1, -1, -1),
        Action::MaritimeTrade { give, rate, get } => ("MARITIME_TRADE".into(), give as i32, rate as i32, get as i32),
        Action::EndTurn => ("END_TURN".into(), -1, -1, -1),
    }
}

pub fn from_canon(c: &Canon) -> Result<Action, String> {
    let (t, a, b, d) = (c.0.as_str(), c.1, c.2, c.3);
    Ok(match t {
        "ROLL" => Action::Roll,
        "MOVE_ROBBER" => Action::MoveRobber { tile: a as u8, victim: b as i8 },
        "DISCARD_RESOURCE" => Action::Discard(a as u8),
        "BUILD_ROAD" => Action::BuildRoad(a as u8),
        "BUILD_SETTLEMENT" => Action::BuildSettlement(a as u8),
        "BUILD_CITY" => Action::BuildCity(a as u8),
        "BUY_DEVELOPMENT_CARD" => Action::BuyDev,
        "PLAY_KNIGHT_CARD" => Action::PlayKnight,
        "PLAY_YEAR_OF_PLENTY" => Action::PlayYop(a as u8, b as i8),
        "PLAY_MONOPOLY" => Action::PlayMonopoly(a as u8),
        "PLAY_ROAD_BUILDING" => Action::PlayRoadBuilding,
        "MARITIME_TRADE" => Action::MaritimeTrade { give: a as u8, rate: b as u8, get: d as u8 },
        "END_TURN" => Action::EndTurn,
        _ => return Err(format!("unknown action type {t}")),
    })
}

impl State {
    pub fn playable_actions(&self) -> Vec<Action> {
        let p = self.current_player;
        match self.prompt {
            Prompt::InitialSettlement => self.buildable_node_ids(p, true).into_iter().map(Action::BuildSettlement).collect(),
            Prompt::InitialRoad => {
                let last = *self.players[p].settlements.last().expect("initial road without settlement");
                self.buildable_edges(p)
                    .into_iter()
                    .filter(|&e| {
                        let (a, b) = self.map.edges[e as usize];
                        a == last || b == last
                    })
                    .map(Action::BuildRoad)
                    .collect()
            }
            Prompt::MoveRobber => self.robber_possibilities(p),
            Prompt::PlayTurn => {
                if self.is_road_building {
                    return self.road_building_possibilities(p, false);
                }
                let mut actions = Vec::new();
                if self.can_play_dev(p, YEAR_OF_PLENTY) {
                    actions.extend(self.year_of_plenty_possibilities());
                }
                if self.can_play_dev(p, MONOPOLY) {
                    for r in 0..5u8 {
                        actions.push(Action::PlayMonopoly(r));
                    }
                }
                if self.can_play_dev(p, KNIGHT) {
                    actions.push(Action::PlayKnight);
                }
                if self.can_play_dev(p, ROAD_BUILDING) && !self.road_building_possibilities(p, false).is_empty() {
                    actions.push(Action::PlayRoadBuilding);
                }
                if !self.players[p].has_rolled {
                    actions.push(Action::Roll);
                } else {
                    actions.push(Action::EndTurn);
                    actions.extend(self.road_building_possibilities(p, true));
                    actions.extend(self.settlement_possibilities(p));
                    actions.extend(self.city_possibilities(p));
                    if self.can_afford_dev(p) && !self.dev_deck.is_empty() {
                        actions.push(Action::BuyDev);
                    }
                    actions.extend(self.maritime_trade_possibilities(p));
                }
                actions
            }
            Prompt::Discard => {
                if self.discard_counts[p] <= 0 {
                    return vec![];
                }
                (0..5u8).filter(|&r| self.players[p].hand[r as usize] > 0).map(Action::Discard).collect()
            }
        }
    }

    fn year_of_plenty_possibilities(&self) -> Vec<Action> {
        let bank = &self.bank;
        let mut options: Vec<Action> = Vec::new();
        fn add(a: Action, options: &mut Vec<Action>) {
            if !options.contains(&a) {
                options.push(a);
            }
        }
        for i in 0..5usize {
            for j in i..5usize {
                let mut need = [0i32; 5];
                need[i] += 1;
                need[j] += 1;
                if (0..5).all(|k| bank[k] >= need[k]) {
                    add(Action::PlayYop(i as u8, j as i8), &mut options);
                } else {
                    if bank[i] >= 1 {
                        add(Action::PlayYop(i as u8, -1), &mut options);
                    }
                    if bank[j] >= 1 {
                        add(Action::PlayYop(j as u8, -1), &mut options);
                    }
                }
            }
        }
        options
    }

    pub fn road_building_possibilities(&self, p: usize, check_money: bool) -> Vec<Action> {
        if self.players[p].roads_available <= 0 {
            return vec![];
        }
        if check_money && !self.hand_contains(p, &ROAD_COST) {
            return vec![];
        }
        self.buildable_edges(p).into_iter().map(Action::BuildRoad).collect()
    }

    fn settlement_possibilities(&self, p: usize) -> Vec<Action> {
        if self.hand_contains(p, &SETTLEMENT_COST) && self.players[p].settlements_available > 0 {
            self.buildable_node_ids(p, false).into_iter().map(Action::BuildSettlement).collect()
        } else {
            vec![]
        }
    }

    fn city_possibilities(&self, p: usize) -> Vec<Action> {
        if !self.hand_contains(p, &CITY_COST) || self.players[p].cities_available <= 0 {
            return vec![];
        }
        self.players[p].settlements.iter().map(|&n| Action::BuildCity(n)).collect()
    }

    fn robber_possibilities(&self, p: usize) -> Vec<Action> {
        let actions = self.robber_possibilities_raw(p);
        if !self.friendly_robber {
            return actions;
        }
        let filtered: Vec<Action> = actions.iter().copied().filter(|a| !self.robber_blocks_low_vp_enemy(p, a)).collect();
        if filtered.is_empty() { actions } else { filtered }
    }

    fn robber_possibilities_raw(&self, p: usize) -> Vec<Action> {
        let mut actions = Vec::new();
        for (tid, tile) in self.map.tiles.iter().enumerate() {
            if tid as u8 == self.robber {
                continue;
            }
            let mut victims: Vec<i8> = Vec::new();
            for &n in &tile.nodes {
                let o = self.owner[n as usize];
                if o >= 0 && o as usize != p && self.num_resources(o as usize) >= 1 && !victims.contains(&o) {
                    victims.push(o);
                }
            }
            if victims.is_empty() {
                actions.push(Action::MoveRobber { tile: tid as u8, victim: -1 });
            } else {
                for v in victims {
                    actions.push(Action::MoveRobber { tile: tid as u8, victim: v });
                }
            }
        }
        actions
    }

    fn robber_blocks_low_vp_enemy(&self, p: usize, a: &Action) -> bool {
        if let Action::MoveRobber { tile, .. } = a {
            for &n in &self.map.tiles[*tile as usize].nodes {
                let o = self.owner[n as usize];
                if o < 0 || o as usize == p {
                    continue;
                }
                if self.players[o as usize].actual_vp < 3 {
                    return true;
                }
            }
        }
        false
    }

    fn maritime_trade_possibilities(&self, p: usize) -> Vec<Action> {
        let hand = &self.players[p].hand;
        let ports = self.port_resources(p);
        let base_rate: u8 = if ports & (1 << 5) != 0 { 3 } else { 4 };
        let mut out = Vec::new();
        for r in 0..5usize {
            let rate = if ports & (1 << r) != 0 { 2 } else { base_rate };
            if hand[r] >= rate as i32 {
                for g in 0..5usize {
                    if g != r && self.bank[g] > 0 {
                        out.push(Action::MaritimeTrade { give: r as u8, rate, get: g as u8 });
                    }
                }
            }
        }
        out
    }
}
