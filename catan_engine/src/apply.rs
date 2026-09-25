//! catanatron.apply_action semantics. `result` pins the stochastic outcome
//! (dice, drawn card, stolen resource); None draws from the state's RNG.

use crate::actions::{offer_key, valid_offer, Action};
use crate::state::*;

/// Realized outcome of a stochastic action: (a, b) with -1 = none.
pub type Outcome = (i32, i32);

impl State {
    pub fn apply(&mut self, action: Action, result: Option<Outcome>) -> Result<Outcome, String> {
        let p = self.current_player;
        match action {
            Action::EndTurn => {
                self.clean_turn(p);
                self.spent_offers.clear();
                self.advance_turn(1);
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::OfferTrade { give, get } => {
                let countering = self.prompt == Prompt::DecideTrade && p != self.current_turn && !self.acceptees.iter().any(|&a| a);
                if !countering && (self.prompt != Prompt::PlayTurn || !self.players[p].has_rolled || self.is_road_building || self.is_resolving_trade) {
                    return Err("offers are made on your own turn after rolling, or as a counter before anyone accepted".into());
                }
                if !valid_offer(&give, &get) {
                    return Err("an offer must give and receive cards and not the same resource on both sides".into());
                }
                if (0..5).any(|r| self.players[p].hand[r] < give[r] as i32) {
                    return Err("you do not hold what you offer".into());
                }
                if self.spent_offers.contains(&offer_key(&give, &get)) {
                    return Err("that offer was already rejected or cancelled this turn".into());
                }
                if countering {
                    self.spend_current_offer(); // the offer it answers is off the table for the turn
                }
                self.is_resolving_trade = true;
                for r in 0..5 {
                    self.current_trade[r] = give[r] as i32;
                    self.current_trade[5 + r] = get[r] as i32;
                }
                self.current_trade[10] = p as i32;
                self.acceptees = [false; 4];
                if countering {
                    self.note(Event::Reply { seat: p as u8, accept: false }); // JSettlers: a counter rejects the offer it answers
                }
                self.note(Event::Offer { from: p as u8, to: if countering { self.current_turn as i8 } else { -1 }, give, get });
                // a counter goes to the turn player alone; an offer goes round the table
                self.current_player = if countering { self.current_turn } else { (0..self.n).find(|&i| i != self.current_turn).expect("another player") };
                self.prompt = Prompt::DecideTrade;
                Ok((-1, -1))
            }
            Action::AcceptTrade | Action::RejectTrade => {
                if self.prompt != Prompt::DecideTrade {
                    return Err("no offer to answer".into());
                }
                self.note(Event::Reply { seat: p as u8, accept: action == Action::AcceptTrade });
                if p == self.current_turn {
                    // the turn player answers a counter-offer: accepting executes it (JSettlers: an
                    // accepted offer trades at once), rejecting spends it
                    let q = self.current_trade[10] as usize;
                    if action == Action::AcceptTrade {
                        if !self.can_accept_offer(p) {
                            return Err("you do not hold what is asked".into());
                        }
                        for r in 0..5 {
                            let give = self.current_trade[r];
                            let get = self.current_trade[5 + r];
                            self.players[q].hand[r] += get - give;
                            self.players[p].hand[r] += give - get;
                        }
                        self.note_trade(q, p);
                    } else {
                        self.spend_current_offer();
                    }
                    self.reset_trade();
                    self.prompt = Prompt::PlayTurn;
                    return Ok((-1, -1));
                }
                if action == Action::AcceptTrade {
                    if !self.can_accept_offer(p) {
                        return Err("you do not hold what is asked".into());
                    }
                    self.acceptees[p] = true;
                }
                // keep going around the table without asking the offerer or players who answered
                match (p + 1..self.n).find(|&i| i != self.current_turn) {
                    Some(next) => self.current_player = next,
                    None => {
                        self.current_player = self.current_turn;
                        if self.acceptees.iter().any(|&a| a) {
                            self.prompt = Prompt::DecideAcceptees;
                        } else {
                            self.spend_current_offer();
                            self.reset_trade();
                            self.prompt = Prompt::PlayTurn;
                        }
                    }
                }
                Ok((-1, -1))
            }
            Action::ConfirmTrade { partner } => {
                let q = partner as usize;
                if self.prompt != Prompt::DecideAcceptees || q >= self.n || !self.acceptees[q] {
                    return Err("that player did not accept".into());
                }
                for r in 0..5 {
                    let give = self.current_trade[r];
                    let get = self.current_trade[5 + r];
                    self.players[p].hand[r] += get - give;
                    self.players[q].hand[r] += give - get;
                }
                self.note_trade(p, q);
                self.reset_trade();
                self.current_player = self.current_turn;
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::CancelTrade => {
                if self.prompt != Prompt::DecideAcceptees {
                    return Err("nothing to cancel".into());
                }
                self.spend_current_offer();
                self.reset_trade();
                self.current_player = self.current_turn;
                self.prompt = Prompt::PlayTurn;
                Ok((-1, -1))
            }
            Action::BuildSettlement(node) => {
                if !self.light { self.pieces.push((1, p as u8, node, self.initial_phase)); }
                if self.initial_phase {
                    self.board_build_settlement(p, node, true);
                    self.build_settlement(p, node, true);
                    if self.players[p].settlements.len() == 2 {
                        let mut got = [0i32; 5];
                        for &tid in &self.map.node_tiles[node as usize].clone() {
                            let r = self.map.tiles[tid as usize].resource;
                            if r >= 0 {
                                self.bank[r as usize] -= 1;
                                self.players[p].hand[r as usize] += 1;
                                got[r as usize] += 1;
                            }
                        }
                        if got.iter().any(|&x| x > 0) {
                            self.note(Event::Gain { seat: p as u8, res: Self::delta(&got) });
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
                if !self.light { self.pieces.push((0, p as u8, edge, self.initial_phase)); }
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
                if !self.light { self.pieces.push((2, p as u8, node, false)); }
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
                self.note(Event::Lose { seat: p as u8, res: Self::delta(&CITY_COST) });
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
                self.note(Event::Lose { seat: p as u8, res: Self::delta(&DEV_COST) });
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
                self.note(Event::Discard { seat: p as u8 });
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
                    self.note(Event::Steal { thief: p as u8, victim: v as u8, res: r as u8 });
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
                self.note(Event::Gain { seat: p as u8, res: Self::delta(&need) });
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
                    if i != p && self.players[i].hand[r] > 0 {
                        let mut res = [0i8; 5];
                        res[r] = self.players[i].hand[r] as i8;
                        stolen += self.players[i].hand[r];
                        self.players[i].hand[r] = 0;
                        self.note(Event::Lose { seat: i as u8, res });
                    }
                }
                self.players[p].hand[r] += stolen;
                if stolen > 0 {
                    let mut res = [0i8; 5];
                    res[r] = stolen as i8;
                    self.note(Event::Gain { seat: p as u8, res });
                }
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
                let mut lose = [0i8; 5];
                lose[give] = rate as i8;
                let mut gain = [0i8; 5];
                gain[get] = 1;
                self.note(Event::Lose { seat: p as u8, res: lose });
                self.note(Event::Gain { seat: p as u8, res: gain });
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
            self.note(Event::Lose { seat: p as u8, res: Self::delta(&SETTLEMENT_COST) });
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
            self.note(Event::Lose { seat: p as u8, res: Self::delta(&ROAD_COST) });
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

    fn spend_current_offer(&mut self) {
        let mut k = [0u8; 10];
        for i in 0..10 {
            k[i] = self.current_trade[i] as u8;
        }
        self.spent_offers.push(k);
    }

    fn reset_trade(&mut self) {
        self.is_resolving_trade = false;
        self.current_trade = [0; 11];
        self.acceptees = [false; 4];
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
            if payout[p].iter().any(|&x| x > 0) {
                self.note(Event::Gain { seat: p as u8, res: Self::delta(&payout[p]) });
            }
        }
    }

    fn note(&mut self, e: Event) {
        if !self.light {
            self.events.push(e);
        }
    }

    fn delta(res: &[i32; 5]) -> [i8; 5] {
        [res[0] as i8, res[1] as i8, res[2] as i8, res[3] as i8, res[4] as i8]
    }

    /// A completed player trade: `from` gave current_trade's give and received its get, `to` the reverse.
    fn note_trade(&mut self, from: usize, to: usize) {
        let ct = self.current_trade;
        let give = [ct[0], ct[1], ct[2], ct[3], ct[4]];
        let get = [ct[5], ct[6], ct[7], ct[8], ct[9]];
        self.note(Event::Lose { seat: from as u8, res: Self::delta(&give) });
        self.note(Event::Gain { seat: from as u8, res: Self::delta(&get) });
        self.note(Event::Lose { seat: to as u8, res: Self::delta(&get) });
        self.note(Event::Gain { seat: to as u8, res: Self::delta(&give) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;
    use crate::map::Map;
    use crate::trade::Eval;
    use std::sync::Arc;

    /// Every card that moves is logged: replaying the public events plus the hidden totals lands on
    /// the true hand totals for every seat, at every step of a played game.
    #[test]
    fn events_account_for_every_card() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let map = Arc::new(Map::generate(5, &layout));
        let mut s = State::new(map, 4, 5, 10);
        let mut seen = 0;
        let mut totals = [0i32; 4];
        let mut steps = 0;
        let mut kinds = [0u32; 6];
        while s.winner() < 0 && steps < 3000 {
            let a = s.trade_action(&Eval::Heuristic).or_else(|| s.decide_heuristic(1)).unwrap_or(s.playable_actions()[0]);
            s.apply(a, None).unwrap();
            for e in &s.events[seen..] {
                match *e {
                    Event::Gain { seat, res } => { totals[seat as usize] += res.iter().map(|&x| x as i32).sum::<i32>(); kinds[0] += 1 }
                    Event::Lose { seat, res } => { totals[seat as usize] -= res.iter().map(|&x| x as i32).sum::<i32>(); kinds[1] += 1 }
                    Event::Discard { seat } => { totals[seat as usize] -= 1; kinds[2] += 1 }
                    Event::Steal { thief, victim, .. } => { totals[thief as usize] += 1; totals[victim as usize] -= 1; kinds[3] += 1 }
                    Event::Offer { .. } => kinds[4] += 1,
                    Event::Reply { .. } => kinds[5] += 1,
                }
            }
            seen = s.events.len();
            for p in 0..4 {
                assert_eq!(totals[p], s.num_resources(p), "step {steps} seat {p}: events {:?} vs hand {:?}", totals, s.players[p].hand);
            }
            steps += 1;
        }
        assert!(kinds.iter().all(|&k| k > 0), "every event kind occurred: {kinds:?}");
    }
}
