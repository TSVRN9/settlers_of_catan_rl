"""Replay the bridge's log-mode oracle (data/jsettlers_oracle*/<game>.jsonl, docs/BENCHMARK.md Phase E)
through the Rust jsettler port and report the match rate per quantity.

Each file: line 1 the board message, then one line per piece the client's trackers saw
(`{"piece":[type,pn,coord],"gameState":g}`, in server order) and one per stock-brain hook with the
decision it took and the trackers' numbers (winGameEta, lrEta, laEta, buildingEtas) at that moment.
The tracker ETAs are fresh only where the Java recomputed them, i.e. at planBuilding under the smart
strategy (`JAVA_OPTS=-Dbridge.strategy=smart jsettlers/run.sh play N log ...`).

    uv run --no-sync python tools/jsettlers_oracle.py [-v] [files...]
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import catan_engine  # noqa: E402
import rust_bridge as rb  # noqa: E402
from jsettlers_server import Server  # noqa: E402

KNIGHT_JS = "9"


def main(paths, verbose=False):
    hits, total = Counter(), Counter()
    shown = Counter()
    for path in paths:
        lines = [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
        if not lines or lines[0].get("op") != "board":
            print(f"{path}: no board line, skipped")
            continue
        srv = Server("rab")
        srv.board(lines[0])
        node_js = [srv.inv_node[i] for i in range(54)]
        game, _ = srv.game({"current": 0, "turns": 1, "robber": lines[0]["hexes"][0][0], "devDeck": 25, "longestRoad": -1, "largestArmy": -1, "spentOffers": [],
                            "players": [{"res": [0] * 6, "devOld": {}, "devNew": {}, "devUnknown": 0, "played": {}, "knights": 0, "vp": 0, "totalVp": 0, "settlements": [], "cities": [], "roads": [], "lrLen": 0, "pieces": [15, 5, 4], "playedDevThisTurn": False} for _ in range(srv.n)]}, "PLAY_TURN", {})
        rs, _ = rb.rust_state(game)
        trackers = catan_engine.JsTrackers(rs, node_js)
        first_player = next((r["piece"][1] for r in lines[1:] if "piece" in r), 0)
        for rec in lines[1:]:
            if rec["gameState"] >= 15:
                trackers.first_turn()
            if "piece" in rec:
                kind, pn, coord = rec["piece"]
                trackers.on_piece(kind, pn, coord, rec["gameState"] < 15)
                continue
            pn = rec["pn"]
            st = rec["state"]
            if rec["hook"] in ("planInitialSettlements", "planSecondSettlement", "planInitRoad"):
                if rec["hook"] == "planInitialSettlements":
                    ours = trackers.plan_initial_settlements(pn)
                    java = rec["chosen"]
                elif rec["hook"] == "planSecondSettlement":
                    ours = trackers.plan_second_settlement(pn)
                    java = rec["chosen"]
                else:
                    ours = trackers.plan_init_road(pn, rec["gameState"], pn, first_player)
                    a, b = rec["chosen"]
                    java = {0x11: b, -0x11: a, 0x0F: a - 0x10, -0x0F: a - 0x01}[a - b]
                total[rec["hook"]] += 1
                hits[rec["hook"]] += ours == java
                if verbose and ours != java and shown[rec["hook"]] < 4:
                    shown[rec["hook"]] += 1
                    print(f"  {Path(path).stem} {rec['hook']} pn {pn}: java {java:#x} rust {ours:#x}")
                continue
            game, _ = srv.game(st, "PLAY_TURN", rec)
            rs, _ = rb.rust_state(game)
            _, from_now_fast, _, _ = catan_engine.jsettler_bse(rs, pn)
            total["buildingEtas"] += 1
            hits["buildingEtas"] += list(from_now_fast) == rec["buildingEtas"]
            if rec["hook"] != "planBuilding":
                continue
            players = st["players"]
            wg, lr, la, _ = trackers.etas(rs, st["longestRoad"], st["largestArmy"], [p["lrLen"] for p in players], [p["knights"] for p in players],
                                          [p["devOld"].get(KNIGHT_JS, 0) for p in players], [p["devNew"].get(KNIGHT_JS, 0) for p in players], st["devDeck"], [p["totalVp"] for p in players])
            if "potSets" in rec:
                ps, prd = trackers.potentials(pn)
                total["potentialSettlements/own seat"] += 1
                hits["potentialSettlements/own seat"] += sorted(ps) == sorted(rec["potSets"])
                total["potentialRoads/own seat"] += 1
                hits["potentialRoads/own seat"] += sorted(prd) == sorted(rec["potRoads"])
                if verbose and sorted(ps) != sorted(rec["potSets"]) and shown["pot"] < 4:
                    shown["pot"] += 1
                    print(f"  {Path(path).stem} turn {st['turns']} potSets java {[hex(c) for c in rec['potSets']]} rust {[hex(c) for c in sorted(ps)]}")
            if "possibles" in rec:
                for q in range(srv.n):
                    ps, prd, pc = trackers.possibles(q)
                    jp = rec["possibles"][q]
                    key = "possibles/own seat" if q == pn else "possibles/other seats"
                    total[key] += 1
                    same = sorted(map(tuple, jp["sets"])) == sorted(ps) and sorted(map(tuple, jp["roads"])) == sorted(prd) and sorted(jp["cities"]) == sorted(pc)
                    hits[key] += same
                    if verbose and not same and shown[key] < 4:
                        shown[key] += 1
                        fmt = lambda xs: [(hex(c), n) for c, n in sorted(xs)]
                        print(f"  {Path(path).stem} turn {st['turns']} seat {q} (pn {pn}) possibles differ:\n    java sets {fmt(map(tuple, jp['sets']))} cities {[hex(c) for c in sorted(jp['cities'])]}\n    rust sets {fmt(ps)} cities {[hex(c) for c in sorted(pc)]}\n    java roads {fmt(map(tuple, jp['roads']))}\n    rust roads {fmt(prd)}")
            # SOCRobotDM.getDevCardScore leaves the real trackers recomputed with one extra VP card in our
            # hand (and never recomputes after), so while the deck lasts the logged own-seat ETA is that one
            wg_plus = wg
            if st["devDeck"] > 0:
                vp_plus = [p["totalVp"] + (1 if q == pn else 0) for q, p in enumerate(players)]
                wg_plus, _, _, _ = trackers.etas(rs, st["longestRoad"], st["largestArmy"], [p["lrLen"] for p in players], [p["knights"] for p in players],
                                                 [p["devOld"].get(KNIGHT_JS, 0) for p in players], [p["devNew"].get(KNIGHT_JS, 0) for p in players], st["devDeck"], vp_plus)
            for q in range(srv.n):
                key = "winGameEta/own seat" if q == pn else "winGameEta/other seats"
                total[key] += 1
                hits[key] += (wg_plus[q] if q == pn else wg[q]) == rec["winGameEta"][q]
            wg_cmp = [wg_plus[q] if q == pn else wg[q] for q in range(srv.n)]
            for name, ours, java in (("winGameEta", wg_cmp, rec["winGameEta"]), ("lrEta", lr[pn], rec["lrEta"]), ("laEta", la[pn], rec["laEta"])):
                total[name] += 1
                if ours == java:
                    hits[name] += 1
                elif verbose and shown[name] < 6:
                    shown[name] += 1
                    print(f"  {Path(path).stem} turn {st['turns']} pn {pn} {name}: java {java} rust {ours}")
                    if name == "winGameEta":
                        for q in range(srv.n):
                            if wg[q] != java[q]:
                                ps, pr, pc = trackers.possibles(q)
                                print(f"    seat {q}: vp {players[q]['totalVp']} settlements {[hex(c) for c in players[q]['settlements']]} posSets {[(hex(c), n) for c, n in ps]} posCities {[hex(c) for c in pc]} posRoads {len(pr)}")
    for k in total:
        print(f"{k}: {hits[k]}/{total[k]} = {100 * hits[k] / total[k]:.1f}% match")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "-v"]
    main(args or sorted(map(str, Path("data/jsettlers_oracle_smart").glob("*.jsonl"))), verbose="-v" in sys.argv)
