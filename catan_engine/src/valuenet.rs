//! value_net.ValueNet's forward pass (mask -> 3 x [Linear, ReLU] -> Linear) in plain Rust, so the
//! search can score its own leaves in the browser and in the jSettlers bridge without torch.
//! Weights come from tools/export_valuenet.py (little-endian f32: mask, then W/b per layer).
//! Decision (docs/superpowers/specs/2026-09-03-...): hand-written loops compiled with simd128 on
//! wasm; ONNX Runtime Web is the fallback if measured latency is poor.

use crate::actions::Action;
use crate::encode::Layout;
use crate::state::State;

pub const N_HEADS: usize = 6;
 // win logit, final VPs of the 4 relative seats / 10, turns remaining / 100

struct Layer {
    wt: Vec<f32>, // n_in x n_out: row j is input j's column of W, so a layer is an axpy per NONZERO input
    wt8: Vec<f32>, // n_out < 8 (the 6-wide head): rows zero-padded to 8, one ymm per nonzero input
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
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: AVX2 was just detected; loads stay inside x (j + 8 <= len), writes inside idx (k < len).
        let k = unsafe { nonzero_avx2(x, idx) };
        return &idx[..k];
    }
    let mut k = 0;
    for (j, &xj) in x.iter().enumerate() {
        idx[k] = j as u32;
        k += (xj != 0.0) as usize;
    }
    &idx[..k]
}

/// `nonzero` eight at a time: a compare, a bitmask, then only the set bits. The rollout rows' layer-1 inputs are
/// differences to the root row, ~12 nonzero of 1,051, and the scalar scan was 19% of self-play generation (2026-09-24).
/// Same indices in the same (ascending) order; NaN counts as nonzero, as `!= 0.0` does.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn nonzero_avx2(x: &[f32], idx: &mut [u32]) -> usize {
    use std::arch::x86_64::*;
    let (mut k, n, zero) = (0usize, x.len(), _mm256_setzero_ps());
    let mut j = 0;
    while j + 8 <= n {
        let mut m = _mm256_movemask_ps(_mm256_cmp_ps::<_CMP_NEQ_UQ>(_mm256_loadu_ps(x.as_ptr().add(j)), zero)) as u32;
        while m != 0 {
            *idx.get_unchecked_mut(k) = (j + m.trailing_zeros() as usize) as u32;
            k += 1;
            m &= m - 1;
        }
        j += 8;
    }
    for (jj, &xj) in x.iter().enumerate().skip(j) {
        if xj != 0.0 {
            idx[k] = jj as u32;
            k += 1;
        }
    }
    k
}

/// `diff = x - root` and the indices of its nonzero entries, in one pass (AVX2) or two (elsewhere). Layer 1 of a leaf
/// row works on its difference to the decision's root row; separate subtract and scan passes read 1,051 floats twice.
fn diff_nonzero<'a>(x: &[f32], root: &[f32], diff: &mut [f32], idx: &'a mut Vec<u32>) -> &'a [u32] {
    if idx.len() < x.len() {
        idx.resize(x.len(), 0);
    }
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: AVX2 was just detected; x, root and diff have the same length, indices stay below it.
        let k = unsafe { diff_nonzero_avx2(x, root, diff, idx) };
        return &idx[..k];
    }
    for ((d, &a), &b) in diff.iter_mut().zip(x).zip(root) {
        *d = a - b;
    }
    nonzero(diff, idx)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn diff_nonzero_avx2(x: &[f32], root: &[f32], diff: &mut [f32], idx: &mut [u32]) -> usize {
    use std::arch::x86_64::*;
    let (mut k, n, zero) = (0usize, x.len(), _mm256_setzero_ps());
    let mut j = 0;
    while j + 8 <= n {
        let d = _mm256_sub_ps(_mm256_loadu_ps(x.as_ptr().add(j)), _mm256_loadu_ps(root.as_ptr().add(j)));
        _mm256_storeu_ps(diff.as_mut_ptr().add(j), d);
        let mut m = _mm256_movemask_ps(_mm256_cmp_ps::<_CMP_NEQ_UQ>(d, zero)) as u32;
        while m != 0 {
            *idx.get_unchecked_mut(k) = (j + m.trailing_zeros() as usize) as u32;
            k += 1;
            m &= m - 1;
        }
        j += 8;
    }
    while j < n {
        diff[j] = x[j] - root[j];
        if diff[j] != 0.0 {
            idx[k] = j as u32;
            k += 1;
        }
        j += 1;
    }
    k
}

/// Portable kernel (wasm, non-AVX2 x86): one axpy per nonzero input.
fn layer_plain(x: &[f32], nz: &[u32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool) {
    out.copy_from_slice(base);
    for &j in nz {
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
unsafe fn layer_fma(x: &[f32], nz: &[u32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool) {
    use std::arch::x86_64::*;
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
    if o == 0 && n_out < 8 {
        // the 6-wide head in one ymm: unfused mul then add per lane, the same two roundings in the same order
        // as the scalar tail below, so the result is bitwise the same
        let mut b8 = [0f32; 8];
        b8[..n_out].copy_from_slice(&base[..n_out]);
        let mut a = _mm256_loadu_ps(b8.as_ptr());
        let w8 = layer.wt8.as_ptr();
        for &j in nz {
            a = _mm256_add_ps(a, _mm256_mul_ps(_mm256_set1_ps(x[j as usize]), _mm256_loadu_ps(w8.add(j as usize * 8))));
        }
        if relu {
            a = _mm256_max_ps(a, _mm256_setzero_ps());
        }
        _mm256_storeu_ps(b8.as_mut_ptr(), a);
        out[..n_out].copy_from_slice(&b8[..n_out]);
        return;
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
    let k = nonzero(x, idx).len();
    layer_nz(x, &idx[..k], layer, base, out, relu)
}

fn layer_nz(x: &[f32], nz: &[u32], layer: &Layer, base: &[f32], out: &mut [f32], relu: bool) {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("fma") && std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the features were just detected on this CPU; every pointer stays inside its slice
        // (o + BLK <= n_out, rows are n_out long, base/out are n_out long).
        return unsafe { layer_fma(x, nz, layer, base, out, relu) };
    }
    layer_plain(x, nz, layer, base, out, relu)
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
                let wt8 = if o < 8 { wt.chunks(o).flat_map(|r| r.iter().copied().chain(std::iter::repeat(0.0).take(8 - o))).collect() } else { vec![] };
                Layer { wt, wt8, b: take(o), n_in: i, n_out: o }
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
                // a separate vectorized pass: an AVX2 fused diff + scan measured +1.1% instructions here (2026-09-24),
                // a scalar fusion 8% slower, thread-local scratch in place of these per-call buffers no change
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

    /// `forward_from(Some(root), ..)` split after its first layer, row by row in the same arithmetic, so
    /// `hidden_heads(layer0_from(..))` is bitwise `forward_from`: the post-ReLU first-layer rows (n x
    /// `hidden_width`) go to `emit` one by one. Parked rollouts (arena.rs) keep only these 256-wide rows, as fp16,
    /// and hand the dense rest to the NPU. (A sparse version that tracked the encoder's written positions with
    /// bitmasks and skipped the template copy and the 1,051-wide passes was exact but 15-30% slower: 2026-09-24.)
    pub fn layer0_from(&self, root: &[f32], xs: &[f32], n: usize, mut emit: impl FnMut(&[f32])) {
        let l0 = &self.layers[0];
        let mut idx = Vec::new();
        let mut pre_root = l0.b.clone();
        layer(root, l0, &l0.b, &mut pre_root, false, &mut idx);
        let mut diff = vec![0f32; self.n_in];
        let mut h = vec![0f32; l0.n_out];
        for row in 0..n {
            let nz = diff_nonzero(&xs[row * self.n_in..(row + 1) * self.n_in], root, &mut diff, &mut idx);
            layer_nz(&diff, nz, l0, &pre_root, &mut h, true);
            emit(&h);
        }
    }

    pub fn hidden_width(&self) -> usize {
        self.layers[0].n_out
    }

    /// The layers after the first on `layer0_from`'s rows: n x N_HEADS.
    pub fn hidden_heads(&self, h0: &[f32], n: usize) -> Vec<f32> {
        let (w, rest) = (self.layers[0].n_out, &self.layers[1..]);
        let mut bufs: Vec<Vec<f32>> = rest.iter().map(|l| vec![0f32; l.n_out]).collect();
        let mut idx = Vec::new();
        let mut out = Vec::with_capacity(n * N_HEADS);
        for row in 0..n {
            for (k, l) in rest.iter().enumerate() {
                let (head, tail) = bufs.split_at_mut(k);
                let input: &[f32] = if k == 0 { &h0[row * w..(row + 1) * w] } else { &head[k - 1] };
                layer(input, l, &l.b, &mut tail[0], k + 1 != rest.len(), &mut idx);
            }
            out.extend_from_slice(&bufs[rest.len() - 1]);
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

/// Expected P(win) per action from its leaves, `logit(k)` = the net's win logit for leaf row k.
pub fn one_ply_ev(n_acts: usize, leaves: &[(usize, f64, f64)], logit: impl Fn(usize) -> f32) -> Vec<f64> {
    let mut ev = vec![0.0; n_acts];
    for (k, &(i, p, exact)) in leaves.iter().enumerate() {
        ev[i] += p * if exact.is_nan() { sigmoid(logit(k) as f64) } else { exact };
    }
    ev
}

/// Index of the first maximum.
pub fn argmax_first(v: &[f64]) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (i, &x) in v.iter().enumerate() {
        if best.is_none_or(|b| x > b.1) {
            best = Some((i, x));
        }
    }
    best.map(|b| b.0)
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
        argmax_first(&ev).map(|i| acts[i])
    }

    /// `decide_net_rollout` up to the forward, for a parked rollout: primes the memo, returns the pruned actions
    /// and their leaves and appends the leaves' first-layer rows to `h0` (fp16, round to nearest even). Resume with `one_ply_ev` +
    /// `argmax_first` on the rows' win logits. Empty actions: nothing appended, the caller plays its fallback.
    pub fn net_rollout_park(&self, net: &ValueNet, layout: &Layout, buf: &mut Vec<f32>, h0: &mut Vec<half::f16>) -> (Vec<Action>, Vec<(usize, f64, f64)>) {
        for p in 0..self.n {
            self.reachable_production(p);
        }
        let acts = self.rollout_actions(false);
        if acts.is_empty() {
            return (acts, vec![]);
        }
        let leaves = self.net_leaves(&acts, self.current_player, layout, buf);
        let nf = layout.n_features;
        net.layer0_from(&buf[..nf], &buf[nf..], leaves.len(), |h| {
            let start = h0.len();
            h0.resize(start + h.len(), half::f16::ZERO);
            half::slice::HalfFloatSliceExt::convert_from_f32_slice(&mut h0[start..], h); // F16C, 8 wide: the same rounding as one at a time
        });
        (acts, leaves)
    }

    /// Each action's expected P(win) for `p0` over its exact outcomes, scored by `net` on this thread
    /// (terminal outcomes exact). The reach memo must be primed.
    pub fn net_one_ply(&self, acts: &[Action], p0: usize, net: &ValueNet, layout: &Layout, buf: &mut Vec<f32>) -> Vec<f64> {
        let leaves = self.net_leaves(acts, p0, layout, buf);
        let nf = layout.n_features;
        let heads = net.forward_from(Some(&buf[..nf]), &buf[nf..], leaves.len());
        one_ply_ev(acts.len(), &leaves, |k| heads[k * N_HEADS])
    }

    /// `net_one_ply`'s leaves: `buf` = the root row, then one row per outcome of every action; returns
    /// (action, proba, exact value or NaN = ask the net) per outcome row.
    pub fn net_leaves(&self, acts: &[Action], p0: usize, layout: &Layout, buf: &mut Vec<f32>) -> Vec<(usize, f64, f64)> {
        buf.clear();
        buf.extend_from_slice(&self.map.static_template);
        self.encode_into(p0, layout, &mut buf[..layout.n_features]); // row 0: the root, the leaves' layer-1 base
        let mut leaves: Vec<(usize, f64, f64)> = Vec::new();
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
        leaves
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
