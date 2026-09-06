// The four readings, around the board rather than tabled beside it.
//
// This is ViewTable's signature. It is analysis, though, and folded away for most of a
// seated game, so the Table carries its own small seat rail for the public facts (VP and
// hand size); this is the whole reading, arcs and all. The arcs are
// laid end to end and sized by each seat's share of the four win estimates — which do not
// sum to 100, because each is that seat's own view of its own chances, so they are
// normalised to fill the circle rather than left with a gap that would read as a fifth
// player. Each label sits at its own arc's midpoint, with one pip per victory point.
//
// It is sized from the same anchor arithmetic as the board (712 / 574 = 1.2404), so it
// scales with the board on resize without a line of JavaScript. It is always mounted at the
// table; `off` folds it away (opacity, scale, the arcs drawn back to nothing), so opening
// the analysis draws it in and closing draws it out.
import { BOT_SHORT, SEAT_NAMES, fmtPct } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { VIEWBOX, portCentre } from "../board/geometry";
import { playing, useApp } from "../store";

const R = 345;            // the ring's radius, in its own 712-unit box
const SW = 22;            // its band
const C = 2 * Math.PI * R;
const GAP = 6;            // between one seat's arc and the next
/** Where a seat's reading sits. A label is horizontal however far round the ring it is, so
 *  a seat at the ring's left or right reaches ~40 units sideways — at 305 that put its
 *  grey bot-kind line on top of the coloured band, where it stopped being readable. The
 *  band's inner edge is R - SW/2 = 334, so 288 keeps the whole label on the chalk. Fixing
 *  the port scale (see U) is what freed the room to move it in: badges now end at ~273. */
const LABEL_R = 288;
/** Ring units per board unit. The ring's box is 712 units over a screen width 1.2404x the
 *  board's, so a ring unit is one design pixel and a board unit is 574/511.56 of them. The
 *  old form multiplied by that 1.2404 as well, counting the ring's extra size twice and
 *  putting the port badges 24% too far out — which is how the labels came to dodge places
 *  no port was. LABEL_R's own comment is the check: ports land ~256, inside it, inside the
 *  band at 345. */
const U = 574 / VIEWBOX.w;
const BOARD_CX = VIEWBOX.x + VIEWBOX.w / 2;
/** Where the island's own centre (board x = 0) lands in the ring's box. The design's
 *  viewBox is not symmetric about the island — it reaches 236.72 left and 274.84 right —
 *  so the box centre is 19.06 units right of the hexes. Centre the ring on the island, or
 *  it hangs visibly off to one side of the board it is drawn around. Vertically the box
 *  *is* symmetric (y -244.2, h 488.4), so only x moves. */
const CX = 356 - BOARD_CX * U;
const CY = 356;
const CLEAR = 58;         // a label's half-width plus a port badge's radius, with room
const NUDGE = (4 * Math.PI) / 180;
const APART = (21 * Math.PI) / 180;   // two labels closer than this overlap

const pip = (cx: number, cy: number, fill: string, key: number) => {
  const w = 3.46, h = 4;  // a small flat hexagon, the same shape as a tile
  const pts = [[cx, cy - h], [cx + w, cy - h / 2], [cx + w, cy + h / 2], [cx, cy + h], [cx - w, cy + h / 2], [cx - w, cy - h / 2]];
  return <polygon key={key} points={pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} fill={fill} />;
};

export default function Ring({ off = false }: { off?: boolean }) {
  const s = useApp();
  const v = s.view;
  if (!v) return null;

  // Looking back at a step, the readings are that step's own.
  const at = s.step != null ? s.frames[s.step] : null;
  const evals = at?.evals.length ? at.evals : s.evals;
  const vps = at ? at.view.players.map((p) => p.vp) : v.players.map((p) => p.vp);
  const wins = v.players.map((_, i) => evals[i]?.win ?? 0);
  const total = wins.reduce((a, b) => a + b, 0);
  const usable = C - GAP * wins.length;

  let travelled = 0;                              // distance around the ring
  const arcs = wins.map((w) => (total > 0 ? (w / total) * usable : usable / wins.length));

  // Labels are placed from a floored share, not the true one. A seat at 0% has no arc and
  // therefore no midpoint, so at the end of a game all four names would stack on the winner.
  const floored = arcs.map((len) => Math.max(len, C * 0.09));
  const scale = usable / floored.reduce((a, b) => a + b, 0);
  let labelAt = 0;

  // A label sits at its arc's midpoint unless a port badge is there, in which case it
  // slides a few degrees along the arc to the nearest clear spot.
  const ports = (s.map?.ports ?? []).map((p) => {
    const [x, y] = portCentre(p.nodes);
    return [CX + x * U, CY + y * U] as const;
  });
  const clearance = (a: number) => {
    const x = CX + LABEL_R * Math.cos(a), y = CY + LABEL_R * Math.sin(a);
    return Math.min(Infinity, ...ports.map(([px, py]) => Math.hypot(px - x, py - y)));
  };
  const settle = (mid: number) => {
    let best = mid, bestClear = clearance(mid);
    for (const k of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
      if (bestClear >= CLEAR) break;
      const a = mid + k * NUDGE, c = clearance(a);
      if (c > bestClear) { best = a; bestClear = c; }
    }
    return best;
  };

  const mids = arcs.map((_, i) => {
    const lw = floored[i] * scale;
    const mid = settle(((labelAt + lw / 2) / C) * 2 * Math.PI - Math.PI / 2);
    labelAt += lw + GAP;
    return mid;
  });
  // Two labels pushed toward each other by port badges can still meet; keep them apart, then
  // clear the badges again, twice over, so neither pass undoes the other.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] < APART) mids[i] = mids[i - 1] + APART;
    if (mids.length > 1 && mids[0] + 2 * Math.PI - mids[mids.length - 1] < APART) mids[mids.length - 1] = mids[0] + 2 * Math.PI - APART;
    for (let i = 0; i < mids.length; i++) mids[i] = settle(mids[i]);
  }

  const seats = arcs.map((len, i) => {
    const start = travelled;
    travelled += len + GAP;
    return { i, len, start, mid: mids[i], vp: vps[i] };
  });

  return (
    <svg data-ring className={off ? "off" : undefined} viewBox="0 0 712 712" aria-hidden="true">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-dust)" strokeWidth={SW} />
      {seats.map(({ i, len, start }) => (
        <circle key={i} className="arc" cx={CX} cy={CY} r={R} fill="none" stroke={SEAT_FILL[i]} strokeWidth={SW}
                strokeLinecap="butt" style={{ strokeDasharray: `${len.toFixed(2)} ${(C - len).toFixed(2)}`, strokeDashoffset: (-start).toFixed(2) }}
                transform={`rotate(-90 ${CX} ${CY})`} />
      ))}
      {seats.map(({ i, mid, vp }) => {
        const x = CX + LABEL_R * Math.cos(mid);
        const y = CY + LABEL_R * Math.sin(mid);
        const n = Math.min(vp, 10);
        // The label group is placed by the `translate` property, which transitions, so a
        // reading drifts to its new place rather than jumping there.
        return (
          <g key={i} className="drift" style={{ translate: `${x.toFixed(1)}px ${y.toFixed(1)}px` }}>
            <text y={-21} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--color-pine)">
              {i === s.human && playing(s) ? `${SEAT_NAMES[i]}, you` : SEAT_NAMES[i]}
            </text>
            <text y={-2} textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--color-pine)"
                  fontFamily="var(--font-display)" className="num">
              {evals[i] ? fmtPct(evals[i].win) : "–"}
            </text>
            {Array.from({ length: n }, (_, k) => pip(-((n - 1) / 2) * 10 + k * 10, 9, SEAT_FILL[i], k))}
            <text y={23} textAnchor="middle" fontSize="10.5" fill="var(--color-moss)">
              {s.lineup[i].kind === "human" ? (i === s.human && playing(s) ? "" : "person") : BOT_SHORT[s.lineup[i].kind]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
