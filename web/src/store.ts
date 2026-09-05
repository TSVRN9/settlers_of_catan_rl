// The whole app's state, in a module rather than in a component.
//
// This is the thing that makes "one board, many views" possible: a view is swapped out by
// App, but the game is not inside it, so nothing a view does can destroy the game. The old
// App rendered exactly one page and a tab switch took the game with it.
//
// One immutable object, replaced wholesale. `getSnapshot` has to be referentially stable or
// React logs "The result of getSnapshot should be cached" and re-renders forever, which is
// also why there is no selector layer: four seats and one board is not a render cost worth
// a subscription graph.
import { useSyncExternalStore } from "react";
import type { BotSpec, Canon, Decision, Evaluation, Frame, MapView, View } from "./engine";

export type ViewName = "table" | "console" | "coach" | "futures" | "move" | "game";

export interface LogRow { step: number; seat: number; action: Canon; note: string | null }

export interface State {
  phase: "lineup" | "dealing" | "playing" | "over";
  seed: number;
  lineup: BotSpec[];
  human: number;

  map: MapView | null;
  view: View | null;
  legal: Canon[];
  evals: Evaluation[];
  advice: Decision | null;
  log: LogRow[];
  last: Canon | null;

  /** What the app is doing. Never what went wrong, and never a gate on whether you can play
   *  — the old `busy` was status, ellipsis and error at once, and one caught error disabled
   *  the human's whole action surface until a new game. */
  status: "idle" | "thinking" | "applying";
  error: string | null;

  /** The path, and the truth behind the hash. `crumbs[crumbs.length - 1]` is the view. */
  crumbs: ViewName[];
  /** The review step, or null while looking at the live position. */
  step: number | null;

  /** A choice the engine offers that needs more than one click to make: whom to rob when a
   *  tile has several victims, which of many trades to offer. Set by the surface that asks,
   *  cleared by the action that answers. */
  pending: { title: string; actions: Canon[] } | null;

  coach: boolean;
  revealAll: boolean;
  /** A seat the reader is looking at, from the 1-4 keys. Not who you are playing. */
  focusSeat: number | null;

  /** What the persistent board shows when it isn't the live position: Futures' top-ranked
   *  candidate, or a review view's frame at `step`. One channel, several producers — never
   *  more than one is active at a time, because the views that set it are mutually exclusive. */
  boardOverride: { view: View; highlight?: Canon | null; litTiles?: number[] } | null;

  /** The live game, replayed once on the review worker. Built lazily on first entry to a
   *  review view; reset whenever a new game starts. */
  review: { map: MapView; frames: Frame[] } | null;
  reviewPlaying: boolean;

  /** Hotseat: the seat now on move, waiting on its own player to tap through before `human`
   *  (whoever the readings are currently written from) moves to it. `null` outside a handoff —
   *  which is always, unless two different human seats are actually sharing the table. */
  pendingHandoff: number | null;
}

const initial: State = {
  phase: "lineup",
  seed: Math.floor(Math.random() * 1e6),
  lineup: [
    { kind: "vnet", depth: 2 },
    { kind: "human", depth: 2 },
    { kind: "heuristic", depth: 2 },
    { kind: "heuristic", depth: 2 },
  ],
  human: 1,
  map: null,
  view: null,
  legal: [],
  evals: [],
  advice: null,
  log: [],
  last: null,
  status: "idle",
  error: null,
  crumbs: ["table"],
  step: null,
  pending: null,
  coach: true,
  revealAll: false,
  focusSeat: null,
  boardOverride: null,
  review: null,
  reviewPlaying: false,
  pendingHandoff: null,
};

let state: State = initial;
const subs = new Set<() => void>();

export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const getSnapshot = () => state;
export const get = () => state;

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const f of subs) f();
}

export const useApp = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

/** Whether a person is at the table at all. A lineup with nobody in it is legal — that is
 *  what watching is — and everything that would otherwise say "your turn" has to know. */
export const playing = (s: State) => s.lineup[s.human]?.kind === "human";

/** The view being shown: the last crumb. */
export const currentView = (s: State): ViewName => s.crumbs[s.crumbs.length - 1] ?? "table";
