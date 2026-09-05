// The four readings, around the board rather than tabled beside it.
//
// This is ViewTable's signature and the reason the Table needs no seat rail. The arcs are
// laid end to end and sized by each seat's share of the four win estimates — which do not
// sum to 100, because each is that seat's own view of its own chances, so they are
// normalised to fill the circle rather than left with a gap that would read as a fifth
// player. Each label sits at its own arc's midpoint, with one pip per victory point.
//
// It is sized from the same anchor arithmetic as the board (712 / 574 = 1.2404), so it
// scales with the board on resize without a line of JavaScript.
import { BOT_SHORT, SEAT_NAMES, fmtPct } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { playing, useApp } from "../store";

const R = 345;            // the ring's radius, in its own 712-unit box
const SW = 22;            // its band
const C = 2 * Math.PI * R;
const GAP = 6;            // between one seat's arc and the next
const LABEL_R = 299;      // inside the band, outside the island

const pip = (cx: number, cy: number, fill: string, key: number) => {
  const w = 3.46, h = 4;  // a small flat hexagon, the same shape as a tile
  const pts = [[cx, cy - h], [cx + w, cy - h / 2], [cx + w, cy + h / 2], [cx, cy + h], [cx - w, cy + h / 2], [cx - w, cy - h / 2]];
  return <polygon key={key} points={pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} fill={fill} />;
};

export default function Ring() {
  const s = useApp();
  const v = s.view;
  if (!v) return null;

  const wins = v.players.map((_, i) => s.evals[i]?.win ?? 0);
  const total = wins.reduce((a, b) => a + b, 0);
  const usable = C - GAP * wins.length;

  let at = 0;                                     // distance travelled around the ring
  const arcs = wins.map((w) => (total > 0 ? (w / total) * usable : usable / wins.length));

  // Labels are placed from a floored share, not the true one. A seat at 0% has no arc and
  // therefore no midpoint, so at the end of a game all four names would stack on the winner.
  const floored = arcs.map((len) => Math.max(len, C * 0.09));
  const scale = usable / floored.reduce((a, b) => a + b, 0);
  let labelAt = 0;

  const seats = arcs.map((len, i) => {
    const start = at;
    at += len + GAP;
    const lw = floored[i] * scale;
    const mid = ((labelAt + lw / 2) / C) * 2 * Math.PI - Math.PI / 2;
    labelAt += lw + GAP;
    return { i, len, start, mid, vp: v.players[i].vp };
  });

  return (
    <svg data-ring viewBox="0 0 712 712" aria-hidden="true">
      <circle cx="356" cy="356" r={R} fill="none" stroke="var(--color-dust)" strokeWidth={SW} />
      {seats.map(({ i, len, start }) => (
        <circle key={i} cx="356" cy="356" r={R} fill="none" stroke={SEAT_FILL[i]} strokeWidth={SW}
                strokeLinecap="butt" strokeDasharray={`${len.toFixed(2)} ${(C - len).toFixed(2)}`}
                strokeDashoffset={(-start).toFixed(2)} transform="rotate(-90 356 356)" />
      ))}
      {seats.map(({ i, mid, vp }) => {
        const x = 356 + LABEL_R * Math.cos(mid);
        const y = 356 + LABEL_R * Math.sin(mid);
        const n = Math.min(vp, 10);
        return (
          <g key={i}>
            <text x={x} y={y - 17} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--color-pine)">
              {i === s.human && playing(s) ? `${SEAT_NAMES[i]}, you` : SEAT_NAMES[i]}
            </text>
            <text x={x} y={y + 2} textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--color-pine)"
                  fontFamily="var(--font-display)" className="num">
              {s.evals[i] ? fmtPct(s.evals[i].win) : "–"}
            </text>
            {Array.from({ length: n }, (_, k) => pip(x - ((n - 1) / 2) * 10 + k * 10, y + 13, SEAT_FILL[i], k))}
            <text x={x} y={y + 30} textAnchor="middle" fontSize="10.5" fill="var(--color-moss)">
              {i === s.human && playing(s) ? "" : BOT_SHORT[s.lineup[i].kind]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
