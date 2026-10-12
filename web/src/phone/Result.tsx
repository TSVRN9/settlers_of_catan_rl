// The end of a game (spec "Game over"; review.mjs D): the hand gives way to the result — who won, your place,
// the whole game's curve with your line bold, the final points with the VP cards face up — and Rematch, which
// keeps the lineup and the board. At your table it covers the seated block, which keeps its height, so the board
// does not move; watching, there is no hand to cover and it takes the slab's place.
import Card from "../board/Card";
import { SEAT_FILL } from "../board/palette";
import { start, toLineup } from "../game";
import { placeText, who } from "../labels";
import { playing, useApp, you } from "../store";
import { places } from "./standings";
import { seen, useMetrics } from "./usePhone";

export default function Result() {
  const s = useApp();
  const { btnH } = useMetrics();
  const v = s.view!;
  const people = s.lineup.filter((b) => b.kind === "human").length;
  // Two people at one phone: whoever held it last is not "you" to the other, so the result names every seat.
  const me = people > 1 ? -1 : you(s);
  const vps = v.players.map((p) => p.actual_vp ?? p.vp);
  const pl = places(vps, v.winner);
  const order = vps.map((_, i) => i).sort((a, b) => pl[a] - pl[b] || a - b);
  const tied = me >= 0 && pl.some((p, j) => j !== me && p === pl[me]);
  const frames = seen(s);
  const last = frames.length - 1;
  const bold = me >= 0 ? me : v.winner;
  const line = (seat: number) => (
    <polyline key={seat} fill="none" stroke={SEAT_FILL[seat]} vectorEffect="non-scaling-stroke"
              strokeWidth={seat === bold ? 2.6 : 1.4} opacity={seat === bold ? 1 : 0.55}
              points={frames.map((f, i) => `${i},${1 - (f.evals[seat]?.win ?? 0.5)}`).join(" ")} />
  );
  return (
    <div className={`ph-result arrive${playing(s) ? " cover" : ""}`}>
      <div className="hd">
        <span className="d win" style={{ color: SEAT_FILL[v.winner] }}>{who(v.winner, me)} won</span>
        {people === 1 && me !== v.winner && <span className="pl">{placeText(pl[me], tied)}</span>}
      </div>
      {last > 1 && (
        <svg className="curve" viewBox={`0 0 ${last} 1`} preserveAspectRatio="none" role="img" aria-label="Each seat's chance over the game">
          {v.players.map((_, seat) => (seat === bold ? null : line(seat)))}{line(bold)}
        </svg>
      )}
      <div className="rows">
        {order.map((i) => (
          <div key={i} className="row">
            <i className="sw" style={{ background: SEAT_FILL[i] }} />
            <span className="nm">{who(i, me)}</span>
            <span className="vpc">{Array.from({ length: v.players[i].devs[4] }, (_, k) => <Card key={k} dev={4} width={22} height={30} />)}</span>
            <span className="d num vp" style={i === v.winner ? { color: SEAT_FILL[i] } : undefined}>{vps[i]}</span>
          </div>
        ))}
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        <button className="ph-btn cut8" onClick={toLineup}>Lineup</button>
        <button className="ph-btn go ph-rematch cut8" onClick={() => void start()}>Rematch</button>
      </div>
    </div>
  );
}
