// The lineup on a phone (spec "Lineup"; more.mjs H1/H2): the board above, one row per seat, each a tap from a
// sheet of everyone who can sit there with its measured strength, then Eval, New board and Play. With nobody
// seated Play is Watch; a game left behind can be gone back to.
import { useState } from "react";
import { resume, start } from "../game";
import { BOT_INFO, BOT_SHORT, SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { set, setEvalShown, setHaptics, setSound, useApp } from "../store";
import { KINDS, sub } from "../views/Picker";
import { addSeat, behind, removeSeat, setSeat, useDealt } from "../views/Lineup";

/** A bot's win rate against three stock jSettlers, whole percent, from its card's measured line. */
const rate = (k: keyof typeof BOT_INFO) => { const m = BOT_INFO[k].measured; return m ? `${Math.round(parseFloat(m))}%` : ""; };

export default function PhoneLineup() {
  const s = useApp();
  useDealt();
  const [open, setOpen] = useState<number | null>(null);
  const n = s.lineup.length;
  const people = s.lineup.filter((b) => b.kind === "human").length;
  const back = behind(s);
  const name = (k: string) => (k === "human" ? (people > 1 ? "Person" : "You") : BOT_SHORT[k]);
  const close = () => setOpen(null);
  return (
    <div className="ph-lineup">
      {s.linkBroken && <div className="ph-err" role="alert">That link isn't a game.</div>}
      {s.lineup.map((b, i) => (
        <button key={i} data-seat={i} className="ph-seatrow cut8" onClick={() => setOpen(i)} aria-label={`${SEAT_NAMES[i]}: ${name(b.kind)}`}>
          <i style={{ background: SEAT_FILL[i] }} />
          <span className="who"><b>{name(b.kind)}</b><small>{sub(b)}</small></span>
          <span className="chev" aria-hidden="true">›</span>
        </button>
      ))}
      {n < 4 && (
        <button className="ph-seatrow add cut8" onClick={addSeat}>
          <i style={{ background: SEAT_FILL[n] }} /><span className="who"><b>Add a seat</b></span><span className="chev" aria-hidden="true">+</span>
        </button>
      )}
      {back && <button className="ph-btn go ph-resume cut8" onClick={() => void resume()}>Back to the game</button>}
      <div className="ph-row ph-switches">
        <label className="ph-switch"><input type="checkbox" role="switch" checked={s.evalShown} onChange={(e) => setEvalShown(e.target.checked)} />Eval</label>
        <label className="ph-switch"><input type="checkbox" role="switch" checked={s.sound} onChange={(e) => setSound(e.target.checked)} />Sound</label>
        {/* iOS has no vibration at all: no switch for what can't happen. */}
        {typeof navigator !== "undefined" && "vibrate" in navigator && (
          <label className="ph-switch"><input type="checkbox" role="switch" checked={s.haptics} onChange={(e) => setHaptics(e.target.checked)} />Haptics</label>
        )}
      </div>
      <div className="ph-row">
        <button className="ph-btn cut8" onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}>New board</button>
        <button className={`ph-btn ph-play cut8${back ? "" : " go"}`} disabled={s.status === "thinking" && !s.map} onClick={() => void start()}>
          {back ? "New game" : people ? "Play" : "Watch"}
        </button>
      </div>
      {open != null && (
        <div className="ph-scrim" onClick={close}>
          <div className="ph-sheet cut" role="dialog" aria-label={`${SEAT_NAMES[open]}'s seat`} onClick={(e) => e.stopPropagation()}>
            <div className="hd">
              <i style={{ background: SEAT_FILL[open] }} /><span className="d">{SEAT_NAMES[open]}</span>
              <span className="unit">wins vs 3 jSettlers</span>
            </div>
            {KINDS.map((k) => {
              const on = s.lineup[open]?.kind === k;
              return (
                <button key={k} data-kind={k} className={`ph-pickrow cut5${on ? " on" : ""}`} autoFocus={on} aria-pressed={on}
                        onClick={() => { setSeat(open, k); close(); }}>
                  <span className="who"><b>{k === "human" ? "Person" : BOT_SHORT[k]}</b>{k !== "human" && <small>{sub({ kind: k, depth: s.lineup[open].depth })}</small>}</span>
                  <span className="num">{rate(k)}</span>
                </button>
              );
            })}
            {n > 2 && <button className="ph-pickrow out cut5" onClick={() => { removeSeat(open); close(); }}>Take {SEAT_NAMES[open]} out</button>}
          </div>
        </div>
      )}
    </div>
  );
}
