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
    wt: Vec<f32>, // n_in x n_out: row j is input j's column of W, so a layer is an axpy per NONZERO input
    b: Vec<f32>,
    n_in: usize,
    n_out: usize,
}

/// Outputs held in registers while the nonzero inputs stream past (8 ymm on AVX2).
#[cfg(target_arch = "x86_64")]
const BLK: usize = 64;

// A layer is out = relu?(base + sum_j x_j * W[:, j]) over the NONZERO x_j only: the encoding is ~90%
// zeros (one-hot buildings, roads; the masked tiles) and the incumbent's ReLU layers 4-20% nonzero, so
// this is ~10x fewer MACs than the dense matvec (docs/PLAN-gen-speed.md 2026-09-22). `base` is the
// bias, or a parent's pre-activation when `x` holds the *difference* to that parent
// (decide_net_rollout: every leaf of one decision differs from the root in ~30 of 1051 features, so
// layer 1 is ~30 axpys per leaf instead of ~110).

/// Indices of the nonzero entries of `x`, into `idx` (branchless: a one-hot-heavy input mispredicts
/// a `continue` per feature).
#[inline(always)]
fn nonzero<'a>(x: &[f32], idx: &'a mut Vec<u32>) -> &'a [u32] {
    if idx.len() < x.len() {
        idx.resize(x.len(), 0);
    }
    let mut k = 0;
    for (j, &xj) in x.iter().enumerate() {
        idx[k] = j as u32;
        k += (xj != 0.0) as usize;
    }
    &idx[..k]
}

/// Portable kernel (wasm, non-AVX2 x86): one axpy per nonzero input.
fn layer_plain(x: &[f32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool, idx: &mut Vec<u32>) {
    out.copy_from_slice(base);
    for &j in nonzero(x, idx) {
        let xj = x[j as usize];
        let w = &layer.wt[j as usize * layer.n_out..(j as usize + 1) * layer.n_out];
        for (o, &wi) in out.iter_mut().zip(w) {
            *o += xj * wi;
        }
    }
    if relu {
        for o in out.iter_mut() {
            *o = o.max(0.0);
        }
    }
}

/// AVX2+FMA kernel: BLK outputs stay in 8 ymm accumulators while the nonzero inputs' weight rows
/// stream past, so each row is read once and the accumulator is never spilled (LLVM does not
/// register-allocate a [f32; 64] from the portable loop -- measured, it was slower).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn layer_fma(x: &[f32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool, idx: &mut Vec<u32>) {
    use std::arch::x86_64::*;
    let nz = nonzero(x, idx);
    let n_out = layer.n_out;
    let wt = layer.wt.as_ptr();
    let mut o = 0;
    while o + BLK <= n_out {
        let mut acc: [__m256; BLK / 8] = [_mm256_setzero_ps(); BLK / 8];
        for (i, a) in acc.iter_mut().enumerate() {
            *a = _mm256_loadu_ps(base.as_ptr().add(o + 8 * i));
        }
        for &j in nz {
            let xj = _mm256_set1_ps(x[j as usize]);
            let row = wt.add(j as usize * n_out + o);
            for (i, a) in acc.iter_mut().enumerate() {
                *a = _mm256_fmadd_ps(xj, _mm256_loadu_ps(row.add(8 * i)), *a);
            }
        }
        let zero = _mm256_setzero_ps();
        for (i, a) in acc.iter().enumerate() {
            _mm256_storeu_ps(out.as_mut_ptr().add(o + 8 * i), if relu { _mm256_max_ps(*a, zero) } else { *a });
        }
        o += BLK;
    }
    for i in o..n_out {
        // tail: the 6-wide head layer
        let mut a = base[i];
        for &j in nz {
            a += x[j as usize] * layer.wt[j as usize * n_out + i];
        }
        out[i] = if relu { a.max(0.0) } else { a };
    }
}

fn layer(x: &[f32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool, idx: &mut Vec<u32>) {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("fma") && std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the features were just detected on this CPU; every pointer stays inside its slice
        // (o + BLK <= n_out, rows are n_out long, base/out are n_out long).
        return unsafe { layer_fma(x, layer, base, out, relu, idx) };
    }
    layer_plain(x, layer, base, out, relu, idx)
}

pub struct ValueNet {
    pub n_in: usize,
    layers: Vec<Layer>, // the input mask is folded into layer 0's rows
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
        let layers = dims
            .iter()
            .enumerate()
            .map(|(li, &(i, o))| {
                let w = take(i * o); // n_out x n_in as exported; stored transposed
                let mut wt = vec![0f32; i * o];
                for r in 0..o {
                    for c in 0..i {
                        wt[c * o + r] = w[r * i + c] * if li == 0 { mask[c] } else { 1.0 }; // x * mask * W == x * (mask * W)
                    }
                }
                Layer { wt, b: take(o), n_in: i, n_out: o }
            })
            .collect();
        Ok(ValueNet { n_in, layers })
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
        self.forward_from(None, xs, n)
    }

    /// `forward_batch`, with layer 1 computed as a correction to `root`'s pre-activation when a
    /// root row is given (the rows are then expected to be near-copies of it, see `layer_plain`).
    pub fn forward_from(&self, root: Option<&[f32]>, xs: &[f32], n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n * N_HEADS);
        let mut bufs: Vec<Vec<f32>> = self.layers.iter().map(|l| vec![0f32; l.n_out]).collect();
        let mut idx = Vec::new();
        let mut diff = vec![0f32; self.n_in];
        let last = self.layers.len() - 1;
        let l0 = &self.layers[0];
        let mut pre_root = l0.b.clone();
        if let Some(r) = root {
            layer(r, l0, &l0.b, &mut pre_root, false, &mut idx);
        }
        for row in 0..n {
            let src = &xs[row * self.n_in..(row + 1) * self.n_in];
            if let Some(r) = root {
                for ((d, &x), &y) in diff.iter_mut().zip(src).zip(r) {
                    *d = x - y;
                }
            }
            for (li, l) in self.layers.iter().enumerate() {
                let (head, tail) = bufs.split_at_mut(li);
                let (input, base): (&[f32], &[f32]) = match li {
                    0 if root.is_some() => (&diff, &pre_root),
                    0 => (src, &l0.b),
                    _ => (&head[li - 1], &l.b),
                };
                debug_assert_eq!(input.len(), l.n_in);
                layer(input, l, base, &mut tail[0], li != last, &mut idx);
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
        let (action, value, root) = search.backup_full(&values, 0.0);
        Decision { action, value, root, leaves: search.n_leaves }
    }

    /// The rollout policy with the net (arena.rs Recorder::rollout, `--roll-net`): one ply over the pruned
    /// rollout action list, every outcome scored by the net on this thread, P(win) for the decider,
    /// terminal leaves exact. One ply because a depth-2 tree is ~500 leaves per playout decision; depth 1
    /// with the net was measured within 4 points of depth 2 as a player (docs/FINDINGS.md 2026-09-02),
    /// which is what a playout policy needs to be: at least as strong as `rab`, the label it replaces.
    pub fn decide_net_rollout(&self, net: &ValueNet, layout: &Layout, buf: &mut Vec<f32>) -> Option<Action> {
        for p in 0..self.n {
            self.reachable_production(p); // prime the memo every non-building child inherits
        }
        let acts = self.rollout_actions(false);
        let ev = self.net_one_ply(&acts, self.current_player, net, layout, buf);
        let mut best: Option<(usize, f64)> = None;
        for (i, &v) in ev.iter().enumerate() {
            if best.is_none_or(|b| v > b.1) {
                best = Some((i, v));
            }
        }
        best.map(|b| acts[b.0])
    }

    /// Each action's expected P(win) for `p0` over its exact outcomes, scored by `net` on this thread
    /// (terminal outcomes exact). The reach memo must be primed.
    pub fn net_one_ply(&self, acts: &[Action], p0: usize, net: &ValueNet, layout: &Layout, buf: &mut Vec<f32>) -> Vec<f64> {
        buf.clear();
        buf.extend_from_slice(&self.map.static_template);
        self.encode_into(p0, layout, &mut buf[..layout.n_features]); // row 0: the root, the leaves' layer-1 base
        let mut leaves: Vec<(usize, f64, f64)> = Vec::new(); // (action, proba, exact value or NaN = ask the net)
        for (i, &a) in acts.iter().enumerate() {
            self.for_each_outcome(a, |s, p| {
                let start = buf.len();
                buf.extend_from_slice(&s.map.static_template);
                let w = s.winner();
                let exact = if w >= 0 {
                    (w as usize == p0) as u8 as f64
                } else {
                    s.encode_into(p0, layout, &mut buf[start..start + layout.n_features]);
                    f64::NAN
                };
                leaves.push((i, p, exact));
            });
        }
        let nf = layout.n_features;
        let heads = net.forward_from(Some(&buf[..nf]), &buf[nf..], leaves.len());
        let mut ev = vec![0.0; acts.len()];
        for (k, &(i, p, exact)) in leaves.iter().enumerate() {
            ev[i] += p * if exact.is_nan() { sigmoid(heads[k * N_HEADS] as f64) } else { exact };
        }
        ev
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
