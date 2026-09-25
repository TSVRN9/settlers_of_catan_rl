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
    OfferTrade { give: [u8; 5], get: [u8; 5] },
    AcceptTrade,
    RejectTrade,
    ConfirmTrade { partner: u8 },
    CancelTrade,
}

/// Five resource counts in 5 bits each (hands never exceed 19 of a kind), so an offer fits the (a, b) ints.
pub fn pack_bundle(b: &[u8; 5]) -> i32 {
    b.iter().enumerate().map(|(i, &c)| (c as i32 & 31) << (5 * i)).sum()
}

pub fn unpack_bundle(x: i32) -> [u8; 5] {
    let mut b = [0u8; 5];
    for (i, v) in b.iter_mut().enumerate() {
        *v = ((x >> (5 * i)) & 31) as u8;
    }
    b
}

/// The 20 one- or two-card bundles, singles first then pairs i <= j (catanatron.models.actions.TRADE_BUNDLES).
pub const TRADE_BUNDLES: [[u8; 5]; 20] = {
    let mut out = [[0u8; 5]; 20];
    let mut k = 0;
    let mut i = 0;
    while i < 5 {
        out[k][i] = 1;
        k += 1;
        i += 1;
    }
    let mut i = 0;
    while i < 5 {
        let mut j = i;
        while j < 5 {
            out[k][i] += 1;
            out[k][j] += 1;
            k += 1;
            j += 1;
        }
        i += 1;
    }
    out
};

/// catanatron.game.is_valid_trade: no giveaways, no like-for-like resource on both sides.
pub fn valid_offer(give: &[u8; 5], get: &[u8; 5]) -> bool {
    let g: u32 = give.iter().map(|&x| x as u32).sum();
    let r: u32 = get.iter().map(|&x| x as u32).sum();
    g > 0 && r > 0 && !(0..5).any(|i| give[i] > 0 && get[i] > 0)
}

pub fn offer_key(give: &[u8; 5], get: &[u8; 5]) -> [u8; 10] {
    let mut k = [0u8; 10];
    k[..5].copy_from_slice(give);
    k[5..].copy_from_slice(get);
    k
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
        Action::OfferTrade { give, get } => ("OFFER_TRADE".into(), pack_bundle(&give), pack_bundle(&get), -1),
        Action::AcceptTrade => ("ACCEPT_TRADE".into(), -1, -1, -1),
        Action::RejectTrade => ("REJECT_TRADE".into(), -1, -1, -1),
        Action::ConfirmTrade { partner } => ("CONFIRM_TRADE".into(), partner as i32, -1, -1),
        Action::CancelTrade => ("CANCEL_TRADE".into(), -1, -1, -1),
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
        "OFFER_TRADE" => Action::OfferTrade { give: unpack_bundle(a), get: unpack_bundle(b) },
        "ACCEPT_TRADE" => Action::AcceptTrade,
        "REJECT_TRADE" => Action::RejectTrade,
        "CONFIRM_TRADE" => Action::ConfirmTrade { partner: a as u8 },
        "CANCEL_TRADE" => Action::CancelTrade,
        _ => return Err(format!("unknown action type {t}")),
    })
}

impl State {
    /// playable_actions minus domestic trade offers: what the searches branch over (offers are decided
    /// by the 1-ply policy in trade.rs, never inside a tree).
    pub fn search_actions(&self) -> Vec<Action> {
        // Every prompt that can offer also has a non-offer action (Roll / EndTurn / RejectTrade), so
        // skipping the ~300 offers at generation is the same list as filtering them out afterwards.
        self.actions(false)
    }

    pub fn can_accept_offer(&self, p: usize) -> bool {
        (0..5).all(|r| self.players[p].hand[r] >= self.current_trade[5 + r])
    }

    /// Offers with up to two cards per side that `p` can make now (catanatron domestic_trade_possibilities).
    pub fn domestic_trade_possibilities(&self, p: usize) -> Vec<Action> {
        if self.is_road_building {
            return vec![];
        }
        let hand = &self.players[p].hand;
        let mut out = Vec::new();
        for give in TRADE_BUNDLES.iter() {
            if (0..5).any(|r| hand[r] < give[r] as i32) {
                continue;
            }
            for get in TRADE_BUNDLES.iter() {
                if (0..5).any(|r| give[r] > 0 && get[r] > 0) {
                    continue;
                }
                if self.spent_offers.contains(&offer_key(give, get)) {
                    continue;
                }
                out.push(Action::OfferTrade { give: *give, get: *get });
            }
        }
        out
    }

    pub fn playable_actions(&self) -> Vec<Action> {
        self.actions(true)
    }

    fn actions(&self, with_offers: bool) -> Vec<Action> {
        let mut out = Vec::new();
        self.actions_into(with_offers, &mut out);
        out
    }

    /// `search_actions` into a caller-owned list (cleared first): playouts reuse one buffer for every step.
    pub fn search_actions_into(&self, out: &mut Vec<Action>) {
        out.clear();
        self.actions_into(false, out);
    }

    fn actions_into(&self, with_offers: bool, out: &mut Vec<Action>) {
        let p = self.current_player;
        match self.prompt {
            Prompt::InitialSettlement => out.extend(self.buildable_node_ids(p, true).into_iter().map(Action::BuildSettlement)),
            Prompt::InitialRoad => {
                let last = *self.players[p].settlements.last().expect("initial road without settlement");
                out.extend(
                    self.buildable_edges(p)
                        .into_iter()
                        .filter(|&e| {
                            let (a, b) = self.map.edges[e as usize];
                            a == last || b == last
                        })
                        .map(Action::BuildRoad),
                )
            }
            Prompt::MoveRobber => self.push_robber(p, out),
            Prompt::DecideTrade => {
                out.push(Action::RejectTrade);
                if self.can_accept_offer(p) {
                    out.push(Action::AcceptTrade);
                }
                // a responder may counter while nobody has accepted; the turn player answering a
                // counter may only accept or reject (JSettlers: a counter is a new offer to the offerer)
                if with_offers && p != self.current_turn && !self.acceptees.iter().any(|&a| a) {
                    out.extend(self.domestic_trade_possibilities(p));
                }
            }
            Prompt::DecideAcceptees => {
                out.push(Action::CancelTrade);
                for (i, &ok) in self.acceptees.iter().enumerate().take(self.n) {
                    if ok {
                        out.push(Action::ConfirmTrade { partner: i as u8 });
                    }
                }
            }
            Prompt::PlayTurn => {
                if self.is_road_building {
                    return self.push_road_building(p, false, out);
                }
                out.reserve(64); // no regrowth
                if self.can_play_dev(p, YEAR_OF_PLENTY) {
                    self.push_year_of_plenty(out);
                }
                if self.can_play_dev(p, MONOPOLY) {
                    for r in 0..5u8 {
                        out.push(Action::PlayMonopoly(r));
                    }
                }
                if self.can_play_dev(p, KNIGHT) {
                    out.push(Action::PlayKnight);
                }
                if self.can_play_dev(p, ROAD_BUILDING) && self.players[p].roads_available > 0 && {
                    let mut any = false;
                    self.for_each_buildable_edge(p, |_| any = true);
                    any
                } {
                    out.push(Action::PlayRoadBuilding);
                }
                if !self.players[p].has_rolled {
                    out.push(Action::Roll);
                } else {
                    out.push(Action::EndTurn);
                    self.push_road_building(p, true, out);
                    self.push_settlements(p, out);
                    self.push_cities(p, out);
                    if self.can_afford_dev(p) && !self.dev_deck.is_empty() {
                        out.push(Action::BuyDev);
                    }
                    self.push_maritime_trades(p, out);
                    if with_offers {
                        out.extend(self.domestic_trade_possibilities(p));
                    }
                }
            }
            Prompt::Discard => {
                if self.discard_counts[p] > 0 {
                    out.extend((0..5u8).filter(|&r| self.players[p].hand[r as usize] > 0).map(Action::Discard));
                }
            }
        }
    }

    // The 15 unordered pairs, a pair the bank cannot pay falling back to its payable singles, first occurrence kept.
    pub(crate) fn push_year_of_plenty(&self, out: &mut Vec<Action>) {
        let (bank, start) = (&self.bank, out.len());
        let add = |a: Action, out: &mut Vec<Action>| {
            if !out[start..].contains(&a) {
                out.push(a);
            }
        };
        for i in 0..5usize {
            for j in i..5usize {
                let mut need = [0i32; 5];
                need[i] += 1;
                need[j] += 1;
                if (0..5).all(|k| bank[k] >= need[k]) {
                    add(Action::PlayYop(i as u8, j as i8), out);
                } else {
                    if bank[i] >= 1 {
                        add(Action::PlayYop(i as u8, -1), out);
                    }
                    if bank[j] >= 1 {
                        add(Action::PlayYop(j as u8, -1), out);
                    }
                }
            }
        }
    }

    pub fn road_building_possibilities(&self, p: usize, check_money: bool) -> Vec<Action> {
        let mut out = Vec::new();
        self.push_road_building(p, check_money, &mut out);
        out
    }

    // The push_* generators append to the caller's list (one allocation per move list instead of one per kind).
    fn push_road_building(&self, p: usize, check_money: bool, out: &mut Vec<Action>) {
        if self.players[p].roads_available <= 0 || (check_money && !self.hand_contains(p, &ROAD_COST)) {
            return;
        }
        self.for_each_buildable_edge(p, |e| out.push(Action::BuildRoad(e)));
    }

    fn push_settlements(&self, p: usize, out: &mut Vec<Action>) {
        if self.hand_contains(p, &SETTLEMENT_COST) && self.players[p].settlements_available > 0 {
            let mut nodes = 0u64;
            for &c in &self.components[p] {
                nodes |= c;
            }
            let mut mask = nodes & self.buildable; // buildable_node_ids(p, false), ascending
            while mask != 0 {
                out.push(Action::BuildSettlement(mask.trailing_zeros() as u8));
                mask &= mask - 1;
            }
        }
    }

    fn push_cities(&self, p: usize, out: &mut Vec<Action>) {
        if self.hand_contains(p, &CITY_COST) && self.players[p].cities_available > 0 {
            out.extend(self.players[p].settlements.iter().map(|&n| Action::BuildCity(n)));
        }
    }

    /// Every tile but the robber's, once per distinct robbable enemy on it in node order (or once with no
    /// victim); with the friendly robber, the moves that spare low-VP enemies unless that leaves none.
    pub(crate) fn push_robber(&self, p: usize, out: &mut Vec<Action>) {
        let start = out.len();
        let mut cards = [0i32; 4];
        for (i, c) in cards.iter_mut().enumerate().take(self.n) {
            *c = self.num_resources(i);
        }
        for (tid, tile) in self.map.tiles.iter().enumerate() {
            if tid as u8 == self.robber {
                continue;
            }
            let mut victims = 0u8;
            for &n in &tile.nodes {
                let o = self.owner[n as usize];
                if o >= 0 && o as usize != p && cards[o as usize] >= 1 && victims & (1 << o) == 0 {
                    victims |= 1 << o;
                    out.push(Action::MoveRobber { tile: tid as u8, victim: o });
                }
            }
            if victims == 0 {
                out.push(Action::MoveRobber { tile: tid as u8, victim: -1 });
            }
        }
        if self.friendly_robber && out[start..].iter().any(|a| !self.robber_blocks_low_vp_enemy(p, a)) {
            let mut keep = start;
            for i in start..out.len() {
                if !self.robber_blocks_low_vp_enemy(p, &out[i]) {
                    out[keep] = out[i];
                    keep += 1;
                }
            }
            out.truncate(keep);
        }
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

    fn push_maritime_trades(&self, p: usize, out: &mut Vec<Action>) {
        let hand = &self.players[p].hand;
        let ports = self.port_resources(p);
        let base_rate: u8 = if ports & (1 << 5) != 0 { 3 } else { 4 };
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
    }
}
