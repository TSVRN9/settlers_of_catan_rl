"""Summarise the bridge's result files (docs/BENCHMARK.md Phase B) as a markdown table.

Each line, written by jsettlers/BridgeBrain.java at game end: `game ourPn winnerPn score0 score1 score2 score3 name0..name3`.

    uv run python tools/jsettlers_results.py docs/benchmark/jsettlers_*.txt
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evaluate import wilson_interval  # noqa: E402


def summarise(path):
    games = wins = vp = 0
    opp = set()
    for line in Path(path).read_text().splitlines():
        f = line.split()
        if len(f) < 11:
            continue
        our, winner = int(f[1]), int(f[2])
        scores = list(map(int, f[3:7]))
        games += 1
        wins += winner == our
        vp += scores[our]
        opp.update(n for i, n in enumerate(f[7:11]) if i != our)
    return games, wins, vp, opp


def main(paths):
    print("| series | games | wins | win ratio | 95% CI | mean VP | opponents seen |")
    print("|---|---|---|---|---|---|---|")
    for p in paths:
        games, wins, vp, opp = summarise(p)
        if not games:
            print(f"| {Path(p).stem} | 0 | – | – | – | – | – |")
            continue
        lo, hi = wilson_interval(wins, games)
        kinds = sorted({n.split("_")[0] for n in opp})
        print(f"| {Path(p).stem} | {games} | {wins} | {100 * wins / games:.1f}% | [{100 * lo:.1f}, {100 * hi:.1f}] | {vp / games:.2f} | {', '.join(kinds)} |")


if __name__ == "__main__":
    main(sys.argv[1:] or sorted(map(str, Path("docs/benchmark").glob("jsettlers_*.txt"))))
