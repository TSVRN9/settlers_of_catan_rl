// What the hand lifts and what a tap on it does, for every phase that reads cards off the hand: a build card
// held (its cost), an offer to you (what it asks of you); the offer builder's cards and a discard's leave their
// stacks. And the offer builder's draft, one tap at a time. Pure; check: node --experimental-strip-types web/src/phone/drafts.ts
export interface LiftInput { mode: string; cost: number[] | null; give: number[]; asked: number[] | null }

const NONE = [0, 0, 0, 0, 0];

/** Cards to lift out of each stack, per resource. Only the phase's own source counts, so a draft left over from
 *  a phase that's over never lifts anything. */
export function lifted(x: LiftInput): number[] {
  if (x.cost) return x.cost;
  if (x.mode === "offer-in" && x.asked) return x.asked;
  return NONE;
}
/** Cards out of the hand, per resource: in the builder the ones put in your offer, in a discard the ones in its slots. */
export const away = (mode: string, give: number[], pick: number[]) => (mode === "builder" ? give : mode === "discard" ? inSlots(pick) : NONE);

/** Your offer as it's built: a hand card tapped goes into it (give), a card in it tapped comes back (ungive); a
 *  resource tapped in the row under it is asked for (ask), an asked card tapped goes (unask). Never both ways at once. */
export interface Draft { give: number[]; want: number[] }
export type DraftTap = "give" | "ungive" | "ask" | "unask";
/** No more of one kind than the bank holds. */
const ASK_MAX = 19;
export function canTap(d: Draft, hand: number[], t: DraftTap, r: number): boolean {
  switch (t) {
    case "give": return d.give[r] < hand[r] && d.want[r] === 0;
    case "ungive": return d.give[r] > 0;
    case "ask": return d.give[r] === 0 && d.want[r] < ASK_MAX;
    case "unask": return d.want[r] > 0;
  }
}
export function tapDraft(d: Draft, hand: number[], t: DraftTap, r: number): Draft {
  if (!canTap(d, hand, t, r)) return d;
  const k = t === "give" || t === "ask" ? 1 : -1;
  const bump = (xs: number[]) => xs.map((n, i) => (i === r ? n + k : n));
  return t === "give" || t === "ungive" ? { give: bump(d.give), want: d.want } : { give: d.give, want: bump(d.want) };
}
/** The discard slots as per-resource counts. */
export const inSlots = (pick: number[]) => NONE.map((_, r) => pick.filter((p) => p === r).length);
/** A tap on resource `r` may fill a slot: one is free and you still hold one of `r` not already in a slot. */
export const canPick = (pick: number[], need: number, hand: number[], r: number) => pick.length < need && inSlots(pick)[r] < hand[r];

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("drafts.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`drafts self-check: ${m}`); };
  assert(lifted({ mode: "build", cost: [1, 1, 0, 0, 0], give: [2, 0, 0, 0, 0], asked: null })[0] === 1, "a held build card's cost");
  assert(lifted({ mode: "build", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 0, "a stale draft lifts nothing");
  assert(lifted({ mode: "offer-in", cost: null, give: NONE, asked: [0, 0, 0, 2, 0] })[3] === 2, "an offer lifts what it asks of you");
  assert(lifted({ mode: "bots", cost: null, give: NONE, asked: [0, 0, 0, 2, 0] })[3] === 0, "an offer between others lifts nothing");
  assert(canPick([], 2, [1, 0, 0, 0, 0], 0) && !canPick([0], 2, [1, 0, 0, 0, 0], 0), "never more than you hold");
  assert(!canPick([0, 1], 2, [3, 3, 0, 0, 0], 0), "full slots take nothing");
  assert(inSlots([3, 0, 3])[3] === 2 && inSlots([3, 0, 3])[0] === 1, "slot counts");
  // The offer builder: every target does one thing, nothing cycles, nothing is silently ignored.
  const hand = [2, 1, 0, 0, 0], d0: Draft = { give: NONE, want: NONE };
  const d1 = tapDraft(d0, hand, "give", 0);
  assert(d1.give[0] === 1 && d1.want.every((n) => n === 0), "a hand card goes to the offer");
  assert(!canTap(tapDraft(d1, hand, "give", 0), hand, "give", 0), "never more than you hold");
  assert(tapDraft(d1, hand, "ungive", 0).give[0] === 0, "a given card comes back");
  assert(!canTap(d0, hand, "ungive", 0) && !canTap(d0, hand, "unask", 3), "nothing to take back");
  const d2 = tapDraft(tapDraft(d1, hand, "ask", 4), hand, "ask", 4);
  assert(d2.want[4] === 2, "asking counts up, it doesn't cycle");
  assert(tapDraft(d2, hand, "unask", 4).want[4] === 1, "an asked card goes back one at a time");
  assert(!canTap(d1, hand, "ask", 0), "you can't ask for what you give");
  assert(!canTap(d2, [2, 1, 0, 0, 3], "give", 4), "you can't give what you ask for");
  assert(tapDraft(d1, hand, "ask", 0) === d1, "a tap that can't apply changes nothing");
  assert(away("builder", [1, 0, 0, 2, 0], [])[3] === 2 && away("discard", NONE, [3, 3])[3] === 2 && away("build", [1, 0, 0, 0, 0], [3])[0] === 0,
         "cards out of the hand: the offer's, the discard's, nothing else's");
  assert(lifted({ mode: "builder", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 0, "the builder's cards leave the hand rather than lift");
  console.log("drafts.ts self-check passed");
}
