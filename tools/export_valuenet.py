"""Export a ValueNet checkpoint for the Rust/wasm forward pass.
  web/public/models/<name>.bin   little-endian f32: mask, W0, b0, W1, b1, W2, b2, W3, b3 (row-major, out x in)
  web/public/models/<name>.json  shapes + sha256 of the .bin
  catan_engine/testdata/<name>_parity.json   8 (obs, heads) pairs for the Rust parity test
Usage: uv run python tools/export_valuenet.py checkpoints_value/v40.pt v40
"""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import torch

from value_net import N_FEATURES, N_HEADS, load_value_net

ROOT = Path(__file__).resolve().parents[1]
path, name = sys.argv[1], sys.argv[2]
net = load_value_net(path)
assert float(net.alpha) == 0.0, "the Rust forward ignores the smooth prior; export needs alpha == 0"
linears = [m for m in net.mlp if isinstance(m, torch.nn.Linear)]
hidden = linears[0].out_features
parts = [net.mask.numpy()]
for lin in linears:
    parts += [lin.weight.detach().numpy(), lin.bias.detach().numpy()]
blob = np.concatenate([p.astype("<f4").ravel() for p in parts]).tobytes()
out = ROOT / "web/public/models"
(out / f"{name}.bin").write_bytes(blob)
meta = {"n_features": N_FEATURES, "hidden": hidden, "n_heads": N_HEADS, "layers": len(linears), "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(), "source": path,
        "layout": "mask[n_features], then per layer W[out*in] row-major, b[out]"}
(out / f"{name}.json").write_text(json.dumps(meta, indent=1))
rng = np.random.default_rng(0)
xs = rng.integers(0, 3, size=(8, N_FEATURES)).astype(np.float32)
xs[:, :10] = rng.random((8, 10), dtype=np.float32) * 5
with torch.no_grad():
    heads = net.heads(torch.from_numpy(xs)).numpy()
(ROOT / "catan_engine/testdata" / f"{name}_parity.json").write_text(json.dumps({"x": xs.tolist(), "heads": heads.tolist()}))
print(meta)
