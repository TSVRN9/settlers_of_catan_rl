// Every seat's public line — VP and hand size — and, opened by a class, the hand itself. One
// rail for the seated Table, the stands and the analysis, so the three cannot drift apart.
//
// Opponents get public `vp`; only a row entitled to see the hand may use `actual_vp`, which
// counts the victory-point cards nobody else is entitled to see. `exact` says which rows those
// are: your own when you are seated, every row when nobody is (a watched game, a review).
// The hand line is hidden information too, so it sits behind the same `open` as the rest of
// the analysis, as its own dimmer sub-row rather than more numbers on the public line — a
// glance has to tell you which of the two you are reading.
import type { PlayerView } from "../engine";
import { who } from "../labels";
import { RES_FILL, SEAT_FILL } from "../board/palette";

interface Props { players: PlayerView[]; you: number; open: boolean; row?: boolean; current?: number }

export default function Seats({ players, you, open, row = false, current }: Props) {
  return (
    <div style={row ? { display: "flex", gap: 22 } : undefined}>
      {players.map((p, i) => {
        const own = i === you;
        const exact = own || you < 0;
        const onMove = i === current;
        const size = onMove ? 13 : 9;
        return (
          <div key={i} style={{ padding: "3px 0", minWidth: row ? 150 : undefined }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
              {/* Bigger, not ringed, for whoever is on the move — sized rather than stroked,
                  and keyed so it remounts (replaying the same .bump every changed count
                  already uses) exactly when that changes, not on every render. */}
              <span key={onMove ? `on-${current}` : `off-${i}`} className={onMove ? "bump" : undefined}
                    style={{ width: size, height: size, flex: `0 0 ${size}px`, background: SEAT_FILL[i] }} />
              <span style={{ flex: 1, fontWeight: own ? 700 : 600 }}>{who(i, you)}</span>
              <span className="d num" style={{ fontSize: 15 }}>{exact ? p.actual_vp ?? p.vp : p.vp}</span>
              <span className="cap" style={{ fontSize: 11 }}>vp</span>
              <span className="d num" style={{ fontSize: 15, marginLeft: 6 }}>{p.hand.reduce((a, b) => a + b, 0)}</span>
              <span className="cap" style={{ fontSize: 11 }}>cards</span>
            </div>
            {/* Longest road / largest army: public information, so it gets its own quiet line
                rather than the hidden hand-line's gate — and no line at all for the seats
                (most of them, most of the game) holding neither. */}
            {(p.has_road || p.has_army) && (
              <div className="cap" style={{ display: "flex", gap: 10, marginLeft: 18, fontSize: 10.5 }}>
                {p.has_road && <span>{p.longest_road_length} road</span>}
                {p.has_army && <span>{p.played[0] ?? 0} army</span>}
              </div>
            )}
            {/* Always mounted, opened by a class: a row that is conditionally rendered can
                animate in at best, and never out. */}
            <div className={`hand-line${open ? " open" : ""}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginLeft: 18, paddingTop: 2 }}>
                {p.hand.map((n, r) => (
                  <span key={r} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <i style={{ width: 6, height: 6, borderRadius: "50%", background: RES_FILL[r] }} />
                    <span className="num" style={{ fontSize: 11.5 }}>{n}</span>
                  </span>
                ))}
                <span className="cap" style={{ fontSize: 10.5, marginLeft: 2 }}>
                  {p.devs.reduce((a, b) => a + b, 0)} dev
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
