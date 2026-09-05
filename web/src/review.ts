// Review, on the second worker. `live`'s record is replayed once, lazily, the first time
// either analysis view is opened — never touching the live engine, and never re-replayed for
// the same game (`store.review` is the cache; `resetReview()` clears it when a new game
// starts). Move/Game analysis's own per-step reads (the ranked ladder, attribution) reuse the
// same client, repositioning it with `replay` only when the viewed step actually changes.
import { EngineClient, isStale } from "./engine";
import type { Attribution, BotKind, Decision, Frame } from "./engine";
import { live } from "./game";
import { push } from "./route";
import { get, set } from "./store";

export const review = new EngineClient();

let recordCache: string | null = null;
let positioned: number | null = null;
const rankedCache = new Map<string, Decision>();
const attrCache = new Map<number, Attribution[]>();
let inflight: Promise<void> | null = null;

async function ensureRecord() {
  if (recordCache == null) recordCache = await live.record();
  return recordCache;
}

/** Idempotent per game: the second and later calls resolve immediately against the cached
 *  `store.review`. */
export function ensureReview(): Promise<void> {
  if (get().review) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const record = await ensureRecord();
      const { map, frames } = await review.analyze(record);
      set({ review: { map, frames } });
    } catch (e) {
      if (!isStale(e)) console.error(e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function positionAt(step: number) {
  if (positioned === step) return;
  await review.replay(await ensureRecord(), step);
  positioned = step;
}

/** The ranked ladder at one step, from one bot's own search — fetched once per (step, bot)
 *  and cached, so scrubbing back to a step already looked at costs nothing. */
export async function rankedAt(step: number, bot: BotKind = "vnet"): Promise<Decision> {
  const key = `${step}:${bot}`;
  const cached = rankedCache.get(key);
  if (cached) return cached;
  await positionAt(step);
  const d = await review.decide(bot, 2);
  rankedCache.set(key, d);
  return d;
}

/** Attribution at one step, for one seat — the "what the net is leaning on" panel's own
 *  lazy read, never precomputed for the whole game. */
export async function attributionAt(step: number, seat: number): Promise<Attribution[]> {
  const key = step * 10 + seat;
  const cached = attrCache.get(key);
  if (cached) return cached;
  await positionAt(step);
  const a = await review.attribution(seat);
  attrCache.set(key, a);
  return a;
}

/** The biggest single-step swings in one seat's own win% — pure arithmetic over an
 *  already-loaded curve, no engine calls. Shared by Game analysis and the ending screen. */
export function topSwings(frames: Frame[], seat: number, n: number) {
  return frames.slice(1).map((f, i) => ({
    step: i + 1,
    delta: f.evals[seat].win - frames[i].evals[seat].win,
    action: frames[i].action,
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, n);
}

export function openGameAnalysis() {
  const v = get().view;
  if (!v) return;
  void ensureReview().then(() => push("game", v.steps));
}

export function openMoveAnalysis(step?: number) {
  const v = get().view;
  if (!v && step == null) return;
  const at = step ?? v!.steps;
  void ensureReview().then(() => push("move", at));
}

const AUTOPLAY_MS = 450;
let timer: ReturnType<typeof setInterval> | null = null;

export function stopAutoplay() {
  if (timer != null) { clearInterval(timer); timer = null; }
  if (get().reviewPlaying) set({ reviewPlaying: false });
}

export function toggleAutoplay() {
  if (timer != null) { stopAutoplay(); return; }
  set({ reviewPlaying: true });
  timer = setInterval(() => {
    const s = get();
    const last = s.review?.frames.length ? s.review.frames.length - 1 : 0;
    if (s.step == null || s.step >= last) { stopAutoplay(); return; }
    set({ step: s.step + 1 });
  }, AUTOPLAY_MS);
}

/** A new game invalidates any review of the old one — called from `game.ts`'s `start()`. */
export function resetReview() {
  stopAutoplay();
  recordCache = null;
  positioned = null;
  rankedCache.clear();
  attrCache.clear();
  set({ review: null });
}
