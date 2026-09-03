import type { Frame } from "../engine";
import { SEAT_COLORS, SEAT_NAMES } from "../labels";

/** P(win) per seat over the game, from the value net evaluated from each seat's own perspective. */
export default function WinProbTimeline({ frames, step, onSeek, n }: { frames: Frame[]; step: number; onSeek: (s: number) => void; n: number }) {
  const W = 600, H = 160, L = 34, B = 20;
  const maxStep = Math.max(frames.length - 1, 1);
  const x = (s: number) => L + (s / maxStep) * (W - L - 8);
  const y = (p: number) => 8 + (1 - p) * (H - B - 8);
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-3 text-xs">
        {Array.from({ length: n }).map((_, s) => (
          <span key={s} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full border border-stone-500" style={{ background: SEAT_COLORS[s] }} />{SEAT_NAMES[s]} {frames[step] ? `${(100 * frames[step].evals[s].win).toFixed(0)}%` : ""}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto cursor-crosshair" onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const fx = ((e.clientX - r.left) / r.width) * W;
        onSeek(Math.max(0, Math.min(maxStep, Math.round(((fx - L) / (W - L - 8)) * maxStep))));
      }}>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}><line x1={L} x2={W - 8} y1={y(p)} y2={y(p)} stroke="currentColor" opacity={p === 0.5 ? 0.35 : 0.12} strokeDasharray={p === 0.5 ? "4 3" : undefined} /><text x={L - 4} y={y(p) + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>{(100 * p).toFixed(0)}</text></g>
        ))}
        {Array.from({ length: n }).map((_, s) => (
          <polyline key={s} fill="none" stroke={SEAT_COLORS[s]} strokeWidth={s === 3 ? 2.5 : 2} strokeLinejoin="round" opacity={0.95} points={frames.map((f) => `${x(f.step)},${y(f.evals[s].win)}`).join(" ")} style={s === 3 ? { filter: "drop-shadow(0 0 1px #555)" } : undefined} />
        ))}
        <line x1={x(step)} x2={x(step)} y1={4} y2={H - B} stroke="#f59e0b" strokeWidth={2} />
        <text x={x(step)} y={H - 6} textAnchor="middle" fontSize={10} fill="currentColor">step {step}{frames[step] ? ` · turn ${frames[step].view.num_turns}` : ""}</text>
      </svg>
    </div>
  );
}
