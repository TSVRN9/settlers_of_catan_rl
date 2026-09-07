//! soc.robot.SOCPlayerTracker: every player's possible roads, settlements and cities with the
//! necessary-road chains between them, threats, and the ETAs (longest road, largest army, win the
//! game) the decision maker plans with. One `Trackers` holds all seats, fed the same piece events in
//! the same order as the Java client's brain (`on_piece`); the ETAs are recomputed from a `GameInfo`
//! snapshot the way `SOCPlayerTracker.updateWinGameETAs` does at the start of smart planning.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::bse::{Bse, PlayerNumbers, Ports, CARD, CITY as B_CITY, ROAD as B_ROAD, ROAD_COST, SETTLEMENT as B_SET};
use super::player::LrPath;
use super::geom::Geom;
use super::player::{Board, Player, CITY, ROAD, SETTLEMENT};
use crate::map::Map;

pub const EXPAND_LEVEL: i32 = 1;

/// A possible piece of some tracker, for threat and conflict lists.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ref {
    pub pn: usize,
    pub kind: u8,
    pub coord: i32,
}

#[derive(Clone, Debug, Default)]
pub struct PossibleRoad {
    pub coord: i32,
    pub necessary_roads: Vec<i32>,
    pub new_possibilities: Vec<(u8, i32)>,
    pub n_necessary: i32,
    pub expanded: bool,
    pub threats: Vec<Ref>,
    pub threat_updated: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PossibleSettlement {
    pub coord: i32,
    pub necessary_roads: Vec<i32>,
    pub conflicts: Vec<(usize, i32)>,
    pub n_necessary: i32,
    pub threats: Vec<Ref>,
    pub threat_updated: bool,
    /// SOCPossibleSettlement.updateSpeedup is commented out in the Java: always zero.
    pub speedup: [i32; 5],
}

/// SOCPossibleCity: its speedup is the building-speed gain of the extra production.
#[derive(Clone, Debug, Default)]
pub struct PossibleCity {
    pub coord: i32,
    pub speedup: [i32; 5],
}

#[derive(Clone, Debug)]
pub struct Tracker {
    pub pn: usize,
    pub possible_roads: BTreeMap<i32, PossibleRoad>,
    pub possible_settlements: BTreeMap<i32, PossibleSettlement>,
    pub possible_cities: BTreeMap<i32, PossibleCity>,
    pub longest_road_eta: i32,
    pub roads_to_go: i32,
    pub largest_army_eta: i32,
    pub win_game_eta: i32,
    pub knights_to_buy: i32,
    pub need_lr: bool,
    pub need_la: bool,
}

impl Tracker {
    fn new(pn: usize) -> Tracker {
        Tracker { pn, possible_roads: BTreeMap::new(), possible_settlements: BTreeMap::new(), possible_cities: BTreeMap::new(), longest_road_eta: 500, roads_to_go: 20, largest_army_eta: 500, win_game_eta: 0, knights_to_buy: 0, need_lr: false, need_la: false }
    }
}

/// What the ETAs read from the game beyond the pieces: the client's view (opponents' dev cards are
/// unknown there, so their knight cards count 0). Numbers, ports and road lengths come from the
/// trackers' own pieces, so temporary pieces are seen.
#[derive(Clone, Debug)]
pub struct GameInfo {
    pub lr_player: Option<usize>,
    pub la_player: Option<usize>,
    pub knights: Vec<i32>,
    pub knight_cards_old: Vec<i32>,
    pub knight_cards_new: Vec<i32>,
    pub dev_cards_left: i32,
    /// SOCPlayer.getTotalVP at the snapshot; temporary pieces add to it through `vp_delta`.
    pub total_vp: Vec<i32>,
    pub vp_winner: i32,
}

pub struct Trackers {
    pub map: Arc<Map>,
    pub geom: Geom,
    pub board: Board,
    pub players: Vec<Player>,
    pub trackers: Vec<Tracker>,
    port_res: Vec<i8>, // js node -> -2 none, -1 3:1, else the 2:1 resource
    /// SOCBoard.getPortCoordinates(portType): node coords per JSettlers port type (0 = 3:1), in the
    /// classic layout's port order.
    pub ports_by_type: [Vec<i32>; 6],
    /// Building VP added by temporary pieces, per seat.
    pub vp_delta: Vec<i32>,
    first_turn_done: bool,
}

/// SOCGame.putTempPiece's saved longest-road lengths, restored by undoPutTempPiece.
pub struct TempPiece {
    pub kind: u8,
    pub pn: usize,
    pub coord: i32,
    lr_lengths: Vec<i32>,
}

/// SOCBoard4p.PORTS_EDGE_V1: the port edges in layout order.
const PORTS_EDGE_V1: [i32; 9] = [0x27, 0x5A, 0x9C, 0xCC, 0xC9, 0xA5, 0x72, 0x42, 0x24];

impl Trackers {
    pub fn new(map: Arc<Map>, n: usize, node_js: [u16; crate::map::NUM_NODES]) -> Trackers {
        let geom = Geom::new(&map, node_js);
        let mut port_res = vec![-2i8; 0x100];
        for p in &map.ports {
            for &node in &p.nodes {
                port_res[geom.node_js[node as usize] as usize] = p.resource;
            }
        }
        let mut ports_by_type: [Vec<i32>; 6] = Default::default();
        for &edge in &PORTS_EDGE_V1 {
            let nodes = Geom::nodes_of_edge(edge);
            let Some(p) = map.ports.iter().find(|p| {
                let mut js: Vec<i32> = p.nodes.iter().map(|&x| geom.node_js[x as usize] as i32).collect();
                js.sort();
                let mut want = nodes.to_vec();
                want.sort();
                js == want
            }) else { continue };
            let pt = if p.resource < 0 { 0 } else { super::opening::JS_TYPE[p.resource as usize] };
            ports_by_type[pt].extend_from_slice(&nodes);
        }
        Trackers { players: (0..n).map(|pn| Player::new(pn, &geom)).collect(), trackers: (0..n).map(Tracker::new).collect(), map, geom, board: Board::default(), port_res, ports_by_type, vp_delta: vec![0; n], first_turn_done: false }
    }

    /// SOCGame.putPieceCommon: every player's putPiece, the board, a city's settlement removal, and
    /// the longest-road recalculations the Java does (the placer for a road; the one opponent whose
    /// road a settlement cuts).
    fn put_piece_game(&mut self, kind: u8, pn: usize, coord: i32) {
        for i in 0..self.players.len() {
            let board = &self.board;
            self.players[i].put_piece(kind, coord, pn, board, &self.geom);
        }
        self.board.put(kind, pn, coord);
        match kind {
            CITY => {
                self.players[pn].remove_settlement(coord);
                self.vp_delta[pn] += 1;
            }
            ROAD => {
                let board = &self.board;
                self.players[pn].calc_longest_road2(board, &self.geom);
            }
            _ => {
                self.vp_delta[pn] += 1;
                let mut roads = vec![0; self.players.len()];
                for e in self.geom.adj_edges_to_node(coord) {
                    if let Some(o) = self.board.road_at(e) {
                        roads[o] += 1;
                    }
                }
                for i in 0..self.players.len() {
                    if i != pn && roads[i] == 2 {
                        let board = &self.board;
                        self.players[i].calc_longest_road2(board, &self.geom);
                        break;
                    }
                }
            }
        }
    }

    /// SOCGame.putTempPiece: the piece goes on the real board and players, lengths saved.
    pub fn put_temp(&mut self, kind: u8, pn: usize, coord: i32) -> TempPiece {
        let lr_lengths = self.players.iter().map(|p| p.longest_road_length).collect();
        self.put_piece_game(kind, pn, coord);
        TempPiece { kind, pn, coord, lr_lengths }
    }

    /// SOCGame.undoPutTempPiece: undoPutPieceCommon (board, every player's undoPutPiece, a city's
    /// settlement put back) and the saved lengths restored; the players' LR paths are left as the
    /// temporary piece's recalculation made them, as in the Java.
    pub fn undo_temp(&mut self, t: TempPiece) {
        self.board.remove(t.kind, t.coord);
        let board = self.board.clone();
        for i in 0..self.players.len() {
            self.players[i].undo_put_piece(t.kind, t.coord, t.pn, &board, &self.geom, self.first_turn_done);
        }
        match t.kind {
            CITY => {
                for i in 0..self.players.len() {
                    let board = &self.board;
                    self.players[i].put_piece(SETTLEMENT, t.coord, t.pn, board, &self.geom);
                }
                self.board.put(SETTLEMENT, t.pn, t.coord);
                self.vp_delta[t.pn] -= 1;
            }
            SETTLEMENT => self.vp_delta[t.pn] -= 1,
            _ => {}
        }
        for (p, &len) in self.players.iter_mut().zip(&t.lr_lengths) {
            p.longest_road_length = len;
        }
    }

    pub fn save_lr_paths(&self) -> Vec<Vec<LrPath>> {
        self.players.iter().map(|p| p.lr_paths.clone()).collect()
    }

    pub fn restore_lr_paths(&mut self, saved: &[Vec<LrPath>]) {
        for (p, s) in self.players.iter_mut().zip(saved) {
            p.lr_paths = s.clone();
        }
    }

    /// SOCPlayerTracker.copyPlayerTrackers: the copy constructors keep coordinates, necessary-road
    /// counts and speedups, then the necessary roads, new possibilities and conflicts are relinked
    /// among the copies; threats, scores and the expanded flags start empty.
    pub fn copy_trackers(&self) -> Vec<Tracker> {
        self.trackers
            .iter()
            .map(|t| Tracker {
                pn: t.pn,
                possible_roads: t.possible_roads.iter().map(|(&c, r)| (c, PossibleRoad { coord: c, n_necessary: r.n_necessary, necessary_roads: r.necessary_roads.clone(), new_possibilities: r.new_possibilities.clone(), ..Default::default() })).collect(),
                possible_settlements: t.possible_settlements.iter().map(|(&c, s)| (c, PossibleSettlement { coord: c, n_necessary: s.n_necessary, speedup: s.speedup, necessary_roads: s.necessary_roads.clone(), conflicts: s.conflicts.clone(), ..Default::default() })).collect(),
                possible_cities: t.possible_cities.clone(),
                longest_road_eta: t.longest_road_eta,
                roads_to_go: t.roads_to_go,
                largest_army_eta: t.largest_army_eta,
                knights_to_buy: t.knights_to_buy,
                win_game_eta: 0,
                need_lr: false,
                need_la: false,
            })
            .collect()
    }

    /// Run `f` with `copies` standing in for the trackers (the Java passes the copy array around).
    pub fn with_trackers<R>(&mut self, copies: &mut Vec<Tracker>, f: impl FnOnce(&mut Trackers) -> R) -> R {
        std::mem::swap(&mut self.trackers, copies);
        let r = f(self);
        std::mem::swap(&mut self.trackers, copies);
        r
    }

    /// SOCPlayerTracker.tryPutPiece: copies of the trackers, the piece placed for real (temporarily),
    /// and the copies told about it.
    pub fn try_put_piece(&mut self, kind: u8, pn: usize, coord: i32) -> (Vec<Tracker>, TempPiece) {
        let mut copies = self.copy_trackers();
        let temp = self.put_temp(kind, pn, coord);
        self.with_trackers(&mut copies, |tr| match kind {
            ROAD => {
                for t in 0..tr.trackers.len() {
                    if t == pn {
                        tr.add_our_new_road(t, coord, EXPAND_LEVEL);
                    } else {
                        tr.add_their_new_road(t, coord);
                    }
                }
            }
            SETTLEMENT => {
                for t in 0..tr.trackers.len() {
                    if t == pn {
                        tr.add_our_new_settlement(t, coord);
                    } else {
                        tr.add_their_new_settlement(t, coord, pn);
                    }
                }
            }
            _ => {
                tr.trackers[pn].possible_cities.remove(&coord);
            }
        });
        (copies, temp)
    }

    /// SOCPossibleCity.updateSpeedup: our building speed minus the speed with the city's extra
    /// production.
    fn city_speedup(&self, pn: usize, node: i32) -> [i32; 5] {
        let numbers = self.numbers(pn);
        let ports = self.port_flags(pn);
        let ours = Bse::new(&numbers, None).from_nothing_fast(&ports, 40);
        let mut with = numbers.clone();
        with.add_node_map(&self.map, self.geom.node(node).unwrap());
        let sp = Bse::new(&with, None).from_nothing_fast(&ports, 40);
        let mut out = [0; 5];
        for b in 0..5 {
            out[b] = ours[b] - sp[b];
        }
        out
    }

    fn refresh_speedups(&mut self, pn: usize) {
        let coords: Vec<i32> = self.trackers[pn].possible_cities.keys().copied().collect();
        for c in coords {
            let sp = self.city_speedup(pn, c);
            self.trackers[pn].possible_cities.get_mut(&c).unwrap().speedup = sp;
        }
    }

    pub fn port_res_at(&self, node: i32) -> i8 {
        self.port_res[node as usize]
    }

    pub fn port_flag_at(&self, ports: &mut Ports, node: i32) {
        self.port_flag(ports, node)
    }

    fn port_flag(&self, ports: &mut Ports, node: i32) {
        match self.port_res[node as usize] {
            -2 => {}
            -1 => ports.misc = true,
            r => ports.res[r as usize] = true,
        }
    }

    /// SOCGame.updateAtGameFirstTurn: when regular play starts, every player's potential
    /// settlements are cleared (they come back only through new roads). Idempotent.
    pub fn first_turn(&mut self) {
        if !self.first_turn_done {
            for p in &mut self.players {
                p.potential_settlements.clear();
            }
            self.first_turn_done = true;
        }
    }

    /// One piece placed, in server order (`initial`: during initial placement).
    pub fn on_piece(&mut self, kind: u8, pn: usize, coord: i32, initial: bool) {
        if !initial {
            self.first_turn();
        }
        self.put_piece_game(kind, pn, coord);
        self.vp_delta[pn] = 0; // a real piece: the caller's snapshot carries the VP
        match kind {
            ROAD => self.track_new_road(coord, pn),
            SETTLEMENT => {
                self.track_new_settlement(coord, pn);
                self.refresh_speedups(pn);
            }
            _ => {
                self.trackers[pn].possible_cities.remove(&coord);
                self.refresh_speedups(pn);
            }
        }
    }

    // ------------------------------------------------------------ SOCRobotBrain.trackNew*

    fn track_new_road(&mut self, coord: i32, pn: usize) {
        for t in 0..self.trackers.len() {
            if t == pn {
                self.add_our_new_road(t, coord, EXPAND_LEVEL);
            } else {
                self.add_their_new_road(t, coord);
            }
        }
        self.clear_threats();
        for t in 0..self.trackers.len() {
            self.update_threats(t);
        }
    }

    fn track_new_settlement(&mut self, coord: i32, pn: usize) {
        for t in 0..self.trackers.len() {
            if t == pn {
                self.add_our_new_settlement(t, coord);
            } else {
                self.add_their_new_settlement(t, coord, pn);
            }
        }
        self.clear_threats();
        for t in 0..self.trackers.len() {
            self.update_threats(t);
        }
    }

    fn clear_threats(&mut self) {
        for tr in &mut self.trackers {
            for pr in tr.possible_roads.values_mut() {
                if pr.threat_updated {
                    pr.threats.clear();
                    pr.threat_updated = false;
                }
            }
            for ps in tr.possible_settlements.values_mut() {
                if ps.threat_updated {
                    ps.threats.clear();
                    ps.threat_updated = false;
                }
            }
        }
    }

    // ------------------------------------------------------------ roads

    fn add_our_new_road(&mut self, t: usize, coord: i32, expand_level: i32) {
        for pr in self.trackers[t].possible_roads.values_mut() {
            pr.expanded = false;
        }
        if self.trackers[t].possible_roads.contains_key(&coord) {
            self.remove_from_necessary_roads_r(t, coord);
            self.trackers[t].possible_roads.remove(&coord);
        }
        for node in self.geom.adj_nodes_to_edge(coord) {
            if self.players[t].can_place_settlement(node) {
                if self.trackers[t].possible_settlements.contains_key(&node) {
                    self.remove_from_necessary_roads_s(t, node);
                    let ps = self.trackers[t].possible_settlements.get_mut(&node).unwrap();
                    ps.necessary_roads.clear();
                    ps.n_necessary = 0;
                } else {
                    self.trackers[t].possible_settlements.insert(node, PossibleSettlement { coord: node, n_necessary: 0, ..Default::default() });
                    self.update_settlement_conflicts(t, node);
                }
            }
        }
        let mut new_roads = vec![];
        let mut to_expand = vec![];
        for edge in self.geom.adj_edges_to_edge(coord) {
            if !self.players[t].is_potential_road(edge) {
                continue;
            }
            if let Some(pr) = self.trackers[t].possible_roads.get_mut(&edge) {
                if !pr.necessary_roads.is_empty() {
                    self.remove_from_necessary_roads_r(t, edge);
                    let pr = self.trackers[t].possible_roads.get_mut(&edge).unwrap();
                    pr.necessary_roads.clear();
                    pr.n_necessary = 0;
                }
                let pr = self.trackers[t].possible_roads.get_mut(&edge).unwrap();
                to_expand.push(edge);
                pr.expanded = true;
            } else {
                new_roads.push(PossibleRoad { coord: edge, n_necessary: 0, expanded: true, ..Default::default() });
                to_expand.push(edge);
            }
        }
        for pr in new_roads {
            self.trackers[t].possible_roads.insert(pr.coord, pr);
        }
        let mut dummy = self.players[t].clone();
        for edge in to_expand {
            self.expand_road(t, edge, &mut dummy, expand_level);
        }
    }

    /// expandRoadOrShip: put the road on a dummy player, add the settlements and roads it opens.
    fn expand_road(&mut self, t: usize, target: i32, dummy: &mut Player, level: i32) {
        let board = self.board.clone();
        dummy.put_piece(ROAD, target, t, &board, &self.geom);
        for node in self.geom.adj_nodes_to_edge(target) {
            if !dummy.can_place_settlement(node) {
                continue;
            }
            let target_n = self.trackers[t].possible_roads[&target].n_necessary;
            if let Some(ps) = self.trackers[t].possible_settlements.get_mut(&node) {
                if !(ps.necessary_roads.is_empty() || ps.necessary_roads.contains(&target)) {
                    ps.necessary_roads.push(target);
                    if target_n + 1 < ps.n_necessary {
                        ps.n_necessary = target_n + 1;
                    }
                    self.trackers[t].possible_roads.get_mut(&target).unwrap().new_possibilities.push((SETTLEMENT, node));
                }
            } else {
                self.trackers[t].possible_settlements.insert(node, PossibleSettlement { coord: node, necessary_roads: vec![target], n_necessary: target_n + 1, ..Default::default() });
                self.trackers[t].possible_roads.get_mut(&target).unwrap().new_possibilities.push((SETTLEMENT, node));
                self.update_settlement_conflicts(t, node);
            }
        }
        if level > 0 && dummy.num_pieces[0] > 0 {
            let mut new_roads = vec![];
            let mut to_expand = vec![];
            for edge in self.geom.adj_edges_to_edge(target) {
                if !dummy.is_potential_road(edge) {
                    continue;
                }
                let target_n = self.trackers[t].possible_roads[&target].n_necessary;
                if let Some(pr) = self.trackers[t].possible_roads.get_mut(&edge) {
                    if !(pr.necessary_roads.is_empty() || pr.necessary_roads.contains(&target)) {
                        pr.necessary_roads.push(target);
                        if target_n + 1 < pr.n_necessary {
                            pr.n_necessary = target_n + 1;
                        }
                        self.trackers[t].possible_roads.get_mut(&target).unwrap().new_possibilities.push((ROAD, edge));
                    }
                    let pr = self.trackers[t].possible_roads.get_mut(&edge).unwrap();
                    if !pr.expanded {
                        to_expand.push(edge);
                        pr.expanded = true;
                    }
                } else {
                    new_roads.push(PossibleRoad { coord: edge, necessary_roads: vec![target], n_necessary: target_n + 1, expanded: true, ..Default::default() });
                    self.trackers[t].possible_roads.get_mut(&target).unwrap().new_possibilities.push((ROAD, edge));
                    to_expand.push(edge);
                }
            }
            for pr in new_roads {
                self.trackers[t].possible_roads.insert(pr.coord, pr);
            }
            for edge in to_expand {
                self.expand_road(t, edge, dummy, level - 1);
            }
        }
        dummy.remove_road(target, &board, &self.geom);
    }

    fn add_their_new_road(&mut self, t: usize, coord: i32) {
        if self.trackers[t].possible_roads.contains_key(&coord) {
            self.remove_from_necessary_roads_r(t, coord);
            let pr = self.trackers[t].possible_roads.remove(&coord).unwrap();
            self.remove_dependents(t, &pr);
        }
    }

    // ------------------------------------------------------------ settlements

    fn update_settlement_conflicts(&mut self, t: usize, coord: i32) {
        let adj = self.geom.adj_nodes_to_node(coord);
        for o in 0..self.trackers.len() {
            if o != t && self.trackers[o].possible_settlements.contains_key(&coord) {
                self.trackers[t].possible_settlements.get_mut(&coord).unwrap().conflicts.push((o, coord));
                self.trackers[o].possible_settlements.get_mut(&coord).unwrap().conflicts.push((t, coord));
            }
            for &n in &adj {
                if self.trackers[o].possible_settlements.contains_key(&n) {
                    self.trackers[t].possible_settlements.get_mut(&coord).unwrap().conflicts.push((o, n));
                    self.trackers[o].possible_settlements.get_mut(&n).unwrap().conflicts.push((t, coord));
                }
            }
        }
    }

    fn remove_conflict_everywhere(&mut self, victim: (usize, i32)) {
        let conflicts = match self.trackers[victim.0].possible_settlements.get(&victim.1) {
            Some(ps) => ps.conflicts.clone(),
            None => return,
        };
        for (o, c) in conflicts {
            if let Some(ps) = self.trackers[o].possible_settlements.get_mut(&c) {
                ps.conflicts.retain(|&x| x != victim);
            }
        }
    }

    fn add_our_new_settlement(&mut self, t: usize, coord: i32) {
        let speedup = self.city_speedup(t, coord);
        self.trackers[t].possible_cities.insert(coord, PossibleCity { coord, speedup });
        if self.trackers[t].possible_settlements.contains_key(&coord) {
            let conflicts = self.trackers[t].possible_settlements[&coord].conflicts.clone();
            self.trackers[t].possible_settlements.remove(&coord);
            self.remove_from_necessary_roads_s(t, coord);
            for (o, c) in conflicts {
                if self.trackers[o].possible_settlements.contains_key(&c) {
                    self.remove_conflict_everywhere((o, c));
                    self.trackers[o].possible_settlements.remove(&c);
                    self.remove_from_necessary_roads_s(o, c);
                }
            }
        } else {
            let adj = self.geom.adj_nodes_to_node(coord);
            for o in 0..self.trackers.len() {
                let mut trash = vec![];
                if self.trackers[o].possible_settlements.contains_key(&coord) {
                    trash.push(coord);
                    self.remove_conflict_everywhere((o, coord));
                }
                for &n in &adj {
                    if self.trackers[o].possible_settlements.contains_key(&n) {
                        trash.push(n);
                        self.remove_conflict_everywhere((o, n));
                    }
                }
                for c in trash {
                    self.trackers[o].possible_settlements.remove(&c);
                    self.remove_from_necessary_roads_s(o, c);
                }
            }
        }
    }

    fn add_their_new_settlement(&mut self, t: usize, coord: i32, settle_pn: usize) {
        let adj_edges = self.geom.adj_edges_to_node(coord);
        for &edge1 in &adj_edges {
            let mut pr_trash = vec![];
            if let Some(pr) = self.trackers[t].possible_roads.get_mut(&edge1) {
                if pr.necessary_roads.is_empty() {
                    if pr.threats.iter().any(|th| th.kind == SETTLEMENT && th.coord == coord && th.pn == settle_pn) {
                        pr_trash.push(edge1);
                    }
                } else {
                    let nr_trash: Vec<i32> = pr.necessary_roads.iter().copied().filter(|nr| adj_edges.contains(nr)).collect();
                    if !nr_trash.is_empty() {
                        for nr in &nr_trash {
                            let pr = self.trackers[t].possible_roads.get_mut(&edge1).unwrap();
                            pr.necessary_roads.retain(|x| x != nr);
                            if let Some(nrr) = self.trackers[t].possible_roads.get_mut(nr) {
                                nrr.new_possibilities.retain(|&x| x != (ROAD, edge1));
                            }
                        }
                        if self.trackers[t].possible_roads[&edge1].necessary_roads.is_empty() {
                            pr_trash.push(edge1);
                        }
                    }
                }
            }
            for c in pr_trash {
                self.remove_from_necessary_roads_r(t, c);
                let pr = self.trackers[t].possible_roads.remove(&c).unwrap();
                self.remove_dependents(t, &pr);
            }
        }
    }

    // ------------------------------------------------------------ dependency bookkeeping

    fn remove_dependents(&mut self, t: usize, road: &PossibleRoad) {
        for &(kind, c) in &road.new_possibilities {
            if kind == ROAD {
                let Some(pr) = self.trackers[t].possible_roads.get_mut(&c) else { continue };
                if pr.necessary_roads.is_empty() {
                    continue; // "ERROR in removeDependents - empty nr list"
                }
                pr.necessary_roads.retain(|&x| x != road.coord);
                if pr.necessary_roads.is_empty() {
                    self.remove_from_necessary_roads_r(t, c);
                    let pr = self.trackers[t].possible_roads.remove(&c).unwrap();
                    self.remove_dependents(t, &pr);
                } else {
                    let nrs = pr.necessary_roads.clone();
                    let mut smallest = 40;
                    for nr in nrs {
                        let n = self.trackers[t].possible_roads.get(&nr).map_or(-1, |x| x.n_necessary);
                        if n + 1 < smallest {
                            smallest = n + 1;
                        }
                    }
                    self.trackers[t].possible_roads.get_mut(&c).unwrap().n_necessary = smallest;
                }
            } else {
                let Some(ps) = self.trackers[t].possible_settlements.get_mut(&c) else { continue };
                if ps.necessary_roads.is_empty() {
                    continue;
                }
                ps.necessary_roads.retain(|&x| x != road.coord);
                if ps.necessary_roads.is_empty() {
                    self.remove_from_necessary_roads_s(t, c);
                    self.remove_conflict_everywhere((t, c));
                    self.trackers[t].possible_settlements.remove(&c);
                } else {
                    let nrs = ps.necessary_roads.clone();
                    let mut smallest = 40;
                    for nr in nrs {
                        let n = self.trackers[t].possible_roads.get(&nr).map_or(-1, |x| x.n_necessary);
                        if n + 1 < smallest {
                            smallest = n + 1;
                        }
                    }
                    self.trackers[t].possible_settlements.get_mut(&c).unwrap().n_necessary = smallest;
                }
            }
        }
    }

    fn remove_from_necessary_roads_r(&mut self, t: usize, coord: i32) {
        let nrs = self.trackers[t].possible_roads.get(&coord).map(|pr| pr.necessary_roads.clone()).unwrap_or_default();
        for nr in nrs {
            if let Some(x) = self.trackers[t].possible_roads.get_mut(&nr) {
                x.new_possibilities.retain(|&p| p != (ROAD, coord));
            }
        }
    }

    fn remove_from_necessary_roads_s(&mut self, t: usize, coord: i32) {
        let nrs = self.trackers[t].possible_settlements.get(&coord).map(|ps| ps.necessary_roads.clone()).unwrap_or_default();
        for nr in nrs {
            if let Some(x) = self.trackers[t].possible_roads.get_mut(&nr) {
                x.new_possibilities.retain(|&p| p != (SETTLEMENT, coord));
            }
        }
    }

    // ------------------------------------------------------------ threats

    fn add_threat(list: &mut Vec<Ref>, r: Ref) {
        if !list.contains(&r) {
            list.push(r);
        }
    }

    fn update_threats(&mut self, t: usize) {
        let n = self.trackers.len();
        let coords: Vec<i32> = self.trackers[t].possible_roads.keys().copied().collect();
        for &coord in &coords {
            let (updated, nr_empty) = {
                let pr = &self.trackers[t].possible_roads[&coord];
                (pr.threat_updated, pr.necessary_roads.is_empty())
            };
            if updated || !nr_empty {
                continue;
            }
            let mut threats = self.trackers[t].possible_roads[&coord].threats.clone();
            let pos_nodes = Geom::nodes_of_edge(coord);
            for adj_edge in self.geom.adj_edges_to_edge(coord) {
                if !self.players[t].has_road_at(adj_edge) {
                    continue;
                }
                let real_nodes = Geom::nodes_of_edge(adj_edge);
                for &pn_node in &pos_nodes {
                    for &rn in &real_nodes {
                        if pn_node != rn {
                            continue;
                        }
                        for o in 0..n {
                            if o != t && self.trackers[o].possible_settlements.contains_key(&pn_node) {
                                Trackers::add_threat(&mut threats, Ref { pn: o, kind: SETTLEMENT, coord: pn_node });
                            }
                        }
                    }
                }
            }
            for o in 0..n {
                if o != t && self.trackers[o].possible_roads.contains_key(&coord) {
                    Trackers::add_threat(&mut threats, Ref { pn: o, kind: ROAD, coord });
                }
            }
            self.trackers[t].possible_roads.get_mut(&coord).unwrap().threats = threats.clone();
            // the threats propagate down chains whose only necessary road is the threatened one
            let mut stack = vec![coord];
            while let Some(cur) = stack.pop() {
                let nps = self.trackers[t].possible_roads[&cur].new_possibilities.clone();
                for (kind, c) in nps {
                    if kind != ROAD {
                        continue;
                    }
                    let Some(np) = self.trackers[t].possible_roads.get_mut(&c) else { continue };
                    if np.necessary_roads.len() == 1 && np.necessary_roads[0] == cur {
                        for &th in &threats {
                            Trackers::add_threat(&mut np.threats, th);
                        }
                    }
                    stack.push(c);
                }
            }
            self.trackers[t].possible_roads.get_mut(&coord).unwrap().threat_updated = true;
        }
        for &coord in &coords {
            if self.trackers[t].possible_roads[&coord].threat_updated {
                continue;
            }
            for o in 0..n {
                if o != t && self.trackers[o].possible_roads.contains_key(&coord) {
                    let pr = self.trackers[t].possible_roads.get_mut(&coord).unwrap();
                    Trackers::add_threat(&mut pr.threats, Ref { pn: o, kind: ROAD, coord });
                    pr.threat_updated = true;
                }
            }
            let nrs = self.trackers[t].possible_roads[&coord].necessary_roads.clone();
            if nrs.len() == 1 {
                let nec = nrs[0];
                for n1 in Geom::nodes_of_edge(coord) {
                    for n2 in Geom::nodes_of_edge(nec) {
                        if n1 != n2 {
                            continue;
                        }
                        for o in 0..n {
                            if o != t && self.trackers[o].possible_settlements.contains_key(&n1) {
                                let pr = self.trackers[t].possible_roads.get_mut(&coord).unwrap();
                                Trackers::add_threat(&mut pr.threats, Ref { pn: o, kind: SETTLEMENT, coord: n1 });
                            }
                        }
                    }
                }
            }
            self.trackers[t].possible_roads.get_mut(&coord).unwrap().threat_updated = true;
        }
        let scoords: Vec<i32> = self.trackers[t].possible_settlements.keys().copied().collect();
        for coord in scoords {
            if self.trackers[t].possible_settlements[&coord].threat_updated {
                continue;
            }
            for o in 0..n {
                if o != t && self.trackers[o].possible_settlements.contains_key(&coord) {
                    let ps = self.trackers[t].possible_settlements.get_mut(&coord).unwrap();
                    Trackers::add_threat(&mut ps.threats, Ref { pn: o, kind: SETTLEMENT, coord });
                }
            }
            let nrs = self.trackers[t].possible_settlements[&coord].necessary_roads.clone();
            if nrs.len() == 1 {
                let ths = self.trackers[t].possible_roads.get(&nrs[0]).map(|r| r.threats.clone()).unwrap_or_default();
                let ps = self.trackers[t].possible_settlements.get_mut(&coord).unwrap();
                for th in ths {
                    Trackers::add_threat(&mut ps.threats, th);
                }
            } else if nrs.len() > 1 {
                let first = self.trackers[t].possible_roads.get(&nrs[0]).map(|r| r.threats.clone()).unwrap_or_default();
                for th in first {
                    let all = nrs[1..].iter().all(|nr2| self.trackers[t].possible_roads.get(nr2).map_or(false, |r| r.threats.contains(&th)));
                    if all {
                        let ps = self.trackers[t].possible_settlements.get_mut(&coord).unwrap();
                        Trackers::add_threat(&mut ps.threats, th);
                    }
                }
            }
            self.trackers[t].possible_settlements.get_mut(&coord).unwrap().threat_updated = true;
        }
    }

    // ------------------------------------------------------------ ETAs

    /// SOCPlayerTracker.updateWinGameETAs on every tracker.
    pub fn update_win_game_etas(&mut self, info: &GameInfo) {
        for t in 0..self.trackers.len() {
            self.recalc_longest_road_eta(t, info);
            self.recalc_largest_army_eta(t, info);
            self.recalc_win_game_eta(t, info);
        }
    }

    pub fn recalc_longest_road_eta(&mut self, t: usize, info: &GameInfo) {
        let bse = Bse::new(&self.numbers(t), None);
        let road_eta = bse.rolls_fast(&[0; 5], &ROAD_COST, 500, &self.port_flags(t));
        let mut roads_to_go = 500;
        if info.lr_player == Some(t) {
            roads_to_go = 0;
        } else {
            let lr_len = match info.lr_player {
                None => self.players[t].longest_road_length.max(4),
                Some(p) => self.players[p].longest_road_length,
            };
            for path in self.players[t].lr_paths.clone() {
                let depth = ((lr_len + 1) - path.len).min(self.players[t].num_pieces[0]);
                roads_to_go = roads_to_go.min(self.lr_eta_aux(t, path.begin, path.len, lr_len, depth));
                roads_to_go = roads_to_go.min(self.lr_eta_aux(t, path.end, path.len, lr_len, depth));
            }
        }
        self.trackers[t].roads_to_go = roads_to_go;
        self.trackers[t].longest_road_eta = roads_to_go * road_eta;
    }

    /// SOCRobotDM.recalcLongestRoadETAAux (the count, not the path).
    fn lr_eta_aux(&self, t: usize, start: i32, path_len: i32, lr_len: i32, depth: i32) -> i32 {
        self.lr_eta_search(t, start, path_len, lr_len, depth).0
    }

    /// recalcLongestRoadETAAux with wantsStack: the edges (root first) of the best extension.
    pub fn lr_eta_path(&self, t: usize, start: i32, path_len: i32, lr_len: i32, depth: i32) -> Option<Vec<i32>> {
        let (n, nodes) = self.lr_eta_search(t, start, path_len, lr_len, depth);
        if n == 500 {
            return None;
        }
        let nodes = nodes?;
        if nodes.len() < 2 {
            return None;
        }
        Some(nodes.windows(2).map(|w| super::geom::edge_between(w[1], w[0])).collect())
    }

    /// The search behind both: (roads to go or 500, the node list of the best path when found).
    fn lr_eta_search(&self, t: usize, start: i32, path_len: i32, lr_len: i32, depth: i32) -> (i32, Option<Vec<i32>>) {
        let pl = &self.players[t];
        let mut longest = 0;
        let mut num_roads = 500;
        let mut best: Option<Vec<i32>> = None;
        let mut pending: Vec<(i32, i32, Vec<i32>, Option<Vec<i32>>)> = vec![(start, path_len, vec![], None)];
        while let Some((coord, mut len, visited, parents)) = pending.pop() {
            let cur_len = len;
            let mut path_end = false;
            if len > 0 {
                if let Some(p) = self.board.settlement_at(coord) {
                    if p != t {
                        path_end = true;
                    }
                }
            }
            if !path_end {
                for pd in &pl.lr_paths {
                    if start != pd.begin && start != pd.end && (coord == pd.begin || coord == pd.end) {
                        path_end = true;
                        len += pd.len;
                        break;
                    }
                }
            }
            if !path_end && (len - path_len) >= depth {
                path_end = true;
            }
            if !path_end {
                path_end = true;
                for dir in 0..3 {
                    let j = self.geom.adj_edge_to_node(coord, dir);
                    if pl.is_legal_road(j) && !visited.contains(&j) {
                        let mut nv = visited.clone();
                        nv.push(j);
                        let mut np = parents.clone().unwrap_or_default();
                        np.push(coord);
                        let next = self.geom.adj_node_to_node(coord, dir);
                        pending.push((next, len + 1, nv, Some(np)));
                        path_end = false;
                    }
                }
            }
            if path_end {
                let mut record = false;
                if len > longest {
                    longest = len;
                    num_roads = cur_len - path_len;
                    record = true;
                } else if len == longest && cur_len < num_roads {
                    num_roads = cur_len - path_len;
                    record = true;
                }
                if record {
                    best = parents.map(|mut p| {
                        p.push(coord);
                        p
                    });
                }
            }
        }
        if longest > lr_len { (num_roads, best) } else { (500, None) }
    }

    pub fn recalc_largest_army_eta(&mut self, t: usize, info: &GameInfo) {
        let la_size = match info.la_player {
            None => 3,
            Some(p) if p == t => {
                self.trackers[t].largest_army_eta = 0;
                return;
            }
            Some(p) => info.knights[p] + 1,
        };
        let mut knights_to_buy = 0;
        if info.knights[t] + info.knight_cards_old[t] + info.knight_cards_new[t] < la_size {
            knights_to_buy = la_size - (info.knights[t] + info.knight_cards_old[t]);
        }
        self.trackers[t].knights_to_buy = knights_to_buy;
        self.trackers[t].largest_army_eta = if info.dev_cards_left >= knights_to_buy {
            let card_eta = Bse::new(&self.numbers(t), None).from_nothing_fast(&self.port_flags(t), 40)[CARD];
            (card_eta + 1) * knights_to_buy
        } else {
            500
        };
    }

    /// calcTotalNecessaryRoads: the roads along the necessary-road chain, capped at 40.
    fn total_necessary_roads(&self, t: usize, coord: i32) -> i32 {
        let ps = &self.trackers[t].possible_settlements[&coord];
        if ps.necessary_roads.is_empty() {
            return 0;
        }
        let mut total = 0;
        let mut queue: std::collections::VecDeque<(i32, Vec<i32>)> = std::collections::VecDeque::new();
        queue.push_back((0, ps.necessary_roads.clone()));
        let mut max_iter = 50;
        while max_iter > 0 && !queue.is_empty() {
            max_iter -= 1;
            let (n, nrs) = queue.pop_front().unwrap();
            total = n;
            if nrs.is_empty() {
                queue.clear();
            } else {
                if queue.len() + nrs.len() > 40 {
                    total = 40;
                    queue.clear();
                    break;
                }
                for nr in nrs {
                    let next = self.trackers[t].possible_roads.get(&nr).map(|r| r.necessary_roads.clone()).unwrap_or_default();
                    queue.push_back((total + 1, next));
                }
            }
        }
        if !queue.is_empty() {
            total = 40;
        }
        total
    }

    fn speedup_total(our: &[i32; 5], other: &[i32; 5], strict: bool) -> i32 {
        (0..5).map(|b| our[b] - other[b]).filter(|&d| if strict { d > 0 } else { d >= 0 }).sum()
    }

    fn ports_plus(&self, base: &Ports, node: i32) -> Ports {
        let mut p = *base;
        self.port_flag(&mut p, node);
        p
    }

    /// SOCPlayerTracker.recalcWinGameETA: rolls until 10 VP, greedily two points at a time.
    pub fn recalc_win_game_eta(&mut self, t: usize, info: &GameInfo) {
        let map = self.map.clone();
        let node_id = |c: i32| self.geom.node(c).unwrap();
        let mut need_lr = false;
        let mut need_la = false;
        let mut win_game_eta = 0;
        let mut temp_numbers = self.numbers(t);
        let mut temp_ports = self.port_flags(t);
        let mut chosen_set_speed = [[0i32; 5]; 2];
        let mut chosen_city_speed = [[0i32; 5]; 2];
        let mut our_speed = Bse::new(&temp_numbers, None).from_nothing_fast(&temp_ports, 40);
        let mut city_eta = our_speed[B_CITY];
        let mut settlement_eta = our_speed[B_SET];
        let mut road_eta = our_speed[B_ROAD];
        let mut card_eta = our_speed[CARD];
        let mut settlement_pieces_left = self.players[t].num_pieces[1];
        let mut city_pieces_left = self.players[t].num_pieces[2];
        let mut city_spots_left = self.trackers[t].possible_cities.len() as i32;
        let have_la = info.la_player == Some(t);
        let have_lr = info.lr_player == Some(t);
        let mut temp_la_eta = self.trackers[t].largest_army_eta;
        let mut temp_lr_eta = self.trackers[t].longest_road_eta;
        let roads_to_go = self.trackers[t].roads_to_go;
        let mut knights_to_buy = self.trackers[t].knights_to_buy;
        let mut pos_sets: BTreeMap<i32, PossibleSettlement> = self.trackers[t].possible_settlements.clone();
        let mut pos_cities: BTreeMap<i32, ()> = self.trackers[t].possible_cities.keys().map(|&c| (c, ())).collect();
        let mut points = info.total_vp[t] + self.vp_delta[t];
        let vp_winner = info.vp_winner;
        // ETA of a settlement after its necessary roads, with the speedups its numbers and port bring
        let speed_at = |numbers: &mut PlayerNumbers, ports: &Ports, node: i32| -> [i32; 5] {
            numbers.add_node_map(&map, node_id(node));
            let s = Bse::new(numbers, None).from_nothing_fast(ports, 40);
            numbers.remove_node_map(&map, node_id(node));
            s
        };
        while points < vp_winner {
            let mut fastest_eta;
            if points == vp_winner - 1 {
                fastest_eta = 500;
                let mut chosen_set: Option<i32> = None;
                if settlement_pieces_left > 0 && !pos_sets.is_empty() {
                    for ps in pos_sets.values() {
                        let eta = settlement_eta + ps.n_necessary * road_eta;
                        if eta < fastest_eta {
                            fastest_eta = eta;
                            chosen_set = Some(ps.coord);
                        }
                    }
                    fastest_eta = match chosen_set {
                        Some(c) => settlement_eta + self.total_necessary_roads_in(&pos_sets, t, c) * road_eta,
                        None => 500,
                    };
                }
                if city_pieces_left > 0 && city_spots_left > 0 && city_eta <= fastest_eta {
                    fastest_eta = city_eta;
                }
                if !have_la && !need_la && temp_la_eta < fastest_eta {
                    fastest_eta = temp_la_eta;
                }
                if !have_lr && !need_lr && temp_lr_eta < fastest_eta {
                    fastest_eta = temp_lr_eta;
                }
                if !have_lr && !need_lr && fastest_eta == temp_lr_eta {
                    need_lr = true;
                } else if !have_la && !need_la && fastest_eta == temp_la_eta {
                    need_la = true;
                }
                win_game_eta += fastest_eta;
                points += 2;
            } else {
                fastest_eta = 500;
                let mut chosen_set: [Option<i32>; 2] = [None, None];
                let mut temp_ports_set = [temp_ports; 2];
                let mut chosen_city: [Option<i32>; 2] = [None, None];
                let mut two_settlements = 0;
                let mut two_cities = 500;
                let mut one_of_each = 0;
                let mut city_before_settlement = 500;
                let mut settlement_before_city = 500;
                if city_pieces_left > 1 && city_spots_left > 1 {
                    two_cities = 500;
                    for &c in pos_cities.keys() {
                        chosen_city_speed[0] = speed_at(&mut temp_numbers, &temp_ports, c);
                        let temp_city_eta = chosen_city_speed[0][B_CITY];
                        if city_eta + temp_city_eta < two_cities {
                            chosen_city[0] = Some(c);
                            two_cities = city_eta + temp_city_eta;
                        }
                    }
                    if two_cities <= fastest_eta {
                        fastest_eta = two_cities;
                    }
                }
                let mut can_build_2 = false;
                if settlement_pieces_left > 1 && pos_sets.len() > 1 {
                    can_build_2 = true;
                    let mut put_back: Vec<PossibleSettlement> = vec![];
                    let mut removed_first: Option<PossibleSettlement> = None;
                    for i in 0..2 {
                        let mut fastest_set_eta = 500;
                        let mut best_speedup = 0;
                        if pos_sets.is_empty() {
                            can_build_2 = false;
                        } else {
                            for ps in pos_sets.values() {
                                let eta = settlement_eta + ps.n_necessary * road_eta;
                                if eta < fastest_set_eta {
                                    fastest_set_eta = eta;
                                    temp_ports_set[i] = self.ports_plus(&temp_ports, ps.coord);
                                    chosen_set_speed[i] = speed_at(&mut temp_numbers, &temp_ports_set[i], ps.coord);
                                    best_speedup += Trackers::speedup_total(&our_speed, &chosen_set_speed[i], true);
                                    chosen_set[i] = Some(ps.coord);
                                } else if eta == fastest_set_eta {
                                    let vp = self.ports_plus(&temp_ports, ps.coord);
                                    let sp = speed_at(&mut temp_numbers, &vp, ps.coord);
                                    let total = Trackers::speedup_total(&our_speed, &sp, false);
                                    if total > best_speedup {
                                        fastest_set_eta = eta;
                                        best_speedup = total;
                                        chosen_set_speed[i] = sp;
                                        temp_ports_set[i] = vp;
                                        chosen_set[i] = Some(ps.coord);
                                    }
                                }
                            }
                            let total_nec = chosen_set[i].map_or(0, |c| self.total_necessary_roads_in(&pos_sets, t, c));
                            if i == 0 {
                                if let Some(c) = chosen_set[0] {
                                    let ps = pos_sets.remove(&c).unwrap();
                                    for &(o, cc) in &ps.conflicts {
                                        if o == t {
                                            if let Some(conf) = pos_sets.remove(&cc) {
                                                put_back.push(conf);
                                            }
                                        }
                                    }
                                    removed_first = Some(ps);
                                    two_settlements += settlement_eta + total_nec * road_eta;
                                }
                            }
                            if i == 1 && chosen_set[1].is_some() {
                                two_settlements += chosen_set_speed[0][B_SET] + total_nec * chosen_set_speed[0][B_ROAD];
                            }
                        }
                    }
                    if let Some(ps) = removed_first {
                        pos_sets.insert(ps.coord, ps);
                    }
                    for ps in put_back {
                        pos_sets.insert(ps.coord, ps);
                    }
                    if can_build_2 && two_settlements <= fastest_eta {
                        fastest_eta = two_settlements;
                    }
                }
                let one_of_each_possible = city_pieces_left > 0 && ((settlement_pieces_left > 0 && city_spots_left >= 0) || (settlement_pieces_left >= 0 && city_spots_left > 0)) && !pos_sets.is_empty();
                if one_of_each_possible {
                    if chosen_city[0].is_none() && city_spots_left > 0 {
                        let mut best = 0;
                        for &c in pos_cities.keys() {
                            let sp = speed_at(&mut temp_numbers, &temp_ports, c);
                            let total = Trackers::speedup_total(&our_speed, &sp, false);
                            if total >= best {
                                best = total;
                                chosen_city_speed[0] = sp;
                                chosen_city[0] = Some(c);
                            }
                        }
                    }
                    if chosen_set[0].is_none() {
                        let mut fastest_set_eta = 500;
                        let mut best_speedup = 0;
                        for ps in pos_sets.values() {
                            let eta = settlement_eta + ps.n_necessary * road_eta;
                            if eta < fastest_set_eta {
                                fastest_set_eta = eta;
                                temp_ports_set[0] = self.ports_plus(&temp_ports, ps.coord);
                                chosen_set_speed[0] = speed_at(&mut temp_numbers, &temp_ports_set[0], ps.coord);
                                best_speedup += Trackers::speedup_total(&our_speed, &chosen_set_speed[0], true);
                                chosen_set[0] = Some(ps.coord);
                            } else if eta == fastest_set_eta {
                                let vp = self.ports_plus(&temp_ports, ps.coord);
                                let sp = speed_at(&mut temp_numbers, &vp, ps.coord);
                                let total = Trackers::speedup_total(&our_speed, &sp, false);
                                if total > best_speedup {
                                    fastest_set_eta = eta;
                                    best_speedup = total;
                                    chosen_set_speed[0] = sp;
                                    temp_ports_set[0] = vp;
                                    chosen_set[0] = Some(ps.coord);
                                }
                            }
                        }
                    }
                    if city_spots_left == 0 {
                        chosen_city[0] = chosen_set[0];
                    }
                    let total_nec = chosen_set[0].map_or(0, |c| self.total_necessary_roads_in(&pos_sets, t, c));
                    if settlement_pieces_left > 0 && city_spots_left >= 0 {
                        settlement_before_city = chosen_set_speed[0][B_CITY] + settlement_eta + total_nec * road_eta;
                    }
                    if settlement_pieces_left >= 0 && city_spots_left > 0 {
                        city_before_settlement = city_eta + chosen_city_speed[0][B_SET] + total_nec * chosen_city_speed[0][B_ROAD];
                    }
                    one_of_each = settlement_before_city.min(city_before_settlement);
                    if one_of_each <= fastest_eta {
                        fastest_eta = one_of_each;
                    }
                }
                if !have_la && !need_la && points > 5 {
                    let la_size = match info.la_player {
                        None => 3,
                        Some(p) if p == t => 0,
                        Some(p) => info.knights[p] + 1,
                    };
                    knights_to_buy = 0;
                    if info.knights[t] + info.knight_cards_old[t] + info.knight_cards_new[t] < la_size {
                        knights_to_buy = la_size - (info.knights[t] + info.knight_cards_old[t]);
                    }
                    temp_la_eta = if info.dev_cards_left >= knights_to_buy { (card_eta + 1) * knights_to_buy } else { 500 };
                    if temp_la_eta < fastest_eta {
                        fastest_eta = temp_la_eta;
                    }
                }
                if !have_lr && !need_lr && points > 5 {
                    temp_lr_eta = road_eta * roads_to_go;
                    if temp_lr_eta < fastest_eta {
                        fastest_eta = temp_lr_eta;
                    }
                }
                points += 2;
                win_game_eta += fastest_eta;
                let recalc = |temp_numbers: &PlayerNumbers, temp_ports: &Ports| Bse::new(temp_numbers, None).from_nothing_fast(temp_ports, 40);
                if settlement_pieces_left > 1 && pos_sets.len() > 1 && can_build_2 && fastest_eta == two_settlements {
                    let (c0, c1) = (chosen_set[0].unwrap(), chosen_set[1].unwrap());
                    let ps0 = pos_sets.remove(&c0);
                    let ps1 = pos_sets.remove(&c1);
                    pos_cities.insert(c0, ());
                    pos_cities.insert(c1, ());
                    for ps in [ps0, ps1].into_iter().flatten() {
                        for &(o, cc) in &ps.conflicts {
                            if o == t {
                                pos_sets.remove(&cc);
                            }
                        }
                    }
                    settlement_pieces_left -= 2;
                    city_spots_left += 2;
                    temp_numbers.add_node_map(&map, node_id(c0));
                    temp_numbers.add_node_map(&map, node_id(c1));
                    self.port_flag(&mut temp_ports, c0);
                    self.port_flag(&mut temp_ports, c1);
                    our_speed = recalc(&temp_numbers, &temp_ports);
                } else if one_of_each_possible && fastest_eta == one_of_each {
                    let Some(cc) = chosen_city[0] else { break };
                    let c0 = chosen_set[0].unwrap();
                    let ps0 = pos_sets.remove(&c0);
                    if c0 != cc {
                        pos_cities.insert(c0, ());
                    }
                    pos_cities.remove(&cc);
                    city_pieces_left -= 1;
                    if let Some(ps) = ps0 {
                        for &(o, x) in &ps.conflicts {
                            if o == t {
                                pos_sets.remove(&x);
                            }
                        }
                    }
                    temp_numbers.add_node_map(&map, node_id(c0));
                    self.port_flag(&mut temp_ports, c0);
                    temp_numbers.add_node_map(&map, node_id(cc));
                    our_speed = recalc(&temp_numbers, &temp_ports);
                } else if city_pieces_left > 1 && city_spots_left > 1 && fastest_eta == two_cities {
                    let c0 = chosen_city[0].unwrap();
                    pos_cities.remove(&c0);
                    temp_numbers.add_node_map(&map, node_id(c0));
                    let mut best = 0;
                    for &c in pos_cities.keys() {
                        let sp = speed_at(&mut temp_numbers, &temp_ports, c);
                        let total = Trackers::speedup_total(&our_speed, &sp, false);
                        if total >= best {
                            best = total;
                            chosen_city[1] = Some(c);
                        }
                    }
                    if let Some(c1) = chosen_city[1] {
                        pos_cities.remove(&c1);
                        temp_numbers.add_node_map(&map, node_id(c1));
                        settlement_pieces_left += 2;
                        city_pieces_left -= 2;
                        city_spots_left -= 2;
                    } else {
                        points -= 1;
                        settlement_pieces_left += 1;
                        city_pieces_left -= 1;
                        city_spots_left -= 1;
                    }
                    our_speed = recalc(&temp_numbers, &temp_ports);
                } else if !have_lr && !need_lr && points > 5 && fastest_eta == temp_lr_eta {
                    need_lr = true;
                } else if !have_la && !need_la && points > 5 && fastest_eta == temp_la_eta {
                    need_la = true;
                }
                settlement_eta = our_speed[B_SET];
                road_eta = our_speed[B_ROAD];
                city_eta = our_speed[B_CITY];
                card_eta = our_speed[CARD];
            }
        }
        let tr = &mut self.trackers[t];
        tr.win_game_eta = win_game_eta;
        tr.need_lr = need_lr;
        tr.need_la = need_la;
        tr.knights_to_buy = knights_to_buy;
    }

    /// calcTotalNecessaryRoads for a settlement in a working copy of the possible set (its necessary
    /// roads live in the tracker's possible roads either way).
    fn total_necessary_roads_in(&self, pos_sets: &BTreeMap<i32, PossibleSettlement>, t: usize, coord: i32) -> i32 {
        if pos_sets.get(&coord).map_or(true, |ps| ps.necessary_roads.is_empty()) {
            return 0;
        }
        self.total_necessary_roads(t, coord)
    }
}
