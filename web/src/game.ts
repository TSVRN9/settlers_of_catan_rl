// The drive loop, outside React.
//
// The old version was a useEffect carrying a generation counter and an `inflight` ref, with
// two bail paths that returned without clearing the ref — so a new game landing between
// `apply` and `evaluateAll` deadlocked the loop until the next `start()`. Here the loop is
// one `async while` with a `try/finally` that always releases, and staleness is the engine
// client's epoch rather than a counter kept in a component.
import { EngineClient, isStale, type Canon, type Evaluation, type Frame, type View } from "./engine";
import { resetReview } from "./review";
import { get, playing, set, transition, type Pace } from "./store";

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
 *  read a move. Seated, a bot's move is held long enough to follow instead.
 *  ponytail: one knob; raise it if the table still feels rushed. */
const SEATED_MS = 900;
const beat = (forced: boolean) => {
  const ms = playing(get()) ? SEATED_MS : get().pace === "fast" ? 0 : PACE[get().pace];
  return forced ? Math.min(120, ms) : ms;
};

/** A live position as a frame: the last of `store.frames` until an action closes it. */
const frame = (view: View, evals: Evaluation[]): Frame =>
  ({ step: view.steps, view, seat: view.current_player, action: null, outcome: null, decision: null, evals, attribution: null });

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
  set({ status: "thinking", error: null, last: null, advice: null, step: null, crumbs: ["table"], pending: null, offering: false, staged: null, hover: null, mark: null,
        boardOverride: null, pendingHandoff: null, coachThread: null, dealt: null, evals: [], frames: [] });
  try {
    const g = await live.newGame(seed, n);
    // A game has an address, so it can be linked and a reload keeps the board. The play
    // itself does not survive that reload — a seed reproduces the map, not the game.
    history.replaceState({ crumbs: ["table"], step: null }, "", `#/g/${seed}`);
    // The reveal only happens now: `reveal` has to be set in the same breath as the map,
    // or the board it animates does not exist yet to carry the class.
    set({ map: g.map, view: g.view, legal: g.legal, dealt: { seed, n }, reveal: !reduced(), status: "idle", frames: [frame(g.view, [])] });
    const ev = await live.evaluateAll();
    set((cur) => ({ evals: ev, frames: cur.frames.length ? [{ ...cur.frames[0], evals: ev }] : [frame(g.view, ev)] }));
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
  transition(() => set({ phase: "lineup", pending: null, offering: false, advice: null, status: "idle", crumbs: ["table"], step: null,
                          boardOverride: null, pendingHandoff: null, paused: false, staged: null, hover: null, mark: null }));
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
  set({ view: f.view, evals: f.evals, legal: [], step: null, phase: done ? "over" : "playing", status: "idle" });
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
      set((cur) => ({ frames: [...cur.frames.slice(0, batch[0].step), ...batch], status: "idle" }));
    });
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
    return;
  }
  if (runToken !== token) return;
  // The run's last frame is the final position; the playhead may still be well behind it.
  const cur = get();
  if (cur.view && cur.frames[cur.view.steps]) show(cur.view.steps);
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

/** Look at a step of the game. In the stands that is the playhead itself, held; at a seat it
 *  is a look back (`step`) while the live position stays where it is. */
export function seek(step: number) {
  const s = get();
  const last = s.frames.length - 1;
  if (last < 0) return;
  const at = Math.max(0, Math.min(last, step));
  if (!playing(s)) { stopTimer(); set({ paused: true }); show(at); return; }
  set({ step: at >= last ? null : at, staged: null, hover: null });
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

/** The one place anything is applied — `pump`, `act`, the offer builder, the discard panel and
 *  the board all arrive here. `at` is the position the action was chosen at; the apply carries
 *  its step count so the engine can refuse an action the game has moved past. That check cannot
 *  live here: the store's view is not replaced until the round-trip resolves, so two actions
 *  chosen from one position both pass anything this function could test. */
async function advance(action: Canon, at: View): Promise<boolean> {
  const s = get();
  if (!s.view) return false;
  const seat = s.view.current_player;
  set({ status: "applying", advice: null, pending: null, staged: null, hover: null, mark: null });
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
  set({ view: res.view, legal: res.legal, last: action, offering: false });
  const ev = await live.evaluateAll();
  // Never drag the app back out of the lineup: leaving a game mid-turn is allowed, and the
  // apply that was already in flight must not undo it.
  set((cur) => {
    const open = cur.frames[cur.frames.length - 1];
    const closed: Frame = { ...open, seat, action, outcome: res.outcome };
    return { evals: ev, status: "idle",
             frames: [...cur.frames.slice(0, -1), closed, frame(res.view, ev)],
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
    const d = await live.decide("vnet", 2);
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
      const forced = s.legal.length === 1;
      if (spec.kind === "human" && !forced) {
        // Hotseat: a different human seat is on move than whoever is currently revealed.
        // Hold there — `human` (and the hand/coach it drives) does not move until that
        // seat's own player taps through `confirmHandoff()`.
        if (seat !== s.human) set({ pendingHandoff: seat });
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
