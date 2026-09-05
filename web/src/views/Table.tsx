// The Table: the game itself, and the view you play from.
//
// Five things docked to the corners of a board that sits in the middle — the odds of a seven
// top-left, the net's opinion or the ending on the right, your hand bottom-left, the actions
// bottom-right, and the one line that says how to build. The seat readings are not here:
// they ring the board, in Ring.tsx.
//
// The board itself is not here either. It is the app's single instance; this view only says
// where it goes, with the anchor below.
import { useEffect } from "react";
import type { Canon } from "../engine";
import { act, start, toLineup } from "../game";
import { PROMPTS, SEAT_NAMES, actionKey, fmtPct, label, tradeText } from "../labels";
import { RES_FILL, SEAT_FILL } from "../board/palette";
import Card from "../board/Card";
import { push } from "../route";
import { ensureReview, openGameAnalysis, openMoveAnalysis, topSwings } from "../review";
import { playing, set, useApp } from "../store";
import { waiting } from "../waiting";
import Ring from "./Ring";

const COST: Record<string, number[]> = {
  BUILD_ROAD: [1, 1, 0, 0, 0],
  BUILD_SETTLEMENT: [1, 1, 1, 1, 0],
  BUILD_CITY: [0, 0, 0, 2, 3],
  BUY_DEVELOPMENT_CARD: [0, 0, 1, 1, 1],
};

/** The board takes builds and the robber; the column takes the standing actions. Everything
 *  else the engine offers goes to the panel, in full — a position with no surface for one of
 *  its legal actions is a position you cannot play. */
const ONBOARD = new Set(["BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "MOVE_ROBBER"]);
const INCOLUMN = new Set(["BUY_DEVELOPMENT_CARD", "ROLL", "END_TURN"]);

const dice = (
  <svg width="29" height="18" viewBox="0 0 29 18" aria-hidden="true" style={{ display: "block" }}>
    {[3.5, 14.5, 25.5].flatMap((cx) => [3.5, 14.5].map((cy) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.5" fill="var(--color-brick)" />
    )))}
  </svg>
);

export default function Table() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const over = !!v && v.winner >= 0;

  // The curve and "moments" list need review data, and there's no click to hang fetching it
  // on the way Game/Move analysis do — it should just be there the moment the game ends.
  useEffect(() => { if (over) void ensureReview(); }, [over]);

  if (!v || !map) return null;

  const me = v.players[s.human];
  const mine = v.current_player === s.human && !over && playing(s);
  const has = (c: number[]) => c.every((n, i) => me.hand[i] >= n);
  const of = (type: string): Canon | undefined => s.legal.find((a) => a[0] === type);
  const advice = s.advice;
  const top = advice?.root.length ? [...advice.root].sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity))[0] : null;
  const held = me.hand.reduce((a, b) => a + b, 0);
  const offers = s.legal.filter((a) => a[0] === "OFFER_TRADE");

  const rest = s.legal.filter((a) => !ONBOARD.has(a[0]) && !INCOLUMN.has(a[0]) && a[0] !== "OFFER_TRADE");
  const panel = s.pending ?? (rest.length
    ? {
        title: v.prompt === "DECIDE_TRADE" ? tradeText(v.current_trade)
             : PROMPTS[v.prompt] ? `You have to ${PROMPTS[v.prompt]}`
             : "Your options",
        actions: rest,
      }
    : null);

  const standings = v.players.map((p, i) => ({ i, vp: p.actual_vp ?? p.vp })).sort((a, b) => b.vp - a.vp);
  const discarding = waiting(s)?.kind === "discard";

  return (
    <>
      {/* where the board goes; layout decides, BoardLayer flies to it */}
      <div data-anchor="table" />
      <Ring />

      {/* A seven only costs you anything over seven cards, so the line only appears then. */}
      {held > 7 && (
        <div style={{ position: "absolute", left: 34, top: 26, width: 296, display: "flex", alignItems: "center", gap: 11 }}>
          <span className="d" style={{ fontSize: 21 }}>
            6<span style={{ color: "var(--color-moss)", fontSize: 14 }}> in 36</span>
          </span>
          {dice}
          <span className="cap" style={{ fontSize: 13, lineHeight: 1.35, maxWidth: 150 }}>
            chance of a seven, which would take {Math.floor(held / 2)} of your {held} cards
          </span>
        </div>
      )}

      {over ? (
        <div style={{ position: "absolute", right: 34, top: 146, width: 280, textAlign: "right" }}>
          <div className="d" style={{ fontSize: 23, lineHeight: 1.2 }}>
            {SEAT_NAMES[v.winner]} won on turn {v.num_turns}
          </div>
          <div style={{ marginTop: 16 }}>
            {standings.map(({ i, vp }) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "5px 0" }}>
                <span style={{ font: "600 13.5px var(--font-sans)" }}>{i === s.human && playing(s) ? "You" : SEAT_NAMES[i]}</span>
                <span className="d num" style={{ fontSize: 17, width: 26, textAlign: "right" }}>{vp}</span>
                <span style={{ width: 13, height: 13, flex: "0 0 13px", background: SEAT_FILL[i] }} />
              </div>
            ))}
          </div>

          {s.review && (() => {
            const frames = s.review.frames;
            const last = frames.length - 1;
            const gw = 280, gh = 56;
            const x = (i: number) => (i / last) * gw;
            const y = (p: number) => gh - p * gh;
            const moments = topSwings(frames, s.human, 3);
            return (
              <div style={{ marginTop: 18 }}>
                <svg viewBox={`0 0 ${gw} ${gh}`} width={gw} height={gh} style={{ display: "block" }}>
                  {v.players.map((_, seat) => (
                    <polyline key={seat} fill="none" stroke={SEAT_FILL[seat]}
                              strokeWidth={seat === s.human ? 2 : 1.2} opacity={seat === s.human ? 1 : 0.6}
                              points={frames.map((f, i) => `${x(i)},${y(f.evals[seat]?.win ?? 0.5)}`).join(" ")} />
                  ))}
                </svg>
                <div className="cap" style={{ marginTop: 8, textAlign: "right" }}>Three moments that decided it</div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, marginTop: 6 }}>
                  {moments.map((m) => (
                    <button key={m.step} className="cap" style={{ background: "none", border: 0, cursor: "pointer", padding: 0, fontSize: 12, textAlign: "right" }}
                            onClick={() => openMoveAnalysis(m.step)}>
                      step {m.step} — {m.action ? label(m.action, map) : "—"}{" "}
                      <span className="d num" style={{ color: m.delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
                        {m.delta >= 0 ? "+" : ""}{(100 * m.delta).toFixed(1)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, marginTop: 18 }}>
            <button className="act cut8" onClick={() => void start(s.seed)}>Play the same board</button>
            <button className="act cut8" onClick={toLineup}>New lineup</button>
            <button className="act cut8" onClick={() => openGameAnalysis()}>Open the analysis</button>
          </div>
        </div>
      ) : advice && top && mine ? (
        <div style={{ position: "absolute", right: 34, top: 146, width: 268, textAlign: "right" }}>
          <div className="cap" style={{ fontSize: 12.5 }}>The net would play</div>
          <div className="d" style={{ fontSize: 19, lineHeight: 1.15, marginTop: 4 }}>{label(top[0] as Canon, map)}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 9, marginTop: 8 }}>
            <span className="d num" style={{ fontSize: 30, color: "var(--color-wheat)" }}>{fmtPct(top[1])}</span>
            <span className="cap" style={{ fontSize: 12 }}>if you play it</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="act cut8" style={{ height: 32, fontSize: 12.5 }} onClick={() => push("coach")}>Why</button>
            <button className="act cut8" style={{ height: 32, fontSize: 12.5 }} onClick={() => push("futures")}>Every legal move</button>
            <button className="act cut8" style={{ height: 32, fontSize: 12.5 }} onClick={() => push("console")}>The turn, counted</button>
            <button className="act cut8" style={{ height: 32, fontSize: 12.5 }}
                    onClick={() => set({ coach: false, advice: null })}>Turn the coach off</button>
          </div>
        </div>
      ) : !s.coach && mine ? (
        <div style={{ position: "absolute", right: 34, top: 146, width: 268, textAlign: "right" }}>
          <button className="act cut8" style={{ height: 32, fontSize: 12.5 }} onClick={() => set({ coach: true })}>
            Turn the coach on
          </button>
        </div>
      ) : null}

      {/* Your hand, docked to the rim and fanned: one card per resource carrying its count,
          which is what the design draws and what stays a fixed size however much you hold. */}
      <div style={{ position: "absolute", left: 40, bottom: 20, display: "flex", alignItems: "flex-end" }}>
        {me.hand.map((n, i) => (
          <span key={i} style={{ marginLeft: i ? -15 : 0 }}>
            <Card resource={i} count={n} width={74} height={100} rotate={(i - 2) * 4} dim={n === 0} />
          </span>
        ))}
      </div>

      <div style={{ position: "absolute", left: 34, bottom: 148, width: 262 }} className="cap">
        Build by touching the board: lit corners take a settlement or a city, lit edges take a
        road. Hold space to see every legal move at once.
      </div>

      {/* One bottom-anchored right column: the panel above the buttons, in the same stack, so
          the two can never overlap the way two separately docked corners did. */}
      <div style={{
        position: "absolute", right: 38, bottom: 26, top: 330, width: 302,
        display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-end", gap: 12,
        pointerEvents: "none",
      }}>
        {mine && panel && !discarding && (
          <div className="cut" style={{
            width: "100%", background: "var(--color-paper)", padding: "13px 15px",
            minHeight: 0, overflowY: "auto", pointerEvents: "auto",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "600 12.5px var(--font-sans)", flex: 1 }}>{panel.title}</span>
              {s.pending && (
                <button className="cap" style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, padding: 0 }}
                        onClick={() => set({ pending: null })}>back</button>
              )}
            </div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
              {panel.actions.map((a) => (
                <button key={actionKey(a)} className="act cut8"
                        style={{ height: 32, fontSize: 12.5, justifyContent: "flex-start" }}
                        onClick={() => void act(a)}>
                  {label(a, map)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9, flex: "0 0 auto", pointerEvents: "auto" }}>
          {!over && offers.length > 0 && (
            <button className="act cut8" style={{ height: 42 }} disabled={!mine}
                    onClick={() => set({ pending: { title: "Offer a trade", actions: offers } })}>
              Offer a trade
            </button>
          )}
          {!over && (["BUY_DEVELOPMENT_CARD", "ROLL", "END_TURN"] as const).map((t) => {
            const a = of(t);
            if (!a) return null;
            const cost = COST[t];
            return (
              <button key={t} className={`act cut8${t === "END_TURN" || t === "ROLL" ? " go" : ""}`}
                      style={{ height: 42 }}
                      disabled={!mine || (cost ? !has(cost) : false)}
                      onClick={() => void act(a)}>
                {label(a, map)}
                {cost && (
                  <span style={{ display: "inline-flex", gap: 3, marginLeft: 4 }}>
                    {cost.flatMap((n, i) => Array.from({ length: n }, (_, k) => (
                      <i key={`${i}-${k}`} style={{ width: 7, height: 7, borderRadius: "50%", background: RES_FILL[i] }} />
                    )))}
                  </span>
                )}
              </button>
            );
          })}
          {s.status === "thinking" && <span className="cap" style={{ fontSize: 12 }}>thinking…</span>}
        </div>
      </div>
    </>
  );
}
