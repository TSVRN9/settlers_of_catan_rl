//! The NPU from the engine (OpenVINO's C API, runtime-linked from the Python wheel's `libopenvino_c`): one compiled
//! model per IR per process, one infer request per caller. Parked rollouts (arena.rs `RollTask`) run their dense
//! layers here in fixed-size chunks inside `PyArena::step`, so a playout takes every net decision it needs within the
//! step instead of one per Python round trip (docs/PLAN-gen-speed.md 2026-09-24).

use openvino::{CompiledModel, Core, DeviceType, InferRequest};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static MODELS: OnceLock<Mutex<(Option<Core>, HashMap<String, CompiledModel>)>> = OnceLock::new();
/// NPU_STATS=1: (infers, real rows) over every NpuNet of the process, printed as each is dropped.
static STATS: [std::sync::atomic::AtomicU64; 2] = [std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0)];

/// At most NPU_INFLIGHT (default 4; 0 = no limit) infers in flight across the process; the other callers sleep on a
/// condvar instead of spinning in the driver's host-side wait (`VPUCommandBuffer::busyWait`, 15% of width-512
/// generation CPU with 32 arenas). Exact; neutral in games/s at 4 (0 and 8 the same, 1-2 slower, 2026-09-29).
fn infer(req: &mut InferRequest) -> Result<(), String> {
    use std::sync::Condvar;
    static LIMIT: OnceLock<Option<usize>> = OnceLock::new();
    static SLOTS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());
    let Some(k) = *LIMIT.get_or_init(|| match std::env::var("NPU_INFLIGHT").ok().and_then(|v| v.parse().ok()) {
        Some(0) => None,
        Some(k) => Some(k),
        None => Some(4),
    }) else { return req.infer().map_err(err) };
    let (m, cv) = &SLOTS;
    {
        let mut n = cv.wait_while(m.lock().unwrap(), |n| *n >= k).unwrap();
        *n += 1;
    }
    let r = req.infer().map_err(err);
    *m.lock().unwrap() -= 1;
    cv.notify_one();
    r
}

fn count(take: usize) {
    use std::sync::atomic::Ordering::Relaxed;
    STATS[0].fetch_add(1, Relaxed);
    STATS[1].fetch_add(take as u64, Relaxed);
}

pub struct NpuNet {
    req: InferRequest,
    rows: usize,  // the IR's static batch
    width: usize, // its input width
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Drop for NpuNet {
    fn drop(&mut self) {
        if std::env::var_os("NPU_STATS").is_some() {
            let (n, r) = (STATS[0].load(std::sync::atomic::Ordering::Relaxed), STATS[1].load(std::sync::atomic::Ordering::Relaxed));
            eprintln!("npu stats: {n} infers of {} rows, {r} real ({:.1}%)", self.rows, 100.0 * r as f64 / (n * self.rows as u64).max(1) as f64);
        }
    }
}

impl NpuNet {
    /// `lib`: the `libopenvino_c` shared library; `xml`: an IR (`.bin` beside it) taking `rows` x `width` fp16 and
    /// returning `rows` x 1 win logits.
    pub fn new(lib: &str, xml: &str, rows: usize, width: usize) -> Result<NpuNet, String> {
        openvino_sys::library::load_from(lib)?;
        let mut guard = MODELS.get_or_init(|| Mutex::new((None, HashMap::new()))).lock().unwrap();
        let (core, models) = &mut *guard;
        if core.is_none() {
            let mut c = Core::new().map_err(err)?;
            if std::env::var("NPU_TURBO").as_deref() == Ok("1") {
                c.set_property(&DeviceType::NPU, &openvino::RwPropertyKey::Other("NPU_TURBO".into()), "YES").map_err(err)?;
            }
            *core = Some(c);
        }
        if !models.contains_key(xml) {
            let core = core.as_mut().unwrap();
            let model = core.read_model_from_file(xml, &xml.replace(".xml", ".bin")).map_err(err)?;
            models.insert(xml.to_string(), core.compile_model(&model, DeviceType::NPU).map_err(err)?);
        }
        let req = models.get_mut(xml).unwrap().create_infer_request().map_err(err)?;
        Ok(NpuNet { req, rows, width })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn chunk_rows(&self) -> usize {
        self.rows
    }

    /// `logits` for f32 rows (search leaves), converted to fp16 on the way into the tensor.
    pub fn logits_f32<'a>(&mut self, mut rows: impl Iterator<Item = &'a [f32]>, n: usize) -> Result<Vec<f32>, String> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let take = (n - out.len()).min(self.rows);
            let mut input = self.req.get_input_tensor().map_err(err)?;
            let dst = input.get_data_mut::<half::f16>().map_err(err)?;
            for r in 0..take {
                half::slice::HalfFloatSliceExt::convert_from_f32_slice(&mut dst[r * self.width..(r + 1) * self.width], rows.next().expect("fewer rows than n"));
            }
            count(take);
            infer(&mut self.req)?;
            let output = self.req.get_output_tensor().map_err(err)?;
            out.extend_from_slice(&output.get_data::<f32>().map_err(err)?[..take]);
        }
        Ok(out)
    }

    /// The win logits of the rows of `blocks` in order (each block a whole number of `width`-long rows), `self.rows`
    /// per infer. The rows past the end in the last chunk hold stale data; their outputs are dropped. The copy into
    /// the input tensor runs in parallel by block piece: row by row on one thread it was ~7% of generation CPU, the
    /// source rows being fresh in other cores' caches (docs/PLAN-gen-speed.md 2026-09-27).
    pub fn logits(&mut self, blocks: &[&[half::f16]]) -> Result<Vec<f32>, String> {
        use rayon::prelude::*;
        const PIECE: usize = 256; // rows per parallel copy
        let w = self.width;
        debug_assert!(blocks.iter().all(|b| b.len() % w == 0));
        let n: usize = blocks.iter().map(|b| b.len() / w).sum();
        let mut out = Vec::with_capacity(n);
        let (mut bi, mut boff) = (0usize, 0usize); // the next row to copy: block bi, row boff
        while out.len() < n {
            let take = (n - out.len()).min(self.rows);
            let mut input = self.req.get_input_tensor().map_err(err)?;
            let dst = input.get_data_mut::<half::f16>().map_err(err)?;
            let mut pieces: Vec<(&mut [half::f16], &[half::f16])> = Vec::new();
            let (mut rest, mut left) = (&mut dst[..take * w], take);
            while left > 0 {
                let avail = blocks[bi].len() / w - boff;
                if avail == 0 {
                    (bi, boff) = (bi + 1, 0);
                    continue;
                }
                let k = avail.min(left).min(PIECE);
                let (d, r) = std::mem::take(&mut rest).split_at_mut(k * w);
                pieces.push((d, &blocks[bi][boff * w..(boff + k) * w]));
                (rest, left, boff) = (r, left - k, boff + k);
            }
            pieces.into_par_iter().for_each(|(d, s)| d.copy_from_slice(s));
            count(take);
            infer(&mut self.req)?;
            let output = self.req.get_output_tensor().map_err(err)?;
            out.extend_from_slice(&output.get_data::<f32>().map_err(err)?[..take]);
        }
        Ok(out)
    }
}
