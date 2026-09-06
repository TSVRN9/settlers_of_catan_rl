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
import { flushSync } from "react-dom";
import type { BotSpec, Canon, Decision, Evaluation, Frame, MapView, View } from "./engine";

export type ViewName = "table" | "futures" | "move" | "game";
export type Pace = "slow" | "normal" | "fast";

export interface Bubble { from: "assistant" | "user"; text: string }

export interface State {
  phase: "lineup" | "playing" | "over";
  seed: number;
  lineup: BotSpec[];
  human: number;
  /** The seed and seat count the board behind the lineup was dealt for. */
  dealt: { seed: number; n: number } | null;
  /** The deal's reveal is running: tiles, numbers and ports arriving. */
  reveal: boolean;

  map: MapView | null;
  view: View | null;
  legal: Canon[];
  evals: Evaluation[];
  advice: Decision | null;
  last: Canon | null;

  /** A move you have picked but not yet played: the board shows it as a ghost and asks. A
   *  hovered target previews the same way. Both are the seat on move's own. */
  staged: Canon | null;
  hover: Canon | null;
  /** The move the coach is talking about, ringed on the live board. */
  mark: Canon | null;

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
  /** The offer builder is open. `pending` carries a list of actions and cannot hold
   *  builder state, so this is its own flag. */
  offering: boolean;

  /** Seated: the analysis is open — the ring, the coach's column beside the board, and the
   *  advice search behind them. Closed by default, so a person's turn costs no depth-2 search
   *  until asked. */
  analysis: boolean;
  /** The coach's conversation this turn. Lives here so Esc and re-entry keep it. */
  coachThread: { step: number; bubbles: Bubble[] } | null;
  revealAll: boolean;
  /** A seat the reader is looking at, from the 1-4 keys. Not who you are playing. */
  focusSeat: number | null;

  /** A watched game's transport: held, and how long each position is shown for. A watched
   *  game is a playback — the worker plays it ahead into `frames`, and `view` is the frame
   *  the playhead is on. */
  paused: boolean;
  pace: Pace;

  /** What the persistent board shows when it isn't the live position: Futures' top-ranked
   *  candidate, or a review view's frame at `step`. One channel, several producers — never
   *  more than one is active at a time, because the views that set it are mutually exclusive. */
  boardOverride: { view: View; highlight?: Canon | null; litTiles?: number[] } | null;

  /** The game so far, one frame per position: `view` and `evals` at each step, the action
   *  that left it. Built by the game itself as it is played (`game.advance`), so the ending's
   *  curve, the stands' seek bar and both analysis views read it without a re-walk. The last
   *  frame is the live position, `action: null`. */
  frames: Frame[];
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
  dealt: null,
  reveal: false,
  map: null,
  view: null,
  legal: [],
  evals: [],
  advice: null,
  last: null,
  staged: null,
  hover: null,
  mark: null,
  status: "idle",
  error: null,
  crumbs: ["table"],
  step: null,
  pending: null,
  offering: false,
  analysis: false,
  coachThread: null,
  revealAll: false,
  focusSeat: null,
  paused: false,
  pace: "normal",
  boardOverride: null,
  frames: [],
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

/** A navigation: the browser animates from the old screen to the new one (the board's
 *  travel, each panel's arrival). `flushSync` makes sure the DOM holds the new state before
 *  the new snapshot is taken. Without View Transitions it is a plain update. */
export function transition(fn: () => void): Promise<void> {
  const apply = () => flushSync(fn);
  if (typeof document !== "undefined" && "startViewTransition" in document) {
    // The callback runs on the next frame, after the old screen is captured — so callers
    // that read the store afterwards await the returned promise. A hidden document skips
    // the animation and rejects `finished`; the update itself still lands.
    const t = document.startViewTransition(apply);
    t.ready.catch(() => {});
    t.finished.catch(() => {});
    return t.updateCallbackDone.catch(() => {});
  }
  apply();
  return Promise.resolve();
}

/** Whether a person is at the table at all. A lineup with nobody in it is legal — that is
 *  what watching is — and everything that would otherwise say "your turn" has to know. */
export const playing = (s: State) => s.lineup[s.human]?.kind === "human";

/** The seat "you" is written from, or -1 when nobody is seated. */
export const you = (s: State) => (playing(s) ? s.human : -1);

/** The view being shown: the last crumb. */
export const currentView = (s: State): ViewName => s.crumbs[s.crumbs.length - 1] ?? "table";
