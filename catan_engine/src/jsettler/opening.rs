//! soc.robot.OpeningBuildStrategy: the two initial settlements and their roads. Every loop runs in
//! the Java's iteration order (jcoll.rs) because the argmaxes are strict and ties are common.

use super::bse::{Bse, PlayerNumbers, Ports, CARD_COST, CITY_COST, ROAD_COST, SETTLEMENT_COST};
use super::geom::NONE;
use super::jcoll::{JSet, JTable};
use super::player::{Player, SETTLEMENT};
use super::tracker::Trackers;

/// SOCNumberProbabilities.INT_VALUES, indexed by the roll.
pub const INT_VALUES: [i32; 13] = [0, 0, 3, 6, 8, 11, 14, 17, 14, 11, 8, 6, 3];
/// SOCBoard.NODE_2_AWAY, facings 1..6 = NE, E, SE, SW, W, NW.
const NODE_2_AWAY: [i32; 7] = [NONE, 0x02, 0x22, 0x20, -0x02, -0x22, -0x20];
/// JSettlers hex/port types CLAY 1, ORE 2, SHEEP 3, WHEAT 4, WOOD 5 for engine resource ids.
pub const JS_TYPE: [usize; 5] = [5, 1, 3, 4, 2];
pub const START1A: i32 = 5;
pub const START1B: i32 = 6;

/// What the strategy reads from the game besides the trackers' pieces.
pub struct Turn {
    pub game_state: i32,
    pub current: usize,
    pub first_player: usize,
}

#[derive(Default, Clone, Debug)]
pub struct Opening {
    pub first_settlement: i32,
    pub second_settlement: i32,
    pub planned_road_destination: i32,
    resource_estimates: Option<[i32; 6]>,
}

impl Trackers {
    /// SOCPlayerNumbers for one seat from its pieces (a city's hexes twice).
    pub fn numbers(&self, pn: usize) -> PlayerNumbers {
        let mut n = PlayerNumbers::default();
        let p = &self.players[pn];
        for &c in &p.settlements {
            n.add_node_map(&self.map, self.geom.node(c).unwrap());
        }
        for &c in &p.cities {
            for _ in 0..2 {
                n.add_node_map(&self.map, self.geom.node(c).unwrap());
            }
        }
        n
    }

    /// SOCPlayer.getPortFlags for one seat.
    pub fn port_flags(&self, pn: usize) -> Ports {
        let mut ports = Ports::default();
        let p = &self.players[pn];
        for &c in p.settlements.iter().chain(p.cities.iter()) {
            self.port_flag_at(&mut ports, c);
        }
        ports
    }

    /// SOCPlayerNumbers.updateNumbersAndProbability: add the node's hexes, return their weight.
    fn add_node_prob(&self, numbers: &mut PlayerNumbers, node: i32) -> i32 {
        let id = self.geom.node(node).unwrap();
        let mut total = 0;
        for &t in &self.map.node_tiles[id as usize] {
            let tile = &self.map.tiles[t as usize];
            if tile.number > 0 {
                total += INT_VALUES[tile.number as usize];
            }
        }
        numbers.add_node_map(&self.map, id);
        total
    }

}

impl Opening {
    /// Speed of a pair of nodes: rolls for settlement, city, card, road with early cut-off.
    fn pair_speed(bse: &Bse, ports: &Ports, cutoff: i32) -> (i32, bool) {
        let mut speed = 0;
        let mut all_the_way = false;
        let costs = [SETTLEMENT_COST, CITY_COST, CARD_COST, ROAD_COST];
        for (i, cost) in costs.iter().enumerate() {
            match bse.rolls_and_rsrc_fast(&[0; 5], cost, cutoff, ports) {
                Ok((_, rolls)) => speed += rolls,
                Err(_) => return (cutoff, false),
            }
            if i < 3 && speed >= cutoff {
                return (speed, false);
            }
        }
        all_the_way = all_the_way || true;
        (speed, all_the_way)
    }

    /// planInitialSettlements: the best pair of potential settlement nodes by joint building speed;
    /// returns the faster of the two (the first to place).
    pub fn plan_initial_settlements(&mut self, tr: &Trackers, pn: usize) -> i32 {
        self.first_settlement = 0;
        self.second_settlement = 0;
        let mut best_speed = 4 * super::bse::DEFAULT_ROLL_LIMIT;
        let mut best_prob = 0;
        let ours: Vec<i32> = tr.players[pn].potential_settlements.iter().copied().collect();
        for (i, &first) in ours.iter().enumerate() {
            // the single-node speed is only logged; the pair loop decides
            for &second in &ours[i + 1..] {
                if tr.geom.adj_nodes_to_node_arr(second).contains(&first) {
                    continue;
                }
                let mut numbers = PlayerNumbers::default();
                let mut prob = tr.add_node_prob(&mut numbers, first);
                prob += tr.add_node_prob(&mut numbers, second);
                let mut ports = Ports::default();
                tr.port_flag_at(&mut ports, first);
                tr.port_flag_at(&mut ports, second);
                let bse = Bse::new(&numbers, None);
                let (speed, all_the_way) = Opening::pair_speed(&bse, &ports, best_speed);
                if speed < best_speed {
                    self.first_settlement = first;
                    self.second_settlement = second;
                    best_speed = speed;
                    best_prob = prob;
                } else if speed == best_speed && all_the_way && prob > best_prob {
                    self.first_settlement = first;
                    self.second_settlement = second;
                    best_speed = speed;
                    best_prob = prob;
                }
            }
        }
        let single = |node: i32, cutoff: i32| -> i32 {
            let mut numbers = PlayerNumbers::default();
            numbers.add_node_map(&tr.map, tr.geom.node(node).unwrap());
            let mut ports = Ports::default();
            tr.port_flag_at(&mut ports, node);
            let bse = Bse::new(&numbers, None);
            [SETTLEMENT_COST, CITY_COST, CARD_COST, ROAD_COST].iter().map(|c| bse.rolls_fast(&[0; 5], c, cutoff, &ports)).sum()
        };
        let first_speed = single(self.first_settlement, 100);
        let second_speed = single(self.second_settlement, best_speed);
        if first_speed > second_speed {
            std::mem::swap(&mut self.first_settlement, &mut self.second_settlement);
        }
        self.first_settlement
    }

    /// planSecondSettlement: the best partner for the first settlement among the nodes left.
    pub fn plan_second_settlement(&mut self, tr: &Trackers, pn: usize) -> i32 {
        let mut best_speed = 4 * super::bse::DEFAULT_ROLL_LIMIT;
        let mut best_prob = 0;
        let first = self.first_settlement;
        self.second_settlement = -1;
        let ours: Vec<i32> = tr.players[pn].potential_settlements.iter().copied().collect();
        for second in ours {
            if tr.geom.adj_nodes_to_node_arr(second).contains(&first) {
                continue;
            }
            let mut numbers = PlayerNumbers::default();
            let mut prob = tr.add_node_prob(&mut numbers, first);
            prob += tr.add_node_prob(&mut numbers, second);
            let mut ports = Ports::default();
            tr.port_flag_at(&mut ports, first);
            tr.port_flag_at(&mut ports, second);
            let bse = Bse::new(&numbers, None);
            let (speed, _) = Opening::pair_speed(&bse, &ports, best_speed);
            if speed < best_speed || self.second_settlement < 0 {
                self.second_settlement = second;
                best_speed = speed;
                best_prob = prob;
            } else if speed == best_speed && prob > best_prob {
                self.second_settlement = second;
                best_speed = speed;
                best_prob = prob;
            }
        }
        self.second_settlement
    }

    /// planInitRoad: the road from the last settlement toward the best node two away.
    pub fn plan_init_road(&mut self, tr: &Trackers, pn: usize, turn: &Turn) -> i32 {
        let me = &tr.players[pn];
        let settlement = *me.settlements.last().expect("planInitRoad before a settlement");
        let mut two_away: JTable<i32> = JTable::new();
        for facing in 1..=6 {
            let tmp = settlement + NODE_2_AWAY[facing];
            if tr.geom.node(tmp).is_some() && me.can_place_settlement(tmp) {
                two_away.put(tmp, 0);
            }
        }
        self.score_nodes_for_settlements(tr, pn, &mut two_away, 3, 5, 10);
        let mut dummy = Player::new(pn, &tr.geom);
        if turn.game_state == START1B {
            let builds = Opening::number_of_enemy_builds(tr.players.len(), turn);
            if builds > 0 {
                let mut all: JTable<i32> = JTable::new();
                for &c in me.potential_settlements.iter() {
                    all.put(c, 0);
                }
                self.best_spot_for_numbers(tr, &mut all, None, 100);
                self.best_spot_2away_from(tr, &mut all, &tr.ports_by_type[0], 5);
                let est = self.estimate_resource_rarity(tr);
                for pt in 1..=5 {
                    if est[pt] > 33 {
                        let weight = (est[pt] * 10) / 56;
                        self.best_spot_2away_from(tr, &mut all, &tr.ports_by_type[pt], weight);
                    }
                }
                dummy.potential_settlements = JSet::from_iter(me.potential_settlements.iter().copied());
                for _ in 0..builds {
                    let (mut best_node, mut best_score) = (0, 0);
                    for k in all.keys() {
                        let score = *all.get(k).unwrap();
                        if best_score < score {
                            best_score = score;
                            best_node = k;
                        }
                    }
                    dummy.update_potentials(SETTLEMENT, best_node, pn, &tr.board, &tr.geom);
                    all.remove(best_node);
                }
            }
        }
        let (mut best_node, mut best_score) = (0, 0);
        for k in two_away.keys() {
            let score = *two_away.get(k).unwrap();
            if dummy.can_place_settlement(k) && best_score < score {
                best_score = score;
                best_node = k;
            }
        }
        self.planned_road_destination = best_node;
        adjacent_edge_to_node_2away(settlement, best_node)
    }

    fn number_of_enemy_builds(n: usize, turn: &Turn) -> i32 {
        let mut builds = 0;
        let mut p = turn.current as i32;
        if turn.game_state == START1A || turn.game_state == START1B {
            loop {
                p += 1;
                if p >= n as i32 {
                    p = 0;
                }
                if p != turn.first_player as i32 {
                    builds += 1;
                }
                if p == turn.first_player as i32 {
                    break;
                }
            }
        }
        loop {
            p -= 1;
            if p < 0 {
                p = n as i32 - 1;
            }
            if p != turn.current as i32 {
                builds += 1;
            }
            if p == turn.current as i32 {
                break;
            }
        }
        builds
    }

    fn score_nodes_for_settlements(&mut self, tr: &Trackers, pn: usize, nodes: &mut JTable<i32>, number_weight: i32, misc_weight: i32, port_weight: i32) {
        self.best_spot_for_numbers(tr, nodes, Some(pn), number_weight);
        let flags = tr.port_flags(pn);
        if !flags.misc {
            Opening::best_spot_in(nodes, &tr.ports_by_type[0], misc_weight);
        }
        let est = self.estimate_resource_rarity(tr);
        for pt in 1..=5 {
            let has = flags.res[JS_TYPE.iter().position(|&t| t == pt).unwrap()];
            if est[pt] > 33 && !has {
                let w = (est[pt] * port_weight) / 56;
                Opening::best_spot_in(nodes, &tr.ports_by_type[pt], w);
            }
        }
    }

    fn best_spot_in(nodes: &mut JTable<i32>, good: &[i32], weight: i32) {
        for k in nodes.keys() {
            let old = *nodes.get(k).unwrap();
            let score = if good.contains(&k) { 100 } else { 0 } * weight;
            nodes.put(k, old + score);
        }
    }

    fn best_spot_2away_from(&self, _tr: &Trackers, nodes: &mut JTable<i32>, good: &[i32], weight: i32) {
        for k in nodes.keys() {
            let old = *nodes.get(k).unwrap();
            let mut score = 0;
            for &g in good {
                if k == g {
                    break;
                } else if NODE_2_AWAY[1..].contains(&(g - k)) {
                    score = 100;
                }
            }
            nodes.put(k, old + score * weight);
        }
    }

    /// estimateResourceRarity: number weight per JSettlers hex type (index 1..5).
    pub fn estimate_resource_rarity(&mut self, tr: &Trackers) -> [i32; 6] {
        if let Some(e) = self.resource_estimates {
            return e;
        }
        let mut est = [0i32; 6];
        for tile in &tr.map.tiles {
            if tile.number > 0 && tile.resource >= 0 {
                est[JS_TYPE[tile.resource as usize]] += INT_VALUES[tile.number as usize];
            }
        }
        self.resource_estimates = Some(est);
        est
    }

    fn best_spot_for_numbers(&self, tr: &Trackers, nodes: &mut JTable<i32>, player: Option<usize>, weight: i32) {
        let numbers = player.map(|p| tr.numbers(p));
        let max_score = if player.is_some() { 80 } else { 40 };
        for k in nodes.keys() {
            let old = *nodes.get(k).unwrap();
            let mut score = 0;
            let id = tr.geom.node(k).unwrap();
            for &t in &tr.map.node_tiles[id as usize] {
                let number = tr.map.tiles[t as usize].number as usize;
                score += INT_VALUES[number];
                if number != 0 {
                    if let Some(n) = &numbers {
                        if !n.pairs.iter().any(|&(num, _, _)| num as usize == number) {
                            score += INT_VALUES[number];
                        }
                    }
                }
            }
            let n_score = ((score * 100) / max_score) * weight;
            nodes.put(k, n_score + old);
        }
    }
}

/// SOCBoard.getAdjacentEdgeToNode2Away.
pub fn adjacent_edge_to_node_2away(node: i32, node2away: i32) -> i32 {
    if ((node >> 4) % 2) == 0 {
        if node2away == node - 0x02 || node2away == node + 0x20 {
            node - 0x01
        } else if node2away < node {
            node - 0x11
        } else {
            node
        }
    } else if node2away == node - 0x20 || node2away == node + 0x02 {
        node - 0x10
    } else if node2away > node {
        node
    } else {
        node - 0x11
    }
}
