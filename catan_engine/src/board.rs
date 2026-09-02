//! Board mutations: catanatron.models.board.Board semantics, including its
//! quirks (longest-road holder recomputed via a dict max after a cut, which
//! can award it below 5 with seating-order tie-breaks; DFS trails may start
//! on enemy nodes; component lists are order-sensitive).

use crate::state::State;

impl State {
    #[inline]
    pub fn is_enemy_node(&self, node: u8, p: usize) -> bool {
        let o = self.owner[node as usize];
        o >= 0 && o as usize != p
    }

    pub fn component_index(&self, node: u8, p: usize) -> Option<usize> {
        self.components[p].iter().position(|c| c & (1u64 << node) != 0)
    }

    /// Python dfs_walk: nodes reachable from `start` over roads of `p`,
    /// entering (but not expanding past) enemy nodes.
    pub fn dfs_walk(&self, start: u8, p: usize) -> u64 {
        let mut agenda = vec![start];
        let mut visited = 0u64;
        while let Some(n) = agenda.pop() {
            visited |= 1u64 << n;
            if self.is_enemy_node(n, p) {
                continue;
            }
            for &v in &self.map.neighbors[n as usize] {
                if visited & (1u64 << v) != 0 {
                    continue;
                }
                let e = self.map.edge(n, v);
                if self.road_owner[e as usize] == p as i8 {
                    agenda.push(v);
                }
            }
        }
        visited
    }

    /// Length of the longest trail (edge-simple path) over p's roads
    /// starting from any node in `nodes`, never entering an enemy node.
    /// An enemy building breaks a road: a trail may start or end at the
    /// enemy's node but never pass through it. Enemy-occupied endpoints are
    /// not in the component (board_build_settlement removes them), so they
    /// are re-added as start nodes -- catanatron issue #378, fixed identically
    /// in the pinned catanatron fork (docs/AUDIT-rules.md).
    pub fn longest_acyclic_path(&self, nodes: u64, p: usize) -> i32 {
        let mut starts = nodes;
        for n in 0..54u8 {
            if nodes & (1u64 << n) == 0 {
                continue;
            }
            for &v in &self.map.neighbors[n as usize] {
                if self.road_owner[self.map.edge(n, v) as usize] == p as i8 && self.is_enemy_node(v, p) {
                    starts |= 1u64 << v;
                }
            }
        }
        let mut best = 0;
        for start in 0..54u8 {
            if starts & (1u64 << start) == 0 {
                continue;
            }
            best = best.max(self.trail_from(start, p, 0u128, 0));
        }
        best
    }

    fn trail_from(&self, node: u8, p: usize, used: u128, len: i32) -> i32 {
        let mut best = len;
        if len > 0 && self.is_enemy_node(node, p) {
            return best; // endpoint only
        }
        for &v in &self.map.neighbors[node as usize] {
            let e = self.map.edge(node, v);
            if self.road_owner[e as usize] != p as i8 {
                continue;
            }
            if used & (1u128 << e) != 0 {
                continue;
            }
            best = best.max(self.trail_from(v, p, used | (1u128 << e), len + 1));
        }
        best
    }

    /// Board.build_settlement. Returns (previous_road_color, road_color).
    pub fn board_build_settlement(&mut self, p: usize, node: u8, initial: bool) -> (i8, i8) {
        self.owner[node as usize] = p as i8;
        self.is_city[node as usize] = false;
        let previous_road_color = self.road_color;
        if initial {
            self.components[p].push(1u64 << node);
        } else {
            // group this node's edges by road color
            let mut by_color: Vec<(i8, Vec<u8>)> = Vec::new(); // (color, neighbor nodes), insertion order
            for &v in &self.map.neighbors[node as usize] {
                let e = self.map.edge(node, v);
                let c = self.road_owner[e as usize];
                match by_color.iter_mut().find(|(cc, _)| *cc == c) {
                    Some((_, vs)) => vs.push(v),
                    None => by_color.push((c, vec![v])),
                }
            }
            for (edge_color, vs) in by_color {
                if edge_color < 0 || edge_color as usize == p {
                    continue;
                }
                let ec = edge_color as usize;
                if vs.len() == 2 {
                    let a_set = self.dfs_walk(vs[0], ec);
                    let c_set = self.dfs_walk(vs[1], ec);
                    let b_index = self.component_index(node, ec).expect("cut node not in a component");
                    self.components[ec].remove(b_index);
                    self.components[ec].push(a_set);
                    self.components[ec].push(c_set);
                    let mut m = 0;
                    for &comp in &self.components[ec] {
                        m = m.max(self.longest_acyclic_path(comp, ec));
                    }
                    self.road_lengths[ec] = m;
                    // road_color, road_length = max(road_lengths.items(), key=len): first max in seating order
                    let mut best_c = 0usize;
                    for c in 1..self.n {
                        if self.road_lengths[c] > self.road_lengths[best_c] {
                            best_c = c;
                        }
                    }
                    self.road_color = best_c as i8;
                    self.road_length = self.road_lengths[best_c];
                } else if vs.len() == 1 {
                    if let Some(b_index) = self.component_index(node, ec) {
                        self.components[ec][b_index] &= !(1u64 << node);
                    }
                }
            }
        }
        self.buildable &= !(1u64 << node);
        for &v in &self.map.neighbors[node as usize] {
            self.buildable &= !(1u64 << v);
        }
        (previous_road_color, self.road_color)
    }

    /// Board.build_road. Returns (previous_road_color, road_color).
    pub fn board_build_road(&mut self, p: usize, edge: u8) -> (i8, i8) {
        self.road_owner[edge as usize] = p as i8;
        let (a, b) = self.map.edges[edge as usize];
        let a_index = self.component_index(a, p);
        let b_index = self.component_index(b, p);
        let component: u64;
        match (a_index, b_index) {
            (None, Some(bi)) if !self.is_enemy_node(a, p) => {
                self.components[p][bi] |= 1u64 << a;
                component = self.components[p][bi];
            }
            (Some(ai), None) if !self.is_enemy_node(b, p) => {
                self.components[p][ai] |= 1u64 << b;
                component = self.components[p][ai];
            }
            (Some(ai), Some(bi)) if ai != bi => {
                let merged = self.components[p][ai] | self.components[p][bi];
                self.components[p][ai] = merged;
                self.components[p].remove(bi);
                component = merged;
            }
            _ => {
                let idx = a_index.or(b_index).expect("road not attached to any component");
                component = self.components[p][idx];
            }
        }
        let previous_road_color = self.road_color;
        let candidate = self.longest_acyclic_path(component, p);
        self.road_lengths[p] = self.road_lengths[p].max(candidate);
        if candidate >= 5 && candidate > self.road_length {
            self.road_color = p as i8;
            self.road_length = candidate;
        }
        (previous_road_color, self.road_color)
    }

    /// buildable_node_ids(p, false).len() without the Vec.
    pub fn num_buildable_nodes(&self, p: usize) -> u32 {
        let mut nodes = 0u64;
        for &c in &self.components[p] {
            nodes |= c;
        }
        (nodes & self.buildable).count_ones()
    }

    pub fn buildable_node_ids(&self, p: usize, initial: bool) -> Vec<u8> {
        let mask = if initial {
            self.buildable
        } else {
            let mut nodes = 0u64;
            for &c in &self.components[p] {
                nodes |= c;
            }
            nodes & self.buildable
        };
        (0..54u8).filter(|n| mask & (1u64 << n) != 0).collect()
    }

    pub fn buildable_edges(&self, p: usize) -> Vec<u8> {
        let mut nodes = 0u64;
        for &c in &self.components[p] {
            nodes |= c;
        }
        let mut seen = 0u128;
        let mut out = Vec::new();
        for n in 0..54u8 {
            if nodes & (1u64 << n) == 0 {
                continue;
            }
            for &v in &self.map.neighbors[n as usize] {
                let e = self.map.edge(n, v);
                if self.road_owner[e as usize] < 0 && seen & (1u128 << e) == 0 {
                    seen |= 1u128 << e;
                    out.push(e);
                }
            }
        }
        out
    }

    /// Port resources owned by p: bit 0..4 = 2:1 resource ports, bit 5 = 3:1.
    pub fn port_resources(&self, p: usize) -> u8 {
        let mut mask = 0u8;
        for port in &self.map.ports {
            if port.nodes.iter().any(|&n| self.owner[n as usize] == p as i8) {
                mask |= if port.resource < 0 { 1 << 5 } else { 1 << port.resource };
            }
        }
        mask
    }
}
