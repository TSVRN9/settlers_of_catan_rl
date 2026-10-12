// Final places, kept free of React so the check at the bottom runs outside Vite:
// node --experimental-strip-types web/src/phone/standings.ts

/** Each seat's place at the end: the winner first whatever the points say, then by points; seats on equal
 *  points share a place, and the seat after them counts every seat ahead ("second, second, fourth"). */
export function places(vps: number[], winner: number): number[] {
  return vps.map((vp, i) => (i === winner ? 1 : 1 + vps.filter((w, j) => j !== i && (j === winner || w > vp)).length));
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("standings.ts")) {
  const eq = (a: number[], b: number[], m: string) => { if (a.join() !== b.join()) throw new Error(`standings self-check: ${m}: ${a}`); };
  eq(places([10, 8, 6, 5], 0), [1, 2, 3, 4], "plain order");
  eq(places([6, 10, 6, 3], 1), [2, 1, 2, 4], "a tie shares second; the next seat is fourth");
  eq(places([9, 10, 9, 9], 1), [2, 1, 2, 2], "a three-way tie");
  eq(places([10, 10], 1), [2, 1], "the winner is first on equal points");
  console.log("standings self-check ok");
}
