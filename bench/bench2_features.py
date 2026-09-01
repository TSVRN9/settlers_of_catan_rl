import time
import gymnasium
import catanatron.gym
import numpy as np
from catanatron import Game, RandomPlayer, Color
from catanatron.features import create_sample_vector, get_feature_ordering

COLORS = [Color.RED, Color.BLUE, Color.WHITE, Color.ORANGE]

# --- 1. feature extraction cost ---
g = Game([RandomPlayer(c) for c in COLORS], seed=1)
for _ in range(120):
    g.play_tick()
print("num features:", len(get_feature_ordering(len(COLORS))))

t = time.perf_counter()
N = 2000
for _ in range(N):
    create_sample_vector(g, Color.RED)
dt = time.perf_counter() - t
print(f"create_sample_vector: {N/dt:.0f}/s  ({dt/N*1e6:.0f} us each)")

# --- 2. playable_actions enumeration cost ---
t = time.perf_counter()
for _ in range(N):
    g.playable_actions
dt = time.perf_counter() - t
print(f"playable_actions: {N/dt:.0f}/s")

# --- 3. gym env step rate (full loop w/ obs + mask) ---
env = gymnasium.make("catanatron/Catanatron-v0")
obs, info = env.reset(seed=0)
print("obs shape:", np.asarray(obs).shape, "action space:", env.action_space)
steps, t = 0, time.perf_counter()
while time.perf_counter() - t < 8.0:
    va = info["valid_actions"]
    obs, r, term, trunc, info = env.step(int(np.random.choice(va)))
    steps += 1
    if term or trunc:
        obs, info = env.reset()
dt = time.perf_counter() - t
print(f"gym env: {steps/dt:.0f} steps/s (1 core, obs+mask included)")
