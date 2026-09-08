import type { Attribution, BotKind, Canon, MapView } from "./engine";

export const RESOURCES = ["Wood", "Brick", "Sheep", "Wheat", "Ore"];
export const RESOURCE_EMOJI = ["🌲", "🧱", "🐑", "🌾", "⛰️"];
export const DEV_CARDS = ["Knight", "Year of Plenty", "Monopoly", "Road Building", "Victory Point"];
export const SEAT_NAMES = ["Red", "Blue", "Orange", "White"];
// Seat colours live in board/palette.ts now, generated from the design canvas — the old
// near-white fourth seat vanished on chalk, sheep and desert.
/** What the engine is waiting for, as an obligation. Only the phases that really are one:
 *  PLAY_TURN is a free turn, and the panel's own "Your options" is the honest title. */
export const PROMPTS: Record<string, string> = {
  BUILD_INITIAL_SETTLEMENT: "place a settlement",
  BUILD_INITIAL_ROAD: "place a road",
  DISCARD: "discard",
  MOVE_ROBBER: "move the robber",
  DECIDE_TRADE: "answer the offer",
  DECIDE_ACCEPTEES: "close the trade",
};

/** An action type as one button, when the engine's decomposition of it is too long to list
 *  (a year of plenty is one action per resource pair). Falls back to the type itself. */
export const GROUP: Record<string, string> = {
  PLAY_YEAR_OF_PLENTY: "Play Year of Plenty…",
  PLAY_MONOPOLY: "Play Monopoly…",
  MARITIME_TRADE: "Trade with the bank…",
};

export const GROUP_AT = 3;   // ponytail: at or below this, a flat list still reads fine
export type Row = { a: Canon; group: Canon[] | null };

/** An action list as the panel's rows. The engine decomposes a card into one action per
 *  outcome — a year of plenty is every resource pair, twenty buttons of it — so a type with
 *  more variants than GROUP_AT becomes one row carrying the whole group, which the panel
 *  opens rather than plays. Order is first-seen, so the flat types keep their place. */
export function rows(actions: Canon[]): Row[] {
  const by = new Map<string, Canon[]>();
  for (const a of actions) by.set(a[0], [...(by.get(a[0]) ?? []), a]);
  return [...by.values()].flatMap((g): Row[] =>
    g.length > GROUP_AT ? [{ a: g[0], group: g }] : g.map((a) => ({ a, group: null })));
}

/** Whether an offer can actually be made, mirroring the four conditions apply.rs:21-43
 *  enforces. The engine validates offers free-form — it only ever *enumerates* the 20-bundle
 *  catalogue — so the builder may propose anything that passes this, 3-for-1 included.
 *  `spent` is view.spent_offers: give[0..5] then get[5..10], per actions.rs offer_key. */
export function canOffer(give: number[], get: number[], hand: number[], spent: number[][]) {
  const g = give.reduce((a, b) => a + b, 0), r = get.reduce((a, b) => a + b, 0);
  if (g === 0 || r === 0) return false;                                   // both sides must have cards
  if (give.some((c, i) => c > 0 && get[i] > 0)) return false;             // never the same resource both ways
  if (give.some((c, i) => c > hand[i])) return false;                     // you cannot offer what you lack
  const key = [...give, ...get];                                          // already refused this turn?
  return !spent.some((k) => key.every((c, i) => k[i] === c));
}

export function actionKey(a: Canon) { return a.join(":"); }

export function label(a: Canon, map?: MapView): string {
  const [t, x, y, z] = a;
  switch (t) {
    case "ROLL": return "Roll the dice";
    case "END_TURN": return "End turn";
    case "BUILD_ROAD": return `Build a road ${edgeName(x, map)}`;
    case "BUILD_SETTLEMENT": return `Build a settlement on ${cornerName(x, map)}`;
    case "BUILD_CITY": return `Build a city on ${cornerName(x, map)}`;
    case "BUY_DEVELOPMENT_CARD": return "Buy a development card";
    case "PLAY_KNIGHT_CARD": return "Play Knight";
    case "PLAY_YEAR_OF_PLENTY": return y < 0 ? `Year of Plenty: take ${RESOURCES[x]}` : `Year of Plenty: take ${RESOURCES[x]} + ${RESOURCES[y]}`;
    case "PLAY_MONOPOLY": return `Monopoly on ${RESOURCES[x]}`;
    case "PLAY_ROAD_BUILDING": return "Play Road Building";
    case "MARITIME_TRADE": return `Trade ${y} ${RESOURCES[x]} → 1 ${RESOURCES[z]}`;
    case "MOVE_ROBBER": return `Robber to ${tileName(x, map)}${y >= 0 ? `, rob ${SEAT_NAMES[y]}` : ""}`;
    case "DISCARD_RESOURCE": return `Discard ${RESOURCES[x]}`;
    case "OFFER_TRADE": return `Offer ${bundleText(unpackBundle(x))} for ${bundleText(unpackBundle(y))}`;
    case "ACCEPT_TRADE": return "Accept the offer";
    case "REJECT_TRADE": return "Reject the offer";
    case "CONFIRM_TRADE": return `Trade with ${SEAT_NAMES[x]}`;
    case "CANCEL_TRADE": return "Cancel the trade";
    default: return t;
  }
}

/** Five resource counts in 5 bits each (actions.rs pack_bundle). */
export function packBundle(counts: number[]) { return counts.reduce((acc, c, i) => acc + ((c & 31) << (5 * i)), 0); }
export function unpackBundle(x: number) { return Array.from({ length: 5 }, (_, i) => (x >> (5 * i)) & 31); }
export function bundleText(counts: number[]) {
  const parts = counts.map((c, i) => (c > 0 ? `${c} ${RESOURCES[i].toLowerCase()}` : "")).filter(Boolean);
  return parts.length ? parts.join(" + ") : "nothing";
}
/** current_trade (give[5], get[5], offerer) -> readable offer. */
export function tradeText(t: number[]) { return `${SEAT_NAMES[t[10]]} offers ${bundleText(t.slice(0, 5))} for ${bundleText(t.slice(5, 10))}`; }

export function tileName(id: number, map?: MapView) {
  const t = map?.tiles[id];
  if (!t) return `tile ${id}`;
  return t.resource < 0 ? "the desert" : `the ${t.number} ${RESOURCES[t.resource].toLowerCase()} tile`;
}

/** A tile, as a person would say it: "8 wood", "the desert". */
export function tileText(t: { resource: number; number: number }) {
  return t.resource < 0 ? "desert" : `${t.number} ${RESOURCES[t.resource].toLowerCase()}`;
}

/** The tiles a corner touches, best number first, desert last. */
export function tilesAt(node: number, map: MapView) {
  return map.tiles.filter((t) => t.nodes.includes(node))
    .sort((a, b) => (b.resource < 0 ? -1 : PIPS_OF[b.number] ?? 0) - (a.resource < 0 ? -1 : PIPS_OF[a.number] ?? 0));
}
const PIPS_OF: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

/** A corner is named by what it touches: "the 8 wood · 3 ore corner". Never by its id. */
export function cornerName(node: number, map?: MapView) {
  const all = map ? tilesAt(node, map) : [];
  const ts = all.filter((t) => t.resource >= 0);
  if (!ts.length) return all.length ? "the desert corner" : "the far corner";
  return `the ${ts.map(tileText).join(" · ")} corner`;
}

/** An edge is named by the tiles either side of it. */
export function edgeName(e: number, map?: MapView) {
  const ed = map?.edges[e];
  if (!ed || !map) return "along the coast";
  const ts = map.tiles.filter((t) => t.nodes.includes(ed[0]) && t.nodes.includes(ed[1]));
  if (ts.length === 2) return `between the ${tileText(ts[0])} and the ${tileText(ts[1])}`;
  if (ts.length === 1) return `along the coast of the ${tileText(ts[0])}`;
  return "along the coast";
}

/** What a stochastic action's outcome meant. */
export const BOT_NAMES: Record<string, string> = {
  human: "You",
  random: "Random",
  heuristic: "Heuristic search (AlphaBeta's evaluator)",
  vnet: "Value-net search (v40)",
  drrl: "DRRL (EUMAS 2018) trades, heuristic search plays",
  jsrobot: "jSettler, smart strategy (JSettlers 2.6.10 robot)",
  jsdroid: "jSettler, fast strategy (JSettlers 2.6.10 droid)",
  uct: "MCTS, UCT (Karamalegos 2016)",
  buct: "MCTS, Bayesian UCT (Karamalegos 2016)",
  vpi: "MCTS, value of perfect information (Karamalegos 2016)",
};
/** The lineup's card on each bot: the chip caption, what decides, how, and one measured figure with its
 *  lineup (docs/BENCHMARK.md results tables). `sub` gets " · depth N" appended for the bots that search. */
export const BOT_INFO: Record<BotKind, { sub: string; what: string; how: string; measured?: string }> = {
  human: { sub: "person", what: "A person at this seat.", how: "Hand, action column and coach; the readings are written from this seat." },
  random: { sub: "uniform over legal moves", what: "Picks uniformly among the legal actions.", how: "No search, no evaluation, no trades." },
  heuristic: {
    sub: "search",
    what: "Catanatron's AlphaBeta player, ported to Rust.",
    how: "Depth-2 expectimax over the dice, leaves scored by AlphaBeta's hand-written evaluator (production, pieces, hand, road and army). Offers and replies come from a 1-ply trade policy over the same evaluator.",
    measured: "AlphaBeta, which this ports: 32.2% of 400 games in the catanatron pool",
  },
  vnet: {
    sub: "search",
    what: "The same search with the evaluator replaced by a learned win-probability net.",
    how: "v40: a value net trained expert-iteration style on rollout outcomes of its own games, read at every leaf of the depth-2 expectimax; leaves are batched per decision. Trades use the 1-ply policy over the net.",
    measured: "72.0% of 400 games in the catanatron pool (AlphaBeta, MCTS and two greedy bots)",
  },
  drrl: {
    sub: "trades by DRRL",
    what: "The EUMAS 2018 agent: a learned trade layer over a fixed base.",
    how: "72 heads (70 offers, accept, reject), one LSTM cell per head over a 154-int state, online SGD after every decision with a VP-difference reward, weights fresh each game. Every prompt that is not an offer or a reply goes to the heuristic search.",
    measured: "11.0% of 400 games in the paper's five-agent pool",
  },
  jsrobot: {
    sub: "SOCRobotBrain, smart",
    what: "JSettlers 2.6.10's robot, ported hook for hook.",
    how: "Building-speed estimates, player trackers, the SMART_STRATEGY planner, the robber, discard and monopoly strategies and the negotiator with counter-offers. Matched against the Java on a replay oracle.",
    measured: "20.8% of 400 games in the paper's five-agent pool (the paper: 21%)",
  },
  jsdroid: {
    sub: "SOCRobotBrain, fast",
    what: "The same JSettlers robot on its FAST_STRATEGY planner.",
    how: "Plans by building-speed estimates alone instead of the smart planner's threat and win-ETA search; otherwise the smart robot's code, negotiator included.",
    measured: "16.7% of 300 games against three heuristic searches",
  },
  uct: {
    sub: "MCTS · 5,000 playouts",
    what: "Monte Carlo tree search with the UCT rule (Karamalegos 2016).",
    how: "A tree over the agent's own post-roll turn, random playouts to a 10-round cut-off, every seat's VP as the reward, selection by UCT with C_p = 1/√2. Placement, robber, discards and trades go to the heuristic search. About 0.25 s a decision.",
    measured: "44.5% of 400 games in the paper's five-agent pool",
  },
  buct: {
    sub: "MCTS · 5,000 playouts",
    what: "The same search with Bayesian UCT selection.",
    how: "Backups keep a Dirichlet count per node; selection takes mean + sqrt(2 ln N) · sigma over the posterior (Tesauro's second rule). Playouts, reward and delegation as UCT.",
    measured: "36.2% of 400 games in the paper's five-agent pool",
  },
  vpi: {
    sub: "MCTS · 1,500 playouts",
    what: "The same search choosing by value of perfect information.",
    how: "Myopic VPI over the Dirichlet posteriors, sampled through Gamma draws; picks max E[q] + VPI. Playouts, reward and delegation as UCT, on a third of the budget.",
    measured: "12.5% of 400 games in the paper's five-agent pool",
  },
};
export const BOT_SHORT: Record<string, string> = { human: "You", random: "Random", heuristic: "Heuristic search", vnet: "Value-net search", drrl: "DRRL", jsrobot: "jSettler", jsdroid: "jSettler fast", uct: "UCT", buct: "BUCT", vpi: "VPI" };

export function fmtPct(p: number | null | undefined) {
  return p == null || Number.isNaN(p) ? "–" : `${(100 * p).toFixed(1)}%`;
}

/** A signed difference in points of win probability: "+3.8", "−1.1". */
export function fmtDelta(d: number) {
  const v = (100 * Math.abs(d)).toFixed(1);
  return d < 0 ? `−${v}` : `+${v}`;
}

/** A seat by name, or "You" when it is the seat the reader is playing from. `you` is -1
 *  when nobody is seated, so a watched game never says "You". */
export function who(seat: number, you: number) { return seat === you ? "You" : SEAT_NAMES[seat]; }
/** The same, mid-sentence. */
export function whom(seat: number, you: number) { return seat === you ? "you" : SEAT_NAMES[seat]; }
export function whose(seat: number, you: number) { return seat === you ? "your" : `${SEAT_NAMES[seat]}'s`; }

/** The attribution row that swings the evaluated seat's win% most, in either direction —
 *  Coach's and Console's "why" callouts both name this one group. `delta < 0` means zeroing
 *  the group costs win probability (it is doing a lot of work); `delta > 0` means zeroing it
 *  helps (it is a liability). Only rows for the evaluated seat itself (`seat === 0`, per
 *  `attribution()`'s own seat-relative-to-evaluated convention) are considered. */
export function worstGroup(attr: Attribution[] | null): Attribution | null {
  if (!attr || !attr.length) return null;
  const mine = attr.filter((a) => a.seat === 0);
  if (!mine.length) return null;
  return [...mine].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}
