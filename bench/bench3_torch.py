import time
import torch
import torch.nn as nn

print("torch", torch.__version__, "| xpu available:", torch.xpu.is_available())
if torch.xpu.is_available():
    print("device:", torch.xpu.get_device_name(0))


def net(obs=614, h=512, act=332):
    return nn.Sequential(
        nn.Linear(obs, h), nn.ReLU(),
        nn.Linear(h, h), nn.ReLU(),
        nn.Linear(h, h), nn.ReLU(),
        nn.Linear(h, act),
    )


def bench(dev, batch, train, iters=60, threads=None):
    if threads:
        torch.set_num_threads(threads)
    m = net().to(dev)
    x = torch.randn(batch, 614, device=dev)
    opt = torch.optim.Adam(m.parameters(), foreach=False)  # foreach=True resets the XPU; see bench5
    sync = (lambda: torch.xpu.synchronize()) if dev == "xpu" else (lambda: None)

    for _ in range(10):  # warmup
        if train:
            opt.zero_grad(); m(x).sum().backward(); opt.step()
        else:
            with torch.no_grad(): m(x)
    sync()

    t = time.perf_counter()
    for _ in range(iters):
        if train:
            opt.zero_grad(); m(x).sum().backward(); opt.step()
        else:
            with torch.no_grad(): m(x)
    sync()
    dt = time.perf_counter() - t
    return iters * batch / dt


devs = ["cpu"] + (["xpu"] if torch.xpu.is_available() else [])
print("\n--- inference (samples/s) ---")
for batch in (1, 32, 256, 2048):
    row = {d: bench(d, batch, train=False) for d in devs}
    print(f"batch {batch:>5}: " + "  ".join(f"{d}={v:>10,.0f}/s" for d, v in row.items()))

print("\n--- training (samples/s) ---")
for batch in (256, 2048, 8192):
    row = {d: bench(d, batch, train=True) for d in devs}
    print(f"batch {batch:>5}: " + "  ".join(f"{d}={v:>10,.0f}/s" for d, v in row.items()))

print("\n--- cpu inference with 1 thread (per-worker realistic) ---")
for batch in (1, 32, 256):
    print(f"batch {batch:>5}: cpu(1thr)={bench('cpu', batch, False, threads=1):>10,.0f}/s")
