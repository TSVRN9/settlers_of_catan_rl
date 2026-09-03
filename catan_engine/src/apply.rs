//! catanatron.apply_action semantics. `result` pins the stochastic outcome
//! (dice, drawn card, stolen resource); None draws from the state's RNG.

use crate::actions::Action;
use crate::state::*;

/// Realized outcome of a stochastic action: (a, b) with -1 = none.
pub type Outcome = (i32, i32);

impl State {
    pub fn apply(&mut self, action: Action, result: Option<Outcome>) -> Result<Outcome, String> {
        let p = self.current_player;
        match action {
            Action::EndTurn => {
                self.clean_turn(p);
                self.advance_turn(1);
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::BuildSettlement(node) => {
                if self.initial_phase {
                    self.board_build_settlement(p, node, true);
                    self.build_settlement(p, node, true);
                    if self.players[p].settlements.len() == 2 {
                        for &tid in &self.map.node_tiles[node as usize].clone() {
                            let r = self.map.tiles[tid as usize].resource;
                            if r >= 0 {
                                self.bank[r as usize] -= 1;
                                self.players[p].hand[r as usize] += 1;
                            }
                        }
                    }
                    self.prompt = Prompt::InitialRoad;
                } else {
                    let (prev, rc) = self.board_build_settlement(p, node, false);
                    self.build_settlement(p, node, false);
                    for i in 0..5 {
                        self.bank[i] += SETTLEMENT_COST[i];
                    }
                    self.maintain_longest_road(prev, rc);
                }
                Ok((-1, -1))
            }
            Action::BuildRoad(edge) => {
                if self.initial_phase {
                    self.board_build_road(p, edge);
                    self.build_road(p, edge, true);
                    let num_buildings: usize = self.players.iter().map(|pl| pl.settlements.len()).sum();
                    let n = self.n;
                    if num_buildings < n {
                        self.advance_turn(1);
                        self.prompt = Prompt::InitialSettlement;
                    } else if num_buildings == n {
                        self.prompt = Prompt::InitialSettlement;
                    } else if num_buildings == 2 * n {
                        self.initial_phase = false;
                        self.prompt = Prompt::PlayTurn;
                    } else {
                        self.advance_turn(-1);
                        self.prompt = Prompt::InitialSettlement;
                    }
                } else if self.is_road_building && self.free_roads > 0 {
                    let (prev, rc) = self.board_build_road(p, edge);
                    self.build_road(p, edge, true);
                    self.maintain_longest_road(prev, rc);
                    self.free_roads -= 1;
                    if self.free_roads == 0 || self.road_building_possibilities(p, false).is_empty() {
                        self.is_road_building = false;
                        self.free_roads = 0;
                    }
                } else {
                    let (prev, rc) = self.board_build_road(p, edge);
                    self.build_road(p, edge, false);
                    self.maintain_longest_road(prev, rc);
                }
                Ok((-1, -1))
            }
            Action::BuildCity(node) => {
                self.is_city[node as usize] = true;
                let pl = &mut self.players[p];
                let pos = pl.settlements.iter().position(|&n| n == node).ok_or("no settlement there")?;
                pl.settlements.remove(pos);
                pl.cities.push(node);
                pl.settlements_available += 1;
                pl.cities_available -= 1;
                pl.vp += 1;
                pl.actual_vp += 1;
                pl.hand[WHEAT] -= 2;
                pl.hand[ORE] -= 3;
                for i in 0..5 {
                    self.bank[i] += CITY_COST[i];
                }
                Ok((-1, -1))
            }
            Action::BuyDev => {
                if self.dev_deck.is_empty() {
                    return Err("No more development cards".into());
                }
                if !self.can_afford_dev(p) {
                    return Err("No money to buy development card".into());
                }
                let card = match result {
                    Some((c, _)) => {
                        // last occurrence: identical to the live pop() when pinned to the true top card
                        let pos = self.dev_deck.iter().rposition(|&x| x as i32 == c).ok_or("card not in deck")?;
                        self.dev_deck.remove(pos);
                        c as usize
                    }
                    None => self.dev_deck.pop().unwrap() as usize,
                };
                let pl = &mut self.players[p];
                pl.devs[card] += 1;
                if card == VICTORY_POINT {
                    pl.actual_vp += 1;
                }
                pl.hand[SHEEP] -= 1;
                pl.hand[WHEAT] -= 1;
                pl.hand[ORE] -= 1;
                for i in 0..5 {
                    self.bank[i] += DEV_COST[i];
                }
                Ok((card as i32, -1))
            }
            Action::Roll => {
                self.players[p].has_rolled = true;
                let dice = match result {
                    Some(d) => d,
                    None => ((self.rand_below(6) + 1) as i32, (self.rand_below(6) + 1) as i32),
                };
                let number = dice.0 + dice.1;
                if number == 7 {
                    let mut first: Option<usize> = None;
                    for i in 0..self.n {
                        let num = self.num_resources(i);
                        let c = if num > self.discard_limit { num / 2 } else { 0 };
                        self.discard_counts[i] = c;
                        if c > 0 && first.is_none() {
                            first = Some(i);
                        }
                    }
                    if let Some(i) = first {
                        self.current_player = i;
                        self.prompt = Prompt::Discard;
                        self.is_discarding = true;
                    } else {
                        self.discard_counts = [0; 4];
                        self.prompt = Prompt::MoveRobber;
                        self.is_moving_knight = true;
                    }
                } else {
                    self.yield_resources(number);
                    self.prompt = Prompt::PlayTurn;
                }
                Ok(dice)
            }
            Action::Discard(r) => {
                let r = r as usize;
                if self.discard_counts[p] <= 0 {
                    return Err("Trying to discard when not required".into());
                }
                self.players[p].hand[r] -= 1;
                self.bank[r] += 1;
                self.discard_counts[p] -= 1;
                if self.discard_counts[p] <= 0 {
                    let next = (self.current_player + 1..self.n).find(|&i| self.discard_counts[i] > 0);
                    match next {
                        Some(i) => self.current_player = i,
                        None => {
                            self.current_player = self.current_turn;
                            self.prompt = Prompt::MoveRobber;
                            self.is_discarding = false;
                            self.is_moving_knight = true;
                            self.discard_counts = [0; 4];
                        }
                    }
                }
                Ok((r as i32, -1))
            }
            Action::MoveRobber { tile, victim } => {
                let mut robbed = -1i32;
                if victim >= 0 {
                    let v = victim as usize;
                    let r = match result {
                        Some((r, _)) => r,
                        None => {
                            let total = self.num_resources(v) as u64;
                            if total == 0 {
                                return Err("nothing to steal".into());
                            }
                            let mut k = self.rand_below(total) as i32;
                            let mut chosen = 0i32;
                            for i in 0..5 {
                                if k < self.players[v].hand[i] {
                                    chosen = i as i32;
                                    break;
                                }
                                k -= self.players[v].hand[i];
                            }
                            chosen
                        }
                    };
                    if r < 0 || self.players[v].hand[r as usize] < 1 {
                        return Err("victim lacks that resource".into());
                    }
                    self.players[v].hand[r as usize] -= 1;
                    self.players[p].hand[r as usize] += 1;
                    robbed = r;
                }
                self.robber = tile;
                self.prompt = Prompt::PlayTurn;
                Ok((robbed, -1))
            }
            Action::PlayKnight => {
                if !self.can_play_dev(p, KNIGHT) {
                    return Err("Player cant play knight card now".into());
                }
                self.play_dev_card(p, KNIGHT);
                self.prompt = Prompt::MoveRobber;
                Ok((-1, -1))
            }
            Action::PlayYop(a, b) => {
                if !self.can_play_dev(p, YEAR_OF_PLENTY) {
                    return Err("Player cant play year of plenty now".into());
                }
                let mut need = [0i32; 5];
                need[a as usize] += 1;
                if b >= 0 {
                    need[b as usize] += 1;
                }
                if !(0..5).all(|i| self.bank[i] >= need[i]) {
                    return Err("Not enough resources in bank".into());
                }
                for i in 0..5 {
                    self.players[p].hand[i] += need[i];
                    self.bank[i] -= need[i];
                }
                self.play_dev_card(p, YEAR_OF_PLENTY);
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::PlayMonopoly(r) => {
                if !self.can_play_dev(p, MONOPOLY) {
                    return Err("Player cant play monopoly now".into());
                }
                let r = r as usize;
                let mut stolen = 0;
                for i in 0..self.n {
                    if i != p {
                        stolen += self.players[i].hand[r];
                        self.players[i].hand[r] = 0;
                    }
                }
                self.players[p].hand[r] += stolen;
                self.play_dev_card(p, MONOPOLY);
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::PlayRoadBuilding => {
                if !self.can_play_dev(p, ROAD_BUILDING) {
                    return Err("Player cant play road building now".into());
                }
                self.play_dev_card(p, ROAD_BUILDING);
                self.is_road_building = true;
                self.free_roads = 2;
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::MaritimeTrade { give, rate, get } => {
                let (give, rate, get) = (give as usize, rate as i32, get as usize);
                if self.players[p].hand[give] < rate {
                    return Err("Trying to trade without money".into());
                }
                if self.bank[get] < 1 {
                    return Err("Bank doenst have those cards".into());
                }
                self.players[p].hand[give] -= rate;
                self.bank[give] += rate;
                self.players[p].hand[get] += 1;
                self.bank[get] -= 1;
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
        }
    }

    fn build_settlement(&mut self, p: usize, node: u8, is_free: bool) {
        let pl = &mut self.players[p];
        pl.settlements.push(node);
        pl.settlements_available -= 1;
        pl.vp += 1;
        pl.actual_vp += 1;
        if !is_free {
            pl.hand[WOOD] -= 1;
            pl.hand[BRICK] -= 1;
            pl.hand[SHEEP] -= 1;
            pl.hand[WHEAT] -= 1;
        }
    }

    fn build_road(&mut self, p: usize, edge: u8, is_free: bool) {
        let pl = &mut self.players[p];
        pl.roads.push(edge);
        pl.roads_available -= 1;
        if !is_free {
            pl.hand[WOOD] -= 1;
            pl.hand[BRICK] -= 1;
            for i in 0..5 {
                self.bank[i] += ROAD_COST[i];
            }
        }
    }

    fn maintain_longest_road(&mut self, previous_road_color: i8, road_color: i8) {
        for i in 0..self.n {
            self.players[i].longest_road_length = self.road_lengths[i];
        }
        if previous_road_color == road_color {
            return;
        }
        if road_color >= 0 {
            let w = &mut self.players[road_color as usize];
            w.has_road = true;
            w.vp += 2;
            w.actual_vp += 2;
        }
        if previous_road_color >= 0 {
            let l = &mut self.players[previous_road_color as usize];
            l.has_road = false;
            l.vp -= 2;
            l.actual_vp -= 2;
        }
    }

    fn largest_army(&self) -> (i8, i32) {
        for i in 0..self.n {
            if self.players[i].has_army {
                return (i as i8, self.players[i].played[KNIGHT]);
            }
        }
        (-1, 0)
    }

    fn play_dev_card(&mut self, p: usize, card: usize) {
        let (prev_color, prev_size) = if card == KNIGHT { self.largest_army() } else { (-1, 0) };
        let pl = &mut self.players[p];
        pl.devs[card] -= 1;
        pl.has_played_dev = true;
        pl.played[card] += 1;
        if card == KNIGHT {
            let size = self.players[p].played[KNIGHT];
            if size < 3 {
                return;
            }
            if prev_color < 0 {
                let w = &mut self.players[p];
                w.has_army = true;
                w.vp += 2;
                w.actual_vp += 2;
            } else if prev_size < size && prev_color as usize != p {
                let w = &mut self.players[p];
                w.has_army = true;
                w.vp += 2;
                w.actual_vp += 2;
                let l = &mut self.players[prev_color as usize];
                l.has_army = false;
                l.vp -= 2;
                l.actual_vp -= 2;
            }
        }
    }

    fn clean_turn(&mut self, p: usize) {
        let pl = &mut self.players[p];
        pl.has_played_dev = false;
        pl.has_rolled = false;
        for c in [KNIGHT, MONOPOLY, YEAR_OF_PLENTY, ROAD_BUILDING] {
            pl.owned_at_start[c] = pl.devs[c] > 0;
        }
    }

    fn advance_turn(&mut self, direction: i32) {
        let next = ((self.current_player as i32 + direction).rem_euclid(self.n as i32)) as usize;
        self.current_player = next;
        self.current_turn = next;
        self.num_turns += 1;
    }

    fn yield_resources(&mut self, number: i32) {
        // intended payout per player per resource; resource totals; depleted check
        let mut payout = [[0i32; 5]; 4];
        let mut totals = [0i32; 5];
        for (tid, tile) in self.map.tiles.iter().enumerate() {
            if tile.number as i32 != number || tid as u8 == self.robber {
                continue;
            }
            let r = tile.resource as usize;
            for &n in &tile.nodes {
                let o = self.owner[n as usize];
                if o < 0 {
                    continue;
                }
                let amt = if self.is_city[n as usize] { 2 } else { 1 };
                payout[o as usize][r] += amt;
                totals[r] += amt;
            }
        }
        // Official rule: a resource the bank cannot fully pay is withheld from everyone,
        // unless only one player would receive it, who takes what is left.
        for r in 0..5 {
            if self.bank[r] < totals[r] {
                let recipients: Vec<usize> = (0..self.n).filter(|&p| payout[p][r] > 0).collect();
                if recipients.len() == 1 && self.bank[r] > 0 {
                    let p = recipients[0];
                    payout[p][r] = payout[p][r].min(self.bank[r]);
                } else {
                    for p in 0..4 {
                        payout[p][r] = 0;
                    }
                }
            }
        }
        for p in 0..self.n {
            for r in 0..5 {
                self.players[p].hand[r] += payout[p][r];
                self.bank[r] -= payout[p][r];
            }
        }
    }
}
