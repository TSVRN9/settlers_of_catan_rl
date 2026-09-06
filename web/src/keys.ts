// One global key handler, so no view grows its own.
//
// Space follows the view: "show me every legal move" while you are playing, play/pause while
// you are reviewing or watching. Those never share a screen — the spine says which you are
// in — so the key follows the view rather than being renamed. It is guarded against a
// focused button, or it double-fires against the board's own keyable targets.
import { seek, stepOnce, togglePause } from "./game";
import { pop } from "./route";
import { toggleAutoplay } from "./review";
import { currentView, get, playing, set } from "./store";

const REVIEW = new Set(["game", "move"]);
const typing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || (a as HTMLElement)?.isContentEditable;
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
    const stands = s.phase !== "lineup" && !playing(s);

    // Esc first lets go of a staged move, then goes back a page.
    if (e.key === "Escape") { e.preventDefault(); if (s.staged) set({ staged: null }); else pop(); return; }
    if (e.key === " " && !onControl()) {
      e.preventDefault();
      if (review) { toggleAutoplay(); return; }
      if (stands) { togglePause(); return; }
      if (!s.revealAll) set({ revealAll: true });
      return;
    }
    if (e.key === "ArrowLeft" && review && s.step != null) { e.preventDefault(); set({ step: Math.max(0, s.step - 1) }); return; }
    if (e.key === "ArrowRight" && review && s.step != null) { e.preventDefault(); set({ step: s.step + 1 }); return; }
    // In the stands the arrows are the seek: ← holds the game and looks back a step, → looks
    // forward until live, then plays one step of the held game.
    if (e.key === "ArrowLeft" && stands && s.view) { e.preventDefault(); seek(s.view.steps - 1); return; }
    if (e.key === "ArrowRight" && stands) { e.preventDefault(); stepOnce(); return; }
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
