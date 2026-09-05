// The Console: the same turn, counted. Additive to the Table — the board stays clickable
// behind the action bar — but denser: every seat's reading at once, the log, and the coach's
// full ranked opinion rather than just its top line.
import { useEffect, useState } from "react";
import type { Attribution, Canon } from "../engine";
import { act, advise, live } from "../game";
import { SEAT_NAMES, actionKey, fmtPct, label, worstGroup } from "../labels";
import { RES_FILL, SEAT_FILL } from "../board/palette";
import Card from "../board/Card";
import { openMoveAnalysis } from "../review";
import { get, set, useApp } from "../store";

/** A closed hexagonal shield, ~14px across — the artboard's seat icon, not a flat swatch. */
function Shield({ fill }: { fill: string }) {
  return (
    <svg viewBox="0 0 14 16" width="13" height="15" style={{ flex: "0 0 13px" }} aria-hidden="true">
      <polygon points="7,0 14,3 14,9 7,16 0,9 0,3" fill={fill} stroke="var(--color-pine)" strokeWidth="0.75" />
    </svg>
  );
}

const COST: Record<string, number[]> = {
  BUILD_ROAD: [1, 1, 0, 0, 0],
  BUILD_SETTLEMENT: [1, 1, 1, 1, 0],
  BUILD_CITY: [0, 0, 0, 2, 3],
  BUY_DEVELOPMENT_CARD: [0, 0, 1, 1, 1],
};
const ACTIONS = ["BUILD_CITY", "BUILD_SETTLEMENT", "BUILD_ROAD", "BUY_DEVELOPMENT_CARD"] as const;
const ACTION_NAME: Record<string, string> = {
  BUILD_CITY: "Build a city", BUILD_SETTLEMENT: "Settlement", BUILD_ROAD: "Road", BUY_DEVELOPMENT_CARD: "Dev card",
};

export default function Console() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const [attr, setAttr] = useState<Attribution[] | null>(null);

  useEffect(() => {
    setAttr(null);
    const at = get().view;
    void live.attribution(s.human).then((a) => { if (get().view === at) setAttr(a); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  if (!v || !map) return null;

  const me = v.players[s.human];
  const mine = v.current_player === s.human && v.winner < 0;
  const has = (c: number[]) => c.every((n, i) => me.hand[i] >= n);
  const of = (type: string) => s.legal.find((a) => a[0] === type);
  const held = me.hand.reduce((a, b) => a + b, 0);

  const root = s.advice?.root.filter(([, val]) => val != null) ?? [];
  const ranked = [...root].sort((a, b) => (b[1] as number) - (a[1] as number));
  const top = ranked[0], second = ranked[1];

  const roadHolder = v.players.findIndex((p) => p.has_road);
  const armyHolder = v.players.findIndex((p) => p.has_army);
  const offers = s.legal.filter((a) => a[0] === "OFFER_TRADE");
  const bankOffers = s.legal.filter((a) => a[0] === "MARITIME_TRADE");
  const worst = worstGroup(attr);

  return (
    <>
      <div data-anchor="console" />

      {/* top-right strip: a seven's odds, and the coach switch */}
      <div style={{ position: "absolute", right: 34, top: 26, display: "flex", alignItems: "flex-end", gap: 20 }}>
        {held > 7 && (
          <div>
            <div className="cap" style={{ marginBottom: 5 }}>A seven next roll</div>
            <span className="d" style={{ fontSize: 20 }}>6<span style={{ color: "var(--color-moss)", fontSize: 13 }}> in 36</span></span>
          </div>
        )}
        <span style={{ width: 1, height: 40, background: "var(--color-dust)" }} />
        <div>
          <div className="cap" style={{ marginBottom: 5 }}>Coach</div>
          <button
            style={{
              display: "inline-flex", width: 48, height: 24, background: "var(--color-pine)",
              padding: 3, justifyContent: s.coach ? "flex-end" : "flex-start", border: 0, cursor: "pointer",
            }}
            onClick={() => { const on = !s.coach; set({ coach: on }); if (on) void advise(); }}
          >
            <span style={{ width: 18, height: 18, background: s.coach ? "var(--color-wheat)" : "var(--color-dust)" }} />
          </button>
        </div>
      </div>

      {/* left aside: every seat's reading, and this turn's log */}
      <div style={{ position: "absolute", left: 34, top: 92, bottom: 26, width: 300, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="cut" style={{ background: "var(--color-paper)", padding: "5px 0 7px" }}>
          {v.players.map((p, i) => {
            const shown = p.actual_vp ?? p.vp;
            const hidden = p.vp - shown;
            const win = s.evals[i]?.win ?? 0;
            const pips = Math.round(win * 14);
            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 11px 9px",
                borderTop: i ? "1px solid var(--color-dust)" : undefined,
                background: v.current_player === i ? "#e7ebe2" : undefined,
              }}>
                <Shield fill={SEAT_FILL[i]} />
                <span style={{ font: "600 13.5px var(--font-sans)", width: 44, flex: "0 0 44px" }}>
                  {i === s.human ? "You" : SEAT_NAMES[i]}
                </span>
                <span style={{ display: "inline-flex", gap: 1.5 }}>
                  {Array.from({ length: 14 }, (_, k) => (
                    <i key={k} style={{ width: 3, height: 10, background: k < pips ? SEAT_FILL[i] : "var(--color-dust)" }} />
                  ))}
                </span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 2, marginLeft: "auto" }}>
                  <span className="d num" style={{ fontSize: 17 }}>{shown}</span>
                  {hidden > 0 && <span className="d num" style={{ fontSize: 11, color: "var(--color-wheat)" }}>+{hidden}</span>}
                </span>
                <span className="d num" style={{ fontSize: 13, width: 42, textAlign: "right" }}>
                  {s.evals[i] ? fmtPct(s.evals[i].win) : "–"}
                </span>
              </div>
            );
          })}
        </div>
        {(roadHolder >= 0 || armyHolder >= 0) && (
          <div className="cap">
            {roadHolder >= 0 && `Longest road to ${roadHolder === s.human ? "you" : SEAT_NAMES[roadHolder]}. `}
            {armyHolder >= 0 && `Largest army to ${armyHolder === s.human ? "you" : SEAT_NAMES[armyHolder]}.`}
          </div>
        )}
        <div className="cut" style={{ flex: 1, minHeight: 0, background: "var(--color-paper)", padding: "12px 13px", overflowY: "auto" }}>
          <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 8 }}>This turn</div>
          {s.log.length === 0 && <div className="cap">Nothing played yet.</div>}
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column-reverse", gap: 6 }}>
            {s.log.map((row, i) => (
              <li key={i} style={{ display: "flex", gap: 7, fontSize: 12.5, color: i < s.log.length - 6 ? "var(--color-moss)" : "var(--color-pine)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px", marginTop: 3, background: SEAT_FILL[row.seat] }} />
                <span>{SEAT_NAMES[row.seat]} {label(row.action, map).toLowerCase()}{row.note ? ` — ${row.note}` : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* center: hand and the action bar */}
      <div className="cut" style={{
        position: "absolute", left: 350, right: 376, bottom: 26, height: 200,
        background: "var(--color-paper)", padding: "12px 15px 13px", display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ font: "600 13px var(--font-sans)" }}>Your hand</span>
          {held > 7 && <span className="cap" style={{ color: "var(--color-brick)" }}>{held} cards — a seven takes {Math.floor(held / 2)}</span>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {me.hand.map((n, i) => (
            <Card key={i} resource={i} count={n} width={52} height={68} dim={n === 0} />
          ))}
        </div>
        {s.pending ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "600 12.5px var(--font-sans)", flex: 1 }}>{s.pending.title}</span>
              <button className="cap" style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, padding: 0 }}
                      onClick={() => set({ pending: null })}>back</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 96, overflowY: "auto" }}>
              {s.pending.actions.map((a) => (
                <button key={actionKey(a)} className="act cut8" style={{ height: 30, fontSize: 12.5, justifyContent: "flex-start" }}
                        onClick={() => void act(a)}>
                  {label(a, map)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="act cut8" style={{ height: 32, flex: 1, fontSize: 12.5 }}
                      disabled={!mine || offers.length === 0}
                      onClick={() => set({ pending: { title: "Offer a trade", actions: offers } })}>
                Offer a trade
              </button>
              <button className="act cut8" style={{ height: 32, flex: 1, fontSize: 12.5 }}
                      disabled={!mine || bankOffers.length === 0}
                      onClick={() => set({ pending: { title: "Bank trade", actions: bankOffers } })}>
                Bank trade
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
              {ACTIONS.map((t) => {
                const a = of(t);
                const cost = COST[t];
                return (
                  <button key={t} className="act cut8" style={{ height: 42, flex: 1, flexDirection: "column", gap: 3, padding: "5px 4px" }}
                          disabled={!mine || !a || !has(cost)} onClick={() => a && void act(a)}>
                    <span style={{ fontSize: 12 }}>{ACTION_NAME[t]}</span>
                    <span style={{ display: "inline-flex", gap: 3 }}>
                      {cost.flatMap((n, i) => Array.from({ length: n }, (_, k) => (
                        <i key={`${i}-${k}`} style={{ width: 6, height: 6, borderRadius: "50%", background: RES_FILL[i] }} />
                      )))}
                    </span>
                  </button>
                );
              })}
              <button className="act cut8 go" style={{ height: 42, flex: 1 }} disabled={!mine}
                      onClick={() => { const a = of("END_TURN") ?? of("ROLL"); if (a) void act(a); }}>
                {of("ROLL") ? "Roll" : "End turn"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* right aside: the coach, always open */}
      <div className="cut" style={{
        position: "absolute", right: 34, top: 92, bottom: 26, width: 326,
        background: "var(--color-paper)", padding: "13px 14px 12px", display: "flex", flexDirection: "column",
      }}>
        <div className="d" style={{ fontSize: 17 }}>What the net would do</div>
        {!s.advice ? (
          <div className="cap" style={{ marginTop: 8 }}>Thinking…</div>
        ) : ranked.length === 0 ? (
          <div className="cap" style={{ marginTop: 8 }}>Nothing to weigh — one move is forced.</div>
        ) : (
          <>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", flex: 1 }}>
              {ranked.map(([a, val], i) => (
                <div key={actionKey(a as Canon)} style={i === 0 ? { background: "#e7ebe2", padding: "5px 7px", margin: "0 -7px" } : undefined}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                    <span>{label(a as Canon, map)}</span>
                    <span className="d num">{fmtPct(val)}</span>
                  </div>
                  <div style={{ height: 8, background: "var(--color-dust)", marginTop: 3 }}>
                    <div style={{
                      height: "100%", width: `${top ? ((val as number) / (top[1] as number)) * 100 : 0}%`,
                      background: i === 0 ? "var(--color-wheat)" : "#c8b98a",
                    }} />
                  </div>
                </div>
              ))}
            </div>
            {top && second && (
              <div style={{ background: "#e7ebe2", padding: "11px 12px", marginTop: 10, fontSize: 12.5 }}>
                {label(top[0] as Canon, map)} beats {label(second[0] as Canon, map).toLowerCase()} by {fmtPct((top[1] as number) - (second[1] as number))}.
              </div>
            )}
            <div className="cap" style={{ marginTop: 10 }}>
              Two turns deep, {s.advice.leaves.toLocaleString()} positions, {Math.round(s.advice.ms)} ms.
            </div>
            {worst && top && second && (
              <div className="cap" style={{ marginTop: 8 }}>
                Why it is not close: your <b style={{ color: "var(--color-pine)" }}>{worst.group}</b>{" "}
                {worst.delta < 0 ? "is doing a lot of the work here." : "is costing you right now."}
              </div>
            )}
            <button className="act cut8" style={{ height: 32, marginTop: 10, fontSize: 12.5 }}
                    onClick={() => openMoveAnalysis()}>
              All {s.legal.length} moves
            </button>
          </>
        )}
      </div>
    </>
  );
}
