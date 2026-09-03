//! value_net.ValueNet's forward pass (mask -> 3 x [Linear, ReLU] -> Linear) in plain Rust, so the
//! search can score its own leaves in the browser and in the jSettlers bridge without torch.
//! Weights come from tools/export_valuenet.py (little-endian f32: mask, then W/b per layer).
//! Decision (docs/superpowers/specs/2026-09-03-...): hand-written loops compiled with simd128 on
//! wasm; ONNX Runtime Web is the fallback if measured latency is poor.

use crate::actions::Action;
use crate::encode::Layout;
use crate::state::State;

pub const N_HEADS: usize = 6; // win logit, final VPs of the 4 relative seats / 10, turns remaining / 100

struct Layer {
    w: Vec<f32>, // n_out x n_in, row-major
    b: Vec<f32>,
    n_in: usize,
    n_out: usize,
}

pub struct ValueNet {
    pub n_in: usize,
    mask: Vec<f32>,
    layers: Vec<Layer>,
}

pub struct Decision {
    pub action: Option<Action>,
    pub value: f64,
    pub root: Vec<(Action, f64)>, // every root action's expected P(win)
    pub leaves: usize,
}

impl ValueNet {
    pub fn from_f32(data: &[f32], n_in: usize, hidden: usize, n_out: usize) -> Result<ValueNet, String> {
        let dims = [(n_in, hidden), (hidden, hidden), (hidden, hidden), (hidden, n_out)];
        let want: usize = n_in + dims.iter().map(|(i, o)| i * o + o).sum::<usize>();
        if data.len() != want {
            return Err(format!("value net blob has {} floats, expected {want} for {n_in}->{hidden}x3->{n_out}", data.len()));
        }
        let mut off = 0;
        let mut take = |k: usize| {
            let s = data[off..off + k].to_vec();
            off += k;
            s
        };
        let mask = take(n_in);
        let layers = dims.iter().map(|&(i, o)| Layer { w: take(i * o), b: take(o), n_in: i, n_out: o }).collect();
        Ok(ValueNet { n_in, mask, layers })
    }

    pub fn from_bytes(bytes: &[u8], n_in: usize, hidden: usize, n_out: usize) -> Result<ValueNet, String> {
        if bytes.len() % 4 != 0 {
            return Err("value net blob length is not a multiple of 4".into());
        }
        let data: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        ValueNet::from_f32(&data, n_in, hidden, n_out)
    }

    /// All heads for `n` rows of `xs` (n x n_in) -> n x N_HEADS.
    pub fn forward_batch(&self, xs: &[f32], n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n * N_HEADS);
        let mut x = vec![0f32; self.n_in];
        let mut bufs: Vec<Vec<f32>> = self.layers.iter().map(|l| vec![0f32; l.n_out]).collect();
        for row in 0..n {
            let src = &xs[row * self.n_in..(row + 1) * self.n_in];
            for ((xo, &xi), &m) in x.iter_mut().zip(src).zip(&self.mask) {
                *xo = xi * m;
            }
            let last = self.layers.len() - 1;
            for (li, layer) in self.layers.iter().enumerate() {
                let (head, tail) = bufs.split_at_mut(li);
                let input: &[f32] = if li == 0 { &x } else { &head[li - 1] };
                let dst = &mut tail[0];
                for o in 0..layer.n_out {
                    let w = &layer.w[o * layer.n_in..(o + 1) * layer.n_in];
                    let dot: f32 = w.iter().zip(input).map(|(a, b)| a * b).sum();
                    let v = dot + layer.b[o];
                    dst[o] = if li == last { v } else { v.max(0.0) };
                }
            }
            out.extend_from_slice(&bufs[last]);
        }
        out
    }

    pub fn heads(&self, x: &[f32]) -> [f32; N_HEADS] {
        let v = self.forward_batch(x, 1);
        let mut h = [0f32; N_HEADS];
        h.copy_from_slice(&v[..N_HEADS]);
        h
    }

    /// P(win) for one encoded state.
    pub fn win_prob(&self, x: &[f32]) -> f64 {
        sigmoid(self.heads(x)[0] as f64)
    }
}

pub fn sigmoid(z: f64) -> f64 {
    1.0 / (1.0 + (-z).exp())
}

impl State {
    /// Encoding of this state from seat `p0`'s perspective (static template + dynamic features).
    pub fn encoded(&self, p0: usize, layout: &Layout) -> Vec<f32> {
        let mut x = self.map.static_template.clone();
        self.encode_into(p0, layout, &mut x);
        x
    }

    /// ValueNetPlayer.decide: depth-d exact expectimax for the current player with the net's
    /// P(win) at the leaves (terminal leaves exact). Same tree as value_net.py's Rust path.
    pub fn decide_vnet(&self, net: &ValueNet, layout: &Layout, depth: u32, max_leaves: usize, own_turn: bool) -> Decision {
        let actions = self.playable_actions();
        if actions.len() == 1 {
            return Decision { action: Some(actions[0]), value: f64::NAN, root: vec![], leaves: 0 };
        }
        let p0 = self.current_player;
        let search = self.expand(depth, p0, layout, max_leaves, own_turn);
        let heads = net.forward_batch(&search.leaves, search.n_leaves);
        let mut values: Vec<f64> = (0..search.n_leaves).map(|i| sigmoid(heads[i * N_HEADS] as f64)).collect();
        for &(i, v) in &search.fixed {
            values[i] = v;
        }
        let (action, value, root) = search.backup_full(&values);
        Decision { action, value, root, leaves: search.n_leaves }
    }

    /// Feature-group attribution for seat `p0`: change in P(win) when a group of input features is
    /// zeroed (leave-one-group-out). Returns (group, relative seat or -1, delta).
    pub fn attribution(&self, net: &ValueNet, layout: &Layout, p0: usize) -> Vec<(String, i32, f64)> {
        let x = self.encoded(p0, layout);
        let base = net.win_prob(&x);
        let mut out = Vec::new();
        let mut probe = |name: &str, seat: i32, idx: &[i32]| {
            let mut y = x.clone();
            let mut touched = false;
            for &i in idx {
                if i >= 0 && y[i as usize] != 0.0 {
                    y[i as usize] = 0.0;
                    touched = true;
                }
            }
            if touched {
                out.push((name.to_string(), seat, net.win_prob(&y) - base));
            }
        };
        let eb = layout.extra_base;
        for i in 0..self.n {
            let sc = &layout.player_scalar_idx[i * 8..i * 8 + 8];
            let mut hand = vec![layout.num_resources_idx[i]];
            if i == 0 {
                hand.extend(&layout.p0_resource_in_hand_idx);
                hand.push(eb + 20);
            }
            probe("hand", i as i32, &hand);
            let mut prod: Vec<i32> = layout.production_idx[i * 5..i * 5 + 5].to_vec();
            prod.extend((0..5).map(|k| eb + (i as i32) * 5 + k));
            probe("production", i as i32, &prod);
            let mut b: Vec<i32> = layout.node_idx[i * 108..i * 108 + 108].to_vec();
            b.push(layout.buildable_nodes_idx[i]);
            probe("buildings", i as i32, &b);
            let mut r: Vec<i32> = layout.edge_idx[i * 72..i * 72 + 72].to_vec();
            r.extend([sc[2], sc[7]]);
            probe("roads", i as i32, &r);
            probe("pieces", i as i32, &[sc[3], sc[4], sc[5]]); // roads / settlements / cities still in the box
            let mut d: Vec<i32> = layout.dev_played_idx[i * 4..i * 4 + 4].to_vec();
            d.extend([layout.num_devs_idx[i], sc[1]]);
            if i == 0 {
                d.extend(&layout.p0_dev_in_hand_idx);
                d.push(layout.p0_has_played_dev_idx);
            }
            probe("devs", i as i32, &d);
            let mut s = vec![sc[0]];
            if i == 0 {
                s.push(layout.p0_actual_vps_idx);
            }
            probe("score", i as i32, &s);
        }
        probe("robber", -1, &layout.robber_idx);
        let mut bank = layout.bank_resource_idx.clone();
        bank.push(layout.bank_dev_cards_idx);
        probe("bank", -1, &bank);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parity with the torch checkpoint on the vectors tools/export_valuenet.py saved.
    #[test]
    fn forward_matches_torch() {
        let blob = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/models/v40.bin")).expect("run tools/export_valuenet.py first");
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/models/v40.json")).unwrap()).unwrap();
        let net = ValueNet::from_bytes(&blob, meta["n_features"].as_u64().unwrap() as usize, meta["hidden"].as_u64().unwrap() as usize, N_HEADS).unwrap();
        let parity: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/v40_parity.json")).unwrap()).unwrap();
        let xs: Vec<Vec<f32>> = parity["x"].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect()).collect();
        let want: Vec<Vec<f32>> = parity["heads"].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect()).collect();
        let flat: Vec<f32> = xs.concat();
        let got = net.forward_batch(&flat, xs.len());
        let mut worst = 0f32;
        for (i, w) in want.iter().enumerate() {
            for (j, &v) in w.iter().enumerate() {
                worst = worst.max((got[i * N_HEADS + j] - v).abs());
            }
        }
        assert!(worst < 1e-3, "max abs diff vs torch = {worst}");
    }
}
