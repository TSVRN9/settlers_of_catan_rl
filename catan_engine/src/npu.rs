//! The NPU from the engine (OpenVINO's C API, runtime-linked from the Python wheel's `libopenvino_c`): one compiled
//! model per IR per process, one infer request per caller. Parked rollouts (arena.rs `RollTask`) run their dense
//! layers here in fixed-size chunks inside `PyArena::step`, so a playout takes every net decision it needs within the
//! step instead of one per Python round trip (docs/PLAN-gen-speed.md 2026-09-24).

use openvino::{CompiledModel, Core, DeviceType, InferRequest};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static MODELS: OnceLock<Mutex<(Option<Core>, HashMap<String, CompiledModel>)>> = OnceLock::new();

pub struct NpuNet {
    req: InferRequest,
    rows: usize,  // the IR's static batch
    width: usize, // its input width
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl NpuNet {
    /// `lib`: the `libopenvino_c` shared library; `xml`: an IR (`.bin` beside it) taking `rows` x `width` fp16 and
    /// returning `rows` x 1 win logits.
    pub fn new(lib: &str, xml: &str, rows: usize, width: usize) -> Result<NpuNet, String> {
        openvino_sys::library::load_from(lib)?;
        let mut guard = MODELS.get_or_init(|| Mutex::new((None, HashMap::new()))).lock().unwrap();
        let (core, models) = &mut *guard;
        if core.is_none() {
            *core = Some(Core::new().map_err(err)?);
        }
        if !models.contains_key(xml) {
            let core = core.as_mut().unwrap();
            let model = core.read_model_from_file(xml, &xml.replace(".xml", ".bin")).map_err(err)?;
            models.insert(xml.to_string(), core.compile_model(&model, DeviceType::NPU).map_err(err)?);
        }
        let req = models.get_mut(xml).unwrap().create_infer_request().map_err(err)?;
        Ok(NpuNet { req, rows, width })
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
            self.req.infer().map_err(err)?;
            let output = self.req.get_output_tensor().map_err(err)?;
            out.extend_from_slice(&output.get_data::<f32>().map_err(err)?[..take]);
        }
        Ok(out)
    }

    /// The win logits of `n` rows, taken in order from `rows` (each `width` long), `self.rows` per infer. The rows past
    /// `n` in the last chunk hold stale data; their outputs are dropped.
    pub fn logits<'a>(&mut self, mut rows: impl Iterator<Item = &'a [half::f16]>, n: usize) -> Result<Vec<f32>, String> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let take = (n - out.len()).min(self.rows);
            let mut input = self.req.get_input_tensor().map_err(err)?;
            let dst = input.get_data_mut::<half::f16>().map_err(err)?;
            for r in 0..take {
                dst[r * self.width..(r + 1) * self.width].copy_from_slice(rows.next().expect("fewer rows than n"));
            }
            self.req.infer().map_err(err)?;
            let output = self.req.get_output_tensor().map_err(err)?;
            out.extend_from_slice(&output.get_data::<f32>().map_err(err)?[..take]);
        }
        Ok(out)
    }
}
