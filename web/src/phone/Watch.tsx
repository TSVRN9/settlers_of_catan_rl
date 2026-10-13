// Watching (nobody seated, or a shared game played back): no hand, so the seats come to the bottom as standings.
// Above them the newest move, the curve as the scrubber, and the transport (spec "Watching bots and shared links";
// review.mjs A and B).
import { goLive, hold, seek, setPace, stepOnce, togglePause } from "../game";
import { BOT_SHORT, SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { useApp, type Pace } from "../store";
import Curve, { seatInk } from "./Curve";
import { MoveLine, moveRow, type MoveRow } from "./Slab";
import { sinceTurn } from "./slab";
import { pct, seen } from "./usePhone";

const PACES: Pace[] = ["slow", "normal", "fast"];
const PACE_NAME: Record<Pace, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };

const Glyph = ({ d }: { d: string }) => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;
const PLAY = "M4 2 L14 8 L4 14 Z", PAUSE = "M3 2 h3.6 v12 h-3.6 Z M9.4 2 h3.6 v12 h-3.6 Z";
const NEXT = "M3 2 L11 8 L3 14 Z M11.5 2 h2.5 v12 h-2.5 Z", PREV = "M13 2 L5 8 L13 14 Z M2 2 h2.5 v12 h-2.5 Z";

export default function Watch() {
  const s = useApp();
  const v = s.view!;
  const at = v.steps, upto = Math.max(at, s.seenTo);
  let row: MoveRow | null = null;
  for (const i of sinceTurn(seen(s), -1)) { row = s.map && moveRow(s.frames, i, s.map, -1); if (row) break; }
  const vps = v.players.map((p) => p.vp);
  const top = Math.max(...vps), lead = vps.filter((x) => x === top).length === 1;
  const kind = (i: number) => (s.film === "unnamed" ? "" : s.lineup[i]?.kind === "human" ? "Person" : BOT_SHORT[s.lineup[i]?.kind ?? ""] ?? "");
  return (
    <div className="ph-watching" inert={v.winner >= 0}>
      <div className="ph-move new cut5 ph-newest">{row && <MoveLine key={row.i} r={row} ev={s.evalShown} />}</div>
      <Curve className="ph-curve cut5" frames={s.frames} at={at} upto={upto} points={!s.evalShown} onSeek={(i) => seek(Math.min(i, upto))} />
      <div className="ph-transport">
        <button className="ph-btn ph-tbtn cut8" aria-label="Back one move" disabled={at === 0} onClick={() => seek(at - 1)}><Glyph d={PREV} /></button>
        <button className="ph-btn go ph-tbtn wide cut8" aria-label={s.paused ? "Play" : "Pause"} onClick={togglePause}><Glyph d={s.paused ? PLAY : PAUSE} /></button>
        <button className="ph-btn ph-tbtn cut8" aria-label="Forward one move" disabled={!s.frames[at + 1]} onClick={() => { hold(); stepOnce(); }}><Glyph d={NEXT} /></button>
        {at < s.seenTo
          ? <button className="ph-btn ph-pace ph-live cut8" onClick={goLive}>Live</button>
          : <button className="ph-btn ph-pace cut8" onClick={() => setPace(PACES[(PACES.indexOf(s.pace) + 1) % PACES.length])}>{PACE_NAME[s.pace]}</button>}
      </div>
      <div className="ph-standings">
        {v.players.map((_, i) => (
          <div key={i} className="row" data-seat={i}>
            <i className="sw" style={{ background: SEAT_FILL[i] }} />
            <span className="nm">{SEAT_NAMES[i]}</span>
            <span className="kd">{kind(i)}</span>
            {s.evalShown && <span className="num pc">{pct(s.evals[i]?.win)}</span>}
            <span className="d num vp" style={lead && vps[i] === top ? { color: seatInk(i) } : undefined}>{vps[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
