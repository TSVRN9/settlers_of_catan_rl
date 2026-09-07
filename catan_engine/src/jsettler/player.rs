//! The parts of soc.game.SOCPlayer and SOCBoard the robot's trackers read: pieces, legal and
//! potential piece sets, road nodes, longest-road paths. Coordinates are JSettlers' (geom.rs). Fed
//! piece by piece in server order, the same way the Java client's SOCGame.putPiece runs it for every
//! player, including the quirk that potential settlements are cleared at the first regular turn and
//! only come back through new roads.

use std::collections::BTreeSet;

use super::geom::{edge_between, Geom, NONE};
use super::jcoll::JSet;

pub const ROAD: u8 = 0;
pub const SETTLEMENT: u8 = 1;
pub const CITY: u8 = 2;

/// SOCBoard's pieces by coordinate.
#[derive(Clone)]
pub struct Board {
    node_owner: Vec<i8>,
    node_city: Vec<bool>,
    edge_owner: Vec<i8>,
}

impl Default for Board {
    fn default() -> Board {
        Board { node_owner: vec![-1; 0x100], node_city: vec![false; 0x100], edge_owner: vec![-1; 0x100] }
    }
}

impl Board {
    /// settlementAtNode: the settlement or city there.
    pub fn settlement_at(&self, node: i32) -> Option<usize> {
        if (0..0x100).contains(&node) && self.node_owner[node as usize] >= 0 { Some(self.node_owner[node as usize] as usize) } else { None }
    }

    pub fn is_city(&self, node: i32) -> bool {
        (0..0x100).contains(&node) && self.node_city[node as usize]
    }

    pub fn road_at(&self, edge: i32) -> Option<usize> {
        if (0..0x100).contains(&edge) && self.edge_owner[edge as usize] >= 0 { Some(self.edge_owner[edge as usize] as usize) } else { None }
    }

    pub fn remove(&mut self, kind: u8, coord: i32) {
        match kind {
            ROAD => self.edge_owner[coord as usize] = -1,
            _ => {
                self.node_owner[coord as usize] = -1;
                self.node_city[coord as usize] = false;
            }
        }
    }

    pub fn put(&mut self, kind: u8, pn: usize, coord: i32) {
        match kind {
            ROAD => self.edge_owner[coord as usize] = pn as i8,
            SETTLEMENT => self.node_owner[coord as usize] = pn as i8,
            _ => {
                self.node_owner[coord as usize] = pn as i8;
                self.node_city[coord as usize] = true;
            }
        }
    }
}

/// SOCLRPathData.
#[derive(Clone, Debug)]
pub struct LrPath {
    pub begin: i32,
    pub end: i32,
    pub len: i32,
    pub pairs: Vec<(i32, i32)>,
}

fn pair_eq(a: (i32, i32), b: (i32, i32)) -> bool {
    a == b || (a.0 == b.1 && a.1 == b.0)
}

#[derive(Clone, Debug)]
pub struct Player {
    pub pn: usize,
    pub num_pieces: [i32; 3], // road, settlement, city
    pub roads: Vec<i32>,
    pub settlements: Vec<i32>,
    pub cities: Vec<i32>,
    pub road_nodes: Vec<i32>,
    pub legal_roads: BTreeSet<i32>,
    pub legal_settlements: BTreeSet<i32>,
    pub potential_roads: BTreeSet<i32>,
    pub potential_settlements: JSet,
    pub potential_cities: BTreeSet<i32>,
    pub lr_paths: Vec<LrPath>,
    pub longest_road_length: i32,
}

impl Player {
    pub fn new(pn: usize, geom: &Geom) -> Player {
        let legal_settlements: BTreeSet<i32> = geom.node_js.iter().map(|&c| c as i32).collect();
        // SOCBoard.initNodesOnLand's row order decides the HashSet's chain order
        let mut rows: Vec<i32> = vec![];
        for (start, end) in [(0x27, 0x8D), (0x25, 0xAD), (0x23, 0xCD), (0x32, 0xDC), (0x52, 0xDA), (0x72, 0xD8)] {
            let mut c = start;
            while c <= end {
                rows.push(c);
                c += 0x11;
            }
        }
        Player {
            pn,
            num_pieces: [15, 5, 4],
            roads: vec![],
            settlements: vec![],
            cities: vec![],
            road_nodes: vec![],
            legal_roads: geom.edge_js.iter().map(|&c| c as i32).collect(),
            potential_settlements: JSet::from_iter(rows.into_iter().filter(|c| legal_settlements.contains(c))),
            legal_settlements,
            potential_roads: BTreeSet::new(),
            potential_cities: BTreeSet::new(),
            lr_paths: vec![],
            longest_road_length: 0,
        }
    }

    pub fn is_potential_road(&self, e: i32) -> bool {
        self.potential_roads.contains(&e)
    }

    pub fn is_legal_road(&self, e: i32) -> bool {
        e >= 0 && self.legal_roads.contains(&e)
    }

    pub fn can_place_settlement(&self, n: i32) -> bool {
        self.potential_settlements.contains(&n)
    }

    pub fn has_road_at(&self, e: i32) -> bool {
        self.roads.contains(&e)
    }

    pub fn is_connected_by_road(&self, a: i32, b: i32) -> bool {
        let e = edge_between(a, b);
        e != NONE && self.has_road_at(e)
    }

    /// SOCPlayer.putPiece, run for every player on every piece (the owner also records it).
    pub fn put_piece(&mut self, kind: u8, coord: i32, owner: usize, board: &Board, geom: &Geom) {
        if owner == self.pn {
            match kind {
                ROAD => {
                    self.num_pieces[0] -= 1;
                    self.roads.push(coord);
                    for n in geom.adj_nodes_to_edge(coord) {
                        if !self.road_nodes.contains(&n) {
                            self.road_nodes.push(n);
                        }
                    }
                }
                SETTLEMENT => {
                    self.num_pieces[1] -= 1;
                    self.settlements.push(coord);
                }
                _ => {
                    self.num_pieces[2] -= 1;
                    self.cities.push(coord);
                }
            }
        }
        self.update_potentials(kind, coord, owner, board, geom);
    }

    /// The settlement a city replaces (SOCGame.putPieceCommon's removePiece of it).
    pub fn remove_settlement(&mut self, coord: i32) {
        if let Some(i) = self.settlements.iter().position(|&c| c == coord) {
            self.settlements.remove(i);
            self.num_pieces[1] += 1;
        }
    }

    /// SOCPlayer.updatePotentials, classic board.
    pub fn update_potentials(&mut self, kind: u8, id: i32, owner: usize, board: &Board, geom: &Geom) {
        let ours = owner == self.pn;
        match kind {
            ROAD => {
                self.potential_roads.remove(&id);
                self.legal_roads.remove(&id);
                if ours {
                    for node in Geom::nodes_of_edge(id) {
                        let blocked = board.settlement_at(node).map_or(false, |p| p != self.pn);
                        if !blocked {
                            for edge in geom.adj_edges_to_node_arr(node) {
                                if edge != NONE && self.legal_roads.contains(&edge) {
                                    self.potential_roads.insert(edge);
                                }
                            }
                            if self.legal_settlements.contains(&node) {
                                self.potential_settlements.insert(node);
                            }
                        }
                    }
                }
            }
            SETTLEMENT => {
                self.potential_settlements.remove(&id);
                self.legal_settlements.remove(&id);
                for n in geom.adj_nodes_to_node_arr(id) {
                    if n != NONE {
                        self.potential_settlements.remove(&n);
                        self.legal_settlements.remove(&n);
                    }
                }
                if ours {
                    self.potential_cities.insert(id);
                    for e in geom.adj_edges_to_node_arr(id) {
                        if e != NONE && self.legal_roads.contains(&e) {
                            self.potential_roads.insert(e);
                        }
                    }
                } else {
                    for e in geom.adj_edges_to_node_arr(id) {
                        if e == NONE || !self.potential_roads.contains(&e) {
                            continue;
                        }
                        let ends = Geom::nodes_of_edge(e);
                        let far = if ends[0] == id { ends[1] } else { ends[0] };
                        let found = geom.adj_edges_to_node_arr(far).iter().any(|&fe| fe != e && self.roads.contains(&fe));
                        if !found {
                            self.potential_roads.remove(&e);
                        }
                    }
                }
            }
            _ => {
                self.potential_cities.remove(&id);
            }
        }
    }

    /// SOCPlayer.removePiece for a road: the trackers' temporary pieces.
    pub fn remove_road(&mut self, coord: i32, board: &Board, geom: &Geom) {
        if let Some(i) = self.roads.iter().position(|&r| r == coord) {
            self.roads.remove(i);
        }
        self.num_pieces[0] += 1;
        for node in geom.adj_nodes_to_edge(coord) {
            let adj = geom.adj_edges_to_node(node);
            let matched = self.roads.iter().any(|r| adj.contains(r));
            if !matched {
                self.road_nodes.retain(|&n| n != node);
                self.potential_settlements.remove(&node);
            }
        }
        self.potential_roads.insert(coord);
        self.legal_roads.insert(coord);
        let mine = Geom::nodes_of_edge(coord);
        for adj_edge in geom.adj_edges_to_edge(coord) {
            if !self.potential_roads.contains(&adj_edge) {
                continue;
            }
            let ends = Geom::nodes_of_edge(adj_edge);
            let between = if mine.contains(&ends[0]) { ends[0] } else { ends[1] };
            if board.settlement_at(between) == Some(self.pn) {
                continue;
            }
            let mut is_potential = false;
            for adj_node in ends {
                if is_potential {
                    break;
                }
                let blocked = board.settlement_at(adj_node).map_or(false, |p| p != self.pn);
                if !blocked {
                    for aa in geom.adj_edges_to_node(adj_node) {
                        if aa != adj_edge && self.roads.contains(&aa) {
                            is_potential = true;
                            break;
                        }
                    }
                }
            }
            if is_potential && self.legal_roads.contains(&adj_edge) {
                self.potential_roads.insert(adj_edge);
            } else {
                self.potential_roads.remove(&adj_edge);
            }
        }
    }

    /// SOCPlayer.undoPutPiece (classic board), after the board has dropped the piece.
    pub fn undo_put_piece(&mut self, kind: u8, coord: i32, owner: usize, board: &Board, geom: &Geom, regular_play: bool) {
        let ours = owner == self.pn;
        match kind {
            ROAD => {
                if ours {
                    self.remove_road(coord, board, geom);
                } else {
                    self.legal_roads.insert(coord);
                    let adj = geom.adj_edges_to_edge(coord);
                    for r in self.roads.clone() {
                        if adj.contains(&r) {
                            self.update_potentials(ROAD, r, self.pn, board, geom);
                        }
                    }
                }
            }
            SETTLEMENT => {
                if ours {
                    self.remove_settlement(coord);
                }
                self.undo_put_piece_aux_settlement(coord, board, geom, regular_play);
                for n in geom.adj_nodes_to_node(coord) {
                    self.undo_put_piece_aux_settlement(n, board, geom, regular_play);
                }
            }
            _ => {
                if ours {
                    if let Some(i) = self.cities.iter().position(|&c| c == coord) {
                        self.cities.remove(i);
                        self.num_pieces[2] += 1;
                    }
                    self.potential_cities.insert(coord);
                }
            }
        }
    }

    /// undoPutPieceAuxSettlement: a node becomes legal again without neighbours, potential again
    /// during initial placement or when one of our roads touches it.
    fn undo_put_piece_aux_settlement(&mut self, node: i32, board: &Board, geom: &Geom, regular_play: bool) {
        let have_neighbor = geom.adj_nodes_to_node(node).iter().any(|&n| board.settlement_at(n).is_some());
        if have_neighbor || geom.node(node).is_none() {
            return;
        }
        self.legal_settlements.insert(node);
        if !regular_play {
            self.potential_settlements.insert(node);
        } else {
            let adj = geom.adj_edges_to_node(node);
            if self.roads.iter().any(|r| adj.contains(r)) {
                self.potential_settlements.insert(node);
            }
        }
    }

    /// SOCPlayer.calcLongestRoad2: the longest road and the path data the ETA search starts from.
    pub fn calc_longest_road2(&mut self, board: &Board, geom: &Geom) -> i32 {
        self.lr_paths.clear();
        let mut longest = 0;
        for start in self.road_nodes.clone() {
            let mut pending: Vec<(i32, i32, Vec<(i32, i32)>)> = vec![(start, 0, vec![])];
            while let Some((coord, len, visited)) = pending.pop() {
                let mut path_end = false;
                if len > 0 {
                    if let Some(p) = board.settlement_at(coord) {
                        if p != self.pn {
                            path_end = true;
                        }
                    }
                }
                if !path_end {
                    path_end = true;
                    let adj = geom.adj_nodes_to_node_arr(coord);
                    for ni in (0..3).rev() {
                        let j = adj[ni];
                        if j == NONE || !self.is_connected_by_road(coord, j) {
                            continue;
                        }
                        let pair = (coord, j);
                        if !visited.iter().any(|&v| pair_eq(v, pair)) {
                            let mut nv = visited.clone();
                            nv.push(pair);
                            pending.push((j, len + 1, nv));
                            path_end = false;
                        }
                    }
                }
                if path_end {
                    if len > longest {
                        longest = len;
                    }
                    let mut add_new = true;
                    let mut trash = vec![];
                    for (idx, old) in self.lr_paths.iter().enumerate() {
                        let intersection = visited.iter().any(|v| old.pairs.iter().any(|np| pair_eq(*np, *v)));
                        if intersection {
                            if old.len < len {
                                trash.push(idx);
                            } else {
                                add_new = false;
                            }
                        }
                    }
                    for idx in trash.into_iter().rev() {
                        self.lr_paths.remove(idx);
                    }
                    if add_new {
                        self.lr_paths.push(LrPath { begin: start, end: coord, len, pairs: visited });
                    }
                }
            }
        }
        self.longest_road_length = longest;
        longest
    }
}
