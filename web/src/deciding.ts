// Turning points on the win-probability curve: the moves that decided the game, the step after
// which the winner never trailed again, and the stretch where the dice were worst to one seat.
//
// Every constant here is measured rather than chosen — 340 games for the swings, 35 fully
// decomposed for the luck; docs/FINDINGS.md carries the numbers. The three exclusions in
// `deciding()` are the load-bearing part: placement steps clear the floor fourteen times as often
// as the middle game, END_TURN carries a systematic +0.037 to the seat now on move (positive 99%
// of the time, so it is tempo rather than an event), and the last step is the winning move, which
// `events()` already letters "W". Leave any of the three in and the answer to "what decided this
// game" comes back wrong rather than merely noisy.
//
// Why this is its own module instead of sitting next to `turns()` in review.ts: review.ts imports
// EngineClient as a value, and node resolves "./engine" to the wasm output *directory*
// src/engine/, so review.ts cannot be loaded outside Vite. This file's only import is a type,
// erased at strip-type, which is what lets the self-check at the bottom run:
//   node --experimental-strip-types web/src/deciding.ts

export type Canon = [string, number, number, number];

/** Just enough of a `Frame` to read a curve — the real one satisfies it, and so can a fixture. */
export interface Step { action: Canon | null; evals: { win: number }[] }

export interface Mark { step: number; seat: number; delta: number; action: Canon | null }
export interface LuckPoint { step: number; luck: number }
export interface Span { from: number; to: number; total: number }

/** lichess's blunder threshold in win probability (lila `Advice.scala`), which carries to four
 *  seats through total variation — TV reduces exactly to the two-player |Δp| when one seat gains
 *  and the rest lose, and measured here the two agree within 0.01 at every percentile, so this
 *  ranks the cheaper max-seat form. chess.com uses 0.20 for the same concept; the field disagrees
 *  with itself by 2×, so this is a convention borrowed with attribution, not a law. */
export const FLOOR = 0.10;

/** The moves that decided the game: the biggest single-step swings, capped *and* floored.
 *  Both halves bind — the floor in ~51% of games, the cap in ~49% — so this is not a renamed
 *  top-N. It marks 2-5 moves in 93% of games and nothing in 3%, where a bare threshold at 0.15
 *  marks nothing in half of all games and is not portable across bot lineups. */
export function deciding(frames: Step[], n = 5, floor = FLOOR): Mark[] {
  const first = frames.findIndex((f) => f.action?.[0] === "ROLL");
  if (first < 0) return [];
  const marks: Mark[] = [];
  // A step's swing needs frames[i + 1], and frames.length - 2 is the winning move, so stop short.
  for (let i = first; i < frames.length - 2; i++) {
    if (frames[i].action?.[0] === "END_TURN") continue;
    let seat = 0, delta = 0;
    frames[i].evals.forEach((e, k) => {
      const d = (frames[i + 1].evals[k]?.win ?? e.win) - e.win;
      if (Math.abs(d) > Math.abs(delta)) { seat = k; delta = d; }
    });
    if (Math.abs(delta) >= floor) marks.push({ step: i, seat, delta, action: frames[i].action });
  }
  return marks.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
}

/** The step after which the winner never trailed again — threshold-free, and exactly one mark.
 *  It leaves a median 31% of the game still to run and sits at only the ~84th percentile of that
 *  game's own swings, so it is usually an ordinary step in a drift: it agrees with the biggest
 *  swing about half the time, which is why it is worth drawing separately.
 *
 *  `margin` and `dwell` are ours, not sourced — no sports source suppresses lead-change noise,
 *  because there a lead is a discrete score rather than a continuous estimate. Raw argmax flips
 *  average 28.7 per game with 62% of them in the first third; 0.05 and 5 cut that to 4.0.
 *  Returns null for a wire-to-wire win, and for the 15% of games where the last lead change *is*
 *  the winning move — that step already carries the "W" puck, so there is nothing to add. */
export function pointOfNoReturn(frames: Step[], winner: number, margin = 0.05, dwell = 5): number | null {
  if (winner < 0 || frames.length < 3) return null;
  let leader = -1, cand = -1, run = 0, last = -1;
  for (let t = 0; t < frames.length; t++) {
    const wins = frames[t].evals.map((e) => e.win);
    let top = 0;
    wins.forEach((w, k) => { if (w > wins[top]) top = k; });
    const second = wins.reduce((m, w, k) => (k !== top && w > m ? w : m), -Infinity);
    // Below the margin nobody is clearly ahead, so the last clear leader stands.
    const clear = wins[top] - second >= margin ? top : leader;
    if (clear === cand) run++; else { cand = clear; run = 1; }
    if (run >= dwell && cand !== leader) leader = cand;
    if (leader >= 0 && leader !== winner) last = t;
  }
  const t = last + 1;
  return last < 0 || t >= frames.length - 2 ? null : t;
}

/** The stretch where the dice were worst to one seat, as a fixed window rather than the maximum
 *  drawdown. Drawdown is exactly Kadane's minimum-sum subarray of the increments (asserted
 *  identical on depth *and* endpoints across 140 curves, so there was never a choice between
 *  them) — but its median span is 138 steps, 29 turns, 42% of the game, which is what a random
 *  walk's drawdown always does and is most of the match rather than a story. Five rolls carry
 *  58% of that depth in a span a reader can actually see. Null when no window is net-negative. */
export function worstLuckWindow(rolls: LuckPoint[], w = 5): Span | null {
  if (rolls.length < w || w < 1) return null;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += rolls[i].luck;
  let best = sum, at = 0;
  for (let i = w; i < rolls.length; i++) {
    sum += rolls[i].luck - rolls[i - w].luck;
    if (sum < best) { best = sum; at = i - w + 1; }
  }
  return best < 0 ? { from: rolls[at].step, to: rolls[at + w - 1].step, total: best } : null;
}

// ── self-check ─────────────────────────────────────────────────────────────────────────
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("deciding.ts")) {
  const assert = (c: unknown, msg: string) => { if (!c) throw new Error(`deciding self-check: ${msg}`); };
  const f = (wins: number[], action: Canon | null = null): Step =>
    ({ action, evals: wins.map((win) => ({ win })) });
  const A = (name: string): Canon => [name, 0, 0, 0];

  // Two seats, so a swing is unambiguous. Comments give the swing of the step at that index.
  const fx: Step[] = [
    f([0.25, 0.75], A("BUILD_SETTLEMENT")),  // 0: +0.25 but before the first ROLL — placement
    f([0.50, 0.50], A("ROLL")),              // 1: +0.05, under the floor
    f([0.55, 0.45], A("END_TURN")),          // 2: +0.20 but an END_TURN — tempo, not an event
    f([0.75, 0.25], A("BUILD_CITY")),        // 3: −0.12  kept
    f([0.63, 0.37], A("BUILD_ROAD")),        // 4: −0.08, under the floor
    f([0.55, 0.45], A("BUILD_CITY")),        // 5: +0.15  kept
    f([0.70, 0.30], A("ROLL")),              // 6: −0.15  kept
    f([0.55, 0.45], A("BUILD_CITY")),        // 7: +0.17  kept
    f([0.72, 0.28], A("BUILD_CITY")),        // 8: −0.17  kept
    f([0.55, 0.45], A("BUILD_CITY")),        // 9: +0.40 — the winning move, lettered "W" already
    f([0.95, 0.05]),                         // 10: terminal
  ];
  const got = deciding(fx);
  assert(got.length === 5, `expected 5 marks, got ${got.length}`);
  const steps = got.map((m) => m.step).sort((a, b) => a - b);
  assert(JSON.stringify(steps) === "[3,5,6,7,8]", `wrong marks: ${JSON.stringify(steps)}`);
  assert(!steps.includes(0), "placement swing must be excluded");
  assert(!steps.includes(2), "END_TURN swing must be excluded");
  assert(!steps.includes(9), "the winning move must be excluded");
  assert(got.every((m) => Math.abs(m.delta) >= FLOOR), "a mark fell under the floor");
  assert(got[0].step === 7 || got[0].step === 8, "marks must be sorted by magnitude");
  assert(got.every((m) => m.seat === 0 || m.seat === 1), "seat out of range");
  // The cap and the floor each bind on their own.
  assert(deciding(fx, 3).length === 3, "n must cap the list");
  assert(deciding(fx, 5, 0.16).length === 2, "the floor must drop the 0.15s");
  assert(deciding(fx, 5, 0.99).length === 0, "an unreachable floor yields nothing");
  assert(deciding([f([0.5, 0.5], A("BUILD_ROAD"))]).length === 0, "no ROLL means no clean set");

  // Seat 1 leads, seat 0 takes over at t=5 and wins. dwell 2 keeps the fixture short.
  const curve: number[][] = [
    [0.3, 0.7], [0.3, 0.7], [0.35, 0.65], [0.45, 0.55], [0.55, 0.45],
    [0.6, 0.4], [0.7, 0.3], [0.8, 0.2], [0.9, 0.1], [0.95, 0.05],
  ];
  const fx2 = curve.map((w) => f(w));
  assert(pointOfNoReturn(fx2, 0, 0.05, 2) === 5, `PoNR: got ${pointOfNoReturn(fx2, 0, 0.05, 2)}`);
  assert(pointOfNoReturn(fx2, 0, 0.05, 99) === null, "a dwell longer than the game yields nothing");
  assert(pointOfNoReturn(fx2, -1) === null, "an unfinished game has no point of no return");
  const wire = curve.map(() => f([0.8, 0.2]));
  assert(pointOfNoReturn(wire, 0, 0.05, 2) === null, "a wire-to-wire win has no crossing");
  // A crossing on the winning move collides with the "W" puck and must be suppressed.
  const lateFlip = [...curve.slice(0, 8).map(() => f([0.3, 0.7])), f([0.7, 0.3]), f([0.95, 0.05])];
  assert(pointOfNoReturn(lateFlip, 0, 0.05, 2) === null, "a crossing at the win must be suppressed");

  const rolls: LuckPoint[] = [
    { step: 1, luck: 0.02 }, { step: 2, luck: -0.01 }, { step: 3, luck: -0.05 },
    { step: 4, luck: -0.04 }, { step: 5, luck: -0.03 }, { step: 6, luck: -0.02 },
    { step: 7, luck: 0.05 },
  ];
  const win = worstLuckWindow(rolls, 3)!;
  assert(win.from === 3 && win.to === 5, `window: got ${win.from}..${win.to}`);
  assert(Math.abs(win.total + 0.12) < 1e-9, `window total ${win.total}`);
  // Against a brute-force scan of every window, which is the thing the sliding sum replaces.
  for (const w of [1, 2, 3, 4, 5]) {
    let bf = Infinity, bfAt = -1;
    for (let i = 0; i + w <= rolls.length; i++) {
      const s = rolls.slice(i, i + w).reduce((a, r) => a + r.luck, 0);
      if (s < bf - 1e-12) { bf = s; bfAt = i; }
    }
    const got2 = worstLuckWindow(rolls, w);
    if (bf < 0) {
      assert(got2 !== null && Math.abs(got2.total - bf) < 1e-9, `w=${w}: total ${got2?.total} vs ${bf}`);
      assert(got2!.from === rolls[bfAt].step, `w=${w}: from ${got2!.from} vs ${rolls[bfAt].step}`);
    } else {
      assert(got2 === null, `w=${w}: a non-negative best window must yield null`);
    }
  }
  assert(worstLuckWindow(rolls, 99) === null, "a window longer than the series yields nothing");
  assert(worstLuckWindow([{ step: 1, luck: 0.1 }, { step: 2, luck: 0.2 }], 2) === null,
         "all-positive luck has no worst run");

  console.log("deciding.ts self-check passed");
}
