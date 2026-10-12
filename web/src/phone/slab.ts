// What the slab under your hand is for, from the position alone. Kept free of React and of the store so
// the check at the bottom runs outside Vite: node --experimental-strip-types web/src/phone/slab.ts
export type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over";
export interface SlabInput { over: boolean; mine: boolean; opening: boolean; prompt: string; legal: string[]; handoff: boolean }

/** Whose eyes the narration and the card flights are for: yours, except while the phone is between two
 *  people, when they are a spectator's — "you drew a victory point" must not reach the next person. */
export const viewerNow = (you: number, handoff: number | null) => (handoff != null ? -1 : you);

/** The phases Milestone 1 designs, and a fallback that lists every legal action for the rest, so no
 *  position strands you on a phone before its own design lands (spec "Milestones"). */
export function slabMode(x: SlabInput): SlabMode {
  if (x.over) return "over";
  if (x.handoff || !x.mine) return "bots";
  if (x.opening) return "opening";                       // Carry holds the piece; the slab shows the supply
  if (x.prompt === "PLAY_TURN" && x.legal.includes("ROLL")) return "roll";
  if (x.prompt === "PLAY_TURN" && x.legal.includes("END_TURN")) return "build";
  if (x.prompt === "MOVE_ROBBER") return "build";        // Carry holds the robber; the build cards sink
  return "fallback";
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("slab.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`slab self-check: ${m}`); };
  const base: SlabInput = { over: false, mine: true, opening: false, prompt: "PLAY_TURN", legal: [], handoff: false };
  assert(slabMode({ ...base, legal: ["ROLL", "PLAY_KNIGHT_CARD"] }) === "roll", "before the roll");
  assert(slabMode({ ...base, legal: ["END_TURN", "BUILD_ROAD"] }) === "build", "main phase");
  assert(slabMode({ ...base, mine: false }) === "bots", "someone else's turn");
  assert(slabMode({ ...base, handoff: true, legal: ["ROLL"] }) === "bots", "a handoff covers your controls");
  assert(slabMode({ ...base, opening: true, prompt: "BUILD_INITIAL_SETTLEMENT" }) === "opening", "opening");
  assert(slabMode({ ...base, prompt: "MOVE_ROBBER", legal: ["MOVE_ROBBER"] }) === "build", "robber in hand");
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"] }) === "fallback", "discard falls back");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE"] }) === "fallback", "offer falls back");
  assert(slabMode({ ...base, over: true, mine: false }) === "over", "game over");
  // During a handoff the screen is between two people: narrate and fly cards as a spectator would see them.
  assert(viewerNow(1, 2) === -1, "a handoff hides the last person's cards");
  assert(viewerNow(1, null) === 1, "no handoff: you");
  console.log("slab.ts self-check passed");
}
