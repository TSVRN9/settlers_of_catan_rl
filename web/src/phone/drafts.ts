// What the hand lifts and what a tap on it does, for every phase that reads cards off the hand: a build card
// held (its cost), the offer builder (what you give), an offer to you (what it asks of you), a discard (cards in
// the slots leave their stacks). Pure; check: node --experimental-strip-types web/src/phone/drafts.ts
export interface LiftInput { mode: string; cost: number[] | null; give: number[]; asked: number[] | null }

const NONE = [0, 0, 0, 0, 0];

/** Cards to lift out of each stack, per resource. Only the phase's own source counts, so a draft left over from
 *  a phase that's over never lifts anything. */
export function lifted(x: LiftInput): number[] {
  if (x.cost) return x.cost;
  if (x.mode === "builder") return x.give;
  if (x.mode === "offer-in" && x.asked) return x.asked;
  return NONE;
}
/** The discard slots as per-resource counts. */
export const inSlots = (pick: number[]) => NONE.map((_, r) => pick.filter((p) => p === r).length);
/** A tap on resource `r` may fill a slot: one is free and you still hold one of `r` not already in a slot. */
export const canPick = (pick: number[], need: number, hand: number[], r: number) => pick.length < need && inSlots(pick)[r] < hand[r];

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("drafts.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`drafts self-check: ${m}`); };
  assert(lifted({ mode: "build", cost: [1, 1, 0, 0, 0], give: [2, 0, 0, 0, 0], asked: null })[0] === 1, "a held build card's cost");
  assert(lifted({ mode: "builder", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 2, "the builder lifts what you give");
  assert(lifted({ mode: "build", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 0, "a stale draft lifts nothing");
  assert(lifted({ mode: "offer-in", cost: null, give: NONE, asked: [0, 0, 0, 2, 0] })[3] === 2, "an offer lifts what it asks of you");
  assert(lifted({ mode: "bots", cost: null, give: NONE, asked: [0, 0, 0, 2, 0] })[3] === 0, "an offer between others lifts nothing");
  assert(canPick([], 2, [1, 0, 0, 0, 0], 0) && !canPick([0], 2, [1, 0, 0, 0, 0], 0), "never more than you hold");
  assert(!canPick([0, 1], 2, [3, 3, 0, 0, 0], 0), "full slots take nothing");
  assert(inSlots([3, 0, 3])[3] === 2 && inSlots([3, 0, 3])[0] === 1, "slot counts");
  console.log("drafts.ts self-check passed");
}
