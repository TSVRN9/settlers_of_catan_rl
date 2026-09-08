//! soc.robot.SOCRobotNegotiator: offers, replies and bank trades. Resource loops run in JSettlers'
//! ids 1..5 (CLAY, ORE, SHEEP, WHEAT, WOOD) because two of the Java's loops index the wrong array
//! and their behaviour depends on that numbering; the engine's ids appear only at the boundary.

use super::bse::{Bse, Ports, Res};
use super::dm::{Dm, Params, Piece, PlanInput};
use super::player::{ROAD, SETTLEMENT};
use super::tracker::{GameInfo, Trackers};
use super::view::Views;
use crate::state::{State, ROAD_BUILDING};

pub const WIN_GAME_CUTOFF: i32 = 25;
pub const REJECT_OFFER: i32 = 0;
pub const ACCEPT_OFFER: i32 = 1;
pub const COUNTER_OFFER: i32 = 2;

/// JSettlers resource id (1..5) -> engine id.
const ENGINE_OF_JS: [usize; 6] = [0, 1, 4, 2, 3, 0];

pub(crate) fn js(r: usize) -> usize {
    ENGINE_OF_JS[r]
}

/// SOCResourceSet over JSettlers ids 1..5 (index 0 unused), subtraction clamped at zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Set(pub [i32; 6]);

impl Set {
    pub fn from_engine(r: &Res) -> Set {
        let mut s = Set::default();
        for t in 1..=5 {
            s.0[t] = r[js(t)];
        }
        s
    }

    pub fn to_engine(&self) -> Res {
        let mut r = [0; 5];
        for t in 1..=5 {
            r[js(t)] = self.0[t];
        }
        r
    }

    pub fn total(&self) -> i32 {
        self.0[1..].iter().sum()
    }

    pub fn has(&self, t: usize) -> bool {
        self.0[t] > 0
    }

    pub fn contains(&self, o: &Set) -> bool {
        (1..=5).all(|t| self.0[t] >= o.0[t])
    }

    pub fn add(&mut self, n: i32, t: usize) {
        self.0[t] += n;
    }

    pub fn sub(&mut self, n: i32, t: usize) {
        self.0[t] = (self.0[t] - n).max(0);
    }

    pub fn minus(&self, o: &Set) -> Set {
        let mut s = *self;
        for t in 1..=5 {
            s.sub(o.0[t], t);
        }
        s
    }

    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub from: usize,
    pub to: Vec<bool>,
    pub give: Set,
    pub get: Set,
}

pub struct Negotiator {
    pub pn: usize,
    pub params: Params,
    is_selling: Vec<[bool; 6]>,
    wants_another: Vec<[bool; 6]>,
    offers_made: Vec<(Set, Set)>,
    pub target_pieces: Vec<Option<Piece>>,
    /// The client's view of every hand (jsettler/view.rs); our own row is exact.
    pub views: Views,
}

impl Negotiator {
    pub fn new(pn: usize, n: usize, params: Params) -> Negotiator {
        Negotiator { pn, params, is_selling: vec![[false; 6]; n], wants_another: vec![[false; 6]; n], offers_made: vec![], target_pieces: vec![None; n], views: Views::new(n) }
    }

    /// A seat's resources as this client sees them: our exact hand, or the known part of the view.
    fn hand_of(&self, s: &State, seat: usize) -> [i32; 5] {
        if seat == self.pn { s.players[seat].hand } else { self.views.known(seat) }
    }

    /// What a plan simulation for another seat reads: the client's view of that player (known cards
    /// only; SOCBuildingSpeedEstimate ignores UNKNOWN).
    fn plan_input_for<'a>(&self, s: &State, info: &'a GameInfo, seat: usize) -> PlanInput<'a> {
        let us = self.pn;
        PlanInput { info, resources: self.hand_of(s, seat), has_played_dev_card: s.players[seat].has_played_dev, roads_card_playable: seat == us && s.can_play_dev(seat, ROAD_BUILDING), for_special_building: s.current_player != seat }
    }

    pub fn reset_target_pieces(&mut self) {
        self.target_pieces.iter_mut().for_each(|t| *t = None);
    }

    pub fn reset_offers_made(&mut self) {
        self.offers_made.clear();
    }

    pub fn add_to_offers_made(&mut self, give: Set, get: Set) {
        self.offers_made.push((give, get));
    }

    /// resetIsSelling: everyone holding a resource is assumed to sell it (never cleared here).
    pub fn reset_is_selling(&mut self, s: &State) {
        for t in 1..=5 {
            for pn in 0..s.n {
                if self.hand_of(s, pn)[js(t)] > 0 {
                    self.is_selling[pn][t] = true;
                }
            }
        }
    }

    pub fn reset_wants_another_offer(&mut self) {
        self.wants_another.iter_mut().for_each(|w| *w = [false; 6]);
    }

    pub fn record_resources_from_offer(&mut self, o: &Offer) {
        for t in 1..=5 {
            if o.give.has(t) {
                self.wants_another[o.from][t] = true;
            }
            if o.get.has(t) {
                self.is_selling[o.from][t] = false;
            }
        }
    }

    pub fn record_resources_from_reject(&mut self, rejector: usize, our_offer: &Offer) {
        for t in 1..=5 {
            if our_offer.get.has(t) && !self.wants_another[rejector][t] {
                self.is_selling[rejector][t] = false;
            }
        }
    }

    /// recordResourcesFromRejectAlt: `rejector` said no to another player's standing offer.
    pub fn record_resources_from_reject_alt(&mut self, rejector: usize, offer: &Offer) {
        if !offer.to.get(rejector).copied().unwrap_or(false) {
            return;
        }
        for t in 1..=5 {
            if offer.get.has(t) && !self.wants_another[rejector][t] {
                self.is_selling[rejector][t] = false;
            }
        }
    }

    pub fn record_resources_from_no_response(&mut self, our_offer: &Offer) {
        for t in 1..=5 {
            if our_offer.get.has(t) {
                for pn in 0..our_offer.to.len() {
                    if our_offer.to[pn] {
                        self.is_selling[pn][t] = false;
                        self.wants_another[pn][t] = false;
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ helpers

    fn eta_to_target(&self, tr: &Trackers, s: &State, player: usize, target: &Set, give: &Set, get: &Set, bse: &Bse) -> i32 {
        let mut copy = Set::from_engine(&self.hand_of(s, player));
        for t in 1..=5 {
            copy.sub(give.0[t], t);
            copy.add(get.0[t], t);
        }
        bse.rolls_fast(&copy.to_engine(), &target.to_engine(), 1000, &tr.port_flags(player))
    }

    /// needed / not-needed resource ids, each sorted by rolls per resource ascending; the arrays are
    /// five wide with zeros beyond the count, as in the Java.
    fn split(target: &Set, rolls: &Res) -> ([usize; 5], usize, [usize; 5], usize) {
        let (mut needed, mut nn) = ([0usize; 5], 0);
        let (mut not_needed, mut nnn) = ([0usize; 5], 0);
        for t in 1..=5 {
            if target.has(t) {
                needed[nn] = t;
                nn += 1;
            } else {
                not_needed[nnn] = t;
                nnn += 1;
            }
        }
        let r = |t: usize| if t == 0 { 0 } else { rolls[js(t)] };
        for (arr, count) in [(&mut needed, nn), (&mut not_needed, nnn)] {
            for j in (0..count).rev() {
                for i in 0..j {
                    if r(arr[i]) > r(arr[i + 1]) {
                        arr.swap(i, i + 1);
                    }
                }
            }
        }
        (needed, nn, not_needed, nnn)
    }

    /// getOfferToBank(targetResources, ourResources): (give, get) in engine terms with the ratio.
    pub fn offer_to_bank(&self, tr: &Trackers, target: &Set, ours: &Set) -> Option<(usize, i32, usize)> {
        if ours.contains(target) {
            return None;
        }
        let bse = Bse::new(&tr.numbers(self.pn), None);
        let rolls = bse.rolls_per_resource;
        let ports = tr.port_flags(self.pn);
        let (needed, nn, not_needed, nnn) = Negotiator::split(target, &rolls);
        if nn == 0 {
            return None;
        }
        let mut get_idx = nn as i32 - 1;
        while get_idx >= 0 && ours.0[needed[get_idx as usize]] >= target.0[needed[get_idx as usize]] {
            get_idx -= 1;
        }
        if get_idx < 0 {
            return None;
        }
        let get = needed[get_idx as usize];
        let ratio = |t: usize| ports.ratio(js(t));
        for &give in &not_needed[..nnn] {
            if ours.0[give] >= ratio(give) {
                return Some((js(give), ratio(give), js(get)));
            }
        }
        for &give in &needed[..nn] {
            let tr_ratio = ratio(give);
            if rolls[js(give)] >= rolls[js(get)] {
                if ours.0[give] - target.0[give] >= tr_ratio {
                    return Some((js(give), tr_ratio, js(get)));
                }
            } else if ours.0[give] >= tr_ratio {
                return Some((js(give), tr_ratio, js(get)));
            }
        }
        None
    }

    fn bank_sets(&self, tr: &Trackers, target: &Set, ours: &Set) -> Option<(Set, Set)> {
        self.offer_to_bank(tr, target, ours).map(|(give, ratio, get)| {
            let mut g = Set::default();
            g.0[super::opening::JS_TYPE[give]] = ratio;
            let mut r = Set::default();
            r.0[super::opening::JS_TYPE[get]] = 1;
            (g, r)
        })
    }

    /// The target piece of a seat, planning for it when unknown (a fresh SOCRobotDM on the shared
    /// trackers, as the Java does).
    pub(crate) fn target_piece(&mut self, tr: &mut Trackers, s: &State, info: &GameInfo, seat: usize) -> Option<Piece> {
        if let Some(p) = self.target_pieces[seat] {
            return Some(p);
        }
        let mut dm = Dm::new(self.params, seat);
        dm.plan_stuff(tr, &self.plan_input_for(s, info, seat));
        let first = dm.plan_in_order().first().copied()?;
        self.target_pieces[seat] = Some(first);
        Some(first)
    }

    /// considerOffer2: how `receiver` would answer `offer`.
    pub fn consider_offer2(&mut self, tr: &mut Trackers, s: &State, info: &GameInfo, offer: &Offer, receiver: usize) -> i32 {
        let receiver_resources = Set::from_engine(&s.players[receiver].hand);
        let rsrcs_out = offer.get;
        let rsrcs_in = offer.give;
        if !receiver_resources.contains(&rsrcs_out) {
            return REJECT_OFFER;
        }
        let sender = offer.from;
        let Some(receiver_target) = self.target_piece(tr, s, info, receiver) else { return REJECT_OFFER };
        let Some(sender_target) = self.target_piece(tr, s, info, sender) else { return REJECT_OFFER };
        let mut response = REJECT_OFFER;
        if tr.trackers[sender].win_game_eta > WIN_GAME_CUTOFF {
            let mut in_a_race = false;
            let (kind, coord) = match receiver_target {
                Piece::Settlement(c) => (Some(SETTLEMENT), c),
                Piece::Road(c) => (Some(ROAD), c),
                _ => (None, 0),
            };
            let (skind, scoord) = match sender_target {
                Piece::Settlement(c) => (SETTLEMENT, c),
                Piece::Road(c) => (ROAD, c),
                Piece::City(c) => (2, c),
                Piece::Card => (9, 0),
            };
            if let Some(k) = kind {
                let threats = if k == SETTLEMENT {
                    tr.trackers[receiver].possible_settlements.get(&coord).map(|p| p.threats.clone()).unwrap_or_default()
                } else {
                    tr.trackers[receiver].possible_roads.get(&coord).map(|p| p.threats.clone()).unwrap_or_default()
                };
                in_a_race = threats.iter().any(|t| t.kind == skind && t.coord == scoord);
                if !in_a_race && k == SETTLEMENT && skind == SETTLEMENT {
                    if let Some(ps) = tr.trackers[receiver].possible_settlements.get(&coord) {
                        in_a_race = ps.conflicts.iter().any(|&(_, c)| c == scoord);
                    }
                }
            }
            if !in_a_race {
                let target = Set::from_engine(&receiver_target.cost());
                let bse = Bse::new(&tr.numbers(receiver), None);
                let batna = self.eta_to_target(tr, s, receiver, &target, &Set::default(), &Set::default(), &bse);
                let offer_time = self.eta_to_target(tr, s, receiver, &target, &rsrcs_out, &rsrcs_in, &bse);
                response = if offer_time < batna { ACCEPT_OFFER } else { COUNTER_OFFER };
            }
        }
        response
    }

    /// makeOfferAux: an offer nobody has seen, to everyone who might sell, if one of them would accept.
    fn make_offer_aux(&mut self, tr: &mut Trackers, s: &State, info: &GameInfo, give: Set, get: Set, needed: usize) -> Option<Offer> {
        let us = self.pn;
        if self.offers_made.iter().any(|(g, r)| *g == give && *r == get) {
            return None;
        }
        if s.is_resolving_trade && s.current_trade[10] as usize != us {
            let mut og = [0; 5];
            let mut or = [0; 5];
            for r in 0..5 {
                og[r] = s.current_trade[r];
                or[r] = s.current_trade[5 + r];
            }
            if Set::from_engine(&or) == give && Set::from_engine(&og) == get {
                return None;
            }
        }
        let mut to = vec![false; s.n];
        let mut num = 0;
        let sells = |pn: usize| self.is_selling[pn][needed] && s.num_resources(pn) >= get.total() && tr.trackers[pn].win_game_eta >= WIN_GAME_CUTOFF;
        if s.current_player == us {
            for i in 0..s.n {
                if i != us && sells(i) {
                    to[i] = true;
                    num += 1;
                }
            }
        } else {
            let cur = s.current_player;
            if sells(cur) {
                to[cur] = true;
                num += 1;
            }
        }
        if num == 0 {
            return None;
        }
        let offer = Offer { from: us, to: to.clone(), give, get };
        for pn in 0..s.n {
            if to[pn] && self.consider_offer2(tr, s, info, &offer, pn) == ACCEPT_OFFER {
                return Some(offer);
            }
        }
        None
    }

    /// makeOffer / makeCounterOffer: `original_give` is the incoming offer's give set when countering.
    pub fn make_offer(&mut self, tr: &mut Trackers, s: &State, info: &GameInfo, target_piece: Piece, original_give: Option<&Set>) -> Option<Offer> {
        let us = self.pn;
        let target = Set::from_engine(&target_piece.cost());
        if target.is_empty() {
            return None;
        }
        let ours = Set::from_engine(&s.players[us].hand);
        if ours.contains(&target) {
            return None;
        }
        let batna = self.bank_sets(tr, &target, &ours);
        let bse = Bse::new(&tr.numbers(us), None);
        let rolls = bse.rolls_per_resource;
        let mut batna_time = self.eta_to_target(tr, s, us, &target, &Set::default(), &Set::default(), &bse);
        if let Some((bg, br)) = &batna {
            batna_time = self.eta_to_target(tr, s, us, &target, bg, br, &bse);
        }
        let (needed, nn, not_needed, nnn) = Negotiator::split(&target, &rolls);
        let mut someone_selling = [false; 6];
        for t in 1..=5 {
            someone_selling[t] = (0..s.n).any(|pn| pn != us && self.is_selling[pn][t]);
        }
        let available = |t: usize| match original_give {
            Some(g) => g.has(t),
            None => someone_selling[t],
        };
        let better = |time: i32, give: &Set| time < batna_time || (batna.is_some() && time == batna_time && give.total() < batna.as_ref().unwrap().0.total());
        let mut offer: Option<Offer> = None;
        let mut give;
        let mut get = Set::default();
        let mut get_idx = nn as i32 - 1;
        while get_idx >= 0 && (ours.0[needed[get_idx as usize]] >= target.0[needed[get_idx as usize]] || !available(needed[get_idx as usize])) {
            get_idx -= 1;
        }
        if get_idx >= 0 {
            let want = needed[get_idx as usize];
            get.add(1, want);
            for &g in &not_needed[..nnn] {
                if offer.is_some() {
                    break;
                }
                if ours.has(g) {
                    give = Set::default();
                    give.add(1, g);
                    offer = self.make_offer_aux(tr, s, info, give, get, want);
                }
            }
            if offer.is_none() {
                for &g in &needed[..nn] {
                    if offer.is_some() {
                        break;
                    }
                    if ours.0[g] > target.0[g] && g != want {
                        give = Set::default();
                        give.add(1, g);
                        let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                        if better(time, &give) {
                            offer = self.make_offer_aux(tr, s, info, give, get, want);
                        }
                    }
                }
            }
            let leftovers = ours.minus(&target);
            if offer.is_none() {
                // two cards for one
                for &g1 in &not_needed[..nnn] {
                    if offer.is_some() {
                        break;
                    }
                    if !ours.has(g1) {
                        continue;
                    }
                    for &g2 in &not_needed[..nnn] {
                        if offer.is_some() {
                            break;
                        }
                        give = Set::default();
                        give.add(1, g1);
                        give.add(1, g2);
                        if ours.contains(&give) {
                            let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                            if better(time, &give) {
                                offer = self.make_offer_aux(tr, s, info, give, get, want);
                            }
                        }
                    }
                    for &g2 in &needed[..nn] {
                        if offer.is_some() {
                            break;
                        }
                        if g2 != want {
                            give = Set::default();
                            give.add(1, g1);
                            give.add(1, g2);
                            if leftovers.contains(&give) {
                                let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                                if better(time, &give) {
                                    offer = self.make_offer_aux(tr, s, info, give, get, want);
                                }
                            }
                        }
                    }
                }
                for &g1 in &needed[..nn] {
                    if offer.is_some() {
                        break;
                    }
                    if !(leftovers.has(g1) && g1 != want) {
                        continue;
                    }
                    for &g2 in &not_needed[..nnn] {
                        if offer.is_some() {
                            break;
                        }
                        give = Set::default();
                        give.add(1, g1);
                        give.add(1, g2);
                        if leftovers.contains(&give) {
                            let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                            if better(time, &give) {
                                offer = self.make_offer_aux(tr, s, info, give, get, want);
                            }
                        }
                    }
                    for &g2 in &needed[..nn] {
                        if offer.is_some() {
                            break;
                        }
                        if g2 != want {
                            give = Set::default();
                            give.add(1, g1);
                            give.add(1, g2);
                            if leftovers.contains(&give) {
                                let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                                if better(time, &give) {
                                    offer = self.make_offer_aux(tr, s, info, give, get, want);
                                }
                            }
                        }
                    }
                }
            }
        }
        // a resource we do not need, to trade on to the bank; the counter-offer version asks for
        // one, two, then three of it
        let rounds: &[i32] = if original_give.is_some() { &[1, 2, 3] } else { &[1] };
        for &amount in rounds {
            if offer.is_some() {
                break;
            }
            let mut leftovers = ours.minus(&target);
            let mut idx2 = nnn as i32 - 1;
            // the Java tests neededRsrc[idx2] here (its own bug), or the original offer's give set
            while idx2 >= 0 && !match original_give {
                Some(g) => g.has(not_needed[idx2 as usize]),
                None => someone_selling[needed[idx2 as usize]],
            } {
                idx2 -= 1;
            }
            while idx2 >= 0 && offer.is_none() {
                let want = not_needed[idx2 as usize];
                get = Set::default();
                get.add(amount, want);
                leftovers.add(amount, want);
                for &g in &not_needed[..nnn] {
                    if offer.is_some() {
                        break;
                    }
                    if leftovers.has(g) && g != want {
                        leftovers.sub(1, g);
                        if self.bank_sets(tr, &target, &leftovers).is_some() {
                            give = Set::default();
                            give.add(1, g);
                            let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                            if time < batna_time {
                                offer = self.make_offer_aux(tr, s, info, give, get, want);
                            }
                        }
                        leftovers.add(1, g);
                    }
                }
                for &g in &needed[..nn] {
                    if offer.is_some() {
                        break;
                    }
                    if leftovers.has(g) {
                        leftovers.sub(1, g);
                        if self.bank_sets(tr, &target, &leftovers).is_some() {
                            give = Set::default();
                            give.add(1, g);
                            let time = self.eta_to_target(tr, s, us, &target, &give, &get, &bse);
                            if time < batna_time {
                                offer = self.make_offer_aux(tr, s, info, give, get, want);
                            }
                        }
                        leftovers.add(1, g);
                    }
                }
                leftovers.sub(amount, want);
                idx2 -= 1;
            }
        }
        offer
    }
}

#[allow(dead_code)]
fn _ports(_: Ports) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsettler::dm::Params;

    /// recordResourcesFromRejectAlt: someone rejected another player's offer; they are not selling
    /// what it asked for, unless they had offered it themselves this turn (wantsAnotherOffer).
    #[test]
    fn reject_alt_marks_not_selling() {
        let mut neg = Negotiator::new(0, 4, Params::SMART);
        neg.is_selling = vec![[true; 6]; 4];
        let mut give = Set::default();
        give.0[1] = 1; // clay
        let mut get = Set::default();
        get.0[5] = 1; // wood
        let offer = Offer { from: 1, to: vec![true, false, true, true], give, get };
        neg.wants_another[3][5] = true;
        neg.record_resources_from_reject_alt(2, &offer);
        neg.record_resources_from_reject_alt(3, &offer);
        neg.record_resources_from_reject_alt(1, &offer); // the offerer: not addressed, nothing changes
        assert!(!neg.is_selling[2][5]);
        assert!(neg.is_selling[3][5], "wantsAnotherOffer overrides");
        assert!(neg.is_selling[1][5]);
        assert!(neg.is_selling[2][1], "only what the offer asked for");
    }
}
