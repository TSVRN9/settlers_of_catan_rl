// Pass and play: who the phone goes to next, whether it is covered, and what the cover replays. Kept free of React
// and of the store so the check at the bottom runs outside Vite: node --experimental-strip-types web/src/phone/pass.ts
export interface PassView {
  n: number; current_player: number; current_turn: number; initial_phase: boolean; winner: number;
  owner: number[]; road_owner: number[];
}

/** Settlements down so far, and whose turn in the opening's snake it is (its index in the 2n order). */
export function draft(v: Pick<PassView, "owner" | "road_owner">) {
  const placed = v.owner.filter((o) => o >= 0).length;
  // A seat that has put its settlement down and owes the road is still on its own turn.
  const roadOwed = v.road_owner.filter((o) => o >= 0).length < placed;
  return { placed, turn: roadOwed ? placed - 1 : placed };
}

/** The next person to decide: the player on move if a person; else the turn's seat if a person, since the turn comes
 *  back to them once the bots have answered; else the first person among the turns still to come — the opening's
 *  snake out and back, then the game's turns from seat 0. -1 with nobody seated. */
export function nextPerson(v: PassView, person: boolean[]): number {
  if (person[v.current_player]) return v.current_player;
  if (person[v.current_turn]) return v.current_turn;
  const n = v.n, upcoming: number[] = [];
  if (v.initial_phase) {
    for (let t = draft(v).turn + 1; t < 2 * n; t++) upcoming.push(t < n ? t : 2 * n - 1 - t);
    for (let k = 0; k < n; k++) upcoming.push(k);
  } else for (let k = 1; k <= n; k++) upcoming.push((v.current_turn + k) % n);
  return upcoming.find((seat) => person[seat]) ?? -1;
}

/** A cover is up while the phone has to change hands: with two or more people, whenever the next person to decide
 *  is not the one holding it (`holder` null means in transit — every person, the last holder included, comes
 *  through a cover). `answer` is a decision inside someone else's turn (a discard, an offer): nothing to replay. */
export type Cover = { seat: number; mode: "replay" | "answer" } | null;
export function coverFor(v: PassView, person: boolean[], holder: number | null): Cover {
  if (person.filter(Boolean).length < 2 || v.winner >= 0) return null;
  const seat = nextPerson(v, person);
  if (seat < 0 || seat === holder) return null;
  return { seat, mode: v.current_player === seat && v.current_turn !== seat ? "answer" : "replay" };
}

/** What the cover replays for `seat`: every closed frame after the last one it acted in (the last frame is live). */
export function sinceActed(frames: { seat: number; action: unknown }[], seat: number): number[] {
  let from = 0;
  for (let i = frames.length - 2; i >= 0; i--) if (frames[i].seat === seat && frames[i].action != null) { from = i + 1; break; }
  const out: number[] = [];
  for (let i = from; i < frames.length - 1; i++) out.push(i);
  return out;
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("pass.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`pass self-check: ${m}`); };
  const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)}`);
  // Seats 0 Red (bot), 1 Blue (person), 2 Orange (person), 3 White (bot); the opening done.
  const P = [false, true, true, false];
  const empty = Array(54).fill(-1), roads = Array(72).fill(-1);
  const game = (o: Partial<PassView>): PassView => ({ n: 4, current_player: 0, current_turn: 0, initial_phase: false, winner: -1,
    owner: empty.map((_, i) => (i < 8 ? i % 4 : -1)), road_owner: roads.map((_, i) => (i < 8 ? i % 4 : -1)), ...o });
  eq(coverFor(game({ current_player: 1, current_turn: 1 }), P, 1), null, "Blue holding, Blue's own turn");
  eq(coverFor(game({ current_player: 0, current_turn: 1 }), P, 1), null, "a bot answering Blue's offer: the turn comes back to Blue");
  eq(coverFor(game({ current_player: 3, current_turn: 3 }), P, 2), { seat: 1, mode: "replay" }, "Orange ended, White's turn: Blue is next, covered at once");
  eq(coverFor(game({ current_player: 2, current_turn: 3 }), P, null), { seat: 2, mode: "answer" }, "in transit, Orange discarding on White's 7: covered for Orange");
  eq(coverFor(game({ current_player: 2, current_turn: 3 }), P, 2), null, "Orange holding the phone answers at once");
  eq(coverFor(game({ current_player: 2, current_turn: 1 }), P, 1), { seat: 2, mode: "answer" }, "Orange answering in Blue's turn");
  eq(coverFor(game({ current_player: 1, current_turn: 1 }), P, null), { seat: 1, mode: "replay" }, "the phone handed back to Blue");
  eq(coverFor(game({ current_player: 3, current_turn: 3 }), [false, true, false, false], null), null, "one person: never covered");
  eq(coverFor(game({ current_player: 1, current_turn: 1, winner: 0 }), P, null), null, "the game is over");
  // The opening's snake 0 1 2 3 3 2 1 0: three pairs down, White on turn 3; after White's two turns Orange places
  // again, not Blue (cyclic order would say Blue).
  const opening = (placed: number, roadsDown: number, cur: number): PassView => ({ n: 4, current_player: cur, current_turn: cur, initial_phase: true, winner: -1,
    owner: empty.map((_, i) => (i < placed ? 0 : -1)), road_owner: roads.map((_, i) => (i < roadsDown ? 0 : -1)) });
  eq(nextPerson(opening(3, 3, 3), P), 2, "snake: after White's first turn comes White, then Orange");
  eq(nextPerson(opening(7, 7, 0), P), 1, "snake's last turn is Red's; then Red rolls, then Blue");
  eq(nextPerson(opening(0, 0, 0), P), 1, "the game's start: Red places, then Blue");
  eq(nextPerson(game({ current_player: 3, current_turn: 3 }), [false, false, false, false]), -1, "nobody");
  eq(sinceActed([{ seat: 0, action: 1 }, { seat: 1, action: 1 }, { seat: 2, action: 1 }, { seat: 3, action: null }], 1), [2], "after Blue's last move");
  eq(sinceActed([{ seat: 0, action: 1 }, { seat: 2, action: 1 }, { seat: 3, action: null }], 1), [0, 1], "never acted: from the start");
  console.log("pass self-check ok");
}
