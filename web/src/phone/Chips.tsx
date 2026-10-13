// The other seats, across the top like players across a table: clockwise from your left. Each is its colour,
// name and points, the cards and development cards it holds (counts are public), and with Eval on its win
// chance as a figure and a bar. The seat on move lifts; while it is someone else's, the rest step back.
import { SEAT_FILL } from "../board/palette";
import { SEAT_NAMES, turnSeat } from "../labels";
import { pct } from "./usePhone";
import { playing, shown, useApp, you } from "../store";
import { offerAnswers } from "../coach";
import { act } from "../game";
import { useCover } from "./Cover";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function Chips() {
  const s = useApp();
  const { view, evals } = shown(s);
  const v = view!;
  const n = v.players.length;
  // Pass and play re-seats the table for whoever the phone is going to: they sit at the bottom. Watching, nobody
  // sits at the bottom: every seat is a chip.
  const cover = useCover();
  const me = cover?.seat ?? s.human;
  const seats = playing(s) ? Array.from({ length: n - 1 }, (_, k) => (me + 1 + k) % n) : Array.from({ length: n }, (_, k) => k);
  const onMove = turnSeat(v);
  const prev = s.frames[v.steps - 1]?.view;
  // Your offer going round: each seat's answer, as it arrives, on open board under its chip.
  const out = playing(s) && s.step == null && !cover && v.is_resolving_trade && v.current_trade[10] === s.human && v.current_turn === s.human
    ? offerAnswers(s.frames, s.frames.length - 1, s.human) : null;
  const ANSWER = { yes: "Accepts", no: "No", counter: "Counters" } as const;
  return (
    <div className={`ph-chips${playing(s) ? "" : " all"}`}>
      {out && (
        <div className="ph-answers">
          {seats.map((i) => {
            const a = out.answers[i];
            const confirm = s.legal.find((x) => x[0] === "CONFIRM_TRADE" && x[1] === i);
            return (
              <span key={i}>
                {confirm ? <button className="badge yes cut5" onClick={() => void act(confirm)} aria-label={`Trade with ${SEAT_NAMES[i]}`}>{ANSWER.yes}</button>
                  : <span className={`badge cut5 ${a ?? "wait"}`}>{a ? ANSWER[a] : "···"}</span>}
              </span>
            );
          })}
        </div>
      )}
      {seats.map((i) => {
        const p = v.players[i];
        const cards = sum(p.hand), devs = sum(p.devs);
        // A count that went up on this step turns green for a beat (no "+3": it would crowd the win figure).
        const gained = !!prev && cards > sum(prev.players[i].hand);
        const win = evals[i]?.win;
        const cls = onMove === i ? " on" : onMove !== (cover ? me : you(s)) ? " off" : "";
        return (
          <div key={i} data-seat={i} className={`ph-chip cut8${cls}`}>
            <div className="ph-chip-row">
              <i className="sw" style={{ background: SEAT_FILL[i] }} />
              <span className="nm">{SEAT_NAMES[i]}</span>
              <span className="d num vp">{p.vp}</span>
            </div>
            <div className="ph-chip-row small">
              <span className="ct"><svg viewBox="0 0 14 16" width="10" height="12" aria-hidden="true"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55" /></svg>
                <span key={v.steps} className={`num${gained ? " gainflash" : ""}`}>{cards}</span></span>
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
