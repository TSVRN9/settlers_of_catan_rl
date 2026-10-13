// The drive loop, outside React.
//
// The old version was a useEffect carrying a generation counter and an `inflight` ref, with
// two bail paths that returned without clearing the ref — so a new game landing between
// `apply` and `evaluateAll` deadlocked the loop until the next `start()`. Here the loop is
// one `async while` with a `try/finally` that always releases, and staleness is the engine
// client's epoch rather than a counter kept in a component.
import { EngineClient, isStale, type Canon, type Evaluation, type Frame, type Readings, type View } from "./engine";
import { resetReview } from "./review";
import { orient, swap } from "./readings";
import { get, playing, rememberedHidden, set, transition, viewer, type Pace } from "./store";
import { autoDecline } from "./phone/pass";

/** The live game's engine. Review holds its own client, because the worker frees its wasm
 *  engine on every `new` — one shared client is how Play and Watch used to destroy each
 *  other. */
export const live = new EngineClient();

let pumping = false;

/** How long a position is held on screen in a watched game's playback, and how long a bot's
 *  move is held when a person is at the table. */
const PACE: Record<Pace, number> = { slow: 1200, normal: 350, fast: 40 };
/** The pace buttons are the stands' own (Table's transport) — a seated player has no
 *  control and used to get the 350ms playback beat, which is faster than a person can
 *  read a move. Seated, the move before is held long enough to follow, by what it was: a
 *  roll until its dice, tiles and cards have landed (views/Fx.tsx), a build until it has
 *  settled, a word in a trade only briefly. Timers, never an animation's end: a background
 *  tab runs no animation frames, and a loop that waited on one would stall there.
 *  ponytail: one table of knobs; tune by feel. */
const SEATED_MS: Record<string, number> = { ROLL: 1800, MOVE_ROBBER: 1300, BUILD_SETTLEMENT: 1100, BUILD_CITY: 1100,
  BUILD_ROAD: 900, BUY_DEVELOPMENT_CARD: 900, END_TURN: 500, OFFER_TRADE: 1000, ACCEPT_TRADE: 600, REJECT_TRADE: 450,
  CONFIRM_TRADE: 900, CANCEL_TRADE: 450, DISCARD_RESOURCE: 250 };
const beat = (forced: boolean) => {
  const s = get();
  if (!playing(s)) { const ms = s.pace === "fast" ? 0 : PACE[s.pace]; return forced ? Math.min(120, ms) : ms; }
  const prev = s.last?.[0] ?? "";
  const ms = SEATED_MS[prev] ?? 900;
  // A tap on the board hurries the bots until the seated person is asked something (the phone's bot turns).
  if (s.hurry) return Math.min(120, ms);
  // A forced move goes quickly — except straight after a roll, whose cards are still flying.
  return forced && prev !== "ROLL" ? Math.min(120, ms) : ms;
};

/** A live position as a frame: the last of `store.frames` until an action closes it. */
const frame = (view: View, evals: Evaluation[], evalsOther: Evaluation[] = []): Frame =>
  ({ step: view.steps, view, seat: view.current_player, action: null, outcome: null, decision: null, evals, evalsOther, attribution: null });

/** Both readings, ordered the way the "Hidden information" switch shows them. */
const shown = (r: Readings) => orient(r, get().showHidden);

/** The "Hidden information" switch: swaps every frame's two readings, so everything that reads
 *  `evals` (the ring, the curves, the deciding marks) follows it without knowing it exists. */
export function setShowHidden(on: boolean, remember = true) {
  if (remember) { try { localStorage.setItem("showHidden", on ? "1" : "0"); } catch { /* private window */ } }
  if (get().showHidden === on) return;
  set((cur) => ({
    showHidden: on, ...swap({ evals: cur.evals, evalsOther: cur.evalsOther }), frames: cur.frames.map(swap),
  }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the board is left dealing itself before play starts. The reveal runs tiles,
 *  then glyphs, then numbers, then ports at 1s; this is the tail of that. */
const DEAL_MS = 1400;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Deal the board the lineup is configuring: the seed's island, for this many seats, shown
 *  behind the lineup with the reveal. The game does not start; `start()` does that, and
 *  reuses this deal when nothing has changed. */
export async function deal() {
  const s = get();
  const seed = s.seed, n = s.lineup.length;
  resetReview();
  stopWatching();
  set({ status: "thinking", error: null, last: null, advice: null, step: null, crumbs: ["table"], pending: null, offering: false, offerDraft: { give: [0, 0, 0, 0, 0], want: [0, 0, 0, 0, 0] }, discardPick: [], devSheet: null, hurry: false, hover: null, carry: null, robTile: null, mark: null,
        boardOverride: null, pendingHandoff: null, coachThread: null, dealt: null, evals: [], evalsOther: [], frames: [], holder: null, gaveUp: [], mutedSeat: null, mutedBy: null, mutedTurn: null });
  // Two people at one screen: the game starts with the hidden cards hidden, whatever this viewer
  // last chose; that choice is not overwritten, so it is back for the next game.
  setShowHidden(s.lineup.filter((p) => p.kind === "human").length > 1 ? false : rememberedHidden(), false);
  try {
    const g = await live.newGame(seed, n);
    // A game has an address, so it can be linked and a reload keeps the board. The play
    // itself does not survive that reload — a seed reproduces the map, not the game.
    history.replaceState({ crumbs: ["table"], step: null }, "", `#/g/${seed}`);
    // The reveal only happens now: `reveal` has to be set in the same breath as the map,
    // or the board it animates does not exist yet to carry the class.
    set({ map: g.map, view: g.view, legal: g.legal, dealt: { seed, n, kinds: s.lineup.map((b) => b.kind).join() }, reveal: !reduced(), status: "idle", frames: [frame(g.view, [])] });
    const [ev, other] = shown(await live.evaluateAll(viewer(get())));
    set((cur) => ({ evals: ev, evalsOther: other, frames: cur.frames.length ? [{ ...cur.frames[0], evals: ev, evalsOther: other }] : [frame(g.view, ev, other)] }));
    if (!reduced()) setTimeout(() => { if (get().map === g.map) set({ reveal: false }); }, DEAL_MS);
  } catch (e) {
    if (!isStale(e)) set({ status: "idle", error: String(e) });
  }
}

/** Sit down at the dealt board. One motion: the lineup leaves, the furniture arrives. */
export async function start() {
  const s = get();
  const ready = s.dealt && s.dealt.seed === s.seed && s.dealt.n === s.lineup.length && s.map && s.view && s.view.steps === 0;
  if (!ready) {
    await deal();
    if (get().error || !get().map) return;
  }
  await transition(() => set({ phase: "playing", crumbs: ["table"], step: null, paused: false, pending: null, offering: false }));
  if (get().reveal) await wait(DEAL_MS);          // let the board finish landing before anyone builds on it
  if (get().phase !== "playing") return;
  if (playing(get())) void pump(); else void watch();
}

/** Back to the setup, keeping the board on screen behind it. The drive loop checks the phase
 *  every turn, so this is also how a game in progress is abandoned. */
export function toLineup() {
  stopWatching();
  transition(() => set({ phase: "lineup", pending: null, offering: false, offerDraft: { give: [0, 0, 0, 0, 0], want: [0, 0, 0, 0, 0] }, discardPick: [], devSheet: null, hurry: false, advice: null, status: "idle", crumbs: ["table"], step: null,
                          boardOverride: null, pendingHandoff: null, paused: false, hover: null, carry: null, robTile: null, mark: null,
                          mutedSeat: null, mutedBy: null, mutedTurn: null }));
}

/** Hotseat's own gate: the seat waiting in `pendingHandoff` has looked away from whoever was
 *  revealed before it and is ready to see its own hand. */
export function confirmHandoff() {
  set((s) => (s.pendingHandoff == null ? {} : { human: s.pendingHandoff, pendingHandoff: null }));
}

// ── a watched game is a playback ──────────────────────────────────────────────────────
// The worker plays the whole game ahead (`run`, streaming frames in batches); the playhead
// walks `frames` at the chosen pace, and `view`/`evals` are whatever frame it is on. So
// pausing, stepping and seeking never touch the engine, and the ending is only announced
// when the playhead gets there.
let runToken = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Puts the playhead on frame `i`. The game is over only once the playhead is on the last
 *  frame of a finished run. */
function show(i: number) {
  const s = get();
  const f = s.frames[i];
  if (!f) return;
  const last = s.frames.length - 1;
  const done = last > 0 && s.frames[last].action === null && f.view.winner >= 0;
  set({ view: f.view, evals: f.evals, evalsOther: f.evalsOther, legal: [], step: null, phase: done ? "over" : "playing", status: "idle" });
}

function stopTimer() { if (timer != null) { clearInterval(timer); timer = null; } }
function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    const s = get();
    if (s.phase !== "playing" || s.paused || playing(s)) { stopTimer(); return; }
    const i = s.view?.steps ?? 0;
    if (s.frames[i + 1]) show(i + 1);            // else the playback is waiting on the worker
  }, PACE[get().pace]);
}

async function watch() {
  const s = get();
  const token = ++runToken;
  set({ paused: false, status: "thinking" });
  startTimer();                                    // the playhead waits on frames, then walks them
  try {
    await live.run(s.seed, s.lineup, (batch) => {
      if (runToken !== token) return;
      // The worker sends public first; turn a batch round if the switch shows hidden.
      const turned = get().showHidden ? batch.map(swap) : batch;
      set((cur) => ({ frames: [...cur.frames.slice(0, batch[0].step), ...turned], status: "idle" }));
    });
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
    return;
  }
  if (runToken !== token) return;
  // The run's last frame is the final position; the playhead may still be well behind it, and
  // then walking or stepping there announces the ending. Only a playhead already on the last
  // frame needs re-showing — re-showing it anywhere else would wipe a review view's `step`.
  const cur = get();
  if (cur.view && cur.frames[cur.view.steps] && !cur.frames[cur.view.steps + 1]) show(cur.view.steps);
}
export function stopWatching() { runToken++; stopTimer(); void live.abort(); }

/** The watched game's transport. Playing means from the playhead on; pausing holds it. */
export function togglePause() {
  const paused = !get().paused;
  set({ paused });
  if (!paused) startTimer();
}
export const stepOnce = () => { const s = get(); if (s.paused && s.view && s.frames[s.view.steps + 1]) show(s.view.steps + 1); };
export function setPace(pace: Pace) { set({ pace }); if (timer != null) startTimer(); }

/** Holds the playback where it is: the stands' seek does this, and so does opening a review view,
 *  whose `step` the playhead would otherwise wipe every tick. */
export function hold() { stopTimer(); set({ paused: true }); }

/** Look at a step of the game. In the stands that is the playhead itself, held; at a seat it
 *  is a look back (`step`) while the live position stays where it is. */
export function seek(step: number) {
  const s = get();
  const last = s.frames.length - 1;
  if (last < 0) return;
  const at = Math.max(0, Math.min(last, step));
  if (!playing(s)) { hold(); show(at); return; }
  set({ step: at >= last ? null : at, hover: null });
}

/** Back to a game left behind the lineup: the lineup leaves, the furniture returns, and the
 *  bots pick up where they were. */
export async function resume() {
  await transition(() => set({ phase: "playing", crumbs: ["table"], step: null, paused: false, pending: null, offering: false }));
  if (playing(get())) void pump(); else startTimer();
}
/** Play one action for whoever is on move. The human's entry point. Returns whether the action
 *  actually landed: one chosen at a position the game has since left is dropped, and the caller
 *  has to be told — the offer builder would otherwise close as if the offer had gone through, and
 *  the discard panel would leave a hand half-discarded with nothing said. */
export async function act(action: Canon): Promise<boolean> {
  const s = get();
  if (!s.view || s.view.winner >= 0) return false;
  if (s.lineup[s.view.current_player].kind !== "human") return false;
  try {
    return await advance(action, s.view);
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
    return false;
  } finally {
    // Always, not only on success: a refused action leaves a bot on move, and `pump` is the one
    // thing that moves it. Returning before this is how a single rejected click used to kill the
    // table — pump's own catch abandons the loop, and `act` then refuses everything.
    void pump();
  }
}

/** A discard chosen whole and played one card per action (the engine's `DISCARD_RESOURCE`): the desktop's
 *  panel and the phone's slots both end here. One refused means the rest were chosen against a hand that no
 *  longer exists: stop rather than discard blind. */
export async function discardAll(counts: number[]): Promise<boolean> {
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < counts[r]; k++) if (!await act(["DISCARD_RESOURCE", r, -1, -1])) return false;
  return true;
}

/** The one place anything is applied — `pump`, `act`, the offer builder, the discard panel and
 *  the board all arrive here. `at` is the position the action was chosen at; the apply carries
 *  its step count so the engine can refuse an action the game has moved past. That check cannot
 *  live here: the store's view is not replaced until the round-trip resolves, so two actions
 *  chosen from one position both pass anything this function could test. */
async function advance(action: Canon, at: View): Promise<boolean> {
  const s = get();
  if (!s.view) return false;
  const seat = s.view.current_player;
  set({ status: "applying", advice: null, pending: null, devSheet: null, hover: null, mark: null, carry: null, robTile: null });
  let res;
  try {
    res = await live.apply(action, at.steps);
  } catch (e) {
    if (isStale(e)) { set({ status: "idle" }); return false; }
    // Which action, from which seat, at which step: apply.rs validates only a few action kinds,
    // so the ones that do throw are the only witnesses to a class of bug the rest suffer silently.
    console.error("apply rejected", action, `seat ${seat}, step ${at.steps}`, e);
    throw e;
  }
  // `offering` clears here rather than above, so a dropped offer leaves the builder open.
  set({ view: res.view, legal: res.legal, last: action, offering: false, offerDraft: { give: [0, 0, 0, 0, 0], want: [0, 0, 0, 0, 0] } });
  const [ev, other] = shown(await live.evaluateAll(viewer(get())));
  // Never drag the app back out of the lineup: leaving a game mid-turn is allowed, and the
  // apply that was already in flight must not undo it.
  set((cur) => {
    // A new deal while this was in flight: deal() empties `frames` first, and these readings were queued ahead
    // of its newGame, so the worker answered them as current (EngineClient stamps the epoch at post, not at
    // call). Closing a frame on an empty list made one with no view, and the header's roundOf crashed on it.
    if (cur.view !== res.view || !cur.frames.length) return {};
    const open = cur.frames[cur.frames.length - 1];
    const closed: Frame = { ...open, seat, action, outcome: res.outcome };
    return { evals: ev, evalsOther: other, status: "idle",
             frames: [...cur.frames.slice(0, -1), closed, frame(res.view, ev, other)],
             phase: cur.phase === "lineup" ? "lineup" : res.view.winner >= 0 ? "over" : "playing" };
  });
  return true;
}

/** The coach's read on your own position. Deliberately outside the drive loop's lock: it is
 *  a depth-2 search over every legal move, and holding the lock across it would swallow the
 *  clicks you make while it runs. */
export async function advise() {
  const s = get();
  if (!s.analysis || s.advice || !s.view || s.view.winner >= 0) return;
  if (s.lineup[s.view.current_player].kind !== "human") return;
  const at = s.view;
  try {
    const d = await live.decide("vnet", 2, true);
    if (get().view === at) set({ advice: d });
  } catch (e) { if (!isStale(e)) console.error(e); }
}

/** Advance every seat that is not a person, and every forced move, until the game needs a
 *  human, is held, or ends. One loop, one lock, one release. `once` plays a single step of a
 *  held game. */
export async function pump(once = false) {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const s = get();
      const v = s.view;
      if (!v || v.winner >= 0 || s.phase !== "playing") return;
      if (s.paused && !once) return;
      const seat = v.current_player;
      const spec = s.lineup[seat];
      // A person's only-legal roll or end of turn still waits for them — playing it for them
      // ended turns before they had seen the card they drew. Every other forced move plays
      // itself, because there is nothing to decide.
      const forced = s.legal.length === 1 && !(spec.kind === "human" && (s.legal[0][0] === "ROLL" || s.legal[0][0] === "END_TURN"));
      // A bot's trade offered to a person they can't take, or from a bot they muted this turn, is
      // answered for them and never reaches the panel, nor in pass and play the phone (phone/pass.ts).
      if (v.prompt === "DECIDE_TRADE" && spec.kind === "human") {
        const give = [5, 6, 7, 8, 9].map((i) => v.current_trade[i]);
        const hand = v.players[seat].hand;
        const from = v.current_trade[10];
        // `num_turns`, not `current_turn` — that is the seat on move, so a mute keyed on it never
        // expired and silently declined that seat's offers for the rest of the game.
        if (autoDecline({ responder: seat, offerer: from, offererIsPerson: s.lineup[from]?.kind === "human",
                          cannotAfford: give.some((n, i) => hand[i] < n), turn: v.num_turns,
                          mute: s.mutedSeat != null && s.mutedBy != null && s.mutedTurn != null ? { seat: s.mutedSeat, by: s.mutedBy, turn: s.mutedTurn } : null })) {
          if (!await advance(["REJECT_TRADE", -1, -1, -1], v)) return;
          continue;
        }
      }
      if (spec.kind === "human" && !forced) {
        // Hotseat: a different human seat is on move than whoever is currently revealed.
        // Hold there — `human` (and the hand/coach it drives) does not move until that
        // seat's own player taps through `confirmHandoff()`.
        if (seat !== s.human) set({ pendingHandoff: seat });
        if (get().hurry) set({ hurry: false });
        return;
      }
      set({ status: "thinking" });
      const d = forced ? null : await live.decide(spec.kind, spec.depth);
      await wait(beat(forced));
      if (get().view !== v) return;                 // a new game landed while we thought
      if (!await advance(d ? d.action : s.legal[0], v)) return;   // and the engine's own last word
      if (once) return;
    }
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
  } finally {
    pumping = false;
    void advise();                                   // only ever after the lock is released
  }
}

// Vite's Fast Refresh re-evaluates this module on every edit, and nothing here used to be torn
// down: a second EngineClient, a second worker, a second engine and a second `pumping` flag would
// end up driving one store, with the old loop still mid-`wait` and about to apply its decision to
// an engine nobody else can see. Dev-only — a build has no HMR, which is why none of it shows up
// under `pnpm preview` or headlessly.
if (import.meta.hot) import.meta.hot.dispose(() => { stopWatching(); live.terminate(); });
