// The top bar: the way back, what this moment is, the last roll, and the Eval control. Eval opens a small
// popover with its two switches: the readings on screen at all, and whether they may use hidden cards.
import { useEffect, useRef, useState } from "react";
import { setShowHidden, toLineup } from "../game";
import { roundOf } from "../labels";
import { hiddenLocked, setEvalShown, useApp } from "../store";
import { Thrown } from "../views/Tray";

export default function TopBar() {
  const s = useApp();
  const v = s.view!;
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  // A tap anywhere else closes it. (Not Esc: keys.ts owns Esc, and a phone rarely has one.)
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);
  const title = v.initial_phase ? "Opening" : roundOf(s.frames, v);
  return (
    <div className="ph-top">
      <button className="ph-back" onClick={toLineup} aria-label="Back to the lineup">‹</button>
      <span className="d ph-title">{title}</span>
      <span className="ph-roll"><Thrown frames={s.frames} at={s.frames.length - 1} live={s.step == null} /></span>
      <div ref={pop} className="ph-evalwrap">
        <button className={`ph-eval${s.evalShown ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          Eval<i />
        </button>
        {open && (
          <div className="ph-pop cut8 arrive" role="group" aria-label="Readings">
            <label><input type="checkbox" role="switch" checked={s.evalShown} onChange={(e) => setEvalShown(e.target.checked)} />Eval</label>
            {!hiddenLocked(s) && (
              <label><input type="checkbox" role="switch" checked={s.showHidden} onChange={(e) => setShowHidden(e.target.checked)} />Hidden information</label>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
