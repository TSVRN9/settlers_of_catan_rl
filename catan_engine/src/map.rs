//! Static board topology, handed over from Python once per game (map
//! generation and its RNG stay in catanatron).

pub const NUM_NODES: usize = 54;
pub const NUM_EDGES: usize = 72;
pub const NUM_TILES: usize = 19;

pub struct Tile {
    pub resource: i8, // 0..4, -1 desert
    pub number: u8,   // 0 desert
    pub nodes: [u8; 6], // NodeRef order: N, NE, SE, S, SW, NW
}

pub struct Port {
    pub resource: i8, // -1 = 3:1
    pub nodes: [u8; 2],
}

pub struct Map {
    pub tiles: Vec<Tile>,
    pub ports: Vec<Port>,
    pub edges: Vec<(u8, u8)>,                    // edge idx -> (a, b), a < b, sorted
    pub edge_of: [[i8; NUM_NODES]; NUM_NODES],
    pub neighbors: Vec<Vec<u8>>,
    pub node_tiles: Vec<Vec<u8>>,                // node -> tile ids (tile-id order)
    pub number_prob: [f64; 13],
    pub static_template: Vec<f32>, // catan_env.Encoder's per-map template (tile/port statics), n_features long
}

impl Map {
    /// `neighbors` is networkx's adjacency order from catanatron's STATIC_GRAPH:
    /// Board.build_settlement processes a node's edges in that order, and the
    /// order the two halves of a cut component are appended is observable.
    pub fn new(tiles: Vec<Tile>, ports: Vec<Port>, static_template: Vec<f32>, neighbors: Vec<Vec<u8>>) -> Map {
        assert_eq!(tiles.len(), NUM_TILES);
        let mut edge_set: Vec<(u8, u8)> = Vec::new();
        for t in &tiles {
            for k in 0..6 {
                let a = t.nodes[k];
                let b = t.nodes[(k + 1) % 6];
                let e = if a < b { (a, b) } else { (b, a) };
                if !edge_set.contains(&e) {
                    edge_set.push(e);
                }
            }
        }
        edge_set.sort();
        assert_eq!(edge_set.len(), NUM_EDGES);
        let mut edge_of = [[-1i8; NUM_NODES]; NUM_NODES];
        for (i, &(a, b)) in edge_set.iter().enumerate() {
            edge_of[a as usize][b as usize] = i as i8;
            edge_of[b as usize][a as usize] = i as i8;
        }
        assert_eq!(neighbors.len(), NUM_NODES);
        for (n, nb) in neighbors.iter().enumerate() {
            for &v in nb {
                assert!(edge_of[n][v as usize] >= 0, "neighbor order lists a non-edge");
            }
        }
        let mut node_tiles = vec![Vec::new(); NUM_NODES];
        for (tid, t) in tiles.iter().enumerate() {
            for &n in &t.nodes {
                node_tiles[n as usize].push(tid as u8);
            }
        }
        let mut number_prob = [0f64; 13];
        for i in 1..=6 {
            for j in 1..=6 {
                number_prob[i + j] += 1.0 / 36.0;
            }
        }
        Map { tiles, ports, edges: edge_set, edge_of, neighbors, node_tiles, number_prob, static_template }
    }

    #[inline]
    pub fn edge(&self, a: u8, b: u8) -> u8 {
        self.edge_of[a as usize][b as usize] as u8
    }
}
