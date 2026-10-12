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
  if (x.prompt === "MOVE_ROBBER") return "build";        // Carry holds the robber; the build cards sink
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
  const base: SlabInput = { over: false, mine: true, opening: false, prompt: "PLAY_TURN", legal: [], handoff: false, offerOut: false, builder: false, sheet: null };
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
  assert(slabMode({ ...base, over: true, mine: false }) === "over", "game over");
  // During a handoff the screen is between two people: narrate and fly cards as a spectator would see them.
  assert(viewerNow(1, 2) === -1, "a handoff hides the last person's cards");
  assert(viewerNow(1, null) === 1, "no handoff: you");
  console.log("slab.ts self-check passed");
}
