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

/** Every closed frame after the last one `seat` acted in (the last frame is live): taken when a person lets the phone
 *  go, it is where their next replay starts. */
export function sinceActed(frames: { seat: number; action: unknown }[], seat: number): number[] {
  let from = 0;
  for (let i = frames.length - 2; i >= 0; i--) if (frames[i].seat === seat && frames[i].action != null) { from = i + 1; break; }
  const out: number[] = [];
  for (let i = from; i < frames.length - 1; i++) out.push(i);
  return out;
}

/** The phone leaves `holder`'s hands (a cover rises, or the game goes back to the lineup): `gaveUp` with where their
 *  next replay starts, after their own last move, whatever is played for them once it has left their hands. */
export function letGo(frames: { seat: number; action: unknown }[], holder: number, gaveUp: number[]): number[] {
  const out = [...gaveUp];
  out[holder] = sinceActed(frames, holder)[0] ?? frames.length - 1;
  return out;
}

/** What a cover replays: every closed frame from where its seat let the phone go (`from`, first index after its own
 *  last move then; undefined if it never held the phone). Moves made for it since — an offer it couldn't afford,
 *  declined for it — don't move the start. */
export function sinceHeld(frames: unknown[], from: number | undefined): number[] {
  const out: number[] = [];
  for (let i = from ?? 0; i < frames.length - 1; i++) out.push(i);
  return out;
}

/** Whether an offer to a person is answered for them, silently: a bot's offer they can't afford, or one from a bot they
 *  muted this turn themselves. Never a person's offer — the instant refusal would tell the offerer the other is short,
 *  and passing the phone to answer costs nothing — and never on someone else's mute. */
export function autoDecline(o: { responder: number; offerer: number; offererIsPerson: boolean; cannotAfford: boolean;
                                  mute: { seat: number; by: number; turn: number } | null; turn: number }): boolean {
  if (o.offererIsPerson) return false;
  const muted = !!o.mute && o.mute.by === o.responder && o.mute.seat === o.offerer && o.mute.turn === o.turn;
  return o.cannotAfford || muted;
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
  // Orange gave the phone up at frame 2; a bot's offer she couldn't afford was declined for her at frame 4. Her replay
  // still starts where she let go, not after the decline she never chose.
  const fr = [0, 2, 3, 2, 2, 1, 0].map((seat, i) => ({ seat, action: i < 6 ? 1 : null }));
  eq(sinceHeld(fr, 2), [2, 3, 4, 5], "replay from where the phone was let go");
  eq(sinceHeld(fr, undefined), [0, 1, 2, 3, 4, 5], "never held: from the start");
  eq(sinceActed(fr.slice(0, 3), 2), [], "the point of letting go: after the holder's own last move");
  eq(letGo([{ seat: 0, action: 1 }, { seat: 1, action: 1 }, { seat: 2, action: 1 }, { seat: 3, action: null }], 1, [5, 9]), [5, 2], "let go after Blue's own move");
  // An offer to a person is answered for them only when it is a bot's and they can't afford it, or they muted that bot
  // this turn; a person's offer always reaches the other person, and one person's mute is not another's.
  const o = { responder: 2, offerer: 3, offererIsPerson: false, cannotAfford: false, mute: { seat: 3, by: 2, turn: 7 }, turn: 7 };
  assert(autoDecline({ ...o, cannotAfford: true, mute: null }), "a bot's offer she can't afford");
  assert(!autoDecline({ ...o, offerer: 1, offererIsPerson: true, cannotAfford: true, mute: null }), "a person's offer reaches her even short");
  assert(autoDecline(o), "she muted this bot this turn");
  assert(!autoDecline({ ...o, mute: { seat: 3, by: 1, turn: 7 } }), "Blue's mute is not Orange's");
  assert(!autoDecline({ ...o, turn: 8 }), "the mute is for one turn");
  console.log("pass self-check ok");
}
