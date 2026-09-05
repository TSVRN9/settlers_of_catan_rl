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
 *  reads the same state everything else does. It reads five fields and not just `prompt`,
 *  because a seven arrives as `is_discarding` and a knight as `is_moving_knight` rather
 *  than as a prompt of their own. */
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
  if (v.is_moving_knight && v.current_player === s.human)
    return { text: "move the robber", seat: s.human, loud: true, kind: "robber" };
  if (v.current_player === s.human) return { text: "your turn", seat: s.human, loud: false, kind: "turn" };
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
