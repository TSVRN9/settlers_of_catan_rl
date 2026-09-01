import time, sys
from catanatron import Game, RandomPlayer, Color

COLORS = [Color.RED, Color.BLUE, Color.WHITE, Color.ORANGE]


def run(n, make_players, label):
    decisions = 0
    turns = 0
    t = time.perf_counter()
    for i in range(n):
        g = Game(make_players(), seed=i)
        g.play()
        decisions += len(g.state.action_records)
        turns += g.state.num_turns
    dt = time.perf_counter() - t
    print(
        f"{label}: {n} games in {dt:.2f}s | {n/dt:.1f} games/s | "
        f"{decisions/n:.0f} decisions/game | {turns/n:.0f} turns/game | "
        f"{decisions/dt:.0f} decisions/s"
    )
    return decisions / dt


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    dps = run(n, lambda: [RandomPlayer(c) for c in COLORS], "4p random")
    print(f"\n1 core: {dps*86400/1e6:.1f}M decisions/day")
    print(f"7 cores: {dps*7*86400/1e6:.1f}M decisions/day")
    print(f"days to 450M decisions on 7 cores: {450e6/(dps*7*86400):.1f}")
