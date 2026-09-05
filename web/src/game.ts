// The drive loop, outside React.
//
// The old version was a useEffect carrying a generation counter and an `inflight` ref, with
// two bail paths that returned without clearing the ref — so a new game landing between
// `apply` and `evaluateAll` deadlocked the loop until the next `start()`. Here the loop is
// one `async while` with a `try/finally` that always releases, and staleness is the engine
// client's epoch rather than a counter kept in a component.
import { EngineClient, isStale, type Canon } from "./engine";
import { outcomeText } from "./labels";
import { resetReview } from "./review";
import { get, set } from "./store";

/** The live game's engine. Review holds its own client, because the worker frees its wasm
 *  engine on every `new` — one shared client is how Play and Watch used to destroy each
 *  other. */
export const live = new EngineClient();

let pumping = false;

/** How long a bot's move is held on screen so it can be watched. One constant, read from
 *  the stylesheet, rather than two magic numbers inline. */
const beat = (forced: boolean) => {
  if (forced) return 120;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--t-bot"));
  return Number.isFinite(v) ? v : 350;     // 0 is a legitimate answer, so not `|| 350`
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long the board is left dealing itself before play starts. The reveal runs tiles,
 *  then glyphs, then numbers, then ports at 1s; this is the tail of that. */
const DEAL_MS = 1400;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function start(seed?: number) {
  const s = get();
  const use = seed ?? s.seed;
  resetReview();
  set({ seed: use, status: "thinking", error: null, log: [], last: null, advice: null,
        step: null, pending: null, crumbs: ["table"], boardOverride: null, pendingHandoff: null });
  try {
    const g = await live.newGame(use, 4);
    // A game has an address, so it can be linked and a reload keeps the board. The play
    // itself does not survive that reload — a seed reproduces the map, not the game.
    history.replaceState({ crumbs: ["table"], step: null }, "", `#/g/${use}`);
    // The reveal only happens now: `dealing` has to be set in the same breath as the map,
    // or the board it animates does not exist yet to carry the class.
    set({ map: g.map, view: g.view, legal: g.legal, phase: reduced() ? "playing" : "dealing", status: "idle" });
    const ev = await live.evaluateAll();
    set({ evals: ev });
    if (!reduced()) {
      await wait(DEAL_MS);
      if (get().map !== g.map) return;              // re-dealt while the board was landing
      set({ phase: "playing" });
    }
    void pump();
  } catch (e) {
    if (!isStale(e)) set({ status: "idle", error: String(e) });
  }
}

/** Back to the setup, keeping the board on screen behind it. The drive loop checks the phase
 *  every turn, so this is also how a game in progress is abandoned. */
export function toLineup() {
  set({ phase: "lineup", pending: null, advice: null, status: "idle" });
}

/** Hotseat's own gate: the seat waiting in `pendingHandoff` has looked away from whoever was
 *  revealed before it and is ready to see its own hand. */
export function confirmHandoff() {
  set((s) => (s.pendingHandoff == null ? {} : { human: s.pendingHandoff, pendingHandoff: null }));
}

/** Play one action for whoever is on move. The human's entry point. */
export async function act(action: Canon) {
  const s = get();
  if (!s.view || s.view.winner >= 0) return;
  if (s.lineup[s.view.current_player].kind !== "human") return;
  try {
    await advance(action);
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
    return;
  }
  void pump();
}

async function advance(action: Canon) {
  const s = get();
  if (!s.view) return;
  const seat = s.view.current_player;
  const step = s.view.steps;
  set({ status: "applying", advice: null, pending: null });
  const res = await live.apply(action);
  set((cur) => ({
    view: res.view,
    legal: res.legal,
    last: action,
    log: [...cur.log, { step, seat, action, note: outcomeText(action, res.outcome) }],
  }));
  const ev = await live.evaluateAll();
  // Never drag the app back out of the lineup: leaving a game mid-turn is allowed, and the
  // apply that was already in flight must not undo it.
  set((cur) => ({ evals: ev, status: "idle",
                  phase: cur.phase === "lineup" ? "lineup" : res.view.winner >= 0 ? "over" : "playing" }));
}

/** The coach's read on your own position. Deliberately outside the drive loop's lock: it is
 *  a depth-2 search over every legal move, and holding the lock across it would swallow the
 *  clicks you make while it runs. */
export async function advise() {
  const s = get();
  if (!s.coach || s.advice || !s.view || s.view.winner >= 0) return;
  if (s.lineup[s.view.current_player].kind !== "human") return;
  const at = s.view;
  try {
    const d = await live.decide("vnet", 2);
    if (get().view === at) set({ advice: d });
  } catch (e) { if (!isStale(e)) console.error(e); }
}

/** Advance every seat that is not a person, and every forced move, until the game needs a
 *  human or ends. One loop, one lock, one release. */
export async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const s = get();
      const v = s.view;
      if (!v || v.winner >= 0 || s.phase === "lineup") return;
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
      await advance(d ? d.action : s.legal[0]);
    }
  } catch (e) {
    if (!isStale(e)) { console.error(e); set({ status: "idle", error: String(e) }); }
  } finally {
    pumping = false;
    void advise();                                   // only ever after the lock is released
  }
}
