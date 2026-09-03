//! BASE board generation without catanatron: the template's topology is baked in
//! (base_topology.rs), tile and port resources are shuffled, numbers follow the
//! official spiral, and the encoder's static template is filled the way
//! catan_env.Encoder._refresh_static_template does.

use crate::base_topology::*;
use crate::encode::Layout;
use crate::map::{Map, Port, Tile};

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn shuffle<T>(v: &mut [T], rng: &mut u64) {
    for i in (1..v.len()).rev() {
        let j = (splitmix(rng) % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

impl Map {
    /// A random board: the same distribution as catanatron's initialize_tiles (every permutation of
    /// the resource multisets equally likely), from a seed instead of Python's global RNG.
    pub fn generate(seed: u64, layout: &Layout) -> Map {
        let mut rng = seed ^ 0xD1B5_4A32_D192_ED03;
        let mut tile_res = TILE_RESOURCES;
        shuffle(&mut tile_res, &mut rng);
        let mut port_res = PORT_RESOURCES;
        shuffle(&mut port_res, &mut rng);
        Map::from_assignment(&tile_res, &port_res, layout)
    }

    /// The board for a given resource assignment (tile id order / port id order).
    pub fn from_assignment(tile_res: &[i8; 19], port_res: &[i8; 9], layout: &Layout) -> Map {
        let mut numbers = [0u8; 19];
        let mut k = 0;
        for &t in SPIRAL_TILE_IDS.iter() {
            if tile_res[t as usize] >= 0 {
                numbers[t as usize] = NUMBERS_SPIRAL[k];
                k += 1;
            }
        }
        let tiles: Vec<Tile> = (0..19).map(|t| Tile { resource: tile_res[t], number: numbers[t], nodes: TILE_NODES[t] }).collect();
        let ports: Vec<Port> = (0..9).map(|p| Port { resource: port_res[p], nodes: PORT_NODES[p] }).collect();
        let template = static_template(&tiles, &ports, layout);
        let neighbors = NEIGHBORS.iter().map(|n| n.to_vec()).collect();
        Map::new(tiles, ports, template, neighbors)
    }
}

/// catan_env.Encoder._refresh_static_template: per-tile roll probability and resource one-hots
/// (incl. desert), per-port resource one-hots (incl. 3:1). Everything else in the vector is 0.
pub fn static_template(tiles: &[Tile], ports: &[Port], layout: &Layout) -> Vec<f32> {
    let mut number_prob = [0f64; 13];
    for i in 1..=6 {
        for j in 1..=6 {
            number_prob[i + j] += 1.0 / 36.0;
        }
    }
    let mut t = vec![0f32; layout.n_features];
    let mut set = |idx: i32, v: f32| {
        if idx >= 0 {
            t[idx as usize] = v;
        }
    };
    for (i, tile) in tiles.iter().enumerate() {
        set(layout.tile_proba_idx[i], if tile.resource >= 0 { number_prob[tile.number as usize] as f32 } else { 0.0 });
        for r in 0..6 {
            let on = if r == 5 { tile.resource < 0 } else { tile.resource == r as i8 };
            set(layout.tile_is_idx[i * 6 + r], on as u8 as f32);
        }
    }
    for (i, port) in ports.iter().enumerate() {
        for r in 0..6 {
            let on = if r == 5 { port.resource < 0 } else { port.resource == r as i8 };
            set(layout.port_is_idx[i * 6 + r], on as u8 as f32);
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_boards_are_well_formed() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        for seed in 0..50u64 {
            let m = Map::generate(seed, &layout);
            assert_eq!(m.tiles.len(), 19);
            assert_eq!(m.edges.len(), 72);
            let mut res = [0; 6];
            for t in &m.tiles {
                res[if t.resource < 0 { 5 } else { t.resource as usize }] += 1;
                assert_eq!(t.resource < 0, t.number == 0);
            }
            assert_eq!(res, [4, 3, 4, 4, 3, 1]); // WOOD BRICK SHEEP WHEAT ORE DESERT
            let mut nums: Vec<u8> = m.tiles.iter().filter(|t| t.resource >= 0).map(|t| t.number).collect();
            nums.sort();
            let mut want = NUMBERS_SPIRAL.to_vec();
            want.sort();
            assert_eq!(nums, want);
            assert_eq!(m.ports.iter().filter(|p| p.resource < 0).count(), 4);
            let nonzero = m.static_template.iter().filter(|&&v| v != 0.0).count();
            assert_eq!(nonzero, 18 + 19 + 9); // probas, tile one-hots, port one-hots
        }
        assert_ne!(Map::generate(1, &layout).tiles[0].resource + 10 * Map::generate(1, &layout).tiles[1].resource, Map::generate(2, &layout).tiles[0].resource + 10 * Map::generate(2, &layout).tiles[1].resource + 100, "seeds differ");
    }
}
