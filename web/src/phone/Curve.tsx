// The game as one picture: each seat's chance (or, with Eval off while watching, its points) at every step, drawn in
// step x share units so the strokes stay thin however the box is stretched. Up to the playhead the lines are solid;
// past it, as far as the game has already been seen, faint. With `onSeek` it is the scrubber: a drag puts the
// playhead under the finger.
import { useRef } from "react";
import { SEAT_FILL, SEAT_LO } from "../board/palette";
import type { Frame } from "../engine";

/** A seat's colour as ink on paper: White's own grey is too pale for a line or a number, so it takes its shade. */
export const seatInk = (seat: number) => (seat === 3 ? SEAT_LO[3] : SEAT_FILL[seat]);

export default function Curve({ frames, at, upto, bold = -1, points = false, onSeek, className }: {
  frames: Frame[]; at: number; upto: number; bold?: number; points?: boolean; onSeek?: (step: number) => void; className?: string;
}) {
  const box = useRef<SVGSVGElement>(null);
  const end = Math.min(upto, frames.length - 1);
  if (end < 1) return <div className={className} />;
  const n = frames[0].view.players.length;
  const head = Math.min(at, end);
  // Points are the public ones: a spectator doesn't see a victory-point card until the game ends.
  const y = (f: Frame, seat: number) => (points ? 1 - Math.min(10, f.view.players[seat].vp) / 10 : 1 - (f.evals[seat]?.win ?? 0.5));
  const pts = (seat: number, a: number, b: number) => frames.slice(a, b + 1).map((f, k) => `${a + k},${y(f, seat).toFixed(4)}`).join(" ");
  const line = (seat: number) => (
    <g key={seat} stroke={seatInk(seat)} fill="none" strokeWidth={seat === bold ? 2.6 : bold >= 0 ? 1.4 : 1.8} opacity={bold >= 0 && seat !== bold ? 0.55 : 1}>
      <polyline vectorEffect="non-scaling-stroke" strokeLinejoin="round" points={pts(seat, 0, head)} />
      {head < end && <polyline vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity={0.3} points={pts(seat, head, end)} />}
    </g>
  );
  const seek = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    onSeek!(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * end));
  };
  return (
    <svg ref={box} className={className} viewBox={`0 0 ${end} 1`} preserveAspectRatio="none" role="img"
         aria-label={points ? "Each seat's points over the game" : "Each seat's chance over the game"}
         onPointerDown={onSeek && ((e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); })}
         onPointerMove={onSeek && ((e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e); })}>
      {Array.from({ length: n }, (_, seat) => (seat === bold ? null : line(seat)))}
      {bold >= 0 && line(bold)}
      {onSeek && <line x1={head} x2={head} y1={0} y2={1} stroke="var(--color-pine)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
