// Hotseat's gate: whichever seat is now on move stays covered — board and hand alike — until
// its own player taps through. `App.tsx` renders this on top of a blurred stage, for any view.
import { confirmHandoff } from "../game";
import { SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { useApp } from "../store";

export default function Handoff() {
  const s = useApp();
  if (s.pendingHandoff == null || !s.view) return null;
  const seat = s.pendingHandoff;

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(238,240,233,.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="cut" style={{ width: 480, background: "var(--color-paper)", padding: "22px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span style={{ width: 17, height: 17, background: SEAT_FILL[seat] }} />
          <span className="d" style={{ fontSize: 23 }}>{SEAT_NAMES[seat]}, it is your turn</span>
        </div>
        <div className="cap" style={{ marginTop: 9, fontSize: 13.5 }}>
          The board and both hands are covered until you say you are ready. Nobody sees cards
          that are not theirs.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 17 }}>
          <button className="act go cut8" onClick={confirmHandoff}>
            I am {SEAT_NAMES[seat]} — show the board
          </button>
          <span className="num cap" style={{ marginLeft: "auto", fontSize: 12 }}>turn {s.view.num_turns}</span>
        </div>
      </div>
    </div>
  );
}
