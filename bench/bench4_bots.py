import time, cProfile, pstats, io
from catanatron import Game, RandomPlayer, Color
from catanatron.players.minimax import AlphaBetaPlayer
from catanatron.players.value import ValueFunctionPlayer
from catanatron.players.weighted_random import WeightedRandomPlayer
from catanatron.features import create_sample_vector

COLORS = [Color.RED, Color.BLUE, Color.WHITE, Color.ORANGE]


def timed(players_fn, n, label):
    t = time.perf_counter()
    for i in range(n):
        Game(players_fn(), seed=i).play()
    dt = time.perf_counter() - t
    print(f"{label:38s} {n:4d} games  {dt:7.2f}s  {dt/n:6.2f} s/game  {n/dt:7.2f} games/s")


timed(lambda: [WeightedRandomPlayer(c) for c in COLORS], 100, "4x WeightedRandom")
timed(lambda: [ValueFunctionPlayer(c) for c in COLORS], 20, "4x ValueFunction")
timed(lambda: [AlphaBetaPlayer(c) for c in COLORS], 3, "4x AlphaBeta (depth default)")
timed(
    lambda: [AlphaBetaPlayer(COLORS[0])] + [RandomPlayer(c) for c in COLORS[1:]],
    5, "1x AlphaBeta vs 3x Random",
)

# Where does obs time actually go?
g = Game([RandomPlayer(c) for c in COLORS], seed=1)
for _ in range(120):
    g.play_tick()
pr = cProfile.Profile()
pr.enable()
for _ in range(1500):
    create_sample_vector(g, Color.RED)
pr.disable()
s = io.StringIO()
pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(12)
print("\n--- create_sample_vector profile ---")
print("\n".join(s.getvalue().splitlines()[4:22]))
