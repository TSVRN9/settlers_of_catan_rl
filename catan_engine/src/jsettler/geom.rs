//! JSettlers' classic 4-player board coordinates (soc.game.SOCBoard, Thomas' dissertation appendix A)
//! over this engine's node and edge ids, so every iteration order the robot depends on (TreeMaps keyed
//! by coordinate, `getAdjacent*` lists) is the Java's. Node coords are 0xRC with corners of hex h at
//! N +0x01, NE +0x12, SE +0x21, S +0x10, SW -0x01, NW -0x10; an edge's coord is its lower node for
//! '/' and '\' edges and the node above-left for '|' edges (getAdjacentNodesToEdge_arr).

use crate::map::{Map, NUM_EDGES, NUM_NODES};

pub const NONE: i32 = -9;

/// Catanatron node id -> JSettlers node coord for a BASE-template map seen at rotation 0
/// (jsettlers_board.node_map(0, tiles) on catanatron's template; `tools/jsettlers_geom.py` prints it).
pub const NODE_JS_ROT0: [u16; NUM_NODES] = include!("node_js_rot0.txt");

pub struct Geom {
    pub node_js: [u16; NUM_NODES],
    pub edge_js: [u16; NUM_EDGES],
    node_of: Vec<i16>, // js coord -> node id, -1
    edge_of: Vec<i16>, // js coord -> edge id, -1
}

impl Geom {
    pub fn new(map: &Map, node_js: [u16; NUM_NODES]) -> Geom {
        let mut node_of = vec![-1i16; 0x100];
        for (n, &c) in node_js.iter().enumerate() {
            node_of[c as usize] = n as i16;
        }
        let mut edge_js = [0u16; NUM_EDGES];
        let mut edge_of = vec![-1i16; 0x100];
        for (e, &(a, b)) in map.edges.iter().enumerate() {
            let c = edge_between(node_js[a as usize] as i32, node_js[b as usize] as i32);
            assert!(c > 0, "nodes {a} {b} not adjacent in JSettlers coords");
            edge_js[e] = c as u16;
            edge_of[c as usize] = e as i16;
        }
        Geom { node_js, edge_js, node_of, edge_of }
    }

    pub fn default_for(map: &Map) -> Geom {
        Geom::new(map, NODE_JS_ROT0)
    }

    pub fn node(&self, js: i32) -> Option<u8> {
        if (0..0x100).contains(&js) && self.node_of[js as usize] >= 0 { Some(self.node_of[js as usize] as u8) } else { None }
    }

    pub fn edge(&self, js: i32) -> Option<u8> {
        if (0..0x100).contains(&js) && self.edge_of[js as usize] >= 0 { Some(self.edge_of[js as usize] as u8) } else { None }
    }

    fn has_node(&self, js: i32) -> bool {
        self.node(js).is_some()
    }

    fn has_edge(&self, js: i32) -> bool {
        self.edge(js).is_some()
    }

    /// getAdjacentNodesToEdge_arr.
    pub fn nodes_of_edge(js: i32) -> [i32; 2] {
        if is_vertical(js) { [js + 0x01, js + 0x10] } else { [js, js + 0x11] }
    }

    /// getAdjacentNodeToNode(coord, dir): dir 0 = NW/SW, 1 = NE/SE, 2 = N/S; NONE when off the board.
    pub fn adj_node_to_node(&self, js: i32, dir: usize) -> i32 {
        let c = match dir {
            0 => if (js & 0x0F) > 0 { js - 0x11 } else { return NONE },
            1 => if (js & 0x0F) < 0xD { js + 0x11 } else { return NONE },
            _ => if ((js >> 4) % 2) == 0 { js + 0x10 - 0x01 } else { js - 0x10 + 0x01 },
        };
        if self.has_node(c) && self.has_edge(edge_between(js, c)) { c } else { NONE }
    }

    pub fn adj_nodes_to_node_arr(&self, js: i32) -> [i32; 3] {
        [self.adj_node_to_node(js, 0), self.adj_node_to_node(js, 1), self.adj_node_to_node(js, 2)]
    }

    /// getAdjacentNodesToNode: the array in reverse, without NONE.
    pub fn adj_nodes_to_node(&self, js: i32) -> Vec<i32> {
        self.adj_nodes_to_node_arr(js).iter().rev().copied().filter(|&n| n != NONE).collect()
    }

    /// getAdjacentEdgeToNode(coord, dir).
    pub fn adj_edge_to_node(&self, js: i32, dir: usize) -> i32 {
        let even = ((js >> 4) % 2) == 0;
        let c = match dir {
            0 => js - 0x11,
            1 => js,
            _ => if even { js - 0x01 } else { js - 0x10 },
        };
        if self.has_edge(c) && Geom::nodes_of_edge(c).contains(&js) { c } else { NONE }
    }

    pub fn adj_edges_to_node_arr(&self, js: i32) -> [i32; 3] {
        [self.adj_edge_to_node(js, 0), self.adj_edge_to_node(js, 1), self.adj_edge_to_node(js, 2)]
    }

    /// getAdjacentEdgesToNode: the array in reverse, without NONE.
    pub fn adj_edges_to_node(&self, js: i32) -> Vec<i32> {
        self.adj_edges_to_node_arr(js).iter().rev().copied().filter(|&e| e != NONE).collect()
    }

    /// getAdjacentEdgesToEdge, in the Java's order.
    pub fn adj_edges_to_edge(&self, js: i32) -> Vec<i32> {
        let cands: [i32; 4] = if is_vertical(js) {
            [js - 0x10, js + 0x01, js + 0x10, js - 0x01]
        } else if ((js >> 4) % 2) == 0 {
            [js - 0x11, js + 0x01, js + 0x11, js - 0x01]
        } else {
            [js - 0x10, js + 0x11, js + 0x10, js - 0x11]
        };
        let mine = Geom::nodes_of_edge(js);
        cands.iter().copied().filter(|&c| self.has_edge(c) && Geom::nodes_of_edge(c).iter().any(|n| mine.contains(n))).collect()
    }

    /// getAdjacentNodesToEdge: both ends, in array order, when on the board.
    pub fn adj_nodes_to_edge(&self, js: i32) -> Vec<i32> {
        Geom::nodes_of_edge(js).iter().copied().filter(|&n| self.has_node(n)).collect()
    }
}

/// A '|' edge (its two nodes are coord+0x01 and coord+0x10), else '/' or '\'.
pub fn is_vertical(js: i32) -> bool {
    (((js & 0x0F) + (js >> 4)) % 2) == 0
}

/// getEdgeBetweenAdjacentNodes; NONE when not adjacent.
pub fn edge_between(a: i32, b: i32) -> i32 {
    match a - b {
        0x11 => b,
        -0x11 => a,
        0x0F => a - 0x10,
        -0x0F => a - 0x01,
        _ => NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Layout;
    use std::sync::Arc;

    /// Every engine edge has a JSettlers coord, every adjacency list agrees with the engine's graph,
    /// and the orders are the Java's (checked by hand on node 0x23: NW 0x12, NE 0x34, S 0x32).
    #[test]
    fn geom_matches_engine_graph() {
        let layout: Layout = serde_json::from_str(include_str!("../base_layout.json")).unwrap();
        let map = Arc::new(Map::generate(5, &layout));
        let g = Geom::default_for(&map);
        for n in 0..NUM_NODES {
            let js = g.node_js[n] as i32;
            let mut adj: Vec<u8> = g.adj_nodes_to_node(js).iter().map(|&c| g.node(c).unwrap()).collect();
            adj.sort();
            let mut want = map.neighbors[n].clone();
            want.sort();
            assert_eq!(adj, want, "node {n} (0x{js:02X})");
            let edges: Vec<u8> = g.adj_edges_to_node(js).iter().map(|&c| g.edge(c).unwrap()).collect();
            assert_eq!(edges.len(), map.neighbors[n].len());
            for e in edges {
                assert!(map.edges[e as usize].0 == n as u8 || map.edges[e as usize].1 == n as u8);
            }
        }
        for e in 0..NUM_EDGES {
            let js = g.edge_js[e] as i32;
            let (a, b) = map.edges[e];
            let ends = g.adj_nodes_to_edge(js);
            assert_eq!(ends.len(), 2);
            assert!(ends.contains(&(g.node_js[a as usize] as i32)) && ends.contains(&(g.node_js[b as usize] as i32)));
            let around = g.adj_edges_to_edge(js);
            assert!(around.len() >= 2 && around.len() <= 4, "edge 0x{js:02X}: {around:?}");
            for c in around {
                let f = g.edge(c).unwrap() as usize;
                let (x, y) = map.edges[f];
                assert!(f != e && (x == a || x == b || y == a || y == b));
            }
        }
        assert_eq!(g.adj_nodes_to_node_arr(0x23), [NONE, 0x34, 0x32]); // 0x12 is off the 4-player board
        assert_eq!(g.adj_edges_to_node_arr(0x23), [NONE, 0x23, 0x22]);
    }
}
