//! Domestic-trade policy for the bots, shared by the arena, the Python players and the site.
//!
//! Searching offers is out of the question (each offer branches into every opponent's reply), so
//! trades are decided 1-ply with the bot's own evaluator:
//! - **offers** are scored by an additive decomposition: gain of the bundle received minus cost of the
//!   bundle given, each one evaluation of a modified hand (40 evaluations rank ~400 candidates); the
//!   top-k are re-scored exactly and an offer is made only if a partner, predicted with the same
//!   evaluator from their seat, would accept;
//! - **replies** accept when the responder's own value improves;
//! - **confirmation** picks the acceptee that leaves the offerer best off.
//! ponytail: the decomposition ignores give/get interaction; the exact re-score of the top-k catches it.

use crate::actions::{offer_key, valid_offer, Action, TRADE_BUNDLES};
use crate::encode::Layout;
use crate::state::{Prompt, State};
use crate::valuenet::ValueNet;

pub const TOP_K: usize = 8;

pub enum Eval<'a> {
    Heuristic,
    Net(&'a ValueNet, &'a Layout),
}

impl Eval<'_> {
    pub fn value(&self, s: &State, p: usize) -> f64 {
        match self {
            Eval::Heuristic => s.base_fn(p),
            Eval::Net(net, layout) => net.win_prob(&s.encoded(p, layout)),
        }
    }

    /// Smallest improvement worth trading for (P(win) is noisy at the third decimal).
    pub fn min_gain(&self) -> f64 {
        match self {
            Eval::Heuristic => 1e-9,
            Eval::Net(..) => 0.003,
        }
    }
}

fn with_hand(s: &State, p: usize, minus: &[u8; 5], plus: &[u8; 5]) -> State {
    let mut t = s.clone();
    for r in 0..5 {
        t.players[p].hand[r] += plus[r] as i32 - minus[r] as i32;
    }
    t
}

impl State {
    /// Would `q` accept giving `asked` for `offered`, judged by `eval` from q's seat?
    pub fn would_accept(&self, q: usize, offered: &[u8; 5], asked: &[u8; 5], eval: &Eval) -> bool {
        if (0..5).any(|r| self.players[q].hand[r] < asked[r] as i32) {
            return false;
        }
        let after = with_hand(self, q, asked, offered);
        eval.value(&after, q) - eval.value(self, q) > eval.min_gain()
    }

    /// The best offer for the current player, or None when nothing beats the current hand or nobody
    /// would take it. Returns the exact gain with the action.
    pub fn best_offer(&self, eval: &Eval) -> Option<(Action, f64)> {
        let p = self.current_player;
        if self.prompt != Prompt::PlayTurn || !self.players[p].has_rolled || self.is_road_building || self.is_resolving_trade {
            return None;
        }
        let hand = self.players[p].hand;
        let base = eval.value(self, p);
        let zero = [0u8; 5];
        let gains: Vec<f64> = TRADE_BUNDLES.iter().map(|r| eval.value(&with_hand(self, p, &zero, r), p) - base).collect();
        let costs: Vec<Option<f64>> = TRADE_BUNDLES
            .iter()
            .map(|g| if (0..5).any(|r| hand[r] < g[r] as i32) { None } else { Some(base - eval.value(&with_hand(self, p, g, &zero), p)) })
            .collect();
        let mut cands: Vec<(usize, usize, f64)> = Vec::new();
        for (gi, g) in TRADE_BUNDLES.iter().enumerate() {
            let Some(cost) = costs[gi] else { continue };
            for (ri, r) in TRADE_BUNDLES.iter().enumerate() {
                if !valid_offer(g, r) || self.spent_offers.contains(&offer_key(g, r)) {
                    continue;
                }
                cands.push((gi, ri, gains[ri] - cost));
            }
        }
        cands.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        let mut best: Option<(Action, f64)> = None;
        for &(gi, ri, _) in cands.iter().take(TOP_K) {
            let (g, r) = (&TRADE_BUNDLES[gi], &TRADE_BUNDLES[ri]);
            let exact = eval.value(&with_hand(self, p, g, r), p) - base;
            if exact <= eval.min_gain() || best.as_ref().is_some_and(|b| b.1 >= exact) {
                continue;
            }
            if (0..self.n).any(|q| q != p && self.would_accept(q, g, r, eval)) {
                best = Some((Action::OfferTrade { give: *g, get: *r }, exact));
            }
        }
        best
    }

    /// DecideTrade: accept iff the responder's value improves.
    pub fn respond_offer(&self, eval: &Eval) -> Action {
        let q = self.current_player;
        let mut offered = [0u8; 5];
        let mut asked = [0u8; 5];
        for r in 0..5 {
            offered[r] = self.current_trade[r] as u8;
            asked[r] = self.current_trade[5 + r] as u8;
        }
        if self.would_accept(q, &offered, &asked, eval) { Action::AcceptTrade } else { Action::RejectTrade }
    }

    /// DecideAcceptees: the acceptee that leaves the offerer best off; cancel if none improves.
    pub fn confirm_offer(&self, eval: &Eval) -> Action {
        let p = self.current_player;
        let base = eval.value(self, p);
        let mut best: Option<(usize, f64)> = None;
        for q in 0..self.n {
            if !self.acceptees[q] {
                continue;
            }
            let mut t = self.clone();
            if t.apply(Action::ConfirmTrade { partner: q as u8 }, None).is_err() {
                continue;
            }
            let v = eval.value(&t, p);
            if v - base > eval.min_gain() && best.is_none_or(|b| v > b.1) {
                best = Some((q, v));
            }
        }
        match best {
            Some((q, _)) => Action::ConfirmTrade { partner: q as u8 },
            None => Action::CancelTrade,
        }
    }

    /// The trade policy's action if one applies now (a reply, a confirmation, or an offer worth
    /// making); None means "decide with the search".
    pub fn trade_action(&self, eval: &Eval) -> Option<Action> {
        match self.prompt {
            Prompt::DecideTrade => Some(self.respond_offer(eval)),
            Prompt::DecideAcceptees => Some(self.confirm_offer(eval)),
            Prompt::PlayTurn => self.best_offer(eval).map(|(a, _)| a),
            _ => None,
        }
    }

    pub fn decide_with_trades(&self, eval: &Eval, search: impl FnOnce(&State) -> Option<Action>) -> Option<Action> {
        self.trade_action(eval).or_else(|| search(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Map;
    use std::sync::Arc;

    /// A hand of 4 ore and no wheat next to a hand of 4 wheat: both sides should agree to swap,
    /// the offer is made, answered, confirmed, and cards move; a rejected offer is spent for the turn.
    #[test]
    fn heuristic_bots_complete_a_trade() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(3, &layout)), 4, 1, 10);
        // fast-forward the initial phase with the first legal action every time
        while s.initial_phase {
            let a = s.playable_actions()[0];
            s.apply(a, None).unwrap();
        }
        s.apply(Action::Roll, Some((2, 3))).unwrap(); // a 5: harmless payout, has_rolled
        let p = s.current_player;
        s.players[p].hand = [0, 0, 0, 0, 4];
        for q in 0..4 {
            if q != p {
                s.players[q].hand = [0, 0, 0, 4, 0];
            }
        }
        let offer = s.best_offer(&Eval::Heuristic);
        let Some((Action::OfferTrade { give, get }, gain)) = offer else { panic!("expected an offer, got {offer:?}") };
        assert!(gain > 0.0 && give[4] > 0 && get[3] > 0, "ore for wheat: {give:?} -> {get:?}");
        s.apply(Action::OfferTrade { give, get }, None).unwrap();
        assert_eq!(s.prompt, Prompt::DecideTrade);
        let mut answered = 0;
        while s.prompt == Prompt::DecideTrade {
            let a = s.respond_offer(&Eval::Heuristic);
            s.apply(a, None).unwrap();
            answered += 1;
        }
        assert_eq!(answered, 3);
        assert_eq!(s.prompt, Prompt::DecideAcceptees, "somebody with 4 wheat should accept ore");
        let c = s.confirm_offer(&Eval::Heuristic);
        let Action::ConfirmTrade { partner } = c else { panic!("expected a confirmation") };
        let before_p = s.players[p].hand;
        let before_q = s.players[partner as usize].hand;
        s.apply(c, None).unwrap();
        for r in 0..5 {
            assert_eq!(s.players[p].hand[r], before_p[r] + get[r] as i32 - give[r] as i32);
            assert_eq!(s.players[partner as usize].hand[r], before_q[r] + give[r] as i32 - get[r] as i32);
        }
        assert_eq!(s.prompt, Prompt::PlayTurn);
        assert!(!s.is_resolving_trade && s.spent_offers.is_empty());
        // an offer everyone rejects is spent until END_TURN
        let bad = Action::OfferTrade { give: [0, 0, 0, 1, 0], get: [0, 0, 0, 0, 2] };
        s.apply(bad, None).unwrap();
        while s.prompt == Prompt::DecideTrade {
            s.apply(Action::RejectTrade, None).unwrap();
        }
        assert_eq!(s.prompt, Prompt::PlayTurn);
        assert!(s.apply(bad, None).is_err(), "a spent offer cannot be repeated");
        assert!(!s.playable_actions().contains(&bad));
        s.apply(Action::EndTurn, None).unwrap();
        assert!(s.spent_offers.is_empty());
    }
}
