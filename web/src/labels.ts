import type { Canon, MapView } from "./engine";

export const RESOURCES = ["Wood", "Brick", "Sheep", "Wheat", "Ore"];
export const RESOURCE_EMOJI = ["🌲", "🧱", "🐑", "🌾", "⛰️"];
export const DEV_CARDS = ["Knight", "Year of Plenty", "Monopoly", "Road Building", "Victory Point"];
export const SEAT_NAMES = ["Red", "Blue", "Orange", "White"];
export const SEAT_COLORS = ["#dc2626", "#2563eb", "#f97316", "#f5f5f4"];
export const SEAT_TEXT = ["text-red-600", "text-blue-600", "text-orange-500", "text-stone-500"];
export const PROMPTS: Record<string, string> = {
  BUILD_INITIAL_SETTLEMENT: "place a settlement",
  BUILD_INITIAL_ROAD: "place a road",
  PLAY_TURN: "play the turn",
  DISCARD: "discard",
  MOVE_ROBBER: "move the robber",
  DECIDE_TRADE: "answer the offer",
  DECIDE_ACCEPTEES: "close the trade",
};

export function actionKey(a: Canon) { return a.join(":"); }

export function label(a: Canon, map?: MapView): string {
  const [t, x, y, z] = a;
  switch (t) {
    case "ROLL": return "Roll the dice";
    case "END_TURN": return "End turn";
    case "BUILD_ROAD": return `Build road ${edgeName(x, map)}`;
    case "BUILD_SETTLEMENT": return `Build settlement at node ${x}`;
    case "BUILD_CITY": return `Upgrade node ${x} to a city`;
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

function edgeName(e: number, map?: MapView) {
  const ed = map?.edges[e];
  return ed ? `${ed[0]}–${ed[1]}` : `#${e}`;
}

/** What a stochastic action's outcome meant. */
export function outcomeText(a: Canon, o: [number, number] | null): string | null {
  if (!o) return null;
  switch (a[0]) {
    case "ROLL": return `rolled ${o[0] + o[1]} (${o[0]}+${o[1]})`;
    case "BUY_DEVELOPMENT_CARD": return o[0] >= 0 ? `drew ${DEV_CARDS[o[0]]}` : null;
    case "MOVE_ROBBER": return o[0] >= 0 ? `stole ${RESOURCES[o[0]]}` : a[2] >= 0 ? "nothing to steal" : null;
    default: return null;
  }
}

export const BOT_NAMES: Record<string, string> = {
  human: "You",
  random: "Random",
  heuristic: "Heuristic search (AlphaBeta's evaluator)",
  vnet: "Value-net search (v40)",
};
export const BOT_SHORT: Record<string, string> = { human: "You", random: "Random", heuristic: "Heuristic search", vnet: "Value-net search" };

export function fmtPct(p: number | null | undefined) {
  return p == null || Number.isNaN(p) ? "–" : `${(100 * p).toFixed(1)}%`;
}
