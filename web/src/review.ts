// Review, on the second worker. The frames themselves are the live game's own
// (`store.frames`, built as it is played); what needs an engine is the per-step ladder and
// attribution, which reposition this second client with `replay` only when the viewed step
// actually changes — never touching the live engine.
//
// Also here: the readings of a record that need no engine at all — the swings, the events on
// the axis, and a frame turned into a row the narration can read.
import { EngineClient } from "./engine";
import type { Attribution, BotKind, Decision, Frame, LuckRoll, MapView, View } from "./engine";
import { EDGES } from "./board/geometry";
import { num, type Row } from "./coach";
import { RESOURCES, SEAT_NAMES, who, whose } from "./labels";
import { push } from "./route";
import { get, set } from "./store";

export const review = new EngineClient();

/** The record is the frames' own actions — never fetched from the live worker, which in a
 *  watched game is busy playing the rest of it. A position at a step the game has passed
 *  never changes, so the per-step caches below stay valid as the game grows. */
let recordCache: { frames: number; text: string } | null = null;
let positioned: number | null = null;
const rankedCache = new Map<string, Decision>();
const attrCache = new Map<number, Attribution[]>();
let luckCache: { frames: number; rolls: LuckRoll[] } | null = null;
let luckPending: Promise<LuckRoll[]> | null = null;

function record() {
  const s = get();
  if (!recordCache || recordCache.frames !== s.frames.length) {
    const log = s.frames.filter((f) => f.action).map((f) => [f.action, f.outcome ?? [0, 0]]);
    recordCache = { frames: s.frames.length, text: JSON.stringify({ seed: s.seed, n: s.lineup.length, log }) };
  }
  return recordCache.text;
}

async function positionAt(step: number) {
  if (positioned === step) return;
  await review.replay(record(), step);
  positioned = step;
}

/** The ranked ladder at one step, from one bot's own search — fetched once per (step, bot)
 *  and cached, so scrubbing back to a step already looked at costs nothing. */
export async function rankedAt(step: number, bot: BotKind = "vnet"): Promise<Decision> {
  const key = `${step}:${bot}`;
  const cached = rankedCache.get(key);
  if (cached) return cached;
  await positionAt(step);
  const d = await review.decide(bot, 2);
  rankedCache.set(key, d);
  return d;
}

/** Attribution at one step, for one seat — the "what the net is leaning on" panel's own
 *  lazy read, never precomputed for the whole game. */
export async function attributionAt(step: number, seat: number): Promise<Attribution[]> {
  const key = step * 10 + seat;
  const cached = attrCache.get(key);
  if (cached) return cached;
  await positionAt(step);
  const a = await review.attribution(seat);
  attrCache.set(key, a);
  return a;
}

/** Dice luck for the whole game — eleven counterfactual replays at every ROLL step, about 0.8 s,
 *  fetched once when Game analysis opens. In flight it is shared rather than started twice, and
 *  a game that has grown since the last fetch is refetched, because a live game's record keeps
 *  changing under it. */
export function luckRolls(): Promise<LuckRoll[]> {
  const s = get();
  if (luckCache && luckCache.frames === s.frames.length) return Promise.resolve(luckCache.rolls);
  if (!luckPending) {
    const at = s.frames.length;
    luckPending = review.luck(record()).then(
      (rolls) => { luckCache = { frames: at, rolls }; luckPending = null; return rolls; },
      (e) => { luckPending = null; throw e; },
    );
  }
  return luckPending;
}

/** Running totals per seat. The aggregate is the only level this is trustworthy at: a single
 *  roll's luck (sd 0.017) sits barely above the evaluator's own inconsistency (sd 0.015), while
 *  the running sum is unbiased because luck is exactly mean-zero per seat by construction. */
export function luckTotals(rolls: LuckRoll[], n: number) {
  const curves: number[][] = Array.from({ length: n }, () => []);
  const totals = new Array<number>(n).fill(0);
  for (const r of rolls) {
    for (let s = 0; s < n; s++) {
      totals[s] += r.luck[s] ?? 0;
      curves[s].push(totals[s]);
    }
  }
  return { totals, curves };
}

/** The biggest single-step swings in one seat's own win% — pure arithmetic over an
 *  already-loaded curve, no engine calls. Shared by Game analysis and the ending screen. */
export function topSwings(frames: Frame[], seat: number, n: number) {
  return frames.slice(1).map((f, i) => ({
    step: i + 1,
    seat,
    delta: f.evals[seat].win - frames[i].evals[seat].win,
    action: frames[i].action,
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
}

/** Where the game turned: the biggest swings for one seat, or — with nobody to write them
 *  from — for whichever seat's curve moved most at each step. */
export function turns(frames: Frame[], seat: number | null, n: number) {
  if (seat != null) return topSwings(frames, seat, n);
  return frames.slice(1).map((f, i) => {
    const deltas = f.evals.map((e, k) => e.win - frames[i].evals[k].win);
    const k = deltas.reduce((best, d, j) => (Math.abs(d) > Math.abs(deltas[best]) ? j : best), 0);
    return { step: i + 1, seat: k, delta: deltas[k], action: frames[i].action };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
}

/** A frame as a row the narration reads: who did what, and what it paid each seat. */
export function rowAt(frames: Frame[], i: number): Row | null {
  const f = frames[i], g = frames[i + 1];
  if (!f?.action || !g) return null;
  const gains = g.view.players.map((p, k) => p.hand.map((c, r) => c - (f.view.players[k]?.hand[r] ?? 0)));
  return { seat: f.seat, action: f.action, outcome: f.outcome, gains };
}

/** The tiles an attribution group is actually about — "production"/"buildings" light the
 *  seat's own settled tiles, "roads" its road tiles, "robber" the robbed one. Everything
 *  else ("hand", "devs", "score", "bank") has no board location, so it lights nothing. */
export function tilesForGroup(map: MapView, v: View, group: string, seat: number): number[] {
  if (group === "robber") return v.robber >= 0 ? [v.robber] : [];
  if (seat < 0) return [];
  let nodes: number[] = [];
  if (group === "production" || group === "buildings") {
    nodes = v.owner.flatMap((o, n) => (o === seat ? [n] : []));
  } else if (group === "roads") {
    nodes = EDGES.flatMap((e, i) => (v.road_owner[i] === seat ? e : []));
  } else {
    return [];
  }
  const nodeSet = new Set(nodes);
  return map.tiles.flatMap((t, i) => (t.resource >= 0 && t.nodes.some((n) => nodeSet.has(n)) ? [i] : []));
}

export interface Event { step: number; seat: number; letter: string; text: string }

/** The turning points a whole game is read by: first cities, sevens, longest road and
 *  largest army changing hands, monopolies, the win. One walk over the frames. */
export function events(frames: Frame[], you: number): Event[] {
  const out: Event[] = [];
  const firstCity = new Set<number>();
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i], g = frames[i + 1];
    const a = f.action;
    if (!a) continue;
    if (a[0] === "BUILD_CITY" && !firstCity.has(f.seat)) {
      firstCity.add(f.seat);
      out.push({ step: i, seat: f.seat, letter: "C", text: `${whose(f.seat, you)} first city` });
    }
    if (a[0] === "ROLL" && f.outcome && f.outcome[0] + f.outcome[1] === 7) {
      const lost = new Map<number, number>();
      for (let j = i + 1; j < frames.length && frames[j].action?.[0] === "DISCARD_RESOURCE"; j++)
        lost.set(frames[j].seat, (lost.get(frames[j].seat) ?? 0) + 1);
      const parts = [...lost].map(([k, c]) => `${who(k, you)} discard${k === you ? "" : "s"} ${num(c)}`);
      out.push({ step: i, seat: f.seat, letter: "7", text: parts.length ? `a seven — ${parts.join(", ")}` : "a seven" });
    }
    const road = (v: Frame) => v.view.players.findIndex((p) => p.has_road);
    const army = (v: Frame) => v.view.players.findIndex((p) => p.has_army);
    if (road(g) >= 0 && road(g) !== road(f)) out.push({ step: i, seat: road(g), letter: "L", text: `${who(road(g), you)} take${road(g) === you ? "" : "s"} longest road` });
    if (army(g) >= 0 && army(g) !== army(f)) out.push({ step: i, seat: army(g), letter: "A", text: `${who(army(g), you)} take${army(g) === you ? "" : "s"} largest army` });
    if (a[0] === "PLAY_MONOPOLY") out.push({ step: i, seat: f.seat, letter: "M", text: `${whose(f.seat, you)} monopoly on ${RESOURCES[a[1]].toLowerCase()}` });
    if (g.view.winner >= 0 && f.view.winner < 0) out.push({ step: i + 1, seat: g.view.winner, letter: "W", text: `${SEAT_NAMES[g.view.winner]} wins` });
  }
  return out;
}

/** Opens at the step being looked at (the stands' seek), else at the live position. */
export function openGameAnalysis() {
  const s = get();
  if (s.view) push("game", s.step ?? s.view.steps);
}

export function openMoveAnalysis(step?: number) {
  const v = get().view;
  if (!v && step == null) return;
  push("move", step ?? v!.steps);
}

const AUTOPLAY_MS = 450;
let timer: ReturnType<typeof setInterval> | null = null;

export function stopAutoplay() {
  if (timer != null) { clearInterval(timer); timer = null; }
  if (get().reviewPlaying) set({ reviewPlaying: false });
}

export function toggleAutoplay() {
  if (timer != null) { stopAutoplay(); return; }
  set({ reviewPlaying: true });
  timer = setInterval(() => {
    const s = get();
    const last = Math.max(0, s.frames.length - 1);
    if (s.step == null || s.step >= last) { stopAutoplay(); return; }
    set({ step: s.step + 1 });
  }, AUTOPLAY_MS);
}

/** A new game invalidates every per-step cache of the old one — called from `game.ts`'s `deal()`. */
export function resetReview() {
  stopAutoplay();
  recordCache = null;
  positioned = null;
  rankedCache.clear();
  attrCache.clear();
  luckCache = null;
  luckPending = null;
}

// Same reason as game.ts: an edit must not leave a second review worker holding a stale position.
if (import.meta.hot) import.meta.hot.dispose(() => review.terminate());
