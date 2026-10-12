// The other seats, across the top like players across a table: clockwise from your left. Each is its colour,
// name and points, the cards and development cards it holds (counts are public), and with Eval on its win
// chance as a figure and a bar. The seat on move lifts; while it is someone else's, the rest step back.
import { SEAT_FILL } from "../board/palette";
import { SEAT_NAMES, turnSeat } from "../labels";
import { pct } from "./usePhone";
import { useApp } from "../store";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function Chips() {
  const s = useApp();
  const v = s.view!;
  const n = v.players.length;
  const seats = Array.from({ length: n - 1 }, (_, k) => (s.human + 1 + k) % n);
  const onMove = turnSeat(v);
  const prev = s.frames[s.frames.length - 2]?.view;
  return (
    <div className="ph-chips">
      {seats.map((i) => {
        const p = v.players[i];
        const cards = sum(p.hand), devs = sum(p.devs);
        // A count that went up on this step turns green for a beat (no "+3": it would crowd the win figure).
        const gained = !!prev && cards > sum(prev.players[i].hand);
        const win = s.evals[i]?.win;
        const cls = onMove === i ? " on" : onMove !== s.human ? " off" : "";
        return (
          <div key={i} data-seat={i} className={`ph-chip cut8${cls}`}>
            <div className="ph-chip-row">
              <i className="sw" style={{ background: SEAT_FILL[i] }} />
              <span className="nm">{SEAT_NAMES[i]}</span>
              <span className="d num vp">{p.vp}</span>
            </div>
            <div className="ph-chip-row small">
              <span className="ct"><svg viewBox="0 0 14 16" width="10" height="12" aria-hidden="true"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55" /></svg>
                <span key={s.frames.length} className={`num${gained ? " gainflash" : ""}`}>{cards}</span></span>
              <span className="ct"><svg viewBox="0 0 32 32" width="12" height="12" aria-hidden="true"><rect x="7" y="4" width="18" height="24" rx="2" fill="currentColor" /></svg>
                <span className="num">{devs}</span></span>
              {s.evalShown && <span className="num pct">{pct(win)}</span>}
            </div>
            {s.evalShown ? <div className="bar"><i style={{ width: `${(win ?? 0) * 100}%`, background: SEAT_FILL[i] }} /></div> : <div className="bar none" />}
          </div>
        );
      })}
    </div>
  );
}
