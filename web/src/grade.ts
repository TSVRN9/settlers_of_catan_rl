// A move's grade (spec "Grades"): how good the choice was, not how it turned out. The margin is the gap between the
// best move's value and the played move's in the value net's ranked root (`rankedAt(step, "vnet")`), in win chance;
// the bands are measured (docs/FINDINGS.md, "Move grades: the margin scale"), not borrowed. Kept free of React and of
// the store so the check at the bottom runs outside Vite: node --experimental-strip-types web/src/grade.ts
import type { Canon } from "./engine";

export type Grade = "Best" | "Good" | "Inaccuracy" | "Mistake" | "Blunder";
export const GRADES: Grade[] = ["Best", "Good", "Inaccuracy", "Mistake", "Blunder"];
export interface GradeMark { seat: number; margin: number; grade: Grade; best: Canon }

/** The lower edge of each band below Best, in win chance (216 games, docs/FINDINGS.md "Move grades"). Under 0.01 is
 *  inside the evaluator's own inconsistency (residual sd 0.015, FINDINGS); per seat-game the heuristic search then has ~3
 *  inaccuracies, ~1.7 mistakes and ~0.2 blunders, jSettlers ~4 / 2.4 / 0.4, and random blunders 0.7 times a game. */
export const BANDS = { good: 0.01, inaccuracy: 0.05, mistake: 0.08, blunder: 0.15 };

export const GRADE_INK: Record<Grade, string> = { Best: "#2e7d4f", Good: "#6f8f7f", Inaccuracy: "#9a7a12", Mistake: "#c46a2a", Blunder: "#a5452b" };

export function grade(m: number): Grade {
  return m >= BANDS.blunder ? "Blunder" : m >= BANDS.mistake ? "Mistake" : m >= BANDS.inaccuracy ? "Inaccuracy" : m >= BANDS.good ? "Good" : "Best";
}

const same = (a: Canon, b: Canon) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

/** How far the played move fell short of the best, or null when there is nothing to grade: a root with fewer than two
 *  ranked moves (a forced move), or a played move the search never ranked (an offer outside its three). Never a
 *  default grade for a move it didn't see. */
export function margin(root: [Canon, number | null][], played: Canon): number | null {
  const ranked = root.filter((r): r is [Canon, number] => r[1] != null && Number.isFinite(r[1]));
  if (ranked.length < 2) return null;
  const mine = ranked.find((r) => same(r[0], played));
  if (!mine) return null;
  return Math.max(0, Math.max(...ranked.map((r) => r[1])) - mine[1]);
}

/** The ranked root's best move. */
export const bestOf = (root: [Canon, number | null][]): Canon | null =>
  root.reduce<[Canon, number] | null>((b, r) => (r[1] != null && (!b || r[1] > b[1]) ? [r[0], r[1]] : b), null)?.[0] ?? null;

/** The kinds of move that get a grade. */
export const graded = (a: Canon) => !UNGRADED.has(a[0]);
const UNGRADED = new Set(["OFFER_TRADE"]);

/** A live grade shows beside its piece only while that move is the last one played; once the next move lands it is
 *  the review's. */
export const showLive = (step: number, framesLength: number) => step === framesLength - 2;

/** The moves a grade is drawn beside on the board. */
export const onBoard = (a: Canon) => a[0] === "BUILD_SETTLEMENT" || a[0] === "BUILD_CITY" || a[0] === "BUILD_ROAD" || a[0] === "MOVE_ROBBER";

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("grade.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`grade self-check: ${m}`); };
  const A = (k: string, x = -1): Canon => [k, x, -1, -1];
  // Each band's lower edge is in it; just under is the band before.
  const edges: [number, Grade][] = [[0, "Best"], [BANDS.good - 1e-9, "Best"], [BANDS.good, "Good"], [BANDS.inaccuracy, "Inaccuracy"],
    [BANDS.mistake - 1e-9, "Inaccuracy"], [BANDS.mistake, "Mistake"], [BANDS.blunder, "Blunder"], [0.9, "Blunder"]];
  for (const [m, g] of edges) assert(grade(m) === g, `grade(${m}) = ${grade(m)}, not ${g}`);
  const root: [Canon, number | null][] = [[A("BUILD_CITY", 3), 0.41], [A("BUILD_ROAD", 7), 0.33], [A("END_TURN"), 0.30]];
  assert(Math.abs(margin(root, A("BUILD_ROAD", 7))! - 0.08) < 1e-9, "a margin");
  assert(margin(root, A("BUILD_CITY", 3)) === 0, "the best move");
  assert(margin(root, A("OFFER_TRADE", 1)) === null, "a move the search never ranked is not graded");
  assert(margin([[A("ROLL"), 0.3]], A("ROLL")) === null, "a forced move is not graded");
  assert(margin([[A("ROLL"), 0.3], [A("PLAY_KNIGHT_CARD"), null]], A("ROLL")) === null, "unvalued moves don't count as rivals");
  assert(JSON.stringify(bestOf(root)) === JSON.stringify(A("BUILD_CITY", 3)), "the best move");
  assert(showLive(10, 12) && !showLive(10, 13) && !showLive(11, 12), "live only while it is the last move played");
  assert(!graded(A("OFFER_TRADE")) && graded(A("BUILD_ROAD")), "which moves are graded");
  console.log("grade self-check ok");
}
