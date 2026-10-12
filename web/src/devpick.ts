// Year of Plenty and Monopoly as a choice of resources, read off the card's own legal actions: shared by the
// desktop tray's picker and the phone's pick slab. Free of React; check: node --experimental-strip-types web/src/devpick.ts
import type { Canon } from "./engine";

const KIND = { 1: "PLAY_YEAR_OF_PLENTY", 2: "PLAY_MONOPOLY" } as const;

/** The resources the open card can still take. Year of Plenty lists a pair once, in either order, so the
 *  first pick may be either slot; a one-card play (the bank down to one kind) has a[2] < 0. */
export function devChoices(dev: 1 | 2, first: number | null, legal: Canon[]): number[] {
  const acts = legal.filter((a) => a[0] === KIND[dev]);
  const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
  if (dev === 2) return uniq(acts.map((a) => a[1]));
  if (first == null) return uniq(acts.flatMap((a) => (a[2] >= 0 ? [a[1], a[2]] : [a[1]])));
  return uniq(acts.filter((a) => (a[1] === first && a[2] >= 0) || a[2] === first).map((a) => (a[1] === first ? a[2] : a[1])));
}

/** One tap on resource `r`: the action it completes, or the first of Year of Plenty's two picks. */
export function devStep(dev: 1 | 2, first: number | null, r: number, legal: Canon[]): { first: number } | { action: Canon } {
  const acts = legal.filter((a) => a[0] === KIND[dev]);
  if (dev === 2) return { action: acts.find((a) => a[1] === r)! };
  if (first == null) {
    const pair = acts.some((a) => (a[1] === r && a[2] >= 0) || a[2] === r);
    return pair ? { first: r } : { action: acts.find((a) => a[1] === r)! };
  }
  return { action: acts.find((a) => (a[1] === first && a[2] === r) || (a[1] === r && a[2] === first))! };
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("devpick.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`devpick self-check: ${m}`); };
  const act = (x: ReturnType<typeof devStep>) => ("action" in x ? JSON.stringify(x.action) : "");
  const yop: Canon[] = [["PLAY_YEAR_OF_PLENTY", 0, 0, -1], ["PLAY_YEAR_OF_PLENTY", 0, 3, -1], ["PLAY_YEAR_OF_PLENTY", 3, 4, -1]];
  assert(JSON.stringify(devChoices(1, null, yop)) === "[0,3,4]", "first pick: every resource in a pair");
  assert(JSON.stringify(devChoices(1, 3, yop)) === "[0,4]", "second pick after wheat: its partners, either order");
  assert(JSON.stringify(devChoices(1, 0, yop)) === "[0,3]", "two of the same kind");
  assert("first" in devStep(1, null, 3, yop), "a resource with partners waits for the second pick");
  assert(act(devStep(1, 3, 0, yop)) === JSON.stringify(yop[1]), "a pair is found in either order");
  const one: Canon[] = [["PLAY_YEAR_OF_PLENTY", 2, -1, -1]];
  assert(act(devStep(1, null, 2, one)) === JSON.stringify(one[0]), "a one-card play commits at once");
  const mono: Canon[] = [0, 1, 2, 3, 4].map((r) => ["PLAY_MONOPOLY", r, -1, -1] as Canon);
  assert(devChoices(2, null, mono).length === 5, "monopoly offers every resource");
  assert(act(devStep(2, null, 4, mono)) === JSON.stringify(mono[4]), "monopoly takes one tap");
  console.log("devpick.ts self-check passed");
}
