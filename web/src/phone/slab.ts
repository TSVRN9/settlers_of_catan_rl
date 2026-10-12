// What the slab under your hand is for, from the position alone. Kept free of React and of the store so
// the check at the bottom runs outside Vite: node --experimental-strip-types web/src/phone/slab.ts
export type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over"
  | "discard" | "offer-in" | "offer-out" | "builder" | "devs" | "pick";
export interface SlabInput {
  over: boolean; mine: boolean; opening: boolean; prompt: string; legal: string[]; handoff: boolean;
  /** Your own offer is on the table: the slab stays yours while the bots answer it. */
  offerOut: boolean;
  /** The offer builder is open (`store.offering`). */
  builder: boolean;
  /** The dev pile spread into the slab, or a Year of Plenty / Monopoly choosing (`store.devSheet`). */
  sheet: "devs" | "pick" | null;
  /** Road Building's free roads are in hand (`view.is_road_building`). */
  roadBuilding: boolean;
}

/** The frames to list under another seat's turn, newest first: every closed frame since the seated person's own
 *  turn ended, their answers inside other turns (a decline, a discard) included. The last frame is the live one.
 *  With nobody seated (`human` -1) it is every closed frame. */
export function sinceTurn(frames: { seat: number; view: { current_turn: number } }[], human: number): number[] {
  const out: number[] = [];
  for (let i = frames.length - 2; i >= 0 && frames[i].view.current_turn !== human; i--) out.push(i);
  return out;
}

/** Whose eyes the narration and the card flights are for: yours, except while the phone is between two
 *  people, when they are a spectator's — "you drew a victory point" must not reach the next person. */
export const viewerNow = (you: number, handoff: number | null) => (handoff != null ? -1 : you);

/** Every phase of a turn has its own slab; the fallback lists the legal actions for any position none of
 *  them covers, so nothing can strand you. A selection (the builder, the dev sheet) only counts in the
 *  phase it belongs to, so one left open when the turn moved on shows nothing stale. */
export function slabMode(x: SlabInput): SlabMode {
  if (x.over) return "over";
  if (x.handoff) return "bots";
  if (x.offerOut) return "offer-out";
  if (!x.mine) return "bots";
  if (x.opening) return "opening";                       // Carry holds the piece; the slab shows the supply
  if (x.prompt === "DISCARD") return "discard";
  // An offer to you, or a counter to yours; Counter opens the builder on it, turned round.
  if (x.prompt === "DECIDE_TRADE") return x.builder && x.legal.includes("OFFER_TRADE") ? "builder" : "offer-in";
  if (x.prompt === "MOVE_ROBBER" || x.roadBuilding) return "build";   // Carry holds the robber or the free roads; the cards sink
  if (x.prompt !== "PLAY_TURN") return "fallback";
  if (x.sheet === "pick" && x.legal.some((k) => k === "PLAY_YEAR_OF_PLENTY" || k === "PLAY_MONOPOLY")) return "pick";
  if (x.sheet === "devs") return "devs";
  if (x.builder && x.legal.includes("END_TURN")) return "builder";
  if (x.legal.includes("ROLL")) return "roll";
  if (x.legal.includes("END_TURN")) return "build";
  return "fallback";
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("slab.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`slab self-check: ${m}`); };
  const base: SlabInput = { over: false, mine: true, opening: false, prompt: "PLAY_TURN", legal: [], handoff: false, offerOut: false, builder: false, sheet: null, roadBuilding: false };
  { const fr = [0, 1, 2, 0, 1].map((t) => ({ seat: t, view: { current_turn: t } }));
    assert(sinceTurn(fr, -1).join() === "3,2,1,0", "watching lists every closed frame, newest first"); }
  assert(slabMode({ ...base, legal: ["ROLL", "PLAY_KNIGHT_CARD"] }) === "roll", "before the roll");
  assert(slabMode({ ...base, legal: ["END_TURN", "BUILD_ROAD"] }) === "build", "main phase");
  assert(slabMode({ ...base, mine: false }) === "bots", "someone else's turn");
  assert(slabMode({ ...base, handoff: true, legal: ["ROLL"] }) === "bots", "a handoff covers your controls");
  assert(slabMode({ ...base, opening: true, prompt: "BUILD_INITIAL_SETTLEMENT" }) === "opening", "opening");
  assert(slabMode({ ...base, prompt: "MOVE_ROBBER", legal: ["MOVE_ROBBER"] }) === "build", "robber in hand");
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"] }) === "discard", "discard");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE"] }) === "offer-in", "an offer to you");
  // A bot's counter to your offer comes to you as the turn player: still an offer to answer.
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE", "OFFER_TRADE"] }) === "offer-in", "a counter");
  // Your offer going round: the bots are on move, but the slab is still yours.
  assert(slabMode({ ...base, mine: false, offerOut: true, prompt: "DECIDE_TRADE" }) === "offer-out", "your offer, bots answering");
  assert(slabMode({ ...base, offerOut: true, prompt: "DECIDE_ACCEPTEES", legal: ["CONFIRM_TRADE", "CANCEL_TRADE"] }) === "offer-out", "answers back");
  assert(slabMode({ ...base, legal: ["END_TURN", "OFFER_TRADE"], builder: true }) === "builder", "the builder");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE", "OFFER_TRADE"], builder: true }) === "builder", "countering an offer");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE"], builder: true }) === "offer-in", "no counter where none is legal");
  assert(slabMode({ ...base, legal: ["END_TURN"], sheet: "devs" }) === "devs", "the dev sheet");
  assert(slabMode({ ...base, legal: ["ROLL", "PLAY_KNIGHT_CARD"], sheet: "devs" }) === "devs", "the dev sheet before the roll");
  assert(slabMode({ ...base, legal: ["END_TURN", "PLAY_YEAR_OF_PLENTY"], sheet: "pick" }) === "pick", "a pick");
  // A selection never outlives its phase: the builder or the sheet left open once the turn moved on means nothing.
  assert(slabMode({ ...base, mine: false, builder: true, sheet: "devs" }) === "bots", "stale selections ignored");
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"], builder: true }) === "discard", "a discard beats a stale builder");
  assert(slabMode({ ...base, prompt: "MOVE_ROBBER", legal: ["MOVE_ROBBER"], sheet: "devs" }) === "build", "the robber in hand beats the sheet");
  // Road Building: its free roads are in hand and BUILD_ROAD is all that's legal (no END_TURN): the build slab, sunk.
  assert(slabMode({ ...base, legal: ["BUILD_ROAD"], roadBuilding: true }) === "build", "road building");
  // The move list: everything since the seated person's own turn, including their answers inside a bot's turn.
  const fr = (seat: number, turn: number) => ({ seat, view: { current_turn: turn } });
  const frames = [fr(1, 1), fr(1, 1), fr(2, 2), fr(1, 2), fr(2, 2), fr(3, 3), fr(3, 3)];
  assert(JSON.stringify(sinceTurn(frames, 1)) === "[5,4,3,2]", `since your turn, your answers included: ${JSON.stringify(sinceTurn(frames, 1))}`);
  assert(JSON.stringify(sinceTurn([fr(2, 2)], 1)) === "[]", "the live frame alone is not a move");
  assert(slabMode({ ...base, over: true, mine: false }) === "over", "game over");
  // During a handoff the screen is between two people: narrate and fly cards as a spectator would see them.
  assert(viewerNow(1, 2) === -1, "a handoff hides the last person's cards");
  assert(viewerNow(1, null) === 1, "no handoff: you");
  console.log("slab.ts self-check passed");
}
