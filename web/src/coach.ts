// Every sentence the app says about the game is built here, from the position itself:
// what a corner pays, how many ways in thirty-six, where the robber sits, what a move
// spends and what it leaves you able to build. No sentence exists that the position cannot
// back, and no raw identifier — a node, an edge, a group name — ever reaches the screen.
//
// Pure functions over the engine's own views. The self-check at the bottom runs with
// `node --experimental-strip-types src/coach.ts`.
import type { Attribution, Canon, MapView, View } from "./engine";
import { DEV_CARDS, GROUP as GROUP_TITLES, RESOURCES, canOffer, SEAT_NAMES, cornerName, edgeName, fmtDelta, fmtPct, rows, tileText, tilesAt, unpackBundle, who, whom, whose } from "./labels.ts";

export interface Ctx { map: MapView; view: View; /** whose move is being weighed */ seat: number; /** the reader's seat, or -1 */ you: number }
export interface Row { seat: number; action: Canon; outcome: [number, number] | null; gains: number[][] }

export const COST: Record<string, number[]> = {
  BUILD_ROAD: [1, 1, 0, 0, 0],
  BUILD_SETTLEMENT: [1, 1, 1, 1, 0],
  BUILD_CITY: [0, 0, 0, 2, 3],
  BUY_DEVELOPMENT_CARD: [0, 0, 1, 1, 1],
};
const BUILD_NOUN: Record<string, string> = {
  BUILD_CITY: "a city", BUILD_SETTLEMENT: "a settlement", BUILD_ROAD: "a road", BUY_DEVELOPMENT_CARD: "a development card",
};

const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
export const num = (n: number) => WORDS[n] ?? String(n);
const res = (r: number) => RESOURCES[r].toLowerCase();
const aRes = (r: number) => (r === 4 ? "an ore" : `a ${res(r)}`);
const an = (n: number) => ([8, 11, 18].includes(n) ? `an ${n}` : `a ${n}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The tiles a corner touches, how many ways in thirty-six they pay, and what sits on it. */
export function corner(node: number, ctx: Ctx) {
  const tiles = tilesAt(node, ctx.map).filter((t) => t.resource >= 0);
  const robbed = tiles.find((t) => t.id === ctx.view.robber) ?? null;
  const ways = sum(tiles.filter((t) => t !== robbed).map((t) => PIPS[t.number] ?? 0));
  const port = ctx.map.ports.find((p) => p.nodes.includes(node));
  return { tiles, robbed, ways, port: port ? port.resource : null };
}

const payText = (tiles: { number: number; resource: number }[]) => list(tiles.map((t) => `${an(t.number)} ${res(t.resource)}`));
const waysText = (ways: number) => `${num(ways)} way${ways === 1 ? "" : "s"} in thirty-six`;
const portText = (port: number | null) => (port == null ? "" : port < 0 ? " It is on a 3:1 port." : ` It is on the 2:1 ${res(port)} port.`);

/** Which builds a hand can pay for. */
export function affordable(hand: number[]) {
  return Object.keys(COST).filter((k) => COST[k].every((n, i) => hand[i] >= n)).map((k) => BUILD_NOUN[k]);
}

/** A move as a noun phrase: "the settlement on the 8 wood · 3 ore corner". */
export function noun(a: Canon, ctx: Ctx): string {
  const [t, x, y, z] = a;
  const m = ctx.map;
  switch (t) {
    case "BUILD_SETTLEMENT": return `the settlement on ${cornerName(x, m)}`;
    case "BUILD_CITY": return `the city on ${cornerName(x, m)}`;
    case "BUILD_ROAD": return `the road ${edgeName(x, m)}`;
    case "BUY_DEVELOPMENT_CARD": return "a development card";
    case "END_TURN": return "ending the turn";
    case "ROLL": return "the roll";
    case "MOVE_ROBBER": return `the robber on the ${tileText(m.tiles[x])}${y >= 0 ? `, robbing ${who(y, ctx.you)}` : ""}`;
    case "PLAY_KNIGHT_CARD": return "the knight";
    case "PLAY_MONOPOLY": return `a monopoly on ${res(x)}`;
    case "PLAY_YEAR_OF_PLENTY": return y < 0 ? `a year of plenty for ${aRes(x)}` : `a year of plenty for ${aRes(x)} and ${aRes(y)}`;
    case "PLAY_ROAD_BUILDING": return "road building";
    case "MARITIME_TRADE": return `trading ${num(y)} ${res(x)} to the bank for ${aRes(z)}`;
    case "OFFER_TRADE": return `offering ${cards(unpackBundle(x))} for ${cards(unpackBundle(y))}`;
    case "ACCEPT_TRADE": return "accepting the offer";
    case "REJECT_TRADE": return "declining the offer";
    case "CONFIRM_TRADE": return `trading with ${who(x, ctx.you)}`;
    case "CANCEL_TRADE": return "withdrawing the offer";
    case "DISCARD_RESOURCE": return `discarding ${aRes(x)}`;
    default: return t.toLowerCase().replace(/_/g, " ");
  }
}

/** The moves that are about a place, and so are the only ones Board actually draws a ring
 *  for (see Board.tsx's `mark` group). Everything else is a card, a roll, or a trade, and
 *  claiming a ring for it is a lie the reader can check. */
export const RINGED = new Set(["BUILD_SETTLEMENT", "BUILD_CITY", "BUILD_ROAD", "MOVE_ROBBER"]);

/** The lead sentence's verb phrase — "I would {lead}". `noun()` answers a different
 *  question ("the heuristic wants {noun}") and returns gerunds for most kinds, so "take
 *  {noun}" only reads for the placed moves and the dev-card buy; the rest need a verb. */
export function lead(a: Canon, ctx: Ctx): string {
  const [t, x, y, z] = a;
  switch (t) {
    case "ROLL": return "roll";
    case "END_TURN": return "end the turn";
    case "PLAY_KNIGHT_CARD": return "play the knight";
    case "PLAY_ROAD_BUILDING": return "play road building";
    case "PLAY_MONOPOLY": return `monopolise ${res(x)}`;
    case "PLAY_YEAR_OF_PLENTY":
      return y < 0 ? `take ${aRes(x)} with the year of plenty` : `take ${aRes(x)} and ${aRes(y)} with the year of plenty`;
    case "MARITIME_TRADE": return `trade ${num(y)} ${res(x)} to the bank for ${aRes(z)}`;
    case "OFFER_TRADE": return `offer ${cards(unpackBundle(x))} for ${cards(unpackBundle(y))}`;
    case "ACCEPT_TRADE": return "accept the offer";
    case "REJECT_TRADE": return "decline the offer";
    case "CONFIRM_TRADE": return `trade with ${whom(x, ctx.you)}`;
    case "CANCEL_TRADE": return "withdraw the offer";
    case "DISCARD_RESOURCE": return `discard ${aRes(x)}`;
    default: return `take ${noun(a, ctx)}`;
  }
}

/** Resource counts as words: "two wood and a wheat". */
export function cards(counts: number[]) {
  const parts = counts.flatMap((c, i) => (c > 0 ? [c === 1 ? aRes(i) : `${num(c)} ${res(i)}`] : []));
  return parts.length ? list(parts) : "nothing";
}

const knightsPlayed = (v: View, seat: number) => v.players[seat].played[0] ?? 0;
function armyNeed(v: View) {
  const holder = v.players.findIndex((p) => p.has_army);
  return holder >= 0 ? knightsPlayed(v, holder) + 1 : 3;
}

/** One or two sentences that back a move, from the position. Empty when there is nothing
 *  to say (a roll is a roll). */
export function evidence(a: Canon, ctx: Ctx): string {
  const [t, x, y, z] = a;
  const v = ctx.view, m = ctx.map;
  const p = v.players[ctx.seat];
  const held = sum(p.hand);
  const yours = ctx.seat === ctx.you;
  const You = yours ? "You" : SEAT_NAMES[ctx.seat];
  switch (t) {
    case "BUILD_SETTLEMENT": {
      const c = corner(x, ctx);
      if (!c.tiles.length) return "It touches only the desert and the sea.";
      return `It pays on ${payText(c.tiles)} — ${waysText(c.ways)}.${c.robbed ? ` The robber is sitting on its ${c.robbed.number}.` : ""}${portText(c.port)}`;
    }
    case "BUILD_CITY": {
      const c = corner(x, ctx);
      const risk = held > 7 ? ` It spends five cards a seven would otherwise pick from.` : "";
      return `It doubles a corner that pays on ${payText(c.tiles)} — ${waysText(c.ways)}, twice over.${risk}${c.robbed ? ` The robber is sitting on its ${c.robbed.number}.` : ""}`;
    }
    case "BUILD_ROAD": {
      const [n1, n2] = m.edges[x];
      const free = [n1, n2].filter((n) => v.owner[n] !== ctx.seat);
      const far = free.length === 1 ? free[0] : free.length === 2 ? (corner(n1, ctx).ways >= corner(n2, ctx).ways ? n1 : n2) : n2;
      const c = corner(far, ctx);
      const taken = v.owner[far] >= 0 && v.owner[far] !== ctx.seat ? ` ${who(v.owner[far], ctx.you)} already holds that corner.` : "";
      return `It reaches ${cornerName(far, m)}${c.ways ? ` — ${waysText(c.ways)}` : ""}.${portText(c.port)}${taken}`;
    }
    case "BUY_DEVELOPMENT_CARD": {
      const k = knightsPlayed(v, ctx.seat);
      return `${cap(num(v.dev_deck))} card${v.dev_deck === 1 ? "" : "s"} left in the deck. ${cap(num(k))} knight${k === 1 ? "" : "s"} played; largest army needs ${num(armyNeed(v))}.`;
    }
    case "MOVE_ROBBER": {
      const tile = m.tiles[x];
      if (y < 0) return `Nobody draws from the ${tileText(tile)}.`;
      const theirs = m.tiles.filter((tt) => tt.resource >= 0 && tt.nodes.some((n) => v.owner[n] === y));
      const best = theirs.every((tt) => (PIPS[tt.number] ?? 0) <= (PIPS[tile.number] ?? 0));
      const c = sum(v.players[y].hand);
      return `${who(y, ctx.you)} draw${y === ctx.you ? "" : "s"} from that ${tileText(tile)}${best ? " — their best number" : ""}${c > 0 ? `, and hold${y === ctx.you ? "" : "s"} ${num(c)} card${c === 1 ? "" : "s"}` : ""}.`;
    }
    case "END_TURN": {
      // No verdict here: this same sentence is printed under a ranking that may have
      // ending second, and "nothing beats holding five cards" would then argue with the
      // numbers beside it. State what the hand can still pay for and what a seven would
      // cost it — the numbers say whether ending is right. Neither fact, and there is
      // nothing to say: "you would carry five cards into the next turn" is the move read
      // back, not an argument, so it returns empty and the chip goes.
      const can = affordable(p.hand);
      return [
        can.length ? `${You} can afford ${list(can)} now.` : "",
        held > 7 ? `${You} hold ${num(held)} cards; a seven would take ${num(Math.floor(held / 2))}.` : "",
      ].filter(Boolean).join(" ");
    }
    case "MARITIME_TRADE": {
      const after = p.hand.slice(); after[x] -= y; after[z] += 1;
      const gained = affordable(after).filter((b) => !affordable(p.hand).includes(b));
      // The fallback is why the trade is bad, not what it is: the bank's rate is the
      // whole story once nothing new comes within reach.
      return gained.length ? `That puts ${list(gained)} within reach.` : `${cap(num(y))} cards for one, and nothing new within reach.`;
    }
    case "OFFER_TRADE": {
      const give = unpackBundle(x), get = unpackBundle(y);
      const after = p.hand.map((c, i) => c - give[i] + get[i]);
      const gained = affordable(after).filter((b) => !affordable(p.hand).includes(b));
      return gained.length ? `If it is taken, that puts ${list(gained)} within reach.` : `It asks for ${cards(get)} ${yours ? "you" : "they"} cannot produce.`;
    }
    case "PLAY_KNIGHT_CARD": {
      const k = knightsPlayed(v, ctx.seat) + 1;
      return `${cap(num(k))} knight${k === 1 ? "" : "s"} played with this one; largest army needs ${num(armyNeed(v))}.`;
    }
    case "PLAY_MONOPOLY": {
      const total = sum(v.players.map((q, i) => (i === ctx.seat ? 0 : q.hand[x])));
      return `Everyone else holds ${num(total)} ${res(x)} between them.`;
    }
    case "PLAY_YEAR_OF_PLENTY": {
      const after = p.hand.slice(); after[x] += 1; if (y >= 0) after[y] += 1;
      const gained = affordable(after).filter((b) => !affordable(p.hand).includes(b));
      return gained.length ? `That puts ${list(gained)} within reach.` : "";
    }
    case "ACCEPT_TRADE":
    case "REJECT_TRADE": {
      const give = unpackBundle2(v.current_trade, 5), get = unpackBundle2(v.current_trade, 0);
      // current_trade is written from the offerer's side: what they give is what you get.
      const after = p.hand.map((c, i) => c + get[i] - give[i]);
      if (after.some((c) => c < 0)) return `${You} cannot cover ${cards(give)}.`;
      const gained = affordable(after).filter((b) => !affordable(p.hand).includes(b));
      const cost = `It costs ${cards(give)} for ${cards(get)}.`;
      return gained.length ? `${cost} Taken, that puts ${list(gained)} within reach.`
                           : `${cost} It puts nothing new within reach.`;
    }
    case "CONFIRM_TRADE": {
      const give = unpackBundle2(v.current_trade, 0), get = unpackBundle2(v.current_trade, 5);
      const held = sum(v.players[x]?.hand ?? []);
      return `${who(x, ctx.you)} take${x === ctx.you ? "" : "s"} ${cards(give)} and give${x === ctx.you ? "" : "s"} back ${cards(get)}, holding ${num(held)} card${held === 1 ? "" : "s"}.`;
    }
    case "CANCEL_TRADE":
      return `Nobody worth trading with took it.`;
    case "DISCARD_RESOURCE": {
      const most = Math.max(...p.hand);
      return p.hand[x] === most ? `${cap(res(x))} is what ${yours ? "you hold" : "they hold"} most of: ${num(p.hand[x])}.` : "";
    }
    default:
      return "";
  }
}

/** current_trade's two halves: give[0..5], get[5..10], offerer at [10] — see labels.tradeText. */
const unpackBundle2 = (t: number[], at: number) => Array.from({ length: 5 }, (_, i) => t[at + i] ?? 0);

const isBuild = (a: Canon) => a[0] === "BUILD_SETTLEMENT" || a[0] === "BUILD_CITY";
const spend = (a: Canon) => sum(COST[a[0]] ?? []);

/** Why two candidates differ, named by kind. Empty when the two are not comparable. */
export function gap(top: Canon, second: Canon, ctx: Ctx): string {
  const held = sum(ctx.view.players[ctx.seat].hand);
  if (isBuild(top) && isBuild(second)) {
    const w1 = corner(top[1], ctx).ways * (top[0] === "BUILD_CITY" ? 2 : 1);
    const w2 = corner(second[1], ctx).ways * (second[0] === "BUILD_CITY" ? 2 : 1);
    if (w1 !== w2) return "The gap is production, not risk.";
  }
  if (held > 7 && spend(top) !== spend(second)) return "The gap is risk, not production.";
  if (isBuild(top) !== isBuild(second)) return "The gap is a point now against a point later.";
  return "";
}

/** What happened, with its consequence: "Rolled an 8: a wood to you, a wood to Red." */
export function narrate(row: Row, map: MapView, you: number): string {
  const [t, x, y, z] = row.action;
  const W = who(row.seat, you);
  const me = row.seat === you;
  const ctx = { map, you } as Ctx;
  switch (t) {
    case "ROLL": {
      if (!row.outcome) return `${W} rolled.`;
      const total = row.outcome[0] + row.outcome[1];
      if (total === 7) return `${W} rolled a seven.`;
      const paid = row.gains.flatMap((g, i) => (sum(g) > 0 ? [`${cards(g)} to ${whom(i, you)}`] : []));
      return `${W} rolled ${an(total)}: ${paid.length ? list(paid) : "it paid nobody"}.`;
    }
    case "BUILD_SETTLEMENT": return `${W} ${me ? "built" : "built"} a settlement on ${cornerName(x, map)}.`;
    case "BUILD_CITY": return `${W} raised a city on ${cornerName(x, map)}.`;
    case "BUILD_ROAD": return `${W} built a road ${edgeName(x, map)}.`;
    case "BUY_DEVELOPMENT_CARD": return me && row.outcome && row.outcome[0] >= 0 ? `You bought a development card and drew ${DEV_CARDS[row.outcome[0]].toLowerCase()}.` : `${W} bought a development card.`;
    case "PLAY_KNIGHT_CARD": return `${W} played a knight.`;
    case "MOVE_ROBBER": {
      const tile = map.tiles[x];
      const took = row.outcome && row.outcome[0] >= 0 && y >= 0 ? ` and took ${aRes(row.outcome[0])} from ${whom(y, you)}` : y >= 0 ? ` but found ${whom(y, you)} empty-handed` : "";
      return `${W} moved the robber onto the ${tileText(tile)}${took}.`;
    }
    case "DISCARD_RESOURCE": return `${W} discarded ${aRes(x)}.`;
    case "OFFER_TRADE": return `${W} offered ${cards(unpackBundle(x))} for ${cards(unpackBundle(y))}.`;
    case "ACCEPT_TRADE": return `${W} accepted the offer.`;
    case "REJECT_TRADE": return `${W} declined the offer.`;
    case "CONFIRM_TRADE": return `${W} traded with ${who(x, you)}.`;
    case "CANCEL_TRADE": return `${W} withdrew the offer.`;
    case "MARITIME_TRADE": return `${W} traded ${num(y)} ${res(x)} to the bank for ${aRes(z)}.`;
    case "PLAY_MONOPOLY": {
      const got = row.gains[row.seat]?.[x] ?? 0;
      return `${W} played a monopoly on ${res(x)} and took ${num(got)}.`;
    }
    case "PLAY_YEAR_OF_PLENTY": return `${W} took ${y < 0 ? aRes(x) : cards([0, 1, 2, 3, 4].map((i) => (i === x ? 1 : 0) + (i === y ? 1 : 0)))} from the bank.`;
    case "PLAY_ROAD_BUILDING": return `${W} played road building.`;
    case "END_TURN": return `${W} ended the turn.`;
    default: return `${W} played ${noun(row.action, ctx)}.`;
  }
  void z;
}

/** Rows worth a line of commentary. Ending a turn is not news. */
export const newsworthy = (a: Canon) => a[0] !== "END_TURN";

const GROUP: Record<string, string> = {
  hand: "hand", production: "production", buildings: "settlements and cities", roads: "roads",
  pieces: "pieces still in the box", devs: "development cards", score: "points",
};
/** Which of those take "are". "Your pieces still in the box is doing most of the work" is
 *  what happens without this. */
const PLURAL = new Set(["buildings", "roads", "pieces", "devs", "score"]);
const GLOBAL: Record<string, string> = { robber: "the robber", bank: "the bank" };

/** An attribution row's owner, as a possessive phrase. `seat` is relative to the evaluated
 *  seat (valuenet.rs); `evaluated` is that seat's absolute index. */
export function groupText(a: Attribution, evaluated: number, n: number, you: number) {
  if (a.seat < 0 || GLOBAL[a.group]) return GLOBAL[a.group] ?? a.group;
  const abs = (evaluated + a.seat) % n;
  return `${whose(abs, you)} ${GROUP[a.group] ?? a.group}`;
}

/** The one group that moves the reading most, said in a sentence with the number that
 *  backs it. */
export function lean(attr: Attribution[] | null, ctx: Ctx): string | null {
  if (!attr?.length) return null;
  const a = [...attr].sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))[0];
  const g = cap(groupText(a, ctx.seat, ctx.view.n, ctx.you));
  const held = sum(ctx.view.players[ctx.seat].hand);
  const be = PLURAL.has(a.group) ? "are" : "is";
  if (a.seat < 0 || GLOBAL[a.group]) return `${g} move${be === "is" ? "s" : ""} the reading ${fmtDelta(-a.delta)} on ${be === "is" ? "its" : "their"} own.`;
  if (a.delta < 0) return `${g} ${be} doing most of the work here: ${fmtDelta(a.delta)} without ${be === "is" ? "it" : "them"}.`;
  return `${g} ${be} a liability right now: ${fmtDelta(a.delta)} if ${be === "is" ? "it were" : "they were"} gone${a.group === "hand" && held > 7 ? " — that is the seven" : ""}.`;
}

/** Who is closest to winning, and why, from what is on the table. */
export function closest(view: View, wins: number[], you: number): string {
  const lead = wins.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0])[0]?.[1] ?? 0;
  const p = view.players[lead];
  const k = knightsPlayed(view, lead);
  const facts = [`${num(p.vp)} point${p.vp === 1 ? "" : "s"}`];
  if (p.has_road) facts.push("longest road");
  if (p.has_army) facts.push("largest army");
  if (k > 0 && !p.has_army) facts.push(`${num(k)} knight${k === 1 ? "" : "s"} played`);
  return `${lead === you ? "You are" : `${SEAT_NAMES[lead]} is`}, at ${fmtPct(wins[lead])}: ${list(facts)}.`;
}

/** The questions worth asking about this position, with their answers. Generated from the
 *  ranked moves, never a fixed list. */
/** One entry per kind of move, best first. The engine decomposes a year of plenty into
 *  every resource pair and a bank trade into every rate, so a raw ranking's 2nd and 3rd
 *  are usually two spellings of the same card — and "Why not a year of plenty for a wheat
 *  and a wheat?" is what that reads like. Anything comparing candidates wants this. */
export function byKind(ranked: [Canon, number][]): [Canon, number][] {
  const seen = new Set<string>();
  return ranked.filter(([a]) => !seen.has(a[0]) && seen.add(a[0]) !== undefined);
}

export function questions(ranked: [Canon, number][], ctx: Ctx, wins: number[]): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = [];
  const kinds = byKind(ranked);
  const top = kinds[0];
  for (const [a, val] of kinds.slice(1, 3)) {
    if (!top) break;
    // A chip whose only answer is the two percentages restates the ladder the reader is
    // already looking at. If there is nothing to say about the move, don't ask about it.
    const said = [evidence(a, ctx), gap(top[0], a, ctx)].filter(Boolean);
    if (!said.length) continue;
    out.push({ q: `Why not ${lead(a, ctx)}?`, a: [...said, `${fmtPct(top[1])} against ${fmtPct(val)}.`].join(" ") });
  }
  if (ctx.view.is_resolving_trade && ctx.view.current_trade?.length) {
    const give = unpackBundle2(ctx.view.current_trade, 5), get = unpackBundle2(ctx.view.current_trade, 0);
    out.push({ q: "What does the offer cost me?", a: `${cap(cards(give))} out, ${cards(get)} back. ${gainText(ctx, get, give)}` });
  }
  out.push({ q: "Who is closest to winning?", a: closest(ctx.view, wins, ctx.you) });
  const held = sum(ctx.view.players[ctx.seat].hand);
  if (held > 7) out.push({ q: "What is the seven costing me?", a: `You hold ${num(held)} cards; a seven takes ${num(Math.floor(held / 2))}. Six rolls in thirty-six.` });
  return out;
}

/** What a hand swap opens up, or that it opens nothing. */
function gainText(ctx: Ctx, gets: number[], gives: number[]) {
  const hand = ctx.view.players[ctx.seat].hand;
  const after = hand.map((c, i) => c + gets[i] - gives[i]);
  const gained = affordable(after).filter((b) => !affordable(hand).includes(b));
  return gained.length ? `That puts ${list(gained)} within reach.` : "It puts nothing new within reach.";
}

// ── self-check ─────────────────────────────────────────────────────────────────────────
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("coach.ts")) {
  const assert = (c: unknown, msg: string) => { if (!c) throw new Error(`coach self-check: ${msg}`); };
  const map: MapView = {
    tiles: [
      { id: 0, resource: 0, number: 8, nodes: [0, 1, 2, 3, 4, 5] },
      { id: 1, resource: 4, number: 3, nodes: [2, 3, 6, 7, 8, 9] },
      { id: 2, resource: -1, number: 0, nodes: [3, 4, 9, 10, 11, 12] },
    ],
    ports: [{ id: 0, resource: -1, nodes: [0, 1] }],
    edges: [[2, 3], [0, 1], [3, 4]],
  };
  const player = () => ({ hand: [1, 1, 1, 1, 0], devs: [0, 0, 0, 0, 0], played: [0, 0, 0, 0, 0], vp: 2, actual_vp: 2,
    roads_available: 13, settlements_available: 3, cities_available: 4, has_road: false, has_army: false, has_rolled: true,
    has_played_dev: false, longest_road_length: 2, settlements: [], cities: [], roads: [] });
  const view = {
    n: 4, players: [player(), player(), player(), player()], bank: [19, 19, 19, 19, 19], dev_deck: 25,
    owner: new Array(54).fill(-1), is_city: new Array(54).fill(false), road_owner: new Array(72).fill(-1), road_color: -1,
    road_length: 0, robber: 2, current_player: 1, current_turn: 3, prompt: "PLAY_TURN", initial_phase: false, is_discarding: false,
    discard_counts: [0, 0, 0, 0], is_moving_knight: false, is_road_building: false, free_roads: 0, num_turns: 3, winner: -1, steps: 12,
    is_resolving_trade: false, current_trade: [], acceptees: [], spent_offers: [],
  } as unknown as View;
  const ctx: Ctx = { map, view, seat: 1, you: 1 };
  assert(cornerName(2, map) === "the 8 wood · 3 ore corner", `corner name: ${cornerName(2, map)}`);
  assert(cornerName(4, map) === "the 8 wood corner", `desert corner: ${cornerName(4, map)}`);
  const e = evidence(["BUILD_SETTLEMENT", 2, -1, -1], ctx);
  assert(e.includes("seven ways in thirty-six") && e.includes("an 8 wood and a 3 ore"), `settlement evidence: ${e}`);
  const port = evidence(["BUILD_SETTLEMENT", 0, -1, -1], ctx);
  assert(port.includes("3:1 port"), `port evidence: ${port}`);
  const city = evidence(["BUILD_CITY", 2, -1, -1], ctx);
  assert(city.startsWith("It doubles a corner"), `city evidence: ${city}`);
  assert(noun(["BUILD_SETTLEMENT", 2, -1, -1], ctx) === "the settlement on the 8 wood · 3 ore corner", "noun");
  assert(gap(["BUILD_CITY", 2, -1, -1], ["BUILD_SETTLEMENT", 0, -1, -1], ctx) === "The gap is production, not risk.", "gap kind");
  const roll = narrate({ seat: 0, action: ["ROLL", -1, -1, -1], outcome: [3, 5], gains: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [0, 0, 0, 0, 0], [2, 0, 0, 1, 0]] }, map, 1);
  assert(roll === "Red rolled an 8: a wood to you and two wood and a wheat to White.", `roll narration: ${roll}`);
  const seven = narrate({ seat: 2, action: ["ROLL", -1, -1, -1], outcome: [3, 4], gains: [] }, map, -1);
  assert(seven === "Orange rolled a seven.", seven);
  const rob = narrate({ seat: 2, action: ["MOVE_ROBBER", 0, 1, -1], outcome: [4, -1], gains: [] }, map, 1);
  assert(rob === "Orange moved the robber onto the 8 wood and took an ore from you.", rob);
  const l = lean([{ group: "pieces", seat: 0, delta: -0.187 }, { group: "hand", seat: 0, delta: 0.02 }], ctx);
  assert(l === "Your pieces still in the box are doing most of the work here: −18.7 without them.", `lean: ${l}`);
  const l1 = lean([{ group: "hand", seat: 0, delta: -0.1 }], ctx);
  assert(l1 === "Your hand is doing most of the work here: −10.0 without it.", `singular lean: ${l1}`);
  assert(groupText({ group: "roads", seat: 2, delta: 0 }, 1, 4, 1) === "White's roads", "relative seat mapping");
  const qs = questions([[["BUILD_CITY", 2, -1, -1], 0.336], [["BUILD_SETTLEMENT", 0, -1, -1], 0.304]], ctx, [0.3, 0.336, 0.2, 0.164]);
  assert(qs[0].q === "Why not take the settlement on the 8 wood corner?", qs[0].q);
  // The reading is stated once, not twice — "It reads 30.4%. … 33.6% against 30.4%." was
  // the same fact in two sentences, and the ladder above the chips already shows it.
  assert(!qs[0].a.includes("It reads") && qs[0].a.includes("33.6% against 30.4%"), qs[0].a);
  assert(qs[1].a === "You are, at 33.6%: two points.", qs[1].a);

  // A card the engine decomposes must not become three chips arguing with itself.
  const yop = (a: number, b: number) => ["PLAY_YEAR_OF_PLENTY", a, b, -1] as Canon;
  const many = questions([[yop(3, 3), 0.34], [yop(3, 4), 0.33], [yop(0, 1), 0.32], [["BUILD_ROAD", 0, -1, -1], 0.31]], ctx, [0.3, 0.34, 0.2, 0.16]);
  const whyNot = many.filter((x) => x.q.startsWith("Why not"));
  assert(whyNot.length === 1 && whyNot[0].q.includes("road"), `one chip per kind: ${whyNot.map((x) => x.q).join(" | ")}`);
  // …and no chip may be nothing but the two percentages restated.
  assert(many.every((x) => !/^\d+\.\d%/.test(x.a)), `contentless chip: ${many.map((x) => x.a).join(" | ")}`);

  // A question reads as a question: "Why not end the turn?", never "Why not ending the turn?".
  const gerunds = questions([[["BUILD_CITY", 2, -1, -1], 0.351], [["END_TURN", -1, -1, -1], 0.299]], ctx, [0.3, 0.351, 0.2, 0.149]);
  assert(gerunds.some((x) => x.q === "Why not end the turn?"), gerunds.map((x) => x.q).join(" | "));
  assert(!gerunds.some((x) => /^Why not \w+ing\b/.test(x.q)), `gerund question: ${gerunds.map((x) => x.q).join(" | ")}`);
  // evidence() says what a move does; it must never claim a move is best, because the same
  // sentence is printed under a ranking that may have put it second. And what it says has
  // to be an argument: "you would carry four cards into the next turn" was the move read
  // back with a number on it, which is what the reader is already looking at.
  const ends = evidence(["END_TURN", -1, -1, -1], ctx);
  assert(!/\bbeats\b|\bnothing\b/i.test(ends), `END_TURN evidence asserts a verdict: ${ends}`);
  assert(ends === "You can afford a road and a settlement now.", ends);
  const broke: Ctx = { ...ctx, view: { ...view, players: [player(), { ...player(), hand: [0, 0, 0, 0, 0] }, player(), player()] } as unknown as View };
  const nothingToSay = evidence(["END_TURN", -1, -1, -1], broke);
  assert(nothingToSay === "", `END_TURN with nothing to say: ${nothingToSay}`);
  const quiet = questions([[["BUILD_ROAD", 0, -1, -1], 0.354], [["END_TURN", -1, -1, -1], 0.334]], broke, [0.3, 0.354, 0.2, 0.146]);
  assert(!quiet.some((x) => x.q === "Why not end the turn?"), `silent chip kept: ${quiet.map((x) => x.q).join(" | ")}`);
  // A bank trade that opens nothing is argued by its rate, not described.
  const rich: Ctx = { ...ctx, view: { ...view, players: [player(), { ...player(), hand: [0, 0, 0, 4, 0] }, player(), player()] } as unknown as View };
  const bank = evidence(["MARITIME_TRADE", 3, 4, 0], rich);
  assert(bank === "Four cards for one, and nothing new within reach.", bank);
  assert(!/turns .* into/.test(bank), `bank trade restated: ${bank}`);

  // The lead sentence is a verb phrase, and only a move about a place claims a ring.
  assert(lead(["ROLL", -1, -1, -1], ctx) === "roll", lead(["ROLL", -1, -1, -1], ctx));
  assert(lead(["END_TURN", -1, -1, -1], ctx) === "end the turn", lead(["END_TURN", -1, -1, -1], ctx));
  assert(lead(["PLAY_KNIGHT_CARD", -1, -1, -1], ctx) === "play the knight", "knight lead");
  assert(lead(["BUILD_CITY", 2, -1, -1], ctx) === "take the city on the 8 wood · 3 ore corner", lead(["BUILD_CITY", 2, -1, -1], ctx));
  assert(!RINGED.has("ROLL") && !RINGED.has("PLAY_KNIGHT_CARD") && RINGED.has("BUILD_ROAD"), "ringed set");
  // Nothing may read "I would take ending the turn" — noun()'s gerunds all need a verb.
  for (const t of ["ROLL", "END_TURN", "ACCEPT_TRADE", "REJECT_TRADE", "CANCEL_TRADE", "CONFIRM_TRADE",
                   "DISCARD_RESOURCE", "MARITIME_TRADE", "OFFER_TRADE", "PLAY_ROAD_BUILDING",
                   "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_KNIGHT_CARD"]) {
    const said = lead([t, 0, 1, 2] as Canon, ctx);
    assert(!/^take (ending|accepting|declining|withdrawing|discarding|trading|offering|road building)/.test(said), `${t}: I would ${said}`);
  }

  // The panel folds an over-decomposed card into one opener, and leaves short lists flat.
  const legal: Canon[] = [["END_TURN", -1, -1, -1], ["BUY_DEVELOPMENT_CARD", -1, -1, -1],
    ...[[0, 1], [0, 2], [0, 3], [1, 2], [1, 3]].map(([a, b]) => ["PLAY_YEAR_OF_PLENTY", a, b, -1] as Canon)];
  const r = rows(legal);
  assert(r.length === 3, `three rows, not ${r.length}: ${r.map((x) => x.a[0]).join(",")}`);
  assert(r[0].group === null && r[1].group === null, "short types stay flat");
  assert(r[2].group?.length === 5 && GROUP_TITLES[r[2].a[0]] === "Play Year of Plenty…", "the card is one opener");
  assert(rows(legal.slice(0, 4)).every((x) => x.group === null), "at or below GROUP_AT nothing folds");

  // The offer builder's rules, mirroring apply.rs. The engine only ever *enumerates* one-
  // and two-card bundles, so the 3-for-1 case is the one that proves the builder is not
  // secretly bound by the catalogue.
  const myHand = [3, 1, 0, 2, 0];
  const bundle = (...xs: number[]) => xs;
  assert(canOffer(bundle(3, 0, 0, 0, 0), bundle(0, 0, 0, 0, 1), myHand, []), "3-for-1 is offerable");
  assert(!canOffer(bundle(1, 0, 0, 0, 0), bundle(1, 0, 0, 0, 0), myHand, []), "same resource both sides");
  assert(!canOffer(bundle(4, 0, 0, 0, 0), bundle(0, 0, 0, 0, 1), myHand, []), "cannot give what you lack");
  assert(!canOffer(bundle(0, 0, 0, 0, 0), bundle(0, 0, 0, 0, 1), myHand, []), "empty give");
  assert(!canOffer(bundle(1, 0, 0, 0, 0), bundle(0, 0, 0, 0, 0), myHand, []), "empty want");
  const refused = [[1, 0, 0, 0, 0, 0, 0, 0, 0, 1]];      // give[0..5] then get[5..10]
  assert(!canOffer(bundle(1, 0, 0, 0, 0), bundle(0, 0, 0, 0, 1), myHand, refused), "already refused this turn");
  assert(canOffer(bundle(1, 0, 0, 0, 0), bundle(0, 1, 0, 0, 0), myHand, refused), "a different offer still stands");

  // A trade the coach can see is a trade it can argue about.
  const trading = { ...view, is_resolving_trade: true, current_trade: [0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0] } as unknown as View;
  const tctx: Ctx = { ...ctx, view: trading };
  const acc = evidence(["ACCEPT_TRADE", -1, -1, -1], tctx);
  assert(acc.includes("a wheat") && acc.includes("a wood and a brick"), `accept evidence: ${acc}`);
  assert(questions([], tctx, [0.25, 0.25, 0.25, 0.25]).some((x) => x.q === "What does the offer cost me?"), "trade chip");
  console.log("coach self-check ok");
}
