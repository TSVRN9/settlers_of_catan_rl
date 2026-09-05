// One global key handler, so no view grows its own.
//
// Space is the only real collision in the map: it means "show me every legal move" while
// you are playing and "play or pause" while you are reviewing. Those two never share a
// screen — the spine says which you are in — so the key follows the view rather than being
// renamed. It is guarded against a focused button, or it double-fires against the board's
// own keyable targets.
import { pop } from "./route";
import { toggleAutoplay } from "./review";
import { currentView, get, set } from "./store";

const REVIEW = new Set(["game", "move"]);
const typing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a as HTMLElement)?.isContentEditable;
};
const onControl = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === "BUTTON" || a.getAttribute("role") === "button");
};

/** Returns its own uninstall — see route.install for why. */
export function install() {
  const onDown = (e: KeyboardEvent) => {
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = get();
    // A handoff is a tap, never a key — Esc or Space reaching through it would let one
    // player's keyboard act on the seat now waiting behind the curtain.
    if (s.pendingHandoff != null) return;
    const review = REVIEW.has(currentView(s));

    if (e.key === "Escape") { e.preventDefault(); pop(); return; }
    if (e.key === " " && !onControl()) {
      e.preventDefault();
      if (review) { toggleAutoplay(); return; }
      if (!s.revealAll) set({ revealAll: true });
      return;
    }
    if (e.key === "ArrowLeft" && review && s.step != null) { e.preventDefault(); set({ step: Math.max(0, s.step - 1) }); return; }
    if (e.key === "ArrowRight" && review && s.step != null) { e.preventDefault(); set({ step: s.step + 1 }); return; }
    // reading, not reassigning: this is which seat you are looking at
    if (/^[1-4]$/.test(e.key)) { const n = Number(e.key) - 1; set({ focusSeat: s.focusSeat === n ? null : n }); return; }
  };

  const onUp = (e: KeyboardEvent) => {
    if (e.key === " " && get().revealAll) set({ revealAll: false });
  };

  addEventListener("keydown", onDown);
  addEventListener("keyup", onUp);
  return () => { removeEventListener("keydown", onDown); removeEventListener("keyup", onUp); };
}
