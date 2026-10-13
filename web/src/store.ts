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
import { viewer as viewerOf } from "./readings";
import type { GradeMark } from "./grade";
import type { BotSpec, Canon, Decision, Evaluation, Frame, MapView, View } from "./engine";

export type ViewName = "table" | "futures" | "move" | "game";
export type Pace = "slow" | "normal" | "fast";
export type Building = "road" | "settlement" | "city";
/** A piece in hand: what it is, and whether it is being dragged (it goes down where the drag
 *  ends) or was picked up with a click (it follows the pointer until a click puts it down). */
export interface Carry { kind: Building; drag: boolean; x0: number; y0: number; kbd?: boolean }

export interface Bubble { from: "assistant" | "user"; text: string }

export interface State {
  phase: "lineup" | "playing" | "over";
  seed: number;
  lineup: BotSpec[];
  human: number;
  /** The seed, seat count and occupants the board behind the lineup was dealt for. */
  dealt: { seed: number; n: number; kinds: string } | null;
  /** The deal's reveal is running: tiles, numbers and ports arriving. */
  reveal: boolean;

  map: MapView | null;
  view: View | null;
  legal: Canon[];
  evals: Evaluation[];
  /** The reading `evals` is not showing: see `Frame.evalsOther`. */
  evalsOther: Evaluation[];
  /** "Hidden information": readings computed from every seat's own hand instead of what the
   *  viewer could know. Per viewer, remembered across visits; locked off while two people share
   *  the screen mid-game (`hiddenLocked`). */
  showHidden: boolean;
  /** The phone's Eval switch: readings on screen during play. Off hides bars, percentages, swings and
   *  Suggest; `evaluateAll` still fills `frames`, so the review after the game is complete. */
  evalShown: boolean;
  advice: Decision | null;
  last: Canon | null;

  /** A Futures candidate under the pointer, shown on the live board as the mover's ghost. */
  hover: Canon | null;
  /** The piece picked up off the building cards. The game also puts one in your hand by
   *  itself — the opening's settlement and road, the robber, Road Building's roads — and that
   *  one is derived (`table.ts` `held`), never stored. */
  carry: Carry | null;
  /** The robber set down on a tile with more than one seat to rob: the board asks whom. */
  robTile: number | null;
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
  /** The phone's offer builder: what you give and what you ask for, per resource. Hand taps add to `give`, so
   *  the hand and the slab both read it. Cleared with `offering` whenever an action lands. */
  offerDraft: { give: number[]; want: number[] };
  /** The phone's discard slots, one resource per filled slot. Not cleared by `advance` — the slots are played
   *  one card per action — but by the commit that plays them (`phone/Slab.tsx`). */
  discardPick: number[];
  /** The phone's dev pile spread into the slab (`dev: null`), or Year of Plenty / Monopoly choosing. Cleared
   *  by `advance`, like `pending`. */
  devSheet: { dev: 1 | 2 | null; first: number | null } | null;
  /** A tap on the board hurries the bots until the seated person is asked something. */
  hurry: boolean;

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

  /** "Ignore this bot's trades for its turn": the offering seat and the `num_turns` it was
   *  muted on. Expires by itself once the turn count moves past it — no separate clear needed. */
  /** Pass and play on a phone: the person holding it, who last tapped Show hand; null while it is between people,
   *  when every person's decision comes through a cover (phone/pass.ts). */
  holder: number | null;
  /** Per seat, the frame its next pass-and-play replay starts at: where it last let the phone go. */
  gaveUp: number[];
  mutedSeat: number | null;
  /** Who set the mute: it is that person's alone. */
  mutedBy: number | null;
  mutedTurn: number | null;

  /** A shared game (share.ts): a recording played back, never a game in play, whoever its seats were. "unnamed" when
   *  the link carries no seats, so the standings don't name occupants it never said. */
  film: "named" | "unnamed" | null;
  /** A shared link that wasn't a game. Cleared by the next deal. */
  linkBroken: boolean;
  /** The phone's review of a finished game (phone/Review.tsx): `step` is its playhead, null for the overview. */
  review: boolean;
  /** Whose moves the review grades and draws bold: you, else the winner, else the seat picked. */
  reviewSeat: number | null;
  /** Grades by step (grade.ts): a person's moves as they are played (Eval on), the reviewed seat's in the review. */
  grades: Record<number, GradeMark>;
  /** Watching: the furthest the playhead has been. The curve is drawn to here, faint past the playhead; Live comes
   *  back here. The frames past it are the worker's lookahead and are never shown. */
  seenTo: number;
}

// A shared link opens on its result, so the lineup (which would deal a board of its own) never mounts.
const opening = typeof location !== "undefined" && location.hash.startsWith("#/r/");

const initial: State = {
  phase: opening ? "over" : "lineup",
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
  evalsOther: [],
  showHidden: rememberedHidden(),
  evalShown: rememberedFlag("evalShown", true),
  advice: null,
  last: null,
  hover: null,
  carry: null,
  robTile: null,
  mark: null,
  status: "idle",
  error: null,
  crumbs: ["table"],
  step: null,
  pending: null,
  offering: false,
  offerDraft: { give: [0, 0, 0, 0, 0], want: [0, 0, 0, 0, 0] },
  discardPick: [],
  devSheet: null,
  hurry: false,
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
  holder: null,
  gaveUp: [],
  mutedSeat: null,
  mutedBy: null,
  mutedTurn: null,
  film: opening ? "named" : null,
  linkBroken: false,
  seenTo: 0,
  review: false,
  reviewSeat: null,
  grades: {},
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
/** The position on screen: a look-back step's (the phone's pass-and-play replay is one) or the live one. */
export function shown(s: Pick<State, "step" | "frames" | "view" | "evals">) {
  const f = s.step != null ? s.frames[s.step] : null;
  return f ? { view: f.view, evals: f.evals } : { view: s.view, evals: s.evals };
}

export const playing = (s: State) => !s.film && s.lineup[s.human]?.kind === "human";

/** The seat "you" is written from, or -1 when nobody is seated. */
export const you = (s: State) => (playing(s) ? s.human : -1);

/** The viewer's last "Hidden information" choice (per browser; a private window reads false). */
export function rememberedFlag(key: string, fallback: boolean) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === "1"; } catch { return fallback; }
}
export function rememberedHidden() { return rememberedFlag("showHidden", false); }
export function setEvalShown(on: boolean) {
  try { localStorage.setItem("evalShown", on ? "1" : "0"); } catch { /* private window */ }
  set({ evalShown: on });
}

/** Whose public reading is shown (readings.ts). */
export const viewer = (s: Pick<State, "lineup">) => viewerOf(s.lineup);

/** Hidden information would show one person the other's hand: off while a shared game is live. */
export const hiddenLocked = (s: State) => !s.film && s.lineup.filter((p) => p.kind === "human").length > 1 && s.phase === "playing";

/** The view being shown: the last crumb. */
export const currentView = (s: State): ViewName => s.crumbs[s.crumbs.length - 1] ?? "table";
