// Pass and play (spec "Pass and play"; handoff.mjs): while the phone is between people, the next person's colour
// covers the private half of the table — their name, why they are needed if it is mid-turn, and the moves since
// they last acted, replayed on the board about a second a move through the same decoration as live play. ↺ replays
// from the start, a row jumps to just before its move, Show hand ends the replay at the present and lifts the cover.
// Everything on it is public: the narration is a spectator's.
import { useEffect, useRef } from "react";
import { SEAT_FILL } from "../board/palette";
import { confirmHandoff } from "../game";
import { coverHead, SEAT_NAMES } from "../labels";
import { get, set, useApp } from "../store";
import { coverFor, sinceHeld, type Cover as CoverState } from "./pass";
import { moveRow, MoveLine, type MoveRow } from "./Slab";
import { useMetrics } from "./usePhone";

/** Ink that reads on each seat's colour: chalk on Red and Blue, pine on Orange and White. */
const INK = ["var(--color-chalk)", "var(--color-chalk)", "var(--color-pine)", "var(--color-pine)"];
const STEP_MS = 1000;

export function useCover(): CoverState {
  const s = useApp();
  return s.view && s.phase === "playing" ? coverFor(s.view, s.lineup.map((b) => b.kind === "human"), s.holder) : null;
}

export default function Cover({ cover }: { cover: NonNullable<CoverState> }) {
  const s = useApp();
  const { btnH } = useMetrics();
  const v = s.view!, seat = cover.seat, replay = cover.mode === "replay";
  // A replay: the moves since this seat last acted, growing as the bots play on. An answer: this turn's moves, the
  // cause among them, with nothing to replay.
  const idx = replay ? sinceHeld(s.frames, s.gaveUp[seat]) : (() => {
    const out: number[] = [];
    for (let i = s.frames.length - 2; i >= 0 && s.frames[i].view.current_turn === v.current_turn; i--) out.unshift(i);
    return out;
  })();
  const rows = idx.map((i) => s.map && moveRow(s.frames, i, s.map, -1)).filter((r): r is MoveRow => !!r);
  const first = rows[0]?.i;
  const playable = replay && rows.length > 0;

  // Start from just before the first move once per cover — as soon as there is a move, which at the game's start comes
  // after the cover rises (rows only grow, so `playable` turns true once) — and leave the present on the way out.
  useEffect(() => {
    if (!playable) return;
    set({ step: first });
    return () => set({ step: null });
  }, [seat, cover.mode, playable]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Each beat plays the next row's move: the board goes to just after it (the unlisted moves between ride along), and
  // past the last row the replay is the present.
  useEffect(() => {
    if (!playable || s.step == null) return;
    const t = setTimeout(() => {
      const at = get().step;
      if (at == null) return;
      const next = rows.find((r) => r.i >= at);
      set({ step: next && next.i + 1 < get().frames.length - 1 ? next.i + 1 : null });
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [s.step, rows.length, playable]);  // eslint-disable-line react-hooks/exhaustive-deps

  // The row playing stays in view as the list scrolls inside the cover.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(".new")?.scrollIntoView({ block: "nearest" }); }, [s.step]);

  const show = () => {
    if (get().pendingHandoff === seat) confirmHandoff();
    set({ human: seat, holder: seat, step: null, pendingHandoff: null });
  };
  const head = cover.mode === "answer" ? coverHead(v, seat) : "";
  const done = (r: MoveRow) => s.step == null || r.i < s.step;
  return (
    <div className="ph-cover cut" data-seat={seat} style={{ background: SEAT_FILL[seat], color: INK[seat] }}>
      <div className="hd"><span className="d nm">{SEAT_NAMES[seat]}</span>{head && <span className="why">{head}</span>}</div>
      {playable && rows.length > 1 && <div className="strip" aria-hidden="true">{rows.map((r) => <i key={r.i} className={done(r) ? "on" : undefined} />)}</div>}
      <div className="rows" ref={list}>
        {rows.map((r) => {
          const now = s.step != null && r.i + 1 === s.step;
          return (
            <button key={r.i} className={`ph-move ph-cover-row cut5${now ? " new" : ""}${done(r) || !playable ? "" : " next"}`}
                    disabled={!playable} onClick={() => set({ step: r.i })}>
              <MoveLine r={r} ev={s.evalShown} />
            </button>
          );
        })}
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        {playable && rows.length > 1 && <button className="ph-btn ph-replay cut8" style={{ flex: `0 0 ${btnH}px` }} onClick={() => set({ step: first })} aria-label="Replay from the start">↺</button>}
        <button className="ph-btn go ph-showhand cut8" onClick={show} autoFocus>Show hand</button>
      </div>
    </div>
  );
}
