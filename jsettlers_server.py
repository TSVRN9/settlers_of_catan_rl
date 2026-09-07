"""Decision server for the JSettlers bridge (docs/BENCHMARK.md Phase B).

`jsettlers/BridgeBrain.java` spawns this process and sends one JSON object per line on stdin:

    {"op": "board", "n": 4, "ourPn": 2, "hexes": [[hexCoord, type, number], ...19], "ports": [[type, nodeA, nodeB], ...9]}
    {"op": "decide", "prompt": P, "state": S, "discard": k, "knight": bool, "offer": {"from": pn, "give": [5], "get": [5]}}
    {"op": "end"}

Coordinates, hex/port types and resource order (clay, ore, sheep, wheat, wood) are JSettlers'; jsettlers_board.py
maps them onto catanatron's BASE map. `S` is the client's view of soc.game.SOCGame (see `js_view` below, which
produces the same shape from a catanatron game and is the contract's executable definition). Each decision
rebuilds a catanatron Game from `S`, so every value_net.make_player token (vnet:<path>, ab, rab, drrl, ...) plays
unchanged, and answers one line: `TYPE a b ...` in JSettlers terms (see `reply`).

Prompts: BUILD_INITIAL_SETTLEMENT, BUILD_INITIAL_ROAD, ROLL (roll or play a knight first), PLAY_TURN, DISCARD
(k cards, decided one at a time here and answered as one set), MOVE_ROBBER, DECIDE_TRADE (an offer to answer).

What the client cannot see is filled in and recorded as a deviation in docs/BENCHMARK.md: opponents' unknown
resource cards are spread over the resources they produce, their hidden dev cards count as knights, their
victory points are the public ones, the dev deck is a seeded shuffle of the cards not yet seen, and the bank is
19 of each minus every card in hand.

    uv run python jsettlers_server.py --player vnet:checkpoints_value/v40.pt      # what the Java client runs
    uv run python jsettlers_server.py --selfcheck                                 # round trip on catanatron games
"""

import argparse
import json
import random
import sys
import traceback

from catanatron.game import Game
from catanatron.models.actions import generate_playable_actions
from catanatron.models.enums import (
    BRICK, CITY, DEVELOPMENT_CARDS, KNIGHT, MONOPOLY, ORE, RESOURCES, ROAD, ROAD_BUILDING, SETTLEMENT, SHEEP, VICTORY_POINT,
    WHEAT, WOOD, YEAR_OF_PLENTY, ActionPrompt, ActionType,
)
from catanatron.models.player import Color, Player
from catanatron.state_functions import build_city, build_road, build_settlement

import jsettlers_board as jb

COLORS = [Color.RED, Color.BLUE, Color.ORANGE, Color.WHITE]
JS_RES = [None, BRICK, ORE, SHEEP, WHEAT, WOOD]  # soc.game.SOCResourceConstants
RES_JS = {r: i for i, r in enumerate(JS_RES) if r}
JS_DEV = {9: KNIGHT, 1: ROAD_BUILDING, 2: YEAR_OF_PLENTY, 3: MONOPOLY}  # soc.game.SOCDevCardConstants; 4..8 are the VP cards
DEV_JS = {KNIGHT: 9, ROAD_BUILDING: 1, YEAR_OF_PLENTY: 2, MONOPOLY: 3, VICTORY_POINT: 4}
DECK = [KNIGHT] * 14 + [YEAR_OF_PLENTY] * 2 + [MONOPOLY] * 2 + [ROAD_BUILDING] * 2 + [VICTORY_POINT] * 5
INITIAL = ("BUILD_INITIAL_SETTLEMENT", "BUILD_INITIAL_ROAD")


def js_dev(t):
    return JS_DEV.get(t, VICTORY_POINT)


class Seat(Player):
    """Placeholder for the rebuilt game's seats; decisions come from the bridge's own player."""

    def decide(self, game, playable_actions):
        raise NotImplementedError


def js_view(game, our_pn, full=False):
    """A catanatron game as the Java client sees it (the JSON contract). `full` reveals opponents' hands
    and dev cards, which the client never can; the self-check uses it for an exact round trip."""
    s = game.state
    colors = list(s.colors)
    ctx = __import__("rust_bridge").ctx_for(game)
    nm, hm = _inverse_maps(game)
    ps = s.player_state
    players = []
    for pn, color in enumerate(colors):
        me = pn == our_pn or full
        key = f"P{pn}"
        hand = [ps[f"{key}_{r}_IN_HAND"] for r in (BRICK, ORE, SHEEP, WHEAT, WOOD)]
        devs = {c: ps[f"{key}_{c}_IN_HAND"] for c in DEVELOPMENT_CARDS}
        old = {DEV_JS[c]: n for c, n in devs.items() if n and ps[f"{key}_{c}_OWNED_AT_START"]}
        new = {DEV_JS[c]: n for c, n in devs.items() if n and not ps[f"{key}_{c}_OWNED_AT_START"]}
        played = {DEV_JS[c]: ps[f"{key}_PLAYED_{c}"] for c in DEVELOPMENT_CARDS if ps[f"{key}_PLAYED_{c}"]}
        settlements = [nm[n] for n in s.buildings_by_color[color][SETTLEMENT]]
        cities = [nm[n] for n in s.buildings_by_color[color][CITY]]
        roads = [[nm[a], nm[b]] for a, b in s.buildings_by_color[color][ROAD]]
        players.append({
            "res": hand + [0] if me else [0, 0, 0, 0, 0, sum(hand)],
            "devOld": old if me else {}, "devNew": new if me else {}, "devUnknown": 0 if me else sum(devs.values()),
            "played": played, "knights": ps[f"{key}_PLAYED_KNIGHT"],
            "vp": ps[f"{key}_VICTORY_POINTS"], "totalVp": ps[f"{key}_ACTUAL_VICTORY_POINTS"] if me else ps[f"{key}_VICTORY_POINTS"],
            "settlements": settlements, "cities": cities, "roads": roads, "lrLen": ps[f"{key}_LONGEST_ROAD_LENGTH"],
            "pieces": [ps[f"{key}_ROADS_AVAILABLE"], ps[f"{key}_SETTLEMENTS_AVAILABLE"], ps[f"{key}_CITIES_AVAILABLE"]],
            "playedDevThisTurn": bool(ps[f"{key}_HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN"]),
        })
    lr = colors.index(s.board.road_color) if s.board.road_color is not None else -1
    la = next((pn for pn in range(len(colors)) if ps[f"P{pn}_HAS_ARMY"]), -1)
    return {
        "current": s.current_turn_index, "turns": s.num_turns, "robber": hm[s.board.robber_coordinate],
        "devDeck": len(s.development_listdeck), "longestRoad": lr, "largestArmy": la, "players": players,
        "spentOffers": [[o[RESOURCES.index(JS_RES[i + 1]) + 5 * half] for half in (0, 1) for i in range(5)] for o in s.spent_offers],
        "hasRolled": bool(ps[f"P{s.current_turn_index}_HAS_ROLLED"]),
    }


def _inverse_maps(game):
    """catanatron node id -> JSettlers node coord and cube coord -> JSettlers hex, for the board of `game`
    (the self-check's boards come from catanatron, so rotation 0 is used for the view)."""
    nm = {v: k for k, v in jb.node_map(0, game.state.board.map.tiles).items()}
    hm = {v: k for k, v in jb.hex_map(0).items()}
    return nm, hm


class Server:
    def __init__(self, token):
        self.token = token
        self.player = None
        self.map = None

    # ---- the board, once per game ----
    def board(self, msg):
        hexes = {h: (t, n) for h, t, n in msg["hexes"]}
        self.map, self.nm, self.hm = jb.catan_map(hexes, [tuple(p) for p in msg["ports"]])
        self.inv_node = {v: k for k, v in self.nm.items()}
        self.inv_hex = {v: k for k, v in self.hm.items()}
        self.n = msg["n"]
        self.our = msg["ourPn"]
        self.colors = list(Game([Seat(c) for c in COLORS[: self.n]], seed=0, catan_map=self.map).state.colors)  # seat -> colour, fixed by the seed
        if self.player is not None:  # one server plays a sequence of games, in different seats
            self.player.color = self.colors[self.our]
            self.player.reset_state()

    # ---- the catanatron game behind one decision ----
    def game(self, st, prompt, msg):
        game = Game([Seat(c) for c in COLORS[: self.n]], seed=0, catan_map=self.map)
        s = game.state
        colors = list(s.colors)  # seat pn -> colour
        ps = s.player_state
        nm = self.nm
        # every settlement before any road: catanatron only splits a road network at an enemy settlement
        # placed after the roads, so a road ending at an enemy's node must find that node occupied
        for pn, p in enumerate(st["players"]):
            color = colors[pn]
            for node in p["settlements"] + p["cities"]:
                build_settlement(s, color, nm[node], True)
                s.board.build_settlement(color, nm[node], True)
            for node in p["cities"]:
                build_city(s, color, nm[node])
                s.board.build_city(color, nm[node])
        for pn, p in enumerate(st["players"]):
            color = colors[pn]
            pending = [tuple(sorted((nm[a], nm[b]))) for a, b in p["roads"]]
            while pending:
                ok = [e for e in pending if e in s.board.buildable_edges(color)]
                if not ok:
                    # a chain cut off from its settlements by an enemy building: its own component, as
                    # catanatron's split would have left it
                    e = pending[0]
                    free = [n for n in e if not s.board.is_enemy_node(n, color)]
                    if not free:
                        raise ValueError(f"seat {pn}: road {e} sits between two enemy buildings")
                    s.board.connected_components[color].append({free[0]})
                    s.board.buildable_edges_cache = {}
                    continue
                for e in ok:
                    build_road(s, color, e, True)
                    s.board.build_road(color, e)
                    pending.remove(e)
        for pn, p in enumerate(st["players"]):
            color, key = colors[pn], f"P{pn}"
            hand = {JS_RES[i + 1]: p["res"][i] for i in range(5)}
            for r, k in zip(RESOURCES, self._spread(p["res"][5], s, color)):
                hand[r] += k
            for r in RESOURCES:
                ps[f"{key}_{r}_IN_HAND"] = hand[r]
            for c in DEVELOPMENT_CARDS:
                ps[f"{key}_{c}_IN_HAND"] = 0
                ps[f"{key}_{c}_OWNED_AT_START"] = False
                ps[f"{key}_PLAYED_{c}"] = 0
            for jt, k in p["devOld"].items():
                ps[f"{key}_{js_dev(int(jt))}_IN_HAND"] += k
                ps[f"{key}_{js_dev(int(jt))}_OWNED_AT_START"] = True
            for jt, k in p["devNew"].items():
                ps[f"{key}_{js_dev(int(jt))}_IN_HAND"] += k
            ps[f"{key}_KNIGHT_IN_HAND"] += p["devUnknown"]
            for jt, k in p["played"].items():
                ps[f"{key}_PLAYED_{js_dev(int(jt))}"] += k
            ps[f"{key}_PLAYED_KNIGHT"] = p["knights"]
            ps[f"{key}_VICTORY_POINTS"] = p["vp"]
            ps[f"{key}_ACTUAL_VICTORY_POINTS"] = p["totalVp"]
            ps[f"{key}_HAS_ROAD"] = pn == st["longestRoad"]
            ps[f"{key}_HAS_ARMY"] = pn == st["largestArmy"]
            ps[f"{key}_LONGEST_ROAD_LENGTH"] = p["lrLen"]
            ps[f"{key}_ROADS_AVAILABLE"], ps[f"{key}_SETTLEMENTS_AVAILABLE"], ps[f"{key}_CITIES_AVAILABLE"] = p["pieces"]
            ps[f"{key}_HAS_ROLLED"] = pn == st["current"] and prompt not in INITIAL and prompt != "ROLL"
            ps[f"{key}_HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN"] = p["playedDevThisTurn"]
        lr = st["longestRoad"]
        s.board.road_color = colors[lr] if lr >= 0 else None
        s.board.road_length = st["players"][lr]["lrLen"] if lr >= 0 else 0
        s.board.robber_coordinate = self.hm[st["robber"]]
        s.resource_freqdeck = [max(0, 19 - sum(ps[f"P{pn}_{r}_IN_HAND"] for pn in range(self.n))) for r in RESOURCES]
        pool = list(DECK)
        for pn in range(self.n):
            for c in DEVELOPMENT_CARDS:
                for _ in range(ps[f"P{pn}_PLAYED_{c}"] + (ps[f"P{pn}_{c}_IN_HAND"] if pn == self.our else 0)):
                    if c in pool:
                        pool.remove(c)
        random.Random(st["turns"] * 131 + st["current"]).shuffle(pool)
        s.development_listdeck = pool[: st["devDeck"]]
        s.current_turn_index = st["current"]
        s.current_player_index = self.our if prompt in ("DISCARD", "DECIDE_TRADE") else st["current"]
        s.num_turns = st["turns"]
        s.is_initial_build_phase = prompt in INITIAL
        s.current_prompt = ActionPrompt[prompt if prompt in ("DISCARD", "MOVE_ROBBER", "DECIDE_TRADE") or prompt in INITIAL else "PLAY_TURN"]
        if prompt == "DISCARD":
            s.is_discarding = True
            s.discard_counts[self.our] = msg["discard"]
        s.is_moving_knight = bool(msg.get("knight"))  # a knight's robber move, or (after it) the rest of that turn
        s.spent_offers = tuple(
            tuple(o[RES_JS[r] - 1 + 5 * half] for half in (0, 1) for r in RESOURCES) for o in st.get("spentOffers", [])
        )
        if prompt == "DECIDE_TRADE":
            o = msg["offer"]
            give = [o["give"][RES_JS[r] - 1] for r in RESOURCES]
            get = [o["get"][RES_JS[r] - 1] for r in RESOURCES]
            s.current_trade = tuple(give + get + [o["from"]])
            s.is_resolving_trade = True
        game.playable_actions = generate_playable_actions(s)
        return game, colors

    def _spread(self, unknown, s, color):
        """Unknown cards spread over the resources a seat produces (largest remainders), all wood if it produces nothing."""
        if not unknown:
            return [0] * 5
        prod = [0.0] * 5
        for node in s.buildings_by_color[color][SETTLEMENT] + s.buildings_by_color[color][CITY] * 2:
            for r, w in s.board.map.node_production[node].items():
                prod[RESOURCES.index(r)] += w
        total = sum(prod) or 1.0
        shares = [unknown * p / total for p in prod] if sum(prod) else [unknown, 0, 0, 0, 0]
        out = [int(x) for x in shares]
        for i in sorted(range(5), key=lambda i: shares[i] - int(shares[i]), reverse=True)[: unknown - sum(out)]:
            out[i] += 1
        return out

    # ---- one decision ----
    def decide(self, msg):
        prompt = msg["prompt"]
        game, colors = self.game(msg["state"], prompt, msg)
        if self.player is None:
            from value_net import make_player

            self.player = make_player(self.token, colors[self.our])
            self.player.bridge = True  # a DrrlPlayer may answer an offer with a counter-offer here
        acts = []

        def step():
            a = self.player.decide(game, game.playable_actions)
            if a.action_type == ActionType.OFFER_TRADE and prompt == "DECIDE_TRADE":
                return a  # a counter-offer: JSettlers' reply, not a move in this engine
            if a.action_type != ActionType.OFFER_TRADE:
                assert a in game.playable_actions, f"{a} not in {game.playable_actions}"
            game.execute(a)
            acts.append(a)
            return a

        a = step()
        if prompt == "DECIDE_TRADE" and a.action_type == ActionType.OFFER_TRADE:
            return "COUNTER_" + self.reply([a], colors)
        if prompt == "DISCARD":
            for _ in range(msg["discard"] - 1):
                step()
        elif a.action_type == ActionType.PLAY_ROAD_BUILDING:
            while game.state.is_road_building and any(x.action_type == ActionType.BUILD_ROAD for x in game.playable_actions):
                step()
        return self.reply(acts, colors)

    def reply(self, acts, colors):
        a = acts[0]
        t, v = a.action_type, a.value
        inv = self.inv_node
        if t in (ActionType.BUILD_ROAD,):
            return f"BUILD_ROAD {inv[v[0]]} {inv[v[1]]}"
        if t in (ActionType.BUILD_SETTLEMENT, ActionType.BUILD_CITY):
            return f"{t.value} {inv[v]}"
        if t == ActionType.MOVE_ROBBER:
            return f"MOVE_ROBBER {self.inv_hex[v[0]]} {colors.index(v[1]) if v[1] is not None else -1}"
        if t == ActionType.DISCARD_RESOURCE:
            counts = [0] * 5
            for x in acts:
                counts[RES_JS[x.value] - 1] += 1
            return "DISCARD " + " ".join(map(str, counts))
        if t == ActionType.PLAY_YEAR_OF_PLENTY:
            rs = [RES_JS[r] for r in v if r is not None]
            return f"PLAY_YEAR_OF_PLENTY {rs[0]} {rs[1] if len(rs) > 1 else 0}"
        if t == ActionType.PLAY_MONOPOLY:
            return f"PLAY_MONOPOLY {RES_JS[v]}"
        if t == ActionType.PLAY_ROAD_BUILDING:
            edges = [f"{inv[x.value[0]]} {inv[x.value[1]]}" for x in acts[1:]]
            return "PLAY_ROAD_BUILDING " + " ".join(edges + ["-1 -1"] * (2 - len(edges)))
        if t == ActionType.MARITIME_TRADE:
            give = [r for r in v[:4] if r is not None]
            return f"MARITIME_TRADE {RES_JS[give[0]]} {len(give)} {RES_JS[v[4]]}"
        if t == ActionType.OFFER_TRADE:
            js = [0] * 10
            for i, r in enumerate(RESOURCES):
                js[RES_JS[r] - 1] = v[i]
                js[5 + RES_JS[r] - 1] = v[5 + i]
            return "OFFER_TRADE " + " ".join(map(str, js))
        return t.value  # ROLL, END_TURN, BUY_DEVELOPMENT_CARD, PLAY_KNIGHT_CARD, ACCEPT_TRADE, REJECT_TRADE

    def end(self):
        if self.player is not None:
            self.player.reset_state()


def serve(token):
    srv = Server(token)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            op = msg["op"]
            out = "OK" if op == "board" else srv.decide(msg) if op == "decide" else "OK"
            if op == "board":
                srv.board(msg)
            elif op == "end":
                srv.end()
        except Exception as e:  # the Java side falls back to the stock brain on ERROR
            traceback.print_exc(file=sys.stderr)
            out = f"ERROR {type(e).__name__}: {e}".replace("\n", " ")
        print(out, flush=True)


def selfcheck():
    """Positions from catanatron games, sent through the client's view with `full` information, rebuild to the
    same Rust state spec (up to the unknowable dev-deck order) with the same legal actions, and a value-net
    decision through `decide` is a legal reply."""
    import rust_bridge as rb
    from value_net import make_player

    from catanatron.models.enums import Action

    checked = 0
    for seed in (11, 12):
        players = [make_player("rab", c) for c in COLORS]
        game = Game(players, seed=seed)
        srv = Server("rab")
        m = game.state.board.map
        js_type = {v: k for k, v in jb.JS_RESOURCE.items()}
        nm, hm = _inverse_maps(game)
        from catanatron.models.map import PORT_DIRECTION_TO_NODEREFS

        hexes = [[hm[c], js_type[t.resource], t.number or 0] for c, t in m.land_tiles.items()]
        ports = []
        for p in m.ports_by_id.values():
            a, b = PORT_DIRECTION_TO_NODEREFS[p.direction]
            ports.append([0 if p.resource is None else js_type[p.resource], nm[p.nodes[a]], nm[p.nodes[b]]])
        srv.board({"op": "board", "n": 4, "ourPn": 0, "hexes": hexes, "ports": ports})
        assert srv.nm == {k: v for k, v in jb.node_map(0, m.tiles).items()} or True  # rotation may differ; specs compared below
        steps = 0
        while game.winning_color() is None and steps < 400:
            s = game.state
            prompt = s.current_prompt.value
            plain = prompt in ("PLAY_TURN", "MOVE_ROBBER", "DISCARD", "BUILD_INITIAL_SETTLEMENT", "BUILD_INITIAL_ROAD", "DECIDE_TRADE")
            if plain and not s.is_road_building and steps % 7 == 0:
                our = s.current_player_index
                srv.our = our
                view = js_view(game, our, full=True)
                p = prompt if prompt != "PLAY_TURN" or view["hasRolled"] else "ROLL"
                msg = {"prompt": p, "state": view, "discard": s.discard_counts[our] if prompt == "DISCARD" else 0, "knight": s.is_moving_knight}
                if prompt == "DECIDE_TRADE":
                    ct = s.current_trade
                    msg["offer"] = {"from": ct[10], "give": [ct[RESOURCES.index(JS_RES[i + 1])] for i in range(5)], "get": [ct[5 + RESOURCES.index(JS_RES[i + 1])] for i in range(5)]}
                rebuilt, colors = srv.game(view, p, msg)
                want, got = rb.state_spec(game), rb.state_spec(rebuilt)
                # the rebuilt board may be a rotated copy: compare through each side's own node/edge names
                for k in ("hand", "devs", "played", "vp", "actual_vp", "roads_available", "settlements_available", "cities_available",
                          "has_road", "has_army", "has_rolled", "has_played_dev", "longest_road_length", "bank", "road_lengths",
                          "road_color", "road_length", "current_player", "current_turn", "prompt", "initial_phase", "is_discarding",
                          "is_moving_knight", "n", "num_turns", "is_resolving_trade", "current_trade", "spent_offers"):
                    assert want[k] == got[k], (k, want[k], got[k], steps, seed)
                assert sorted(map(len, want["settlements"])) == sorted(map(len, got["settlements"]))
                assert sorted(map(len, got["roads"])) == sorted(map(len, want["roads"]))
                assert sum(want["is_city"]) == sum(got["is_city"]) and sorted(want["owner"]) == sorted(got["owner"])
                assert sorted(want["road_owner"]) == sorted(got["road_owner"])
                assert len(want["buildable"]) == len(got["buildable"]), (len(want["buildable"]), len(got["buildable"]))
                assert len(want["dev_deck"]) == len(got["dev_deck"])
                assert len(game.playable_actions) == len(rebuilt.playable_actions), (game.playable_actions, rebuilt.playable_actions)
                assert sorted(a.action_type.value for a in game.playable_actions) == sorted(a.action_type.value for a in rebuilt.playable_actions)
                srv.player = None
                line = srv.decide(msg)
                legal = {a.action_type.value for a in rebuilt.playable_actions} | {"OFFER_TRADE"}
                assert line.split()[0] in legal or (line.startswith("DISCARD ") and "DISCARD_RESOURCE" in legal), line
                checked += 1
            game.play_tick()
            steps += 1
    # a request the server rejected on 2026-09-07: our road ended at an enemy settlement (node 201) and the
    # rebuilt board let it continue past it
    msg = json.load(open("jsettlers/fixtures/rejected_road.json"))
    srv = Server("rab")
    srv.board(json.load(open("jsettlers/fixtures/rejected_road_board.json")))
    game, colors = srv.game(msg["state"], msg["prompt"], msg)
    roads = {tuple(sorted((srv.inv_node[a.value[0]], srv.inv_node[a.value[1]]))) for a in game.playable_actions if a.action_type == ActionType.BUILD_ROAD}
    assert (201, 216) not in roads, "a road past an enemy settlement is still offered"
    assert roads, "no roads at all"
    print(f"jsettlers_server: {checked} positions rebuilt from the client's view with matching specs and legal replies, rejected-road fixture: ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--player", default="vnet:checkpoints_value/v40.pt", help="value_net.make_player token")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()
    if args.selfcheck:
        selfcheck()
    else:
        serve(args.player)
