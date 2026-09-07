//! The jSettler on this engine: SOCRobotBrain's turn flow over the ported opening strategy,
//! trackers and decision maker, plus RobberStrategy, DiscardStrategy and MonopolyStrategy. One
//! `decide` call is one iteration of the brain's PLAY1 loop; the plan and the per-turn flags live
//! across calls. Offers and replies come from the negotiator; a counter-offer the Java would make
//! in reply becomes a rejection, which this engine's trade round cannot express.

use super::bse::{Bse, PlayerNumbers, Ports, Res, CARD as B_CARD, ROAD as B_ROAD};
use super::dm::{Dm, Params, Piece, PlanInput};
use super::negotiator::{Negotiator, Offer, Set, ACCEPT_OFFER};
use super::geom::NONE;
use super::opening::{Opening, Turn, START1A, START1B};
use super::player::{CITY, ROAD, SETTLEMENT};
use super::tracker::{GameInfo, Trackers};
use crate::actions::Action;
use crate::map::Map;
use crate::state::{Prompt, State, KNIGHT, MONOPOLY, ROAD_BUILDING, YEAR_OF_PLENTY};
use std::sync::Arc;

pub const MAX_DENIED_BUILDING_PER_TURN: i32 = 3;
const START2B: i32 = 11;

/// JSettlers resource order CLAY, ORE, SHEEP, WHEAT, WOOD as engine ids.
const JS_ORDER: [usize; 5] = super::bse::JS_ORDER;

pub struct Jsettler {
    pub pn: usize,
    pub tr: Trackers,
    pub dm: Dm,
    pub opening: Opening,
    pub negotiator: Negotiator,
    /// SOCRobotParameters.tradeFlag: whether offers are made at all.
    pub trade: bool,
    seen: usize,
    last_turn: i32,
    failed_attempts: i32,
    free_road: Option<i32>,
    pending_discards: Vec<u8>,
    done_trading: bool,
    pending_offer: Option<Offer>,
    pub offers_made: u32,
    rng: u64,
}

/// The client's view of the game for the trackers' ETAs: our own dev cards known, the others' not.
pub fn game_info(s: &State, pn: usize) -> GameInfo {
    let n = s.n;
    let mut old = vec![0; n];
    let mut new = vec![0; n];
    let me = &s.players[pn];
    if me.owned_at_start[KNIGHT] {
        old[pn] = me.devs[KNIGHT];
    } else {
        new[pn] = me.devs[KNIGHT];
    }
    GameInfo {
        lr_player: if s.road_color < 0 { None } else { Some(s.road_color as usize) },
        la_player: s.players.iter().position(|p| p.has_army),
        knights: s.players.iter().map(|p| p.played[KNIGHT]).collect(),
        knight_cards_old: old,
        knight_cards_new: new,
        dev_cards_left: s.dev_deck.len() as i32,
        total_vp: s.players.iter().enumerate().map(|(q, p)| if q == pn { p.actual_vp } else { p.vp }).collect(),
        vp_winner: s.vps_to_win,
    }
}

impl Jsettler {
    pub fn new(map: Arc<Map>, n: usize, pn: usize, params: Params, seed: u64, node_js: [u16; crate::map::NUM_NODES]) -> Jsettler {
        Jsettler { pn, tr: Trackers::new(map, n, node_js), dm: Dm::new(params, pn), opening: Opening::default(), negotiator: Negotiator::new(pn, n, params), trade: true, seen: 0, last_turn: -1, failed_attempts: 0, free_road: None, pending_discards: vec![], done_trading: false, pending_offer: None, offers_made: 0, rng: seed ^ 0x5E77_1E25_0000_0001 }
    }

    fn next_rand(&mut self) -> u64 {
        self.rng = self.rng.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// A piece the trackers have not seen (kind as player.rs, engine node or edge id).
    pub fn observe(&mut self, kind: u8, pn: usize, engine_coord: u8, initial: bool) {
        let js = if kind == ROAD { self.tr.geom.edge_js[engine_coord as usize] } else { self.tr.geom.node_js[engine_coord as usize] } as i32;
        self.tr.on_piece(kind, pn, js, initial);
    }

    /// Feed the state's piece log from where we left off.
    fn catch_up(&mut self, s: &State) {
        while self.seen < s.pieces.len() {
            let (kind, pn, coord, initial) = s.pieces[self.seen];
            self.observe(kind, pn as usize, coord, initial);
            self.seen += 1;
        }
        if !s.initial_phase {
            self.tr.first_turn();
        }
    }

    fn plan_input<'a>(&self, s: &State, info: &'a GameInfo) -> PlanInput<'a> {
        let p = self.pn;
        PlanInput { info, resources: s.players[p].hand, has_played_dev_card: s.players[p].has_played_dev, roads_card_playable: s.can_play_dev(p, ROAD_BUILDING), for_special_building: s.current_player != p }
    }

    fn engine_node(&self, js: i32) -> Option<u8> {
        self.tr.geom.node(js)
    }

    fn engine_edge(&self, js: i32) -> Option<u8> {
        self.tr.geom.edge(js)
    }

    /// The brain's decision for the current prompt; None when nothing applies (the caller takes the
    /// first legal action).
    pub fn decide(&mut self, s: &State) -> Option<Action> {
        self.catch_up(s);
        let p = self.pn;
        if s.current_player != p {
            return None;
        }
        let acts = s.playable_actions();
        if acts.is_empty() {
            return None;
        }
        if s.num_turns != self.last_turn {
            // resetFieldsAtStartTurn / resetFieldsAtEndTurn
            self.last_turn = s.num_turns;
            self.dm.plan.clear();
            self.failed_attempts = 0;
            self.free_road = None;
            self.pending_discards.clear();
            self.done_trading = !self.trade;
            self.pending_offer = None;
            self.negotiator.reset_is_selling(s);
            self.negotiator.reset_offers_made();
            self.negotiator.reset_target_pieces();
        }
        match s.prompt {
            Prompt::InitialSettlement => {
                let js = if s.players[p].settlements.is_empty() { self.opening.plan_initial_settlements(&self.tr, p) } else { self.opening.plan_second_settlement(&self.tr, p) };
                let a = self.engine_node(js).map(Action::BuildSettlement)?;
                acts.contains(&a).then_some(a)
            }
            Prompt::InitialRoad => {
                let turn = Turn { game_state: if s.players[p].settlements.len() == 1 { START1B } else { START2B }, current: p, first_player: 0 };
                let js = self.opening.plan_init_road(&self.tr, p, &turn);
                let a = self.engine_edge(js).map(Action::BuildRoad)?;
                acts.contains(&a).then_some(a)
            }
            Prompt::Discard => {
                if self.pending_discards.is_empty() {
                    self.pending_discards = self.discards(s, s.discard_counts[p]);
                }
                let r = self.pending_discards.pop()?;
                let a = Action::Discard(r);
                acts.contains(&a).then_some(a)
            }
            Prompt::MoveRobber => self.move_robber(s, &acts),
            Prompt::DecideTrade => Some(self.consider_offer(s)),
            Prompt::DecideAcceptees => Some(self.confirm_offer(s)),
            Prompt::PlayTurn => self.play_turn(s, &acts),
        }
    }

    fn play_turn(&mut self, s: &State, acts: &[Action]) -> Option<Action> {
        let p = self.pn;
        let me = &s.players[p];
        if s.is_road_building {
            // PLACING_FREE_ROAD1 then FREE_ROAD2: the road the card was played for, then the plan's next
            let next = match self.free_road.take() {
                Some(c) => Some(c),
                None => match self.dm.plan.last().copied() {
                    Some(Piece::Road(c)) => {
                        self.dm.plan.pop();
                        Some(c)
                    }
                    _ => None,
                },
            };
            if let Some(c) = next {
                if let Some(a) = self.engine_edge(c).map(Action::BuildRoad) {
                    if acts.contains(&a) {
                        return Some(a);
                    }
                }
            }
            return acts.iter().copied().find(|a| matches!(a, Action::BuildRoad(_)));
        }
        if !me.has_rolled {
            // rollOrPlayKnightOrExpectDice: a knight first when the robber sits on one of our hexes
            if s.can_play_dev(p, KNIGHT) && !self.has_no_resources_for_hex(s, p, s.robber) && acts.contains(&Action::PlayKnight) {
                return Some(Action::PlayKnight);
            }
            return Some(Action::Roll);
        }
        // planAndDoActionForPLAY1
        if !me.has_played_dev && s.can_play_dev(p, KNIGHT) && self.should_play_knight_for_la(s) && acts.contains(&Action::PlayKnight) {
            return Some(Action::PlayKnight);
        }
        for _ in 0..(MAX_DENIED_BUILDING_PER_TURN + 1) {
            if self.dm.plan.is_empty() && s.num_resources(p) > 1 && self.failed_attempts < MAX_DENIED_BUILDING_PER_TURN {
                let info = game_info(s, p);
                let inp = self.plan_input(s, &info);
                self.dm.plan_stuff(&mut self.tr, &inp);
            }
            if self.dm.plan.is_empty() {
                break;
            }
            match self.build_or_get_resource(s, acts) {
                Ok(a) => return Some(a),
                Err(false) => break,  // nothing more to do this turn
                Err(true) => continue, // a plan the engine refuses: replan
            }
        }
        Some(Action::EndTurn)
    }

    /// buildOrGetResourceByTradeOrCard: Ok(action) to send now, Err(true) when the planned piece is
    /// not buildable here (the Java's cancelWrongPiecePlacement), Err(false) when the turn should end.
    fn build_or_get_resource(&mut self, s: &State, acts: &[Action]) -> Result<Action, bool> {
        let p = self.pn;
        let me = &s.players[p];
        let n = self.dm.plan.len();
        if !me.has_played_dev && me.roads_available >= 2 && s.can_play_dev(p, ROAD_BUILDING) && n > 1 {
            if let (Some(Piece::Road(top)), Some(Piece::Road(_))) = (self.dm.plan.get(n - 1), self.dm.plan.get(n - 2)) {
                if acts.contains(&Action::PlayRoadBuilding) {
                    let top = *top;
                    self.dm.plan.pop();
                    self.free_road = Some(top);
                    return Ok(Action::PlayRoadBuilding);
                }
            }
        }
        let target = *self.dm.plan.last().unwrap();
        let cost = target.cost();
        if !me.has_played_dev && s.can_play_dev(p, YEAR_OF_PLENTY) {
            if let Some(picks) = self.choose_free_resources_if_needed(s, &cost, 2) {
                let (a, b) = (picks[0].min(picks[1]), picks[0].max(picks[1]));
                let act = Action::PlayYop(a, b as i8);
                if acts.contains(&act) {
                    return Ok(act);
                }
            }
        }
        if !me.has_played_dev && s.can_play_dev(p, MONOPOLY) {
            if let Some(r) = self.decide_play_monopoly(s) {
                let act = Action::PlayMonopoly(r as u8);
                if acts.contains(&act) {
                    return Ok(act);
                }
            }
        }
        self.negotiator.target_pieces[p] = Some(target);
        if !self.done_trading && !s.hand_contains(p, &cost) {
            let info = game_info(s, p);
            let offer = self.negotiator.make_offer(&mut self.tr, s, &info, target, None);
            self.negotiator.reset_wants_another_offer();
            match offer {
                Some(o) => {
                    let (give, get) = (o.give.to_engine(), o.get.to_engine());
                    let act = Action::OfferTrade { give: give.map(|x| x as u8), get: get.map(|x| x as u8) };
                    if acts.contains(&act) {
                        self.pending_offer = Some(o);
                        self.offers_made += 1;
                        return Ok(act);
                    }
                    self.done_trading = true;
                }
                None => self.done_trading = true,
            }
        }
        if !s.hand_contains(p, &cost) {
            if let Some(act) = self.offer_to_bank(s, &cost) {
                if acts.contains(&act) {
                    return Ok(act);
                }
            }
            return Err(false);
        }
        // buildRequestPlannedPiece
        let act = match target {
            Piece::Card => Some(Action::BuyDev),
            Piece::Road(c) => self.engine_edge(c).map(Action::BuildRoad),
            Piece::Settlement(c) => self.engine_node(c).map(Action::BuildSettlement),
            Piece::City(c) => self.engine_node(c).map(Action::BuildCity),
        };
        self.dm.plan.pop();
        match act {
            Some(a) if acts.contains(&a) => Ok(a),
            _ => {
                self.failed_attempts += 1;
                self.dm.plan.clear();
                Err(true)
            }
        }
    }

    // ---------------------------------------------------------------- dev cards

    /// SOCRobotDM.shouldPlayKnightForLA.
    fn should_play_knight_for_la(&self, s: &State) -> bool {
        let p = self.pn;
        let la = s.players.iter().position(|q| q.has_army);
        if la == Some(p) {
            return false;
        }
        let size = match la {
            None => 3,
            Some(q) => s.players[q].played[KNIGHT] + 1,
        };
        s.players[p].played[KNIGHT] + s.players[p].devs[KNIGHT] >= size
    }

    /// chooseFreeResourcesIfNeeded(target, numChoose, false): the card is worth playing only when
    /// exactly `num` resources are missing; then chooseFreeResources picks the slowest ones.
    fn choose_free_resources_if_needed(&self, s: &State, target: &Res, num: i32) -> Option<[u8; 2]> {
        let p = self.pn;
        let hand = s.players[p].hand;
        let needed: i32 = (0..5).map(|r| (target[r] - hand[r]).max(0)).sum();
        if needed != num {
            return None;
        }
        let bse = Bse::new(&self.tr.numbers(p), None);
        let mut copy = hand;
        let mut picks = [0u8; 2];
        for pick in picks.iter_mut() {
            let mut most: Option<usize> = None;
            for &r in &JS_ORDER {
                if copy[r] < target[r] && most.map_or(true, |m| bse.rolls_per_resource[r] > bse.rolls_per_resource[m]) {
                    most = Some(r);
                }
            }
            let m = most?;
            *pick = m as u8;
            copy[m] += 1;
        }
        Some(picks)
    }

    /// MonopolyStrategy.decidePlayMonopoly.
    fn decide_play_monopoly(&self, s: &State) -> Option<usize> {
        let p = self.pn;
        let ports = self.tr.port_flags(p);
        let mut best_count = 0;
        let mut best = None;
        for &r in &JS_ORDER {
            let total: i32 = s.players.iter().enumerate().filter(|&(q, _)| q != p).map(|(_, pl)| pl.hand[r]).sum();
            let free = total / ports.ratio(r);
            if free > best_count {
                best_count = free;
                best = Some(r);
            }
        }
        if best_count > 2 { best } else { None }
    }

    // ---------------------------------------------------------------- bank

    /// SOCRobotNegotiator.getOfferToBank as an engine maritime trade.
    pub fn offer_to_bank(&self, s: &State, target: &Res) -> Option<Action> {
        let (give, rate, get) = self.negotiator.offer_to_bank(&self.tr, &Set::from_engine(target), &Set::from_engine(&s.players[self.pn].hand))?;
        Some(Action::MaritimeTrade { give: give as u8, rate: rate as u8, get: get as u8 })
    }

    /// The engine's current offer as the negotiator sees it (offered to everyone).
    fn current_offer(s: &State) -> Offer {
        let mut give = [0; 5];
        let mut get = [0; 5];
        for r in 0..5 {
            give[r] = s.current_trade[r];
            get[r] = s.current_trade[5 + r];
        }
        Offer { from: s.current_trade[10] as usize, to: (0..s.n).map(|q| q != s.current_trade[10] as usize).collect(), give: Set::from_engine(&give), get: Set::from_engine(&get) }
    }

    /// SOCRobotBrain.considerOffer for an opponent's offer: accept, else reject (a counter-offer the
    /// Java would send cannot be made here).
    fn consider_offer(&mut self, s: &State) -> Action {
        let p = self.pn;
        let offer = Jsettler::current_offer(s);
        self.negotiator.record_resources_from_offer(&offer);
        let info = game_info(s, p);
        let response = self.negotiator.consider_offer2(&mut self.tr, s, &info, &offer, p);
        if response == ACCEPT_OFFER && s.can_accept_offer(p) {
            self.negotiator.target_pieces[p] = None;
            Action::AcceptTrade
        } else {
            Action::RejectTrade
        }
    }

    /// Our offer answered: the first acceptor among those it was for, else everyone rejected it.
    fn confirm_offer(&mut self, s: &State) -> Action {
        let Some(offer) = self.pending_offer.take() else { return Action::CancelTrade };
        let mut partner = None;
        for q in 0..s.n {
            if !offer.to[q] {
                continue;
            }
            if s.acceptees[q] {
                if partner.is_none() {
                    partner = Some(q);
                }
            } else {
                self.negotiator.record_resources_from_reject(q, &offer);
            }
        }
        match partner {
            Some(q) => Action::ConfirmTrade { partner: q as u8 },
            None => {
                self.negotiator.add_to_offers_made(offer.give, offer.get);
                Action::CancelTrade
            }
        }
    }

    // ---------------------------------------------------------------- robber

    fn has_no_resources_for_hex(&self, _s: &State, p: usize, tile: u8) -> bool {
        !self.tr.numbers(p).pairs.iter().any(|&(_, _, t)| t == tile)
    }

    /// RobberStrategy: the victim with the lowest win ETA, the hex that slows them most.
    fn move_robber(&mut self, s: &State, acts: &[Action]) -> Option<Action> {
        let p = self.pn;
        let info = game_info(s, p);
        for t in 0..self.tr.trackers.len() {
            self.tr.recalc_win_game_eta(t, &info);
        }
        let etas: Vec<i32> = self.tr.trackers.iter().map(|t| t.win_game_eta).collect();
        let mut victim: Option<usize> = None;
        for q in 0..s.n {
            if q == p {
                continue;
            }
            match victim {
                None => victim = Some(q),
                Some(v) if etas[q] < etas[v] => victim = Some(q),
                _ => {}
            }
        }
        let victim = victim?;
        let prev = s.robber;
        // land hexes in JSettlers coordinate order
        let mut tiles: Vec<(i32, u8)> = (0..s.map.tiles.len()).map(|t| (self.tr.geom.node_js[s.map.tiles[t].nodes[0] as usize] as i32 - 0x01, t as u8)).collect();
        tiles.sort();
        let victim_numbers = self.tr.numbers(victim);
        let victim_ports = self.tr.port_flags(victim);
        let mut best = prev;
        let mut worst_speed = 0;
        for &(_, tile) in &tiles {
            if tile != prev && self.has_no_resources_for_hex(s, p, tile) {
                let speeds = Bse::new(&victim_numbers, Some(tile)).from_nothing_fast(&victim_ports, 40);
                let total: i32 = speeds.iter().sum();
                if total > worst_speed {
                    best = tile;
                    worst_speed = total;
                }
            }
        }
        if best == prev {
            let mut n = 0;
            while best == prev || (n < 30 && !self.has_no_resources_for_hex(s, p, best)) {
                best = tiles[(self.next_rand() % tiles.len() as u64) as usize].1;
                n += 1;
            }
        }
        // chooseRobberVictim among the players the engine offers on that hex
        let candidates: Vec<i8> = acts.iter().filter_map(|a| match a {
            Action::MoveRobber { tile, victim } if *tile == best => Some(*victim),
            _ => None,
        }).collect();
        if candidates.is_empty() {
            return acts.first().copied();
        }
        let mut choice = candidates[0];
        for &c in &candidates[1..] {
            if c >= 0 && (choice < 0 || etas[c as usize] < etas[choice as usize]) {
                choice = c;
            }
        }
        Some(Action::MoveRobber { tile: best, victim: choice })
    }

    // ---------------------------------------------------------------- discards

    /// DiscardStrategy.discard: keep what the plan needs, shed the rest slowest-to-get first.
    fn discards(&mut self, s: &State, num: i32) -> Vec<u8> {
        let p = self.pn;
        let hand = s.players[p].hand;
        if self.dm.plan.is_empty() {
            let info = game_info(s, p);
            let inp = self.plan_input(s, &info);
            self.dm.plan_stuff(&mut self.tr, &inp);
        }
        let mut out = vec![];
        if let Some(target) = self.dm.plan.last() {
            let cost = target.cost();
            let mut left = [0; 5];
            for r in 0..5 {
                left[r] = if hand[r] > cost[r] { hand[r] - cost[r] } else { 0 };
            }
            let mut needed = [0; 5];
            for r in 0..5 {
                needed[r] = hand[r] - left[r];
            }
            let order = rolls_sorted(&Bse::new(&self.tr.numbers(p), None).rolls_per_resource);
            while (out.len() as i32) < num {
                let before = out.len();
                let mut cur = 0;
                while (out.len() as i32) < num && cur < 5 {
                    if left[order[cur]] > 0 {
                        out.push(order[cur] as u8);
                        left[order[cur]] -= 1;
                    } else {
                        cur += 1;
                    }
                }
                cur = 0;
                while (out.len() as i32) < num && cur < 5 {
                    if needed[order[cur]] > 0 {
                        out.push(order[cur] as u8);
                        needed[order[cur]] -= 1;
                    } else {
                        cur += 1;
                    }
                }
                if out.len() == before {
                    break;
                }
            }
        } else {
            // SOCGame.discardOrGainPickRandom
            let mut temp: Vec<u8> = vec![];
            for &r in &JS_ORDER {
                for _ in 0..hand[r] {
                    temp.push(r as u8);
                }
            }
            for _ in 0..num {
                if temp.is_empty() {
                    break;
                }
                let i = (self.next_rand() % temp.len() as u64) as usize;
                out.push(temp.remove(i));
            }
        }
        out.reverse(); // popped from the back, one card per prompt
        out
    }
}

/// SOCBuildingSpeedEstimate.getRollsForResourcesSorted: resources by rolls descending.
pub fn rolls_sorted(rolls: &Res) -> [usize; 5] {
    let mut order = JS_ORDER;
    for j in (0..5).rev() {
        for i in 0..j {
            if rolls[order[i]] < rolls[order[i + 1]] {
                order.swap(i, i + 1);
            }
        }
    }
    order
}

#[allow(dead_code)]
fn _unused(_: PlayerNumbers, _: Ports, _: i32, _: usize) -> i32 {
    NONE + B_CARD as i32 + B_ROAD as i32 + START1A + SETTLEMENT as i32 + CITY as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;

    /// Four jSettlers play a whole game on the engine: every decision legal, the game ends.
    #[test]
    fn jsettlers_play_a_game() {
        let layout: Layout = serde_json::from_str(include_str!("../base_layout.json")).unwrap();
        let map = Arc::new(Map::generate(11, &layout));
        let mut s = State::new(map.clone(), 4, 11, 10);
        let mut bots: Vec<Jsettler> = (0..4).map(|pn| Jsettler::new(map.clone(), 4, pn, if pn % 2 == 0 { Params::SMART } else { Params::FAST }, 11, super::super::geom::NODE_JS_ROT0)).collect();
        let mut steps = 0;
        while s.winner() < 0 && steps < 4000 {
            let p = s.current_player;
            let acts = s.playable_actions();
            let a = bots[p].decide(&s).unwrap_or(acts[0]);
            assert!(acts.contains(&a), "step {steps}: {a:?} not legal, prompt {:?}", s.prompt);
            s.apply(a, None).unwrap();
            steps += 1;
        }
        assert!(s.winner() >= 0, "no winner after {steps} steps, turn {}", s.num_turns);
        assert!(s.pieces.len() >= 16);
        let offers: u32 = bots.iter().map(|b| b.offers_made).sum();
        assert!(offers > 0, "no jSettler ever offered a trade");
    }
}
