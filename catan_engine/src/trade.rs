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

#[derive(Clone, Copy)]
pub enum Eval<'a> {
    Heuristic,
    Net(&'a ValueNet, &'a Layout),
    /// The net for the bot's own trades, `base_fn` for predicting partners' replies: exact against
    /// AlphaBeta partners, which answer with `base_fn` (the arena's `vnetx:` seat).
    NetVsHeuristic(&'a ValueNet, &'a Layout),
}

impl Eval<'_> {
    pub fn value(&self, s: &State, p: usize) -> f64 {
        match self {
            Eval::Heuristic => s.base_fn(p),
            Eval::Net(net, layout) | Eval::NetVsHeuristic(net, layout) => net.win_prob(&s.encoded(p, layout)),
        }
    }

    /// `(value(root), [value of root with p holding h, for h in hands])`, p the current player. The net scores them in
    /// one batch as differences from the root's encoding (valuenet.rs `forward_from`): a trade moves only hand features
    /// (encode.rs `hand_delta`), so layer 1 is a handful of columns, and no state is built or re-encoded (the vnetx
    /// seats' best_offer was 17% of self-play CPU, 2026-09-25). Not bitwise `value`: summation order differs (~1e-7).
    pub fn values(&self, root: &State, p: usize, hands: &[[i32; 5]]) -> (f64, Vec<f64>) {
        match self {
            Eval::Heuristic => (root.base_fn(p), hands.iter().map(|h| with_hand_exact(root, p, h).base_fn(p)).collect()),
            Eval::Net(net, layout) | Eval::NetVsHeuristic(net, layout) => {
                let nf = layout.n_features;
                let x0 = root.encoded(p, layout);
                let mut xs = vec![0f32; (hands.len() + 1) * nf];
                xs[..nf].copy_from_slice(&x0);
                for (i, h) in hands.iter().enumerate() {
                    root.encode_hand(p, layout, &x0, h, &mut xs[(i + 1) * nf..(i + 2) * nf]);
                }
                let z = net.forward_from(Some(&x0), &xs, hands.len() + 1);
                let v = |i: usize| crate::valuenet::sigmoid(z[i * crate::valuenet::N_HEADS] as f64);
                (v(0), (1..=hands.len()).map(v).collect())
            }
        }
    }

    /// The evaluator a partner is predicted to answer an offer with.
    pub fn partner(&self) -> Eval<'_> {
        match self {
            Eval::NetVsHeuristic(..) => Eval::Heuristic,
            e => *e,
        }
    }

    /// Smallest improvement worth trading for (P(win) is noisy at the third decimal).
    pub fn min_gain(&self) -> f64 {
        match self {
            Eval::Heuristic => 1e-9,
            Eval::Net(..) | Eval::NetVsHeuristic(..) => 0.003,
        }
    }
}

fn hand_after(s: &State, p: usize, minus: &[u8; 5], plus: &[u8; 5]) -> [i32; 5] {
    let mut h = s.players[p].hand;
    for r in 0..5 {
        h[r] += plus[r] as i32 - minus[r] as i32;
    }
    h
}

fn with_hand_exact(s: &State, p: usize, hand: &[i32; 5]) -> State {
    let mut t = s.clone_light();
    t.players[p].hand = *hand;
    t
}

fn with_hand(s: &State, p: usize, minus: &[u8; 5], plus: &[u8; 5]) -> State {
    let mut t = s.clone_light();
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
    /// would take it. Returns the exact gain with the action. Three stages, shared with the arena's parked version
    /// (the net's rows scored on the NPU with the search leaves): `offer_candidates` -> values -> `offer_shortlist`
    /// -> exact values -> `offer_pick`.
    pub fn best_offer(&self, eval: &Eval) -> Option<(Action, f64)> {
        let p = self.current_player;
        let (hands, affordable) = self.offer_candidates()?;
        let (base, vals) = eval.values(self, p, &hands);
        let short = self.offer_shortlist(base, &vals, &affordable);
        let exacts = if short.is_empty() { vec![] } else { eval.values(self, p, &self.shortlist_hands(&short)).1 };
        self.offer_pick(base, &short, &exacts, eval)
    }

    /// Stage 1: the current player's hands to evaluate -- one per bundle received (all 20), then one per affordable
    /// bundle given -- and which bundles are affordable; None when no offer can be made now.
    pub fn offer_candidates(&self) -> Option<(Vec<[i32; 5]>, Vec<bool>)> {
        let p = self.current_player;
        if self.prompt != Prompt::PlayTurn || !self.players[p].has_rolled || self.is_road_building || self.is_resolving_trade {
            return None;
        }
        let hand = self.players[p].hand;
        let zero = [0u8; 5];
        let affordable: Vec<bool> = TRADE_BUNDLES.iter().map(|g| (0..5).all(|r| hand[r] >= g[r] as i32)).collect();
        let mut hands: Vec<[i32; 5]> = TRADE_BUNDLES.iter().map(|r| hand_after(self, p, &zero, r)).collect();
        hands.extend(TRADE_BUNDLES.iter().zip(&affordable).filter(|(_, &a)| a).map(|(g, _)| hand_after(self, p, g, &zero)));
        Some((hands, affordable))
    }

    /// Stage 2: the top-k (give, get) bundle pairs by the additive estimate gain(get) - cost(give), from the values of
    /// `offer_candidates`' states (`vals`, in its order) and the current hand's value `base`.
    pub fn offer_shortlist(&self, base: f64, vals: &[f64], affordable: &[bool]) -> Vec<(usize, usize)> {
        let gains: Vec<f64> = vals[..TRADE_BUNDLES.len()].iter().map(|v| v - base).collect();
        let mut rest = vals[TRADE_BUNDLES.len()..].iter();
        let costs: Vec<Option<f64>> = affordable.iter().map(|&a| if a { Some(base - rest.next().unwrap()) } else { None }).collect();
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
        cands.into_iter().take(TOP_K).map(|(gi, ri, _)| (gi, ri)).collect()
    }

    /// The current player's hands after each shortlisted trade, for their exact values.
    pub fn shortlist_hands(&self, short: &[(usize, usize)]) -> Vec<[i32; 5]> {
        short.iter().map(|&(gi, ri)| hand_after(self, self.current_player, &TRADE_BUNDLES[gi], &TRADE_BUNDLES[ri])).collect()
    }

    /// Stage 3: the best shortlisted offer whose exact gain clears `min_gain` and that a partner would accept.
    pub fn offer_pick(&self, base: f64, short: &[(usize, usize)], exacts: &[f64], eval: &Eval) -> Option<(Action, f64)> {
        let p = self.current_player;
        let mut best: Option<(Action, f64)> = None;
        for (&(gi, ri), &v) in short.iter().zip(exacts) {
            let (g, r) = (&TRADE_BUNDLES[gi], &TRADE_BUNDLES[ri]);
            let exact = v - base;
            if exact <= eval.min_gain() || best.as_ref().is_some_and(|b| b.1 >= exact) {
                continue;
            }
            if (0..self.n).any(|q| q != p && self.would_accept(q, g, r, &eval.partner())) {
                best = Some((Action::OfferTrade { give: *g, get: *r }, exact));
            }
        }
        best
    }

    /// Trades inside the search (`vnets<k>x`): the best `k` shortlisted offers by exact gain that clear `min_gain` and
    /// that a partner would accept (the partner model: the first seat that would), each with the state it leads to
    /// if accepted. They become extra root children of the depth-2 search, so trading competes with building on the
    /// same depth-2 values (+3.7 points at 1,000 games, docs/FINDINGS.md 2026-09-25).
    pub fn offer_children_from(&self, base: f64, short: &[(usize, usize)], exacts: &[f64], eval: &Eval, k: usize) -> Vec<(Action, State)> {
        let p = self.current_player;
        let mut order: Vec<usize> = (0..short.len()).filter(|&i| exacts[i] - base > eval.min_gain()).collect();
        order.sort_by(|&a, &b| exacts[b].total_cmp(&exacts[a]));
        let mut extra = Vec::new();
        for i in order {
            if extra.len() == k {
                break;
            }
            let (give, get) = (TRADE_BUNDLES[short[i].0], TRADE_BUNDLES[short[i].1]);
            let Some(q) = (0..self.n).find(|&q| q != p && self.would_accept(q, &give, &get, &eval.partner())) else { continue };
            let mut t = self.clone_light();
            for r in 0..5 {
                t.players[p].hand[r] += get[r] as i32 - give[r] as i32;
                t.players[q].hand[r] += give[r] as i32 - get[r] as i32;
            }
            extra.push((Action::OfferTrade { give, get }, t));
        }
        extra
    }

    /// `offer_children_from` with the offer stages evaluated here (the site's synchronous path; the arena parks them).
    pub fn offer_children(&self, eval: &Eval, k: usize) -> Vec<(Action, State)> {
        let p = self.current_player;
        let Some((hands, affordable)) = self.offer_candidates() else { return vec![] };
        let (base, vals) = eval.values(self, p, &hands);
        let short = self.offer_shortlist(base, &vals, &affordable);
        if short.is_empty() {
            return vec![];
        }
        let exacts = eval.values(self, p, &self.shortlist_hands(&short)).1;
        self.offer_children_from(base, &short, &exacts, eval, k)
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
            let mut t = self.clone_light();
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

    /// A trade what-if encoded from the hand delta is bitwise the full encoding of the state holding that hand, and
    /// its layer-1 row through a leaf sink is bitwise the full row's.
    #[test]
    fn hand_delta_matches_full_encoding() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(5, &layout)), 4, 7, 10);
        while s.initial_phase {
            let a = s.playable_actions()[0];
            s.apply(a, None).unwrap();
        }
        s.apply(Action::Roll, Some((2, 3))).unwrap();
        let p = s.current_player;
        s.players[p].hand = [2, 1, 0, 3, 1];
        let (hands, _) = s.offer_candidates().expect("PlayTurn after the roll");
        let nf = layout.n_features;
        let x0 = s.encoded(p, &layout);
        let mut w = vec![0f32; nf + nf * 64 + 64 + 2 * (64 * 64 + 64) + 64 * 6 + 6];
        for (i, v) in w.iter_mut().enumerate() {
            *v = ((i * 2654435761) % 1000) as f32 / 1000.0 - 0.5;
        }
        let net = Arc::new(ValueNet::from_f32(&w, nf, 64, 6).unwrap());
        let mut a = net.leaf_sink(&x0, &s.map.static_template, vec![]);
        let mut b = net.leaf_sink(&x0, &s.map.static_template, vec![]);
        let mut row = vec![0f32; nf];
        for h in &hands {
            let mut t = s.clone_light();
            t.players[p].hand = *h;
            let full = t.encoded(p, &layout);
            s.encode_hand(p, &layout, &x0, h, &mut row);
            assert!(full.iter().zip(&row).all(|(x, y)| x.to_bits() == y.to_bits()), "hand {h:?}");
            t.encode_into(p, &layout, &mut a.row);
            a.push_row();
            b.push_delta(&mut s.hand_delta(p, &layout, h));
        }
        assert!(a.out == b.out, "push_delta differs from push_row");
    }

    /// The root-board leaf path (encode_rest_into onto the root's board features, scanned only at rest_indices) is
    /// bitwise the full path, and the rest encoder writes nowhere outside rest_indices.
    #[test]
    fn root_board_leaves_match_full_encoding() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut s = State::new(Arc::new(Map::generate(9, &layout)), 4, 3, 10);
        while s.initial_phase {
            let a = s.playable_actions()[0];
            s.apply(a, None).unwrap();
        }
        let p = s.current_player;
        let nf = layout.n_features;
        let rest = State::rest_indices(&layout, s.n);
        let mut probe = vec![f32::NAN; nf];
        s.encode_rest_into(p, &layout, &mut probe);
        for (i, v) in probe.iter().enumerate() {
            assert!(v.is_nan() || rest.binary_search(&(i as u32)).is_ok(), "encode_rest_into wrote {i} outside rest_indices");
        }
        let mut w = vec![0f32; nf + nf * 64 + 64 + 2 * (64 * 64 + 64) + 64 * 6 + 6];
        for (i, v) in w.iter_mut().enumerate() {
            *v = ((i * 2654435761) % 1000) as f32 / 1000.0 - 0.5;
        }
        let net = Arc::new(ValueNet::from_f32(&w, nf, 64, 6).unwrap());
        let x0 = s.encoded(p, &layout);
        let mut base = s.map.static_template.clone();
        s.encode_board_into(p, &layout, &mut base);
        let mut a = net.leaf_sink(&x0, &s.map.static_template, vec![]);
        let mut b = net.leaf_sink(&x0, &s.map.static_template, vec![]).with_board(base, s.board_key(), rest);
        let mut kids = 0;
        for roll in 2..=12i32 {
            let mut t = s.clone_light();
            t.apply(Action::Roll, Some((roll / 2, (roll + 1) / 2))).unwrap();
            for c in 0..4 {
                t.players[c].hand[c % 5] += roll % 3; // hands move, the board doesn't
            }
            assert!(t.board_is(&b.board));
            t.encode_into(p, &layout, &mut a.row);
            a.push_row();
            t.encode_rest_into(p, &layout, &mut b.brow);
            b.push_brow();
            kids += 1;
        }
        assert_eq!(kids, 11);
        assert!(a.out == b.out, "push_brow differs from push_row");
    }

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

    /// A responder counters, the turn player accepts: hands swap at once. A rejected counter is spent.
    #[test]
    fn counter_offers_round_trip() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let map = Arc::new(Map::generate(3, &layout));
        let mut s = State::new(map, 4, 3, 10);
        s.initial_phase = false;
        s.prompt = Prompt::PlayTurn;
        s.current_turn = 0;
        s.current_player = 0;
        s.players[0].has_rolled = true;
        s.players[0].hand = [2, 0, 0, 0, 0];
        s.players[1].hand = [0, 0, 0, 3, 0];
        s.apply(Action::OfferTrade { give: [1, 0, 0, 0, 0], get: [0, 0, 0, 1, 0] }, None).unwrap();
        assert_eq!(s.prompt, Prompt::DecideTrade);
        assert_eq!(s.current_player, 1);
        let counters: Vec<Action> = s.playable_actions().into_iter().filter(|a| matches!(a, Action::OfferTrade { .. })).collect();
        assert!(counters.contains(&Action::OfferTrade { give: [0, 0, 0, 1, 0], get: [2, 0, 0, 0, 0] }), "seat 1 may counter with what it holds");
        // seat 1 counters: 1 wheat for 2 wood, addressed to seat 0 only
        s.apply(Action::OfferTrade { give: [0, 0, 0, 1, 0], get: [2, 0, 0, 0, 0] }, None).unwrap();
        assert_eq!(s.prompt, Prompt::DecideTrade);
        assert_eq!(s.current_player, 0, "the turn player answers the counter");
        assert_eq!(s.current_trade, [0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 1]);
        assert!(!s.playable_actions().iter().any(|a| matches!(a, Action::OfferTrade { .. })), "no counter to a counter");
        let mut rejecting = s.clone();
        rejecting.apply(Action::RejectTrade, None).unwrap();
        assert_eq!(rejecting.prompt, Prompt::PlayTurn);
        assert_eq!(rejecting.current_player, 0);
        assert!(rejecting.spent_offers.contains(&[0, 0, 0, 1, 0, 2, 0, 0, 0, 0]), "a rejected counter is spent");
        assert!(rejecting.spent_offers.contains(&[1, 0, 0, 0, 0, 0, 0, 0, 1, 0]), "the countered offer is spent too");
        assert_eq!(rejecting.players[0].hand, [2, 0, 0, 0, 0]);
        s.apply(Action::AcceptTrade, None).unwrap();
        assert_eq!(s.prompt, Prompt::PlayTurn);
        assert_eq!(s.current_player, 0);
        assert_eq!(s.players[0].hand, [0, 0, 0, 1, 0], "seat 0 gave 2 wood, got 1 wheat");
        assert_eq!(s.players[1].hand, [2, 0, 0, 2, 0]);
        assert!(!s.is_resolving_trade);
        // once someone accepted, later responders cannot counter
        let mut t = State::new(Arc::clone(&s.map), 4, 3, 10);
        t.initial_phase = false;
        t.prompt = Prompt::PlayTurn;
        t.players[0].has_rolled = true;
        t.players[0].hand = [1, 0, 0, 0, 0];
        t.players[1].hand = [0, 0, 0, 1, 0];
        t.players[2].hand = [0, 0, 0, 1, 0];
        t.apply(Action::OfferTrade { give: [1, 0, 0, 0, 0], get: [0, 0, 0, 1, 0] }, None).unwrap();
        t.apply(Action::AcceptTrade, None).unwrap();
        assert_eq!(t.current_player, 2);
        assert!(!t.playable_actions().iter().any(|a| matches!(a, Action::OfferTrade { .. })));
        assert!(t.apply(Action::OfferTrade { give: [0, 0, 0, 1, 0], get: [1, 0, 0, 0, 0] }, None).is_err());
    }
}
