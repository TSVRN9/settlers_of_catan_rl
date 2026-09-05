// The hash, and the crumb stack behind it.
//
// The stack is the truth and the hash is a projection of it, not the other way round:
// Console and Coach have no route of their own (they are live-game views, and a live game
// does not survive a reload), so a path derived purely from the URL could not reproduce
// `Table > Console`. Esc goes through history.back(), so Esc and the browser's back button
// are one gesture rather than two that disagree.
import { currentView, get, set, type ViewName } from "./store";

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
  set({ crumbs, step });
  // The stack rides in history.state, not just in the URL. Console and Coach project onto
  // their game's own address, so two different paths can share a hash; without this, going
  // back from Coach would land on Table instead of Console.
  history.pushState({ crumbs, step }, "", format(s.seed, view, step));
}

/** Go to a crumb already on the path, dropping everything after it.
 *
 *  One `history.go(-n)`, never a loop of `back()`. `back()` is asynchronous: the store only
 *  changes on the `popstate` that lands after the current task, so anything that loops while
 *  reading the store's crumb count spins forever. That is what froze the tab from every view
 *  but the Table. */
export function to(index: number) {
  const n = get().crumbs.length - 1 - index;
  if (n > 0) history.go(-n);
}

export const pop = () => to(get().crumbs.length - 2);

/** All the way back to the table — what the spine's waiting pill does. */
export const toRoot = () => to(0);

/** History moved. Prefer the stack we stored on the entry; fall back to the hash, which is
 *  what a cold load or a pasted link gives us. */
export function sync(e?: PopStateEvent) {
  const st = e?.state as { crumbs?: ViewName[]; step?: number | null } | null | undefined;
  if (st?.crumbs?.length) { set({ crumbs: st.crumbs, step: st.step ?? null }); return; }
  const p = parse();
  if (!p) { set({ crumbs: ["table"], step: null }); return; }
  set({ crumbs: stackFor(p.view), step: p.step, seed: p.seed });
}

/** Returns its own uninstall, because StrictMode invokes the mounting effect twice and two
 *  sets of listeners make Escape pop two crumbs and the seat keys toggle on and off again. */
export function install() {
  const onPop = (e: PopStateEvent) => sync(e);
  const onHash = () => sync();
  addEventListener("popstate", onPop);
  addEventListener("hashchange", onHash);
  return () => { removeEventListener("popstate", onPop); removeEventListener("hashchange", onHash); };
}
