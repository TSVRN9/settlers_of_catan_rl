"""Evidence behind docs/RUST-ENGINE.md.

Three questions:
  1. Where does the 52 us engine step actually go? (is there a hot spot to optimize?)
  2. Does ActionRecord.result capture every stochastic outcome? (is replay-based
     differential testing against a reimplementation possible without RNG parity?)
  3. What does search-based training cost in Python? (is AlphaZero gated on a rewrite?)

Takes ~3 min; the MCTS section dominates.
"""

import cProfile, io, pstats, time

from catanatron import Color, Game, RandomPlayer
from catanatron.players.mcts import MCTSPlayer
from catanatron.players.playouts import run_playout

COLORS = [Color.RED, Color.BLUE, Color.WHITE, Color.ORANGE]
STOCHASTIC = {"ROLL", "BUY_DEVELOPMENT_CARD", "DISCARD_RESOURCE", "MOVE_ROBBER"}


def profile_engine(n=25):
    print(f"=== 1. engine profile ({n} games) ===")
    pr = cProfile.Profile()
    pr.enable()
    for i in range(n):
        Game([RandomPlayer(c) for c in COLORS], seed=i).play()
    pr.disable()
    s = io.StringIO()
    pstats.Stats(pr, stream=s).sort_stats("tottime").print_stats(8)
    print("\n".join(s.getvalue().splitlines()[4:16]))


def check_replay_oracle(seeds=30):
    """Every random outcome must be recorded, or replay-based conformance testing breaks."""
    print("\n=== 2. replay oracle: are stochastic outcomes recorded? ===")
    seen = {}
    for s in range(seeds):
        g = Game([RandomPlayer(c) for c in COLORS], seed=s)
        g.play()
        for r in g.state.action_records:
            name = r.action.action_type.name
            if name == "MOVE_ROBBER" and r.action.value[1] is None:
                continue  # no victim -> nothing drawn -> result=None is correct
            if name in STOCHASTIC and name not in seen:
                seen[name] = r
        if STOCHASTIC <= seen.keys():
            break

    for name in sorted(seen):
        print(f"  {name:22s} result={seen[name].result!r}")

    missing = STOCHASTIC - seen.keys()
    unrecorded = [n for n, r in seen.items() if r.result is None]
    assert not missing, f"never observed: {missing} (raise `seeds`)"
    assert not unrecorded, (
        f"ORACLE HOLE: {unrecorded} have result=None, so a replay would diverge. "
        "Differential testing against a reimplementation is NOT safe."
    )
    print("  OK: all stochastic outcomes recorded -> replay needs no RNG parity")


def search_cost():
    print("\n=== 3. search cost ===")
    g = Game([RandomPlayer(c) for c in COLORS], seed=3)
    for _ in range(150):
        g.play_tick()

    n = 150
    t = time.perf_counter()
    for _ in range(n):
        run_playout(g.copy())
    print(f"  single run_playout: {(time.perf_counter()-t)/n*1000:6.1f} ms")

    n = 3000
    t = time.perf_counter()
    for _ in range(n):
        g.copy()
    copy_us = (time.perf_counter() - t) / n * 1e6
    print(f"  Game.copy():        {copy_us:6.1f} us")

    for sims in (10, 50):
        n = 2
        t = time.perf_counter()
        for i in range(n):
            Game(
                [MCTSPlayer(COLORS[0], num_simulations=sims)]
                + [RandomPlayer(c) for c in COLORS[1:]],
                seed=i,
            ).play()
        print(f"  MCTSPlayer({sims:3d} sims):  {(time.perf_counter()-t)/n:6.1f} s/game")

    # AlphaZero uses value-net leaf eval, not rollouts, so copy cost is what binds.
    moves = 435  # non-forced decisions per game; see docs/FINDINGS.md
    print(
        f"\n  AlphaZero projection @800 sims/move (copy-bound): "
        f"{800 * copy_us / 1e6 * moves:.0f} s/game"
    )


if __name__ == "__main__":
    profile_engine()
    check_replay_oracle()
    search_cost()
