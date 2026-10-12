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
import { vpCards, who } from "../labels";
import { RES_FILL, SEAT_FILL } from "../board/palette";

interface Props {
  players: PlayerView[]; you: number; open: boolean; row?: boolean; current?: number;
  /** The face-up line; off in the opening, where every figure on it is a nought. */
  stats?: boolean;
}

/** The three things that lie face up in front of a seat, as marks sized for an 11px line. */
const KNIGHT = <svg width="9" height="10" viewBox="5 3 22 26" aria-hidden="true"><path d="M16 3 L27 7.5 V15.5 C27 22 22 26.5 16 29 C10 26.5 5 22 5 15.5 V7.5 Z" fill="currentColor" /></svg>;
const ROAD = <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><line x1="1.5" y1="6.5" x2="10.5" y2="1.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>;
const DEV = <svg width="8" height="11" viewBox="0 0 8 11" aria-hidden="true"><rect x="0.5" y="0.5" width="7" height="10" rx="1" fill="currentColor" /></svg>;

export default function Seats({ players, you, open, row = false, current, stats = true }: Props) {
  return (
    <div style={row ? { display: "flex", gap: 22 } : undefined}>
      {players.map((p, i) => {
        const own = i === you;
        const exact = own || you < 0;
        const onMove = i === current;
        const size = onMove ? 13 : 9;
        return (
          <div key={i} data-seat={i} className={`seat${onMove ? " on" : ""}`} style={{ minWidth: row ? 150 : undefined }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
              {/* Bigger, not ringed, for whoever is on the move — sized rather than stroked,
                  and keyed so it remounts (replaying the same .bump every changed count
                  already uses) exactly when that changes, not on every render. */}
              <span key={onMove ? `on-${current}` : `off-${i}`} className={onMove ? "bump" : undefined}
                    style={{ width: size, height: size, flex: `0 0 ${size}px`, background: SEAT_FILL[i] }} />
              <span style={{ flex: 1, fontWeight: own ? 700 : 600 }}>{who(i, you)}</span>
              {/* keyed on the score, so a point gained or lost pulses rather than just changing */}
              <span key={`vp${exact ? p.actual_vp ?? p.vp : p.vp}`} className="d num bump" style={{ fontSize: 15 }}>{exact ? p.actual_vp ?? p.vp : p.vp}</span>
              <span className="cap" style={{ fontSize: 11 }}>vp</span>
              <span className="d num" style={{ fontSize: 15, marginLeft: 6 }}>{p.hand.reduce((a, b) => a + b, 0)}</span>
              <span className="cap" style={{ fontSize: 11 }}>cards</span>
            </div>
            {/* What lies face up in front of the seat, on every row so the rail never changes
                height: the race for Largest Army and Longest Road is read here, and the holder
                of either has it drawn as the card it is. */}
            {stats && (() => {
              const knights = p.played[0] ?? 0, devs = p.devs.reduce((a, b) => a + b, 0);
              return (
                <div className="stats num">
                  <span className={`stat${p.has_army ? " held" : ""}`} title={p.has_army ? "Largest Army" : "Knights played"}
                        aria-label={`${knights} knights played${p.has_army ? ", Largest Army" : ""}`}>{KNIGHT}{knights}</span>
                  <span className={`stat${p.has_road ? " held" : ""}`} title={p.has_road ? "Longest Road" : "Longest road"}
                        aria-label={`longest road ${p.longest_road_length}${p.has_road ? ", Longest Road" : ""}`}>{ROAD}{p.longest_road_length}</span>
                  <span className="stat" title="Development cards in hand" aria-label={`${devs} development cards in hand`}>{DEV}{devs}</span>
                </div>
              );
            })()}
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
                {vpCards(p) && <span className="cap" style={{ fontSize: 10.5 }}>{vpCards(p)}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
