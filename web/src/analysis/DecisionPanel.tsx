import type { Canon, Decision, MapView } from "../engine";
import { BOT_SHORT, actionKey, fmtPct, label } from "../labels";

/** Every root action the bot considered, ranked by its search value; the chosen one is marked. */
export default function DecisionPanel({ decision, map, onHover, compare }: { decision: Decision; map: MapView; onHover?: (a: Canon | null) => void; compare?: Decision | null }) {
  if (!decision.root.length) return <p className="text-sm text-stone-500">Forced move — only one legal action.</p>;
  const isProb = decision.bot === "vnet";
  const vals = decision.root.map(([, v]) => v).filter((v): v is number => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const norm = (v: number | null) => (v == null || hi === lo ? 0 : (v - lo) / (hi - lo));
  const rows = [...decision.root].sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity));
  const chosen = actionKey(decision.action);
  const other = compare ? actionKey(compare.action) : null;
  return (
    <div>
      <p className="mb-1 text-xs text-stone-500">{BOT_SHORT[decision.bot]} · {decision.root.length} root actions{decision.leaves ? ` · ${decision.leaves.toLocaleString()} leaves` : ""}{decision.ms ? ` · ${decision.ms.toFixed(0)} ms` : ""}{isProb ? " · values are P(win) after the search" : " · values are the heuristic's score (higher is better)"}</p>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto pr-1 text-sm">
        {rows.map(([a, v]) => {
          const k = actionKey(a);
          return (
            <li key={k} className={`flex items-center gap-2 rounded px-1 ${k === chosen ? "bg-amber-100 font-semibold dark:bg-amber-900/40" : ""}`} onMouseEnter={() => onHover?.(a)} onMouseLeave={() => onHover?.(null)}>
              <span className="w-32 shrink-0 md:w-48 truncate" title={label(a, map)}>{label(a, map)}</span>
              <span className="h-2.5 flex-1 rounded bg-stone-200 dark:bg-stone-800"><span className="block h-full rounded bg-amber-500" style={{ width: `${Math.max(3, 100 * norm(v))}%` }} /></span>
              <span className="w-16 shrink-0 text-right font-mono text-xs">{isProb ? fmtPct(v) : v == null ? "–" : v.toExponential(2)}</span>
              {k === chosen && <span title="chosen">✓</span>}
              {other && k === other && k !== chosen && <span className="text-xs text-stone-500" title={`${BOT_SHORT[compare!.bot]} would pick this`}>◇</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
