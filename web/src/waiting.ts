// Two derivations that live here so they exist exactly once.
import type { Canon, Decision } from "./engine";
import { actionKey, SEAT_NAMES } from "./labels";
import { playing, type State } from "./store";

export type WaitingKind = "discard" | "trade-offer" | "trade-answer" | "robber" | "turn" | "thinking" | "win";
export interface Waiting { text: string; seat: number; loud: boolean; kind: WaitingKind }

/** What the game wants from you, whatever view you are in.
 *
 *  This is derived from the snapshot rather than pushed anywhere, which is the entire
 *  mechanism by which an interrupt reaches you three crumbs deep in analysis: the spine
 *  reads the same state everything else does. It reads more than `prompt`,
 *  because a seven arrives as `is_discarding` rather than as a prompt of its own. */
export function waiting(s: State): Waiting | null {
  const v = s.view;
  if (!v) return null;
  if (v.winner >= 0) return { text: `${SEAT_NAMES[v.winner]} wins`, seat: v.winner, loud: true, kind: "win" };
  // Nobody is playing, so nothing is waiting on you.
  if (!playing(s)) return { text: `${SEAT_NAMES[v.current_player]} is thinking`, seat: v.current_player, loud: false, kind: "thinking" };
  if (v.is_discarding && v.discard_counts[s.human] > 0)
    return { text: `a seven — ${v.discard_counts[s.human]} cards to discard`, seat: s.human, loud: true, kind: "discard" };
  // Two different states share is_resolving_trade. On DECIDE_ACCEPTEES the offerer in
  // current_trade[10] is *you*, so reading it out would say you offered yourself a trade.
  if (v.is_resolving_trade && v.current_player === s.human) {
    return v.prompt === "DECIDE_ACCEPTEES"
      ? { text: "your offer was answered", seat: s.human, loud: true, kind: "trade-answer" }
      : { text: `${SEAT_NAMES[v.current_trade[10]]} offers you a trade`, seat: v.current_trade[10], loud: true, kind: "trade-offer" };
  }
  // Not `is_moving_knight`: the engine sets it and never clears it (Catanatron does the same, and
  // the replay oracle holds the port to that), so it read "move the robber" long after the move.
  if (v.prompt === "MOVE_ROBBER" && v.current_player === s.human)
    return { text: s.robTile != null ? "choose whom to rob" : "move the robber", seat: s.human, loud: true, kind: "robber" };
  if (v.is_road_building && v.current_player === s.human && s.legal.some((a) => a[0] === "BUILD_ROAD"))
    return { text: v.free_roads > 1 ? `place ${v.free_roads} free roads` : "place a free road", seat: s.human, loud: false, kind: "turn" };
  if (v.current_player === s.human && v.initial_phase)
    return { text: s.legal.some((a) => a[0] === "BUILD_ROAD") ? "place a road" : "place a settlement", seat: s.human, loud: false, kind: "turn" };
  if (v.current_player === s.human) return { text: "your turn", seat: s.human, loud: false, kind: "turn" };
  // Another person's seat, behind the handoff: they are not thinking, they are up.
  if (s.lineup[v.current_player]?.kind === "human")
    return { text: `${SEAT_NAMES[v.current_player]}'s turn`, seat: v.current_player, loud: false, kind: "turn" };
  return { text: `${SEAT_NAMES[v.current_player]} is thinking`, seat: v.current_player, loud: false, kind: "thinking" };
}

export interface Heat { [key: string]: number }

/** A search's root values, min-max normalised to 0..1 for the board's tint. Was duplicated
 *  verbatim in Play.tsx and Watch.tsx. */
export function heat(d: Decision | null | undefined): Heat | undefined {
  if (!d || !d.root.length) return undefined;
  const vals = d.root.map(([, v]) => v).filter((v): v is number => v != null);
  if (!vals.length) return undefined;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const out: Heat = {};
  for (const [a, v] of d.root) if (v != null) out[actionKey(a as Canon)] = (v - lo) / span;
  return out;
}

export type HeldKind = "road" | "settlement" | "city" | "robber";
export interface Held { kind: HeldKind; auto: boolean; drag: boolean; x0: number; y0: number; kbd?: boolean }
const ACTION_OF: Record<HeldKind, string> = { road: "BUILD_ROAD", settlement: "BUILD_SETTLEMENT", city: "BUILD_CITY", robber: "MOVE_ROBBER" };
export const heldAction = (k: HeldKind) => ACTION_OF[k];

/** The piece in your hand, if any. The game puts one there itself whenever a placement is the
 *  only thing it will take — the opening's settlement and road, the robber after a seven or a
 *  knight, Road Building's free roads — and otherwise it is whatever you picked up off the
 *  building cards, for as long as it can still go somewhere. */
export function held(s: State): Held | null {
  const v = s.view;
  if (!v || s.phase !== "playing" || !playing(s) || s.step != null || s.pendingHandoff != null) return null;
  if (v.current_player !== s.human || v.winner >= 0) return null;
  const has = (t: string) => s.legal.some((a) => a[0] === t);
  const auto = (kind: HeldKind): Held => ({ kind, auto: true, drag: false, x0: 0, y0: 0 });
  if (v.prompt === "MOVE_ROBBER" && has("MOVE_ROBBER")) return auto("robber");
  if (v.initial_phase) return has("BUILD_SETTLEMENT") ? auto("settlement") : has("BUILD_ROAD") ? auto("road") : null;
  if (v.is_road_building && has("BUILD_ROAD")) return auto("road");
  const c = s.carry;
  return c && has(ACTION_OF[c.kind]) ? { ...c, auto: false } : null;
}
