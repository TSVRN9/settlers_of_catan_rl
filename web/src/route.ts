// The hash, and the crumb stack behind it.
//
// The stack is the truth and the hash is a projection of it, not the other way round:
// Console and Coach have no route of their own (they are live-game views, and a live game
// does not survive a reload), so a path derived purely from the URL could not reproduce
// `Table > Console`. Every navigation — Esc and a crumb included — sets the stack and pushes
// an entry carrying it; the browser's back button re-seeds the stack from the entry it lands
// on. (Navigating *by* `history.go(-n)` trusted the browser's depth to mirror the stack, which
// a deep link on a cold load or a step scrubbed inside a review breaks.)
//
// Every change of view goes through `transition()`, so the board travels and the panels
// arrive rather than the screen being redrawn.
import { currentView, get, set, subscribe, transition, type ViewName } from "./store";

const RE = /^#\/g\/(\d+)(?:\/(futures)|\/step\/(\d+)(\/move)?)?$/;

export interface Parsed { seed: number; view: ViewName; step: number | null }

export function parse(hash = location.hash): Parsed | null {
  const m = RE.exec(hash);
  if (!m) return null;
  const seed = Number(m[1]);
  if (m[2]) return { seed, view: "futures", step: null };
  if (m[3] !== undefined) return { seed, view: m[4] ? "move" : "game", step: Number(m[3]) };
  return { seed, view: "table", step: null };
}

/** Views the hash can name. Console and Coach project to their game's own address. */
function format(seed: number, view: ViewName, step: number | null) {
  const base = `#/g/${seed}`;
  if (view === "futures") return `${base}/futures`;
  if (view === "game" && step != null) return `${base}/step/${step}`;
  if (view === "move" && step != null) return `${base}/step/${step}/move`;
  return base;
}

const stackFor = (view: ViewName): ViewName[] =>
  view === "table" ? ["table"]
  : view === "move" ? ["table", "game", "move"]
  : ["table", view];

export function push(view: ViewName, step: number | null = get().step) {
  const s = get();
  if (currentView(s) === view) return;
  const crumbs = [...s.crumbs, view];
  transition(() => set({ crumbs, step }));
  // The stack rides in history.state, not just in the URL. Console and Coach project onto
  // their game's own address, so two different paths can share a hash; without this, going
  // back from Coach would land on Table instead of Console.
  history.pushState({ crumbs, step }, "", format(s.seed, view, step));
}

const REVIEW = new Set<ViewName>(["game", "move"]);

/** Go to a crumb already on the path, dropping everything after it. The step travels with
 *  you into a review view (the "Step 118" crumb lands on step 118) and is dropped otherwise. */
export function to(index: number) {
  const s = get();
  if (index < 0 || index >= s.crumbs.length - 1) return;
  const crumbs = s.crumbs.slice(0, index + 1);
  const view = crumbs[crumbs.length - 1];
  const step = REVIEW.has(view) ? s.step : null;
  transition(() => set({ crumbs, step }));
  history.pushState({ crumbs, step }, "", format(s.seed, view, step));
}

export const pop = () => to(get().crumbs.length - 2);

/** All the way back to the table — what the spine's waiting pill does. */
export const toRoot = () => to(0);

/** History moved. Prefer the stack we stored on the entry; fall back to the hash, which is
 *  what a cold load or a pasted link gives us. */
export function sync(e?: PopStateEvent) {
  const st = e?.state as { crumbs?: ViewName[]; step?: number | null } | null | undefined;
  const patch = st?.crumbs?.length
    ? { crumbs: st.crumbs, step: st.step ?? null }
    : (() => {
        const p = parse();
        return p ? { crumbs: stackFor(p.view), step: p.step, seed: p.seed } : { crumbs: ["table"] as ViewName[], step: null };
      })();
  const changed = currentView(get()) !== patch.crumbs[patch.crumbs.length - 1];
  if (changed) transition(() => set(patch)); else set(patch);
}

/** Returns its own uninstall, because StrictMode invokes the mounting effect twice and two
 *  sets of listeners make Escape pop two crumbs and the seat keys toggle on and off again. */
export function install() {
  const onPop = (e: PopStateEvent) => sync(e);
  const onHash = () => sync();
  addEventListener("popstate", onPop);
  addEventListener("hashchange", onHash);
  // The entry follows the step: scrubbing inside a review view rewrites the current entry, so
  // reload, back and the address bar all name the step on screen.
  let lastStep = get().step;
  const offStore = subscribe(() => {
    const s = get();
    if (s.step === lastStep) return;
    lastStep = s.step;
    const view = currentView(s);
    if (REVIEW.has(view) && s.step != null) history.replaceState({ crumbs: s.crumbs, step: s.step }, "", format(s.seed, view, s.step));
  });
  return () => { removeEventListener("popstate", onPop); removeEventListener("hashchange", onHash); offStore(); };
}
