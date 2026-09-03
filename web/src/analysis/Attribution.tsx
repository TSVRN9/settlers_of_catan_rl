import type { Attribution } from "../engine";
import { SEAT_NAMES } from "../labels";

const GROUP: Record<string, string> = { hand: "hand", production: "production", buildings: "buildings", roads: "roads", devs: "dev cards", score: "victory points", robber: "robber", bank: "bank" };

/** Leave-one-group-out: how P(win) for `seat` moves when a group of input features is zeroed. */
export default function AttributionPanel({ rows, seat, n }: { rows: Attribution[]; seat: number; n: number }) {
  const sorted = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
  const max = Math.max(...sorted.map((r) => Math.abs(r.delta)), 1e-6);
  const who = (rel: number) => (rel < 0 ? "" : rel === 0 ? "own" : SEAT_NAMES[(seat + rel) % n]);
  return (
    <div>
      <p className="mb-1 text-xs text-stone-500">Δ P(win) for {SEAT_NAMES[seat]} when the net is shown the position without a feature group. Negative: the group is helping them.</p>
      <ul className="space-y-0.5 text-sm">
        {sorted.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-36 shrink-0 truncate">{who(r.seat)} {GROUP[r.group] ?? r.group}</span>
            <span className="relative h-2.5 flex-1 rounded bg-stone-200 dark:bg-stone-800">
              <span className={`absolute top-0 h-full rounded ${r.delta < 0 ? "bg-emerald-500" : "bg-rose-500"}`} style={r.delta < 0 ? { right: "50%", width: `${50 * Math.abs(r.delta) / max}%` } : { left: "50%", width: `${50 * Math.abs(r.delta) / max}%` }} />
            </span>
            <span className="w-14 shrink-0 text-right font-mono text-xs">{r.delta >= 0 ? "+" : ""}{(100 * r.delta).toFixed(1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
