// The review of a finished game (spec "The review"; review.mjs E and F). The overview: the whole game's curve with
// the reviewed seat's line bold, the decisive moves lettered on it (`deciding.pucks`) and the point of no return
// dashed; that seat's grades counted; the decisive moves as rows. At a move: the move with its grade, the best move
// when it was another (a ghost on the board, and by how much), one coach line, the curve as the scrubber, and the
// steps. The playhead is `store.step`, a position: the move discussed is the one that led to it.
import { useEffect, useMemo, useState } from "react";
import { SEAT_FILL } from "../board/palette";
import { closeReview, shareLink } from "../game";
import { evidence, gap } from "../coach";
import { pointOfNoReturn, pucks as letter } from "../deciding";
import { GRADES, GRADE_INK, onBoard } from "../grade";
import { SEAT_NAMES, label, roundOf } from "../labels";
import { gradeAt } from "../review";
import { get, set, useApp, you } from "../store";
import type { Frame, MapView } from "../engine";
import Curve, { seatInk } from "./Curve";
import { EvalControl } from "./TopBar";
import { isStale } from "../engine";
import { MoveLine, moveRow, type MoveRow } from "./Slab";

/** A move as a row even when it isn't news (an END_TURN): the list's narration, else the action's own label. */
function rowFor(frames: Frame[], i: number, map: MapView, viewer: number): MoveRow | null {
  const f = frames[i];
  if (!f?.action) return null;
  return moveRow(frames, i, map, viewer) ?? { i, seat: f.seat, a: f.action, text: label(f.action, map), d: null, dice: null };
}

/** The reviewed seat's moves graded one by one on the review client, earliest first, into `store.grades`. */
function useGrading(seat: number) {
  const n = useApp().frames.length;
  useEffect(() => {
    let on = true;
    void (async () => {
      const frames = get().frames;
      for (let i = 0; i < frames.length - 1 && on; i++) {
        if (frames[i].seat !== seat || !frames[i].action || get().grades[i]) continue;
        try {
          const g = await gradeAt(i);
          if (on && g) set((cur) => ({ grades: { ...cur.grades, [i]: g } }));
        } catch (e) {
          if (isStale(e)) return;                  // another game now: nothing left to grade here
          console.warn("no grade for step", i, e);
        }
      }
    })();
    return () => { on = false; };
  }, [seat, n]);
}

export function ReviewBar() {
  const s = useApp();
  const people = s.lineup.filter((b) => b.kind === "human").length;
  const choose = people !== 1 || !!s.film;     // nobody, or more than one, sat here as "you"
  const seat = s.reviewSeat ?? 0;
  // The game's link is made once; the move on screen is its last part.
  const [base, setBase] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { let on = true; shareLink().then((u) => { if (on) setBase(u); }, () => {}); return () => { on = false; }; }, [s.frames.length]);
  const share = () => {
    if (!base) return;
    const url = s.step != null ? `${base}/${s.step}` : base;
    history.replaceState(history.state, "", url);
    if (navigator.share) { navigator.share({ url }).catch(() => {}); return; }
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <div className="ph-top">
      <button className="ph-back" onClick={() => (s.step != null ? set({ step: null }) : closeReview())} aria-label={s.step != null ? "Back to the review" : "Back to the result"}>‹</button>
      <span className="d ph-title">Review</span>
      <span className="ph-seats">
        {/* Whose game this review reads, when nobody (or more than one) sat as "you": a tap moves to the next seat. */}
        {choose && (
          <button className="ph-seatpick cut8" aria-label={`Reviewing ${SEAT_NAMES[seat]}: next seat`}
                  style={{ background: SEAT_FILL[seat] }} onClick={() => set({ reviewSeat: (seat + 1) % s.view!.players.length })} />
        )}
      </span>
      <button className="ph-btn ph-revshare cut8" disabled={!base} onClick={share}>{copied ? "Copied" : "Share"}</button>
      <EvalControl />
    </div>
  );
}

export default function Review() {
  const s = useApp();
  const seat = s.reviewSeat ?? 0;
  useGrading(seat);
  const frames = s.frames, last = frames.length - 1;
  const winner = frames[last]?.view.winner ?? -1;
  const pk = useMemo(() => letter(frames, winner), [frames, winner]);
  const ponr = useMemo(() => pointOfNoReturn(frames, winner), [frames, winner]);
  // Two people at one phone: the last holder is not "you" to the other, as on the result.
  const viewer = s.lineup.filter((b) => b.kind === "human").length > 1 ? -1 : you(s);
  const map = s.map!;
  const step = s.step;
  const go = (p: number) => set({ step: Math.max(1, Math.min(last, p)) });
  const curve = <Curve className="ph-curve cut5" frames={frames} at={step ?? last} upto={last} bold={seat} pucks={pk} ponr={ponr} onSeek={(i) => go(i)} />;

  if (step == null) {
    const counts = GRADES.map((g) => Object.values(s.grades).filter((m) => m.seat === seat && m.grade === g).length);
    return (
      <div className="ph-review">
        {curve}
        <div className="ph-tally">
          {GRADES.map((g, k) => (
            <div key={g} className="cut5"><span className="d num" style={{ color: GRADE_INK[g] }}>{counts[k]}</span><small>{g}</small></div>
          ))}
        </div>
        <div className="ph-keys">
          {pk.map((p) => {
            const r = rowFor(frames, p.step, map, viewer);
            return r && (
              <button key={p.letter} className="ph-move ph-key cut5" onClick={() => go(p.step + 1)}>
                <span className="lt"><b className="puck" style={{ background: seatInk(p.seat) }}>{p.letter}</b>
                  <span className="rd num">{roundOf(frames, frames[p.step].view)}</span></span>
                <MoveLine r={r} ev={s.evalShown} />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const m = step - 1, f = frames[m];
  const r = rowFor(frames, m, map, viewer);
  const g = f.seat === seat ? s.grades[m] : undefined;
  const better = g && g.grade !== "Best" ? g.best : null;
  const ctx = { map, view: f.view, seat: f.seat, you: viewer };
  const line = f.action && g ? ((better && gap(better, f.action, ctx)) || evidence(f.action, ctx)) : "";
  // Next key move: the next decisive move, or the next of this seat's moves graded worse than Good.
  const keys = [...pk.map((p) => p.step), ...Object.entries(s.grades).filter(([, x]) => x.seat === seat && GRADES.indexOf(x.grade) >= 2).map(([i]) => +i)]
    .filter((i) => i > m).sort((a, b) => a - b);
  return (
    <div className="ph-review">
      <div className="ph-move new cut5 ph-newest">
        {r && <MoveLine r={r} ev={s.evalShown} />}
        {g && <span className="gr" style={{ color: GRADE_INK[g.grade] }}>{g.grade}</span>}
      </div>
      {better && (
        <div className="ph-move cut5 ph-newest ph-best">
          <MoveLine r={{ i: m, seat: f.seat, a: better, text: label(better, map), d: null, dice: null }} ev={false} />
          <span className="gr" style={{ color: GRADE_INK.Best }}>Best</span>
          <span className="num over">+{(g!.margin * 100).toFixed(1)} over {f.seat === viewer ? "yours" : `${SEAT_NAMES[f.seat]}'s`}</span>
        </div>
      )}
      {line && <div className="ph-coach">{line}</div>}
      {curve}
      <div className="ph-transport">
        <button className="ph-btn ph-tbtn cut8" aria-label="Back one move" disabled={step <= 1} onClick={() => go(step - 1)}>‹</button>
        <button className="ph-btn ph-tbtn cut8" aria-label="Forward one move" disabled={step >= last} onClick={() => go(step + 1)}>›</button>
        <button className="ph-btn ph-nextkey cut8" disabled={!keys.length} onClick={() => go(keys[0] + 1)}>Next key move</button>
      </div>
    </div>
  );
}

/** What the board shows in the review: the position on screen, the move that led to it landing, and the best move
 *  as a ghost in the mover's colour when the reviewed seat could have done better. */
export function reviewBoard(s: ReturnType<typeof get>) {
  const step = s.step;
  if (step == null) return null;
  const f = s.frames[step - 1], g = s.grades[step - 1];
  const better = g && g.grade !== "Best" && f.seat === s.reviewSeat && onBoard(g.best) ? g.best : null;
  return { since: f?.view ?? null, ghost: better, ghostSeat: f?.seat };
}
