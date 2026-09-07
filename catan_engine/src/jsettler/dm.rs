//! soc.robot.SOCRobotDM: the build plan. The smart strategy scores every possible settlement, road
//! and city by how a temporary copy of it changes everyone's win-game ETA (on tracker copies that
//! carry no threats), the fast strategy takes the cheapest
//! thing that scores. Every Java quirk that shows in the plans is kept: the road ETA taken from the
//! ship column, the dev-card scoring leaving the planner's own ETA at +1 VP, the LR paths restored
//! only at two points, scores in f32.

use std::collections::HashMap;

use super::bse::{Bse, Res, CARD, CARD_COST, CITY as B_CITY, ROAD as B_ROAD, ROAD_COST, SETTLEMENT as B_SET, SETTLEMENT_COST, SHIP as B_SHIP};
use super::player::{CITY, ROAD, SETTLEMENT};
use super::tracker::{GameInfo, Tracker, Trackers};

/// soc.util.SOCRobotParameters, the fields the decision maker reads.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub eta_bonus_factor: f32,
    pub adversarial_factor: f32,
    pub leader_adversarial_factor: f32,
    pub dev_card_multiplier: f32,
    pub threat_multiplier: f32,
    pub smart: bool,
}

impl Params {
    /// SOCServer.ROBOT_PARAMS_DEFAULT (the "droid" bots, FAST_STRATEGY).
    pub const FAST: Params = Params { eta_bonus_factor: 0.13, adversarial_factor: 1.0, leader_adversarial_factor: 1.0, dev_card_multiplier: 3.0, threat_multiplier: 1.0, smart: false };
    /// SOCServer.ROBOT_PARAMS_SMARTER (the "robot" bots, SMART_STRATEGY).
    pub const SMART: Params = Params { smart: true, ..Params::FAST };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Piece {
    Road(i32),
    Settlement(i32),
    City(i32),
    Card,
}

impl Piece {
    pub fn cost(&self) -> Res {
        match self {
            Piece::Road(_) => ROAD_COST,
            Piece::Settlement(_) => SETTLEMENT_COST,
            Piece::City(_) => super::bse::CITY_COST,
            Piece::Card => CARD_COST,
        }
    }
}

/// The planner's view besides the trackers.
pub struct PlanInput<'a> {
    pub info: &'a GameInfo,
    pub resources: Res,
    pub has_played_dev_card: bool,
    pub roads_card_playable: bool,
    /// game.isSpecialBuilding() || current player is not us
    pub for_special_building: bool,
}

#[derive(Clone, Debug)]
pub struct Dm {
    pub params: Params,
    pub pn: usize,
    /// SOCBuildPlanStack: bottom first, the last element is the next piece to build.
    pub plan: Vec<Piece>,
    scores: HashMap<Piece, f32>,
    favorite_road: Option<i32>,
    favorite_settlement: Option<i32>,
    favorite_city: Option<i32>,
    threatened_settlements: Vec<i32>,
    good_settlements: Vec<i32>,
    threatened_roads: Vec<i32>,
    good_roads: Vec<i32>,
    /// scoreSettlementsForDumb: ETA and road path (stack, last = next to build) per settlement.
    dumb_eta: HashMap<i32, i32>,
    dumb_path: HashMap<i32, Vec<i32>>,
    pub resource_choices: Res,
}

impl Dm {
    pub fn new(params: Params, pn: usize) -> Dm {
        Dm { params, pn, plan: vec![], scores: HashMap::new(), favorite_road: None, favorite_settlement: None, favorite_city: None, threatened_settlements: vec![], good_settlements: vec![], threatened_roads: vec![], good_roads: vec![], dumb_eta: HashMap::new(), dumb_path: HashMap::new(), resource_choices: [0, 2, 0, 0, 0] }
    }

    fn score(&self, p: Piece) -> f32 {
        *self.scores.get(&p).unwrap_or(&0.0)
    }

    /// The favourites and the card score after a plan, for the oracle check.
    pub fn favorites(&self) -> (Option<(i32, f32)>, Option<(i32, f32)>, Option<(i32, f32)>, Option<f32>) {
        (
            self.favorite_settlement.map(|c| (c, self.score(Piece::Settlement(c)))),
            self.favorite_city.map(|c| (c, self.score(Piece::City(c)))),
            self.favorite_road.map(|c| (c, self.score(Piece::Road(c)))),
            self.scores.get(&Piece::Card).copied(),
        )
    }

    /// The plan in build order (SOCBuildPlanStack.getPlannedPiece(i)).
    pub fn plan_in_order(&self) -> Vec<Piece> {
        self.plan.iter().rev().copied().collect()
    }

    /// getETABonus: the bonus discounted by the rolls it takes.
    fn eta_bonus(&self, eta: i32, bonus: f32) -> f32 {
        bonus / (((1.0f32 + self.params.eta_bonus_factor) as f64).powf(eta as f64) as f32)
    }

    fn leaders(originals: &[i32]) -> (Vec<usize>, i32) {
        let mut best = 1000;
        let mut leaders = vec![];
        for (pn, &w) in originals.iter().enumerate() {
            if w < best {
                best = w;
                leaders.clear();
                leaders.push(pn);
            } else if w == best {
                leaders.push(pn);
            }
        }
        (leaders, best)
    }

    /// calcWGETABonusAux.
    fn wgeta_bonus_aux(&self, originals: &[i32], after: &[Tracker], leaders: &[usize]) -> f32 {
        let n = originals.len();
        let per = 100.0f32 / n as f32;
        let mut diffs: Vec<i32> = originals.to_vec();
        let mut best = 1000;
        for &o in originals {
            if o < best {
                best = o;
            }
        }
        let mut bonus = 0.0f32;
        for t in after {
            diffs[t.pn] -= t.win_game_eta;
            if t.pn == self.pn && t.win_game_eta == 0 {
                bonus += per;
            }
        }
        if originals[self.pn] > 0 && bonus == 0.0 {
            bonus += per * (diffs[self.pn] as f32 / originals[self.pn] as f32);
        }
        for pn in 0..n {
            for &leader in leaders {
                if pn == self.pn || pn == leader {
                    continue;
                }
                if originals[pn] > 0 {
                    let takedown = -1.0f32 * per * self.params.adversarial_factor * (diffs[pn] as f32 / originals[pn] as f32) * (best as f32 / originals[pn] as f32);
                    bonus += takedown;
                } else if diffs[pn] < 0 {
                    bonus += per * self.params.adversarial_factor;
                }
            }
        }
        for &leader in leaders {
            if leader == self.pn {
                continue;
            }
            if originals[leader] > 0 {
                let takedown = -1.0f32 * per * self.params.leader_adversarial_factor * (diffs[leader] as f32 / originals[leader] as f32);
                bonus += takedown;
            } else if diffs[leader] < 0 {
                bonus += per * self.params.leader_adversarial_factor;
            }
        }
        bonus
    }

    /// calcWGETABonus: the real trackers before, the copies after.
    fn wgeta_bonus(&self, before: &[Tracker], after: &[Tracker]) -> f32 {
        let originals: Vec<i32> = before.iter().map(|t| t.win_game_eta).collect();
        let (leaders, _) = Dm::leaders(&originals);
        self.wgeta_bonus_aux(&originals, after, &leaders)
    }

    /// planStuff: the whole plan for this turn.
    pub fn plan_stuff(&mut self, tr: &mut Trackers, inp: &PlanInput) {
        let pn = self.pn;
        let etas = Bse::new(&tr.numbers(pn), None).from_now_fast(&inp.resources, &tr.port_flags(pn));
        self.threatened_settlements.clear();
        self.good_settlements.clear();
        self.threatened_roads.clear();
        self.good_roads.clear();
        self.favorite_road = None;
        self.favorite_settlement = None;
        self.favorite_city = None;
        self.scores.clear();
        if self.params.smart {
            tr.update_win_game_etas(inp.info);
        }
        if self.params.smart {
            self.smart_strategy(tr, inp, &etas);
        } else {
            self.fast_strategy(tr, inp, &etas);
        }
        if self.params.smart && !inp.has_played_dev_card && tr.players[pn].num_pieces[0] >= 2 && inp.roads_card_playable {
            self.plan_road_building_two_roads(tr, inp);
        }
    }

    fn leaders_current(&self, tr: &Trackers) -> i32 {
        tr.trackers.iter().map(|t| t.win_game_eta).fold(tr.trackers[self.pn].win_game_eta, i32::min)
    }

    // ---------------------------------------------------------------- smart

    fn smart_strategy(&mut self, tr: &mut Trackers, inp: &PlanInput, etas: &[i32; 5]) {
        let pn = self.pn;
        let saved = tr.save_lr_paths();
        let leaders_wgeta = self.leaders_current(tr);
        let pieces = tr.players[pn].num_pieces;
        if pieces[1] > 0 {
            self.score_possible_settlements(tr, inp, etas[B_SET]);
        }
        if pieces[0] > 0 {
            for (&c, pr) in &tr.trackers[pn].possible_roads {
                if pr.necessary_roads.is_empty() && !self.threatened_roads.contains(&c) && !self.good_roads.contains(&c) {
                    self.good_roads.push(c);
                }
            }
        }
        if pieces[1] > 0 {
            for list in [self.threatened_settlements.clone(), self.good_settlements.clone()] {
                for c in list {
                    if tr.trackers[pn].possible_settlements.get(&c).map_or(false, |s| s.necessary_roads.is_empty()) {
                        if self.favorite_settlement.map_or(true, |f| self.score(Piece::Settlement(c)) > self.score(Piece::Settlement(f))) {
                            self.favorite_settlement = Some(c);
                        }
                    }
                }
            }
        }
        tr.restore_lr_paths(&saved);
        if pieces[0] > 0 {
            for c in self.threatened_roads.clone() {
                self.scores.insert(Piece::Road(c), 0.0);
                self.wgeta_bonus_for_road(tr, inp, c, etas[B_ROAD], leaders_wgeta);
                if self.favorite_road.map_or(true, |f| self.score(Piece::Road(c)) > self.score(Piece::Road(f))) {
                    self.favorite_road = Some(c);
                }
            }
            for c in self.good_roads.clone() {
                self.scores.insert(Piece::Road(c), 0.0);
                // the Java's etype test is inverted: a plain road takes the SHIP column's ETA
                self.wgeta_bonus_for_road(tr, inp, c, etas[B_SHIP], leaders_wgeta);
                if self.favorite_road.map_or(true, |f| self.score(Piece::Road(c)) > self.score(Piece::Road(f))) {
                    self.favorite_road = Some(c);
                }
            }
        }
        tr.restore_lr_paths(&saved);
        if pieces[2] > 0 {
            let mut copies = tr.copy_trackers();
            let cities: Vec<i32> = tr.trackers[pn].possible_cities.keys().copied().collect();
            for c in cities {
                tr.with_trackers(&mut copies, |t| t.update_win_game_etas(inp.info));
                let originals: Vec<i32> = copies.iter().map(|t| t.win_game_eta).collect();
                let (leaders, _) = Dm::leaders(&originals);
                let temp = tr.put_temp(CITY, pn, c);
                let city = copies[pn].possible_cities.remove(&c);
                tr.with_trackers(&mut copies, |t| t.update_win_game_etas(inp.info));
                let wgeta_score = self.wgeta_bonus_aux(&originals, &copies, &leaders);
                if let Some(city) = city {
                    copies[pn].possible_cities.insert(c, city);
                }
                tr.undo_temp(temp);
                let bonus = self.eta_bonus(etas[B_CITY], wgeta_score);
                *self.scores.entry(Piece::City(c)).or_insert(0.0) += bonus;
                if self.favorite_city.map_or(true, |f| self.score(Piece::City(c)) > self.score(Piece::City(f))) {
                    self.favorite_city = Some(c);
                }
            }
        }
        let (fs, fr, fc) = (self.favorite_settlement, self.favorite_road, self.favorite_city);
        let s_score = |c: Option<i32>, mk: fn(i32) -> Piece| c.map_or(0.0, |x| self.score(mk(x)));
        let mut pick: Option<Piece> = None;
        let mut pick_score = 0.0f32;
        if let Some(c) = fc {
            let cs = self.score(Piece::City(c));
            let vs_set = fs.is_none() || pieces[1] == 0 || cs > s_score(fs, Piece::Settlement) || (cs == s_score(fs, Piece::Settlement) && etas[B_CITY] < etas[B_SET]);
            let vs_road = fr.is_none() || pieces[0] == 0 || cs > s_score(fr, Piece::Road) || (cs == s_score(fr, Piece::Road) && etas[B_CITY] < etas[B_ROAD]);
            if pieces[2] > 0 && cs > 0.0 && vs_set && vs_road {
                pick = Some(Piece::City(c));
                pick_score = cs;
            }
        }
        if pick.is_none() {
            if let Some(r) = fr {
                let rs = self.score(Piece::Road(r));
                if pieces[0] > 0 && rs > 0.0 && (fs.is_none() || pieces[1] == 0 || s_score(fs, Piece::Settlement) < rs) {
                    pick = Some(Piece::Road(r));
                    pick_score = rs;
                }
            }
        }
        if pick.is_none() {
            if let Some(s) = fs {
                if pieces[1] > 0 {
                    pick = Some(Piece::Settlement(s));
                    pick_score = self.score(Piece::Settlement(s));
                }
            }
        }
        if inp.info.dev_cards_left > 0 && !inp.for_special_building {
            let card_score = self.dev_card_score(tr, inp, etas[CARD]);
            if pick.is_none() || card_score > pick_score {
                pick = Some(Piece::Card);
            }
        }
        if let Some(p) = pick {
            self.plan.push(p);
        }
    }

    /// scorePossibleSettlements: every settlement with no necessary roads is tried on the board.
    fn score_possible_settlements(&mut self, tr: &mut Trackers, inp: &PlanInput, settlement_eta: i32) {
        let pn = self.pn;
        let coords: Vec<(i32, bool)> = tr.trackers[pn].possible_settlements.iter().map(|(&c, s)| (c, s.necessary_roads.is_empty())).collect();
        for (c, buildable) in coords {
            if !self.threatened_settlements.contains(&c) {
                self.threatened_settlements.push(c);
            } else if !self.good_settlements.contains(&c) {
                self.good_settlements.push(c);
            }
            if buildable {
                let (mut copies, temp) = tr.try_put_piece(SETTLEMENT, pn, c);
                tr.with_trackers(&mut copies, |t| t.update_win_game_etas(inp.info));
                let wgeta = self.wgeta_bonus(&tr.trackers, &copies);
                let bonus = self.eta_bonus(settlement_eta, wgeta);
                *self.scores.entry(Piece::Settlement(c)).or_insert(0.0) += bonus;
                tr.undo_temp(temp);
            }
        }
    }

    /// getWinGameETABonusForRoad.
    fn wgeta_bonus_for_road(&mut self, tr: &mut Trackers, inp: &PlanInput, c: i32, road_eta: i32, _leaders: i32) {
        let pn = self.pn;
        let (mut copies, temp) = tr.try_put_piece(ROAD, pn, c);
        tr.with_trackers(&mut copies, |t| t.update_win_game_etas(inp.info));
        let mut score = self.wgeta_bonus(&tr.trackers, &copies);
        if !tr.trackers[pn].possible_roads[&c].threats.is_empty() {
            score *= self.params.threat_multiplier;
        }
        let bonus = self.eta_bonus(road_eta, score);
        *self.scores.entry(Piece::Road(c)).or_insert(0.0) += bonus;
        tr.undo_temp(temp);
    }

    /// getDevCardScore: a knight's and a VP card's effect on the ETAs, on the real trackers; the
    /// VP card's recomputation is left in place.
    fn dev_card_score(&mut self, tr: &mut Trackers, inp: &PlanInput, card_eta: i32) -> f32 {
        let pn = self.pn;
        let originals: Vec<i32> = tr.trackers.iter().map(|t| t.win_game_eta).collect();
        let (leaders, _) = Dm::leaders(&originals);
        let mut score = 0.0f32;
        let mut with_knight = inp.info.clone();
        with_knight.knights[pn] += 1;
        tr.update_win_game_etas(&with_knight);
        score += self.wgeta_bonus_aux(&originals, &tr.trackers, &leaders) * 0.58;
        tr.update_win_game_etas(inp.info);
        let mut with_vp = inp.info.clone();
        with_vp.total_vp[pn] += 1;
        tr.update_win_game_etas(&with_vp);
        score += self.wgeta_bonus_aux(&originals, &tr.trackers, &leaders) * 0.21;
        score += self.params.dev_card_multiplier;
        let s = self.eta_bonus(card_eta, score);
        self.scores.insert(Piece::Card, s);
        s
    }

    /// planRoadBuildingTwoRoads: a second road to go with the favourite when the card is playable.
    fn plan_road_building_two_roads(&mut self, tr: &mut Trackers, inp: &PlanInput) {
        let pn = self.pn;
        let Some(fav) = self.favorite_road else { return };
        let (mut copies, temp) = tr.try_put_piece(ROAD, pn, fav);
        tr.with_trackers(&mut copies, |t| t.update_win_game_etas(inp.info));
        let mut second: Option<i32> = None;
        let news: Vec<i32> = tr.trackers[pn].possible_roads.get(&fav).map(|r| r.new_possibilities.iter().filter(|(k, _)| *k == ROAD).map(|&(_, c)| c).collect()).unwrap_or_default();
        for c in news.into_iter().chain(self.threatened_roads.clone()).chain(self.good_roads.clone()) {
            self.scores.insert(Piece::Road(c), 0.0);
            if c != fav && (second.is_none() || self.score(Piece::Road(c)) > self.score(Piece::Road(second.unwrap()))) {
                second = Some(c);
            }
        }
        tr.undo_temp(temp);
        if !self.plan.is_empty() {
            let top = *self.plan.last().unwrap();
            if !matches!(top, Piece::Road(_)) {
                if let Some(s) = second {
                    self.plan.push(Piece::Road(s));
                    self.plan.push(Piece::Road(fav));
                }
            } else if let Some(s) = second {
                let tmp = self.plan.pop().unwrap();
                self.plan.push(Piece::Road(s));
                self.plan.push(tmp);
            }
        }
    }

    // ---------------------------------------------------------------- fast

    fn fast_strategy(&mut self, tr: &mut Trackers, inp: &PlanInput, etas: &[i32; 5]) {
        let pn = self.pn;
        let info = inp.info;
        let special = inp.for_special_building;
        let mut best_eta = 500;
        let bse = Bse::new(&tr.numbers(pn), None);
        let ports = tr.port_flags(pn);
        let pieces = tr.players[pn].num_pieces;
        let total_vp = info.total_vp[pn] + tr.vp_delta[pn];
        if total_vp < 5 {
            if pieces[2] > 0 {
                for (&c, city) in &tr.trackers[pn].possible_cities {
                    let sp: i32 = city.speedup.iter().sum();
                    if self.favorite_city.map_or(true, |f| sp > tr.trackers[pn].possible_cities[&f].speedup.iter().sum::<i32>()) {
                        self.favorite_city = Some(c);
                        best_eta = etas[B_CITY];
                    }
                }
            }
            self.score_settlements_for_dumb(tr, inp, etas[B_SET], &bse, &ports);
            for &c in tr.trackers[pn].possible_settlements.keys() {
                let eta = self.dumb_eta[&c];
                if eta < best_eta {
                    best_eta = eta;
                    self.favorite_settlement = Some(c);
                } else if eta == best_eta && self.favorite_settlement.is_none() && self.favorite_city.map_or(true, |f| 0 > tr.trackers[pn].possible_cities[&f].speedup.iter().sum::<i32>()) {
                    self.favorite_settlement = Some(c);
                }
            }
            if let Some(s) = self.favorite_settlement {
                self.plan.push(Piece::Settlement(s));
                if !tr.trackers[pn].possible_settlements[&s].necessary_roads.is_empty() {
                    let mut path = self.dumb_path.get(&s).cloned().unwrap_or_default();
                    while let Some(r) = path.pop() {
                        self.plan.push(Piece::Road(r));
                    }
                }
            } else if let Some(c) = self.favorite_city {
                self.plan.push(Piece::City(c));
            } else if info.dev_cards_left > 0 && !special {
                self.plan.push(Piece::Card);
            }
            return;
        }
        let mut choice = -1;
        let la_size = match info.la_player {
            None => 3,
            Some(p) if p == pn => 0,
            Some(p) => info.knights[p] + 1,
        };
        let mut knights_to_buy = 0;
        if info.knights[pn] + info.knight_cards_old[pn] + info.knight_cards_new[pn] < la_size {
            knights_to_buy = la_size - (info.knights[pn] + info.knight_cards_old[pn]);
        }
        let mut la_eta = 500;
        if info.dev_cards_left >= knights_to_buy {
            let mut target = [0; 5];
            for _ in 0..knights_to_buy {
                for r in 0..5 {
                    target[r] += CARD_COST[r];
                }
            }
            la_eta = bse.rolls_fast(&inp.resources, &target, 100, &ports);
        }
        if la_eta < best_eta && !special {
            best_eta = la_eta;
            choice = 0;
        }
        let mut lr_eta = 500;
        let mut best_lr_path: Option<Vec<i32>> = None;
        if info.lr_player != Some(pn) {
            let lr_len = match info.lr_player {
                None => tr.players[pn].longest_road_length.max(4),
                Some(p) => tr.players[p].longest_road_length,
            };
            for path in tr.players[pn].lr_paths.clone() {
                let depth = ((lr_len + 1) - path.len).min(pieces[0]);
                for start in [path.begin, path.end] {
                    if let Some(p) = tr.lr_eta_path(pn, start, path.len, lr_len, depth) {
                        if best_lr_path.as_ref().map_or(true, |b| p.len() < b.len()) {
                            best_lr_path = Some(p);
                        }
                    }
                }
            }
            if let Some(p) = &best_lr_path {
                let mut target = [0; 5];
                for _ in 0..p.len() {
                    for r in 0..5 {
                        target[r] += ROAD_COST[r];
                    }
                }
                lr_eta = bse.rolls_fast(&inp.resources, &target, 100, &ports);
            }
        }
        if lr_eta < best_eta {
            best_eta = lr_eta;
            choice = 1;
        }
        if pieces[2] > 0 && etas[B_CITY] <= best_eta {
            for (&c, city) in &tr.trackers[pn].possible_cities {
                let sp: i32 = city.speedup.iter().sum();
                if self.favorite_city.map_or(true, |f| sp > tr.trackers[pn].possible_cities[&f].speedup.iter().sum::<i32>()) {
                    self.favorite_city = Some(c);
                    best_eta = etas[B_CITY];
                    choice = 2;
                }
            }
        }
        if pieces[1] > 0 {
            self.score_settlements_for_dumb(tr, inp, etas[B_SET], &bse, &ports);
            for &c in tr.trackers[pn].possible_settlements.keys() {
                let path_ok = self.dumb_path.get(&c).map_or(true, |p| pieces[0] >= p.len() as i32);
                if !path_ok {
                    continue;
                }
                let eta = self.dumb_eta[&c];
                if eta < best_eta {
                    best_eta = eta;
                    self.favorite_settlement = Some(c);
                    choice = 3;
                } else if eta == best_eta && self.favorite_settlement.is_none() && self.favorite_city.map_or(true, |f| 0 > tr.trackers[pn].possible_cities[&f].speedup.iter().sum::<i32>()) {
                    self.favorite_settlement = Some(c);
                    choice = 3;
                }
            }
        }
        match choice {
            0 => {
                if !special {
                    for _ in 0..knights_to_buy {
                        self.plan.push(Piece::Card);
                    }
                }
            }
            1 => {
                let mut path = best_lr_path.unwrap_or_default();
                while let Some(e) = path.pop() {
                    self.plan.push(Piece::Road(e));
                }
            }
            2 => self.plan.push(Piece::City(self.favorite_city.unwrap())),
            3 => {
                let s = self.favorite_settlement.unwrap();
                self.plan.push(Piece::Settlement(s));
                if !tr.trackers[pn].possible_settlements[&s].necessary_roads.is_empty() {
                    let mut path = self.dumb_path.get(&s).cloned().unwrap_or_default();
                    while let Some(r) = path.pop() {
                        self.plan.push(Piece::Road(r));
                    }
                }
            }
            _ => {}
        }
    }

    /// scoreSettlementsForDumb: a road path to each settlement (BFS through necessary roads) and
    /// its ETA from the current hand.
    fn score_settlements_for_dumb(&mut self, tr: &Trackers, inp: &PlanInput, settlement_eta: i32, bse: &Bse, ports: &super::bse::Ports) {
        let pn = self.pn;
        self.dumb_eta.clear();
        self.dumb_path.clear();
        let t = &tr.trackers[pn];
        for (&c, ps) in &t.possible_settlements {
            if ps.necessary_roads.is_empty() {
                self.dumb_eta.insert(c, settlement_eta);
                continue;
            }
            let mut queue: std::collections::VecDeque<(i32, Option<Vec<i32>>)> = ps.necessary_roads.iter().map(|&r| (r, None)).collect();
            let mut too_long = false;
            let mut path: Option<Vec<i32>> = None;
            let mut max_iter = 50;
            while max_iter > 0 && !queue.is_empty() {
                max_iter -= 1;
                let (cur, to_cur) = queue.pop_front().unwrap();
                let nec = t.possible_roads.get(&cur).map(|r| r.necessary_roads.clone()).unwrap_or_default();
                if nec.is_empty() {
                    let mut p = vec![cur];
                    if let Some(tc) = &to_cur {
                        for &r in tc.iter().rev() {
                            p.push(r);
                        }
                    }
                    path = Some(p);
                    queue.clear();
                } else {
                    let mut and_cur = to_cur.clone().unwrap_or_default();
                    and_cur.push(cur);
                    if queue.len() + nec.len() > 40 {
                        too_long = true;
                        queue.clear();
                        break;
                    }
                    for r in nec {
                        queue.push_back((r, Some(and_cur.clone())));
                    }
                }
            }
            if !queue.is_empty() {
                too_long = true;
            }
            if too_long {
                self.dumb_eta.insert(c, 500);
            } else {
                let mut target = SETTLEMENT_COST;
                if let Some(p) = &path {
                    for _ in 0..p.len() {
                        for r in 0..5 {
                            target[r] += ROAD_COST[r];
                        }
                    }
                }
                self.dumb_eta.insert(c, bse.rolls_fast(&inp.resources, &target, 100, ports));
            }
            if let Some(p) = path {
                self.dumb_path.insert(c, p);
            }
        }
    }
}
