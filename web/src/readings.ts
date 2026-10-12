// Whose win chances the site shows, and which of a position's two readings is on screen.
//
// Every position is read twice (docs/FINDINGS.md 2026-10-12): `pub`, what a viewer could know,
// and `full`, every seat read from its own hand, which shows anyone else an opponent's VP cards.
// The "Hidden information" switch picks one. Its own module, with only type imports, so the
// self-check at the bottom runs outside Vite: node --experimental-strip-types web/src/readings.ts

import type { Evaluation, Readings } from "./engine";

/** Whose public reading is shown: the one person at the table, or a spectator (-1) when nobody
 *  is — or when two people share the screen, so neither one's hand colours the other's. */
export function viewer(lineup: { kind: string }[]): number {
  const people = lineup.flatMap((p, i) => (p.kind === "human" ? [i] : []));
  return people.length === 1 ? people[0] : -1;
}

/** Both readings as [shown, other] for the switch's position. */
export const orient = (r: Readings, hidden: boolean): [Evaluation[], Evaluation[]] => (hidden ? [r.full, r.pub] : [r.pub, r.full]);

/** A frame (or the store) with its two readings swapped: what flipping the switch does. */
export const swap = <T extends { evals: Evaluation[]; evalsOther: Evaluation[] }>(f: T): T => ({ ...f, evals: f.evalsOther, evalsOther: f.evals });

// ── self-check ─────────────────────────────────────────────────────────────────────────
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("readings.ts")) {
  const assert = (c: unknown, msg: string) => { if (!c) throw new Error(`readings self-check: ${msg}`); };
  const bot = { kind: "vnet" }, person = { kind: "human" };
  assert(viewer([bot, person, bot, bot]) === 1, "one person is the viewer");
  assert(viewer([bot, bot, bot, bot]) === -1, "nobody seated: a spectator");
  assert(viewer([person, bot, person, bot]) === -1, "two people sharing: a spectator");
  const ev = (w: number): Evaluation[] => [{ win: w, vps: [], turns_left: 0 }];
  const r: Readings = { pub: ev(0.1), full: ev(0.9) };
  assert(orient(r, false)[0] === r.pub && orient(r, false)[1] === r.full, "switch off shows public");
  assert(orient(r, true)[0] === r.full && orient(r, true)[1] === r.pub, "switch on shows full");
  const f = { step: 3, evals: r.pub, evalsOther: r.full };
  assert(swap(f).evals === r.full && swap(swap(f)).evals === r.pub && swap(f).step === 3, "swap is its own inverse and keeps the rest");
  console.log("readings.ts self-check passed");
}
