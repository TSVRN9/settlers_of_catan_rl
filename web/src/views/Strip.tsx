// The whole game as one strip: what has been played in wheat, a tick at every turn, the
// turning points as lettered markers above it, a pine handle at the step being looked at.
// Drag anywhere on it to move. Shared by the Table's seek bar and Move analysis, so both
// scrub the same way.
import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Frame } from "../engine";
import { SEAT_FILL } from "../board/palette";
import { events } from "../review";

interface Props { frames: Frame[]; step: number; you: number; onSeek: (step: number) => void }

export default function Strip({ frames, step, you, onSeek }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = Math.max(1, frames.length - 1);
  const pct = (i: number) => `${(i / last) * 100}%`;
  const turns = useMemo(() => frames.flatMap((f, i) => (i > 0 && f.view.num_turns !== frames[i - 1].view.num_turns ? [i] : [])), [frames]);
  // Markers closer than about a marker's width stack in a second row rather than overlap.
  const ev = useMemo(() => events(frames, you), [frames, you]);
  const near = last * 0.024;
  const lane = ev.map((e, i) => (i > 0 && e.step - ev[i - 1].step < near ? 1 : 0));

  const toStep = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    return Math.max(0, Math.min(last, Math.round(((clientX - r.left) / r.width) * last)));
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek(toStep(e.clientX)); };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (dragging.current) onSeek(toStep(e.clientX)); };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); };

  return (
    <div ref={el} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} role="slider"
         aria-label="Step" aria-valuemin={0} aria-valuemax={last} aria-valuenow={step}
         style={{ position: "relative", height: 8, marginTop: 30, background: "var(--color-dust)", cursor: "col-resize", touchAction: "none" }}>
      <div className="track" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: pct(step), background: "var(--color-wheat)" }} />
      {turns.map((i) => (
        <span key={i} style={{ position: "absolute", left: pct(i), top: 0, bottom: 0, width: 1, background: "var(--color-chalk)", opacity: 0.8 }} />
      ))}
      {ev.map((e, i) => (
        <span key={`${e.step}-${i}`} className="num" title={e.text} style={{
          position: "absolute", left: pct(e.step), top: -15 - lane[i] * 13, width: 11, height: 11, marginLeft: -5.5, borderRadius: "50%",
          background: SEAT_FILL[e.seat], color: e.seat === 3 ? "var(--color-pine)" : "var(--color-chalk)",
          font: "700 7.5px var(--font-sans)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none",
        }}>{e.letter}</span>
      ))}
      <span style={{ position: "absolute", left: pct(step), top: -4, bottom: -4, width: 3, marginLeft: -1.5, background: "var(--color-pine)", transition: "left var(--t-feel) var(--ease)" }} />
    </div>
  );
}
