import time, sys, traceback
import torch, torch.nn as nn

print("torch", torch.__version__, "xpu:", torch.xpu.is_available())


def net(obs=614, h=512, act=332):
    return nn.Sequential(
        nn.Linear(obs, h), nn.ReLU(),
        nn.Linear(h, h), nn.ReLU(),
        nn.Linear(h, h), nn.ReLU(),
        nn.Linear(h, act),
    )


def train_bench(dev, batch, opt_name, iters=50):
    m = net().to(dev)
    x = torch.randn(batch, 614, device=dev)
    opt = {"adam": torch.optim.Adam, "sgd": torch.optim.SGD,
           "adamf": lambda p: torch.optim.Adam(p, foreach=False)}[opt_name](m.parameters())
    for _ in range(5):
        opt.zero_grad(); m(x).sum().backward(); opt.step()
    if dev == "xpu":
        torch.xpu.synchronize()
    t = time.perf_counter()
    for _ in range(iters):
        opt.zero_grad(); m(x).sum().backward(); opt.step()
    if dev == "xpu":
        torch.xpu.synchronize()
    return iters * batch / (time.perf_counter() - t)


for opt_name in ("sgd", "adamf", "adam"):
    for batch in (256, 2048):
        for dev in ("cpu", "xpu"):
            try:
                v = train_bench(dev, batch, opt_name)
                print(f"{opt_name:6s} batch {batch:>5} {dev}: {v:>12,.0f} samples/s")
            except Exception as e:
                print(f"{opt_name:6s} batch {batch:>5} {dev}: FAILED {type(e).__name__}: {str(e)[:90]}")
                sys.stdout.flush()
