// Whether the window is phone-sized: below the width the desktop table was designed down to.
import { useSyncExternalStore } from "react";
import type { Frame, View } from "../engine";

/** A win chance as a whole percentage: a chip has no room for "100.0%". */
export const pct = (w: number | null | undefined) => (w == null ? "–" : `${Math.round(w * 100)}%`);

// One subscribe per query, made once: a subscribe function built inside the hook is a new function every
// render, and useSyncExternalStore re-attaches the listener whenever it changes.
const query = (q: string) => {
  const subscribe = (cb: () => void) => { const m = matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
  const snap = () => matchMedia(q).matches;
  return () => useSyncExternalStore(subscribe, snap);
};
export const usePhone = query("(max-width: 999px)");
/** The same question outside React: grades and the review are the phone's alone (the desktop shows neither). */
export const isPhone = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 999px)").matches;

/** The frames up to the position on screen. Seated they are all of them; watching, the worker has played ahead of
 *  the playhead, and the moves after it must not show; and a pass-and-play replay (`step`) is a playhead too. */
export const seen = (s: { frames: Frame[]; view: View | null; step: number | null }) => (s.view ? s.frames.slice(0, (s.step ?? s.view.steps) + 1) : s.frames);
const useShort = query("(max-height: 699px)"), useSlim = query("(max-width: 374px)");
export interface Metrics { cw: number; ch: number; tileH: number; btnH: number }
/** Card, build-card and button sizes, stepped down on small phones (spec "Layout"; small.mjs). The same
 *  numbers are phone.css's --cw/--ch/--tile-h/--btn-h; components that size a Card need them as numbers. */
export function useMetrics(): Metrics {
  const short = useShort(), slim = useSlim();
  return short ? { cw: 44, ch: 60, tileH: 70, btnH: 46 } : slim ? { cw: 46, ch: 63, tileH: 80, btnH: 50 } : { cw: 50, ch: 68, tileH: 84, btnH: 50 };
}
