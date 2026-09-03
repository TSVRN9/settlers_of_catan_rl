import type { Evaluation } from "../engine";
import { SEAT_COLORS, SEAT_NAMES } from "../labels";

/** P(win) per seat from the value net (each seat evaluated from its own perspective) next to the score.
 * v40's auxiliary heads (final VPs, turns left) are untrained -- the winning recipe used rollout values only
 * (docs/FINDINGS.md) -- so they are not shown. */
export default function Forecast({ evals, actualVps, publicVps, n }: { evals: Evaluation[]; actualVps: number[]; publicVps: number[]; n: number }) {
  const total = evals.reduce((a, e) => a + e.win, 0) || 1;
  return (
    <table className="w-full text-sm">
      <thead><tr className="label"><th className="text-left font-semibold">seat</th><th className="text-right font-semibold">P(win)</th><th className="text-right font-semibold">normalised</th><th className="text-right font-semibold">VP</th></tr></thead>
      <tbody>
        {Array.from({ length: n }).map((_, s) => (
          <tr key={s} className="border-t border-stone-200 dark:border-stone-800">
            <td className="py-1"><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full border border-stone-500 align-middle" style={{ background: SEAT_COLORS[s] }} />{SEAT_NAMES[s]}</td>
            <td className="text-right font-mono">{(100 * evals[s].win).toFixed(1)}%</td>
            <td className="text-right font-mono text-stone-500">{(100 * evals[s].win / total).toFixed(0)}%</td>
            <td className="text-right font-mono" title="public (actual, incl. hidden VP cards)">{publicVps[s]}{actualVps[s] !== publicVps[s] ? ` (${actualVps[s]})` : ""}</td>
          </tr>
        ))}
      </tbody>
      <caption className="caption-bottom pt-1 text-left text-xs text-stone-500">Each seat's P(win) is the net's own estimate; they need not sum to 1, so a normalised column is shown too.</caption>
    </table>
  );
}
