import type { View } from "../engine";
import { DEV_CARDS, RESOURCE_EMOJI, RESOURCES, SEAT_COLORS, SEAT_NAMES } from "../labels";

/** One card per seat: score, hand (identities only for `reveal` seats), pieces, awards. */
export default function PlayerCards({ view, names, reveal, mover }: { view: View; names: string[]; reveal: (seat: number) => boolean; mover: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
      {view.players.map((p, s) => {
        const total = p.hand.reduce((a, b) => a + b, 0);
        const devs = p.devs.reduce((a, b) => a + b, 0);
        return (
          <div key={s} className={`card p-2 ${s === mover ? "ring-2 ring-amber-500" : ""}`}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-semibold"><span className="inline-block h-3 w-3 rounded-full border border-stone-500" style={{ background: SEAT_COLORS[s] }} />{SEAT_NAMES[s]} <span className="font-normal text-stone-500">· {names[s]}</span></span>
              <span className="font-mono text-sm" title={`public ${p.vp} / actual ${p.actual_vp}`}>{p.vp}{p.actual_vp !== p.vp ? <span className="text-stone-500"> ({p.actual_vp})</span> : null} VP</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
              {reveal(s) ? RESOURCES.map((r, i) => p.hand[i] > 0 && <span key={r} title={r}>{RESOURCE_EMOJI[i]}{p.hand[i]}</span>) : <span>🂠 {total} cards</span>}
              {devs > 0 && <span title={reveal(s) ? p.devs.map((c, i) => c ? `${c}× ${DEV_CARDS[i]}` : "").filter(Boolean).join(", ") : "development cards"}>🃏 {devs}</span>}
              {p.played[0] > 0 && <span title="knights played">⚔️ {p.played[0]}</span>}
              {p.has_army && <span title="Largest Army">🛡️</span>}
              {p.has_road && <span title="Longest Road">🛣️ {p.longest_road_length}</span>}
              <span className="text-stone-500" title="roads / settlements / cities left">{p.roads_available}·{p.settlements_available}·{p.cities_available}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
