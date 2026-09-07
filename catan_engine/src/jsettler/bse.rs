//! SOCBuildingSpeedEstimate + SOCPlayerNumbers + SOCNumberProbabilities: how many rolls until a player
//! can afford each piece. Resource sets are engine order (WOOD, BRICK, SHEEP, WHEAT, ORE); every loop that
//! the Java runs over CLAY..WOOD runs here over [`JS_ORDER`], because the trade heuristic's tie-breaks
//! depend on that order.

use crate::state::State;

pub const ROAD: usize = 0;
pub const SETTLEMENT: usize = 1;
pub const CITY: usize = 2;
pub const CARD: usize = 3;
pub const SHIP: usize = 4;
pub const DEFAULT_ROLL_LIMIT: i32 = 40;
/// SOCNumberProbabilities.FLOAT_VALUES, indexed by the roll.
pub const FLOAT_VALUES: [f32; 13] = [0.0, 0.0, 0.03, 0.06, 0.08, 0.11, 0.14, 0.17, 0.14, 0.11, 0.08, 0.06, 0.03];
/// Engine resource ids in JSettlers' order CLAY, ORE, SHEEP, WHEAT, WOOD.
pub const JS_ORDER: [usize; 5] = [1, 4, 2, 3, 0];

pub type Res = [i32; 5];
pub const ROAD_COST: Res = [1, 1, 0, 0, 0];
pub const SETTLEMENT_COST: Res = [1, 1, 1, 1, 0];
pub const CITY_COST: Res = [0, 0, 0, 2, 3];
pub const CARD_COST: Res = [0, 0, 1, 1, 1];
pub const SHIP_COST: Res = [1, 0, 1, 0, 0];
pub const COSTS: [Res; 5] = [ROAD_COST, SETTLEMENT_COST, CITY_COST, CARD_COST, SHIP_COST];

pub fn contains(have: &Res, target: &Res) -> bool {
    (0..5).all(|r| have[r] >= target[r])
}

/// SOCPlayer.getPortFlags: `misc` = a 3:1 port, `res[r]` = a 2:1 port for r.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Ports {
    pub misc: bool,
    pub res: [bool; 5],
}

impl Ports {
    pub fn of(s: &State, p: usize) -> Ports {
        let mut out = Ports::default();
        for port in &s.map.ports {
            if port.nodes.iter().any(|&n| s.owner[n as usize] == p as i8) {
                if port.resource < 0 {
                    out.misc = true;
                } else {
                    out.res[port.resource as usize] = true;
                }
            }
        }
        out
    }

    /// The bank ratio for giving resource r.
    pub fn ratio(&self, r: usize) -> i32 {
        if self.res[r] { 2 } else if self.misc { 3 } else { 4 }
    }
}

/// SOCPlayerNumbers: one (roll, resource, tile) per touching land hex per piece, a city's twice.
#[derive(Clone, Default, Debug)]
pub struct PlayerNumbers {
    pub pairs: Vec<(u8, usize, u8)>,
}

impl PlayerNumbers {
    pub fn of(s: &State, p: usize) -> PlayerNumbers {
        let mut out = PlayerNumbers::default();
        for (&node, times) in s.players[p].settlements.iter().map(|n| (n, 1)).chain(s.players[p].cities.iter().map(|n| (n, 2))) {
            for _ in 0..times {
                out.add_node(s, node);
            }
        }
        out
    }

    pub fn add_node(&mut self, s: &State, node: u8) {
        self.add_node_map(&s.map, node);
    }

    /// SOCPlayerNumbers.updateNumbers(nodeCoord, board): one pair per touching land hex.
    pub fn add_node_map(&mut self, map: &crate::map::Map, node: u8) {
        for &t in &map.node_tiles[node as usize] {
            let tile = &map.tiles[t as usize];
            if tile.resource >= 0 {
                self.pairs.push((tile.number, tile.resource as usize, t));
            }
        }
    }

    /// undoUpdateNumbers: remove one matching pair per touching land hex.
    pub fn remove_node_map(&mut self, map: &crate::map::Map, node: u8) {
        for &t in &map.node_tiles[node as usize] {
            let tile = &map.tiles[t as usize];
            if tile.resource >= 0 {
                if let Some(i) = self.pairs.iter().position(|&(n, r, _)| n == tile.number && r == tile.resource as usize) {
                    self.pairs.remove(i);
                }
            }
        }
    }

    pub fn numbers_for_resource(&self, r: usize, robber: Option<u8>) -> impl Iterator<Item = u8> + '_ {
        self.pairs.iter().filter(move |&&(_, res, t)| res == r && Some(t) != robber).map(|&(n, _, _)| n)
    }
}

/// SOCBuildingSpeedEstimate over one player's numbers (`robber` = None ignores the robber, the
/// constructor's default; the trackers pass the robber hex).
#[derive(Clone, Debug)]
pub struct Bse {
    pub rolls_per_resource: Res,
    pub resources_for_roll: [Res; 13],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutoffExceeded;

impl Bse {
    pub fn new(numbers: &PlayerNumbers, robber: Option<u8>) -> Bse {
        let mut rolls_per_resource = [55555; 5];
        for r in 0..5 {
            let total: f32 = numbers.numbers_for_resource(r, robber).fold(0.0, |acc, n| acc + FLOAT_VALUES[n as usize]);
            if total != 0.0 {
                rolls_per_resource[r] = (1.0 / total + 0.5).floor() as i32; // Math.round(float)
            }
        }
        let mut resources_for_roll = [[0; 5]; 13];
        for &(n, r, t) in &numbers.pairs {
            if Some(t) != robber {
                resources_for_roll[n as usize][r] += 1;
            }
        }
        Bse { rolls_per_resource, resources_for_roll }
    }

    pub fn of(s: &State, p: usize, robber: Option<u8>) -> Bse {
        Bse::new(&PlayerNumbers::of(s, p), robber)
    }

    /// The bank-trade heuristic shared by every estimate: give surplus in CLAY..WOOD order for the
    /// most-needed (slowest) missing resource, stopping when the target is affordable.
    fn trade_toward(&self, our: &mut Res, target: &Res, ports: &Ports) {
        for &give in &JS_ORDER {
            let ratio = ports.ratio(give);
            let num_trades = (our[give] - target[give]) / ratio;
            for _ in 0..num_trades.max(0) {
                let mut most: Option<usize> = None;
                for &r in &JS_ORDER {
                    if our[r] < target[r] && most.map_or(true, |m| self.rolls_per_resource[r] > self.rolls_per_resource[m]) {
                        most = Some(r);
                    }
                }
                if let Some(m) = most {
                    if our[give] >= ratio {
                        our[m] += 1;
                        our[give] -= ratio;
                    }
                }
                if contains(our, target) {
                    break;
                }
            }
            if contains(our, target) {
                break;
            }
        }
    }

    /// calculateRollsAndRsrcFast: each resource arrives every rolls_per_resource rolls, bank trades
    /// between rolls; Err past `cutoff` rolls.
    pub fn rolls_and_rsrc_fast(&self, start: &Res, target: &Res, cutoff: i32, ports: &Ports) -> Result<(Res, i32), CutoffExceeded> {
        let mut our = *start;
        let mut rolls = 0;
        if !contains(&our, target) {
            self.trade_toward(&mut our, target, ports);
        }
        while !contains(&our, target) {
            rolls += 1;
            if rolls > cutoff {
                return Err(CutoffExceeded);
            }
            for r in 0..5 {
                let per = self.rolls_per_resource[r];
                if per == 0 || rolls % per == 0 {
                    our[r] += 1;
                }
            }
            if !contains(&our, target) {
                self.trade_toward(&mut our, target, ports);
            }
        }
        Ok((our, rolls))
    }

    /// calculateRollsFast: the rolls, or the cutoff itself past it.
    pub fn rolls_fast(&self, start: &Res, target: &Res, cutoff: i32, ports: &Ports) -> i32 {
        self.rolls_and_rsrc_fast(start, target, cutoff, ports).map_or(cutoff, |(_, rolls)| rolls)
    }

    /// calculateRollsAccurate: the roll by which the probability of affording the target reaches 1/2,
    /// over the distribution of hands (bank trades applied to each hand).
    pub fn rolls_accurate(&self, start: &Res, target: &Res, cutoff: i32, ports: &Ports) -> Result<(Res, i32), CutoffExceeded> {
        let mut last: Vec<(Res, f32)> = vec![(*start, 1.0)];
        let mut rolls = 0;
        let mut reached_prob = 0.0f32;
        let mut reached: Option<Res> = None;
        let mut target_reached = contains(start, target);
        if target_reached {
            reached = Some(*start);
        }
        while !target_reached {
            rolls += 1;
            if rolls > cutoff {
                return Err(CutoffExceeded);
            }
            let mut this: Vec<(Res, f32)> = Vec::new();
            for dice in 2..=12usize {
                let gained = self.resources_for_roll[dice];
                let dice_prob = FLOAT_VALUES[dice];
                for &(last_res, last_prob) in &last {
                    let mut new = last_res;
                    for r in 0..5 {
                        new[r] += gained[r];
                    }
                    let new_prob = last_prob * dice_prob;
                    if !contains(&new, target) {
                        // the accurate variant only trades a resource with a surplus of two or more,
                        // which the shared heuristic's num_trades already implies for ratios >= 2
                        self.trade_toward(&mut new, target, ports);
                    }
                    if contains(&new, target) {
                        reached_prob += new_prob;
                        reached.get_or_insert(new);
                        if reached_prob >= 0.5 {
                            target_reached = true;
                        }
                    } else if let Some(e) = this.iter_mut().find(|(r, _)| *r == new) {
                        e.1 += new_prob;
                    } else {
                        this.push((new, new_prob));
                    }
                }
            }
            last = this;
        }
        Ok((reached.unwrap_or(*start), rolls))
    }

    /// getEstimatesFromNothingFast(ports, limit): rolls from an empty hand for road, settlement, city,
    /// card, ship; `limit` when past it.
    pub fn from_nothing_fast(&self, ports: &Ports, limit: i32) -> [i32; 5] {
        let mut out = [limit; 5];
        for (i, cost) in COSTS.iter().enumerate() {
            match self.rolls_and_rsrc_fast(&[0; 5], cost, limit, ports) {
                Ok((_, rolls)) => out[i] = rolls,
                Err(_) => break, // the Java catches the exception outside the whole sequence
            }
        }
        out
    }

    pub fn from_now_fast(&self, have: &Res, ports: &Ports) -> [i32; 5] {
        let mut out = [DEFAULT_ROLL_LIMIT; 5];
        for (i, cost) in COSTS.iter().enumerate() {
            match self.rolls_and_rsrc_fast(have, cost, DEFAULT_ROLL_LIMIT, ports) {
                Ok((_, rolls)) => out[i] = rolls,
                Err(_) => break,
            }
        }
        out
    }

    pub fn from_nothing_accurate(&self, ports: &Ports) -> [i32; 5] {
        self.from_now_accurate(&[0; 5], ports)
    }

    pub fn from_now_accurate(&self, have: &Res, ports: &Ports) -> [i32; 5] {
        let mut out = [DEFAULT_ROLL_LIMIT; 5];
        for (i, cost) in COSTS.iter().enumerate() {
            match self.rolls_accurate(have, cost, DEFAULT_ROLL_LIMIT, ports) {
                Ok((_, rolls)) => out[i] = rolls,
                Err(_) => break,
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbers the Java gives (SOCBuildingSpeedEstimate on a SOCPlayerNumbers with 6-wood, 8-clay,
    /// 5-wheat added by hand; harness in the session notes) for a settlement touching those three hexes.
    #[test]
    fn bse_matches_java() {
        let numbers = PlayerNumbers { pairs: vec![(6, 0, 0), (8, 1, 1), (5, 3, 2)] };
        let b = Bse::new(&numbers, None);
        assert_eq!(b.rolls_per_resource, [7, 7, 55555, 9, 55555]);
        assert_eq!(b.resources_for_roll[6], [1, 0, 0, 0, 0]);
        let none = Ports::default();
        let misc = Ports { misc: true, res: [false; 5] };
        assert_eq!(b.from_nothing_fast(&none, DEFAULT_ROLL_LIMIT), [7, 35, 40, 40, 40]);
        assert_eq!(b.from_nothing_fast(&misc, DEFAULT_ROLL_LIMIT), [7, 28, 40, 40, 40]);
        assert_eq!(b.from_nothing_fast(&misc, 300), [7, 28, 42, 21, 21]);
        assert_eq!(b.from_nothing_accurate(&none), [9, 24, 40, 28, 19]);
        assert_eq!(b.from_nothing_accurate(&misc), [8, 19, 31, 21, 14]);
        let have = [4, 1, 0, 2, 0];
        assert_eq!(b.from_now_fast(&have, &misc), [0, 0, 14, 14, 0]);
        assert_eq!(b.from_now_accurate(&have, &misc), [0, 1, 14, 7, 1]);
        assert_eq!(b.rolls_fast(&[0; 5], &SETTLEMENT_COST, 300, &misc), 28);
        assert_eq!(Bse::new(&numbers, Some(0)).rolls_per_resource[0], 55555);
    }
}
