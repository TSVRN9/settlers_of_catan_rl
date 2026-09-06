// The Table: the game itself, and the view you play from — or watch from.
//
// The board sits in the middle with the game so far as a strip above it. Seated, the
// furniture docks around it: the odds of a seven top-left, your hand and the log bottom-left,
// the actions bottom-right, and — folded against the right edge — the analysis: a zone that
// opens to draw the ring of readings in around the board and dock the coach's column beside
// it. In the stands — a lineup with nobody in it — the game is a playback: the log bottom-left,
// a transport bottom-right, the ring always out, and nothing that asks you to play.
//
// The board itself is the app's single instance; this view only says where it goes, with the
// anchor below.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Canon, Frame } from "../engine";
import { act, advise, seek, setPace, start, stepOnce, toLineup, togglePause } from "../game";
import { GROUP, PROMPTS, actionKey, fmtDelta, fmtPct, label, rows, tradeText, who, type Row } from "../labels";
import { RES_FILL, SEAT_FILL } from "../board/palette";
import Card from "../board/Card";
import Dock from "../Dock";
import { COST, narrate, newsworthy } from "../coach";
import { openGameAnalysis, openMoveAnalysis, rowAt, turns } from "../review";
import { playing, set, useApp, you, type Pace, type State } from "../store";
import { waiting } from "../waiting";
import Coach from "./Coach";
import Ring from "./Ring";
import Strip from "./Strip";

/** The board takes builds and the robber; the column takes the standing actions. Everything
 *  else the engine offers goes to the panel, in full — a position with no surface for one of
 *  its legal actions is a position you cannot play. */
const ONBOARD = new Set(["BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "MOVE_ROBBER"]);
const INCOLUMN = new Set(["BUY_DEVELOPMENT_CARD", "ROLL", "END_TURN"]);
/** The right column sits beside the analysis fold, which owns the last 84px of the edge. */
const RIGHT = { position: "absolute", right: 128, width: 302 } as const;
/** The seek bar: board-width, but centred on the screen and staying there. It deliberately
 *  does not track --board-x — the board slides aside for the coach and the transport it is
 *  read against should not slide with it. */
const BOARD_W = "min(39.861cqw, 65.826cqh)";
const STRIP_X = { left: `calc(var(--strip-x) - ${BOARD_W} / 2)`, width: BOARD_W } as const;

const dice = (
  <svg width="29" height="18" viewBox="0 0 29 18" aria-hidden="true" style={{ display: "block" }}>
    {[3.5, 14.5, 25.5].flatMap((cx) => [3.5, 14.5].map((cy) => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.5" fill="var(--color-brick)" />
    )))}
  </svg>
);

/** The index of the position on screen: the playhead in the stands, the step being looked
 *  back at, or the live position. */
const shown = (s: State) => Math.max(0, Math.min(s.step ?? s.view!.steps, s.frames.length - 1));

/** What happened, newest first and in full ink. Three lines at rest; hovering opens the
 *  whole log, which scrolls. */
const LOG_ROWS = 60;
/** The Spine above the stage. --log-open is measured off the viewport rather than the
 *  stage's own cq units: a container-query unit inside a transitioned length does not
 *  animate reliably, and the log's opening is a transition. */
const SPINE = 28;
function Log({ s, style }: { s: State; style?: React.CSSProperties }) {
  const upTo = shown(s);
  const { frames, map } = s;
  const me = you(s);
  const rows = useMemo(() => {
    const out: { i: number; text: string; seat: number }[] = [];
    for (let i = upTo - 1; i >= 0 && out.length < LOG_ROWS; i--) {
      const row = rowAt(frames, i);
      if (row && newsworthy(row.action) && map) out.push({ i, text: narrate(row, map, me), seat: row.seat });
    }
    return out;
  }, [frames, upTo, map, me]);
  // Fade only the edge that actually has something beyond it — an edge fade over a log that
  // fits is just a dimmed line. Written straight onto the node rather than held in state:
  // this reads layout on every render and a setState here would loop.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      el.toggleAttribute("data-fade-t", el.scrollTop > 1);
      el.toggleAttribute("data-fade-b", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);          // opening on hover can end the clipping
    ro.observe(el);
    return () => { el.removeEventListener("scroll", read); ro.disconnect(); };
  });
  if (!map) return null;
  return (
    <div className="log" ref={box} style={style}>
      {rows.length === 0 && <div className="cap">Nothing has happened yet.</div>}
      {rows.map(({ i, text, seat }, k) => (
        <div key={i} className="line" style={{ display: "flex", gap: 8, lineHeight: 1.4, fontSize: k === 0 ? 13.5 : 12.5, color: k === 0 ? "var(--color-pine)" : "var(--color-moss)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 7px", marginTop: 6, background: SEAT_FILL[seat] }} />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

/** A die face. */
const FACE: [number, number][][] = [
  [], [[0, 0]], [[-1, -1], [1, 1]], [[-1, -1], [0, 0], [1, 1]], [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
];
const Die = ({ n }: { n: number }) => (
  <svg width="38" height="38" viewBox="-1.6 -1.6 3.2 3.2" aria-hidden="true" style={{ display: "block" }}>
    <rect x="-1.5" y="-1.5" width="3" height="3" rx="0.42" fill="var(--color-paper)" />
    {(FACE[n] ?? []).map(([x, y], i) => <circle key={i} cx={x * 0.72} cy={y * 0.72} r="0.23" fill="var(--color-pine)" />)}
  </svg>
);

/** The roll, over the board's centre: two dice and the total, rising in and fading out. */
function Roll({ frame }: { frame: Frame }) {
  const [a, b] = frame.outcome!;
  const seven = a + b === 7;
  return (
    <div className="roll" aria-label={`Rolled ${a + b}`}>
      <Die n={a} /><Die n={b} />
      <span className="d num" style={{ fontSize: 36, marginLeft: 4, color: seven ? "var(--color-brick)" : "var(--color-pine)" }}>{a + b}</span>
    </div>
  );
}

/** The game so far, above the board. Seated it looks back; in the stands it is the playhead. */
function GameStrip({ s, over }: { s: State; over: boolean }) {
  const last = s.frames.length - 1;
  if (last < 1) return null;
  const at = shown(s);
  const f = s.frames[at];
  const looking = playing(s) && s.step != null;
  const done = over || (!playing(s) && s.frames[last].action === null && s.frames[last].view.winner >= 0);
  return (
    <Dock name="table-strip" side="t" style={{ position: "absolute", ...STRIP_X, top: 24 }}>
      <Strip frames={s.frames} step={at} you={you(s)} onSeek={seek} />
      <div className="cap num" style={{ marginTop: 6, fontSize: 11.5, display: "flex", justifyContent: "space-between" }}>
        <span>step {at} of {last}{done || playing(s) ? "" : " so far"} · turn {f.view.num_turns}</span>
        {looking && <button className="cap" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", fontSize: 11.5 }} onClick={() => seek(last)}>back to live ›</button>}
      </div>
    </Dock>
  );
}

/** One door out of every game, however it was played. */
function Ending({ s }: { s: State }) {
  const v = s.view!, map = s.map!;
  const me = you(s);
  const standings = v.players.map((p, i) => ({ i, vp: p.actual_vp ?? p.vp })).sort((a, b) => b.vp - a.vp);
  const focus = me >= 0 ? me : v.winner;
  const frames = s.frames;
  const last = frames.length - 1;
  const gw = 280, gh = 56;
  const x = (i: number) => (i / Math.max(1, last)) * gw;
  const y = (p: number) => gh - p * gh;
  const moments = last > 1 ? turns(frames, focus, 3) : [];
  return (
    <Dock name="table-ending" side="r" style={{ ...RIGHT, right: 34, top: 146, textAlign: "right" }}>
      <div className="d" style={{ fontSize: 23, lineHeight: 1.2 }}>
        {who(v.winner, me)} won on turn {v.num_turns}
      </div>
      <div style={{ marginTop: 16 }}>
        {standings.map(({ i, vp }) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "5px 0" }}>
            <span style={{ font: "600 13.5px var(--font-sans)" }}>{who(i, me)}</span>
            <span className="d num" style={{ fontSize: 17, width: 26, textAlign: "right" }}>{vp}</span>
            <span style={{ width: 13, height: 13, flex: "0 0 13px", background: SEAT_FILL[i] }} />
          </div>
        ))}
      </div>
      {last > 1 && (
        <div className="arrive" style={{ marginTop: 18 }}>
          <svg viewBox={`0 0 ${gw} ${gh}`} width={gw} height={gh} style={{ display: "block" }}>
            {v.players.map((_, seat) => (
              <polyline key={seat} fill="none" stroke={SEAT_FILL[seat]}
                        strokeWidth={seat === focus ? 2 : 1.2} opacity={seat === focus ? 1 : 0.6}
                        points={frames.map((f, i) => `${x(i)},${y(f.evals[seat]?.win ?? 0.5)}`).join(" ")} />
            ))}
          </svg>
          <div className="cap" style={{ marginTop: 8 }}>The three moments that decided it</div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, marginTop: 6 }}>
            {moments.map((m) => {
              const row = rowAt(frames, m.step - 1);
              return (
                <button key={m.step} className="cap" style={{ background: "none", border: 0, cursor: "pointer", padding: 0, fontSize: 12, textAlign: "right", lineHeight: 1.4 }}
                        onClick={() => openMoveAnalysis(m.step - 1)}>
                  {row ? narrate(row, map, me) : `Step ${m.step}`}{" "}
                  <span className="d num" style={{ color: m.delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>{fmtDelta(m.delta)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="act cut8 go" onClick={() => openGameAnalysis()}>Open the analysis</button>
        <button className="act cut8" onClick={() => void start()}>Play the same board</button>
        <button className="act cut8" onClick={toLineup}>New lineup</button>
      </div>
    </Dock>
  );
}

const PACES: Pace[] = ["slow", "normal", "fast"];

/** The stands: a log and a transport over a playback. Nothing here asks you to play. */
function Stands({ s, over }: { s: State; over: boolean }) {
  return (
    <>
      <Dock name="table-log" side="b" style={{
        position: "absolute", left: 34, bottom: 26, width: 300,
        ["--log-open" as string]: `calc(100vh - ${SPINE + 160}px)`,
      }}>
        <Log s={s} />
      </Dock>
      {!over && (
        <Dock name="table-transport" side="r" style={{ position: "absolute", right: 34, bottom: 26, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="act cut8" style={{ height: 42 }} disabled={!s.paused} onClick={stepOnce} title="One step on">Step</button>
            <button className="act cut8 go" style={{ height: 42, minWidth: 92 }} onClick={togglePause}>{s.paused ? "Play" : "Pause"}</button>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {PACES.map((p) => (
              <button key={p} className="act cut8" onClick={() => setPace(p)} aria-pressed={s.pace === p}
                      style={{ height: 28, fontSize: 12, padding: "0 10px",
                               background: s.pace === p ? "var(--color-pine)" : undefined, color: s.pace === p ? "var(--color-chalk)" : undefined }}>
                {p}
              </button>
            ))}
          </div>
        </Dock>
      )}
    </>
  );
}

/** The seat: hand, actions, the fold that opens the analysis, and the coach beside the board. */
function Seated({ s, over }: { s: State; over: boolean }) {
  const v = s.view!, map = s.map!;
  const me = v.players[s.human];
  const mine = v.current_player === s.human && !over && s.step == null;
  const has = (c: number[]) => c.every((n, i) => me.hand[i] >= n);
  const of = (type: string): Canon | undefined => s.legal.find((a) => a[0] === type);
  const held = me.hand.reduce((a, b) => a + b, 0);
  // Not a menu any more: the builder makes its own offer. This only answers "may I?" —
  // the engine emits these exactly when an offer is legal to make.
  const offers = s.legal.filter((a) => a[0] === "OFFER_TRADE");
  const discarding = waiting(s)?.kind === "discard";
  // The seat rail's box, named once: the log's ceiling is measured off it.
  const railTop = held > 7 ? 128 : 72;
  const railHeight = v.players.length * (s.analysis ? 44 : 25);
  const rest = s.legal.filter((a) => !ONBOARD.has(a[0]) && !INCOLUMN.has(a[0]) && a[0] !== "OFFER_TRADE");
  // Inside a drill-down the group is already the whole list; outside it, fold the long ones.
  const listed: Row[] =
    s.pending ? s.pending.actions.map((a) => ({ a, group: null })) : rows(rest);
  const panel = s.pending ?? (rest.length
    ? {
        title: v.prompt === "DECIDE_TRADE" ? tradeText(v.current_trade)
             : PROMPTS[v.prompt] ? `You have to ${PROMPTS[v.prompt]}`
             : "Your options",
        actions: rest,
      }
    : null);

  // What the last move did to this hand, floated off the cards.
  const at = shown(s);
  const prev = s.frames[at - 1];
  const cur = s.frames[at];
  const gains = prev && cur ? cur.view.players[s.human].hand.map((c, r) => c - prev.view.players[s.human].hand[r]) : [];
  const devGains = prev && cur ? cur.view.players[s.human].devs.map((c, r) => c - (prev.view.players[s.human].devs[r] ?? 0)) : [];
  const hand = s.step != null && cur ? cur.view.players[s.human] : me;

  return (
    <>
      {/* A seven only costs you anything over seven cards, so the line only appears then. */}
      {held > 7 && !over && (
        <Dock name="table-odds" side="t" style={{ position: "absolute", left: 34, top: 72, width: 296, display: "flex", alignItems: "center", gap: 11 }}>
          <span className="d" style={{ fontSize: 21 }}>
            6<span style={{ color: "var(--color-moss)", fontSize: 14 }}> in 36</span>
          </span>
          {dice}
          <span className="cap" style={{ fontSize: 13, lineHeight: 1.35, maxWidth: 150 }}>
            chance of a seven, which would take {Math.floor(held / 2)} of your {held} cards
          </span>
        </Dock>
      )}

      {/* Every seat, yours included. The ring says all this and more, but the ring is
          analysis and is folded away for most of a seated game — and how far ahead someone
          is, and how much they are holding, is table information you can see across a real
          table. Opponents get public `p.vp`; only your own row may use `actual_vp`, which
          counts the victory-point cards in a hand nobody else is entitled to see.

          With the analysis open each row also spells out the hand itself. That is hidden
          information, so it is deliberately behind the same fold the rest of the analysis
          lives behind, and it is drawn as its own dimmer sub-row rather than as more
          numbers on the public line — a glance has to tell you which of the two you are
          reading. */}
      <Dock name="table-seats" side="l" style={{ position: "absolute", left: 34, top: railTop, width: 262 }}>
        {v.players.map((p, i) => {
          const own = i === s.human;
          return (
            <div key={i} style={{ padding: "3px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
                <span style={{ width: 9, height: 9, flex: "0 0 9px", background: SEAT_FILL[i] }} />
                <span style={{ flex: 1, fontWeight: own ? 700 : 600 }}>{who(i, s.human)}</span>
                <span className="d num" style={{ fontSize: 15 }}>{own ? p.actual_vp ?? p.vp : p.vp}</span>
                <span className="cap" style={{ fontSize: 11 }}>vp</span>
                <span className="d num" style={{ fontSize: 15, marginLeft: 6 }}>{p.hand.reduce((a, b) => a + b, 0)}</span>
                <span className="cap" style={{ fontSize: 11 }}>cards</span>
              </div>
              {/* Always mounted, opened by a class: a row that is conditionally rendered can
                  animate in at best, and never out. */}
              <div className={`hand-line${s.analysis ? " open" : ""}`}>
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
      </Dock>

      {/* The analysis, folded against the right edge: a zone, not a button. */}
      {!over && (
        <Dock name="table-fold" side="r" style={{ position: "absolute", right: 30, top: 26, bottom: 26, width: 84 }}>
          <div className="fold" role="button" tabIndex={0} aria-expanded={s.analysis}
               onClick={() => { const on = !s.analysis; set({ analysis: on, advice: on ? s.advice : null }); if (on) void advise(); }}
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}>
            <span className="d" style={{ fontSize: 26, lineHeight: 1 }}>{s.analysis ? "›" : "‹"}</span>
            <span className="cap" style={{ fontSize: 12, lineHeight: 1.3, textAlign: "center" }}>{s.analysis ? "close" : "open"}<br />analysis</span>
          </div>
        </Dock>
      )}

      {!over && s.analysis && (
        <Dock name="table-coach" side="r" className="coached" style={{ ...RIGHT, top: 26, bottom: 336 }}>
          <Coach />
        </Dock>
      )}

      {/* Your hand, docked to the rim and fanned: one card per resource carrying its count, and
          beside it your development cards. A change floats off the card it happened to. */}
      <Dock name="table-hand" side="b" style={{ position: "absolute", left: 40, bottom: 20, display: "flex", alignItems: "flex-end", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          {hand.hand.map((n, i) => (
            <span key={i} style={{ marginLeft: i ? -15 : 0 }}>
              <Card resource={i} count={n} width={74} height={100} rotate={(i - 2) * 4} dim={n === 0} delta={gains[i] || 0} deltaKey={at} />
            </span>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          {hand.devs.map((n, i) => (
            <span key={i} style={{ marginLeft: i ? -8 : 0 }}>
              <Card dev={i} count={n} width={40} height={54} dim={n === 0} delta={devGains[i] || 0} deltaKey={at} />
            </span>
          ))}
        </div>
      </Dock>

      {/* The log opens upward, so it may only have the room between itself and the seat rail
          above it — otherwise it expands straight through the rail and the heading. */}
      <Dock name="table-log" side="l" style={{
        position: "absolute", left: 34, bottom: 148, width: 262,
        ["--log-open" as string]: `calc(100vh - ${SPINE + 148 + railTop + railHeight + 18}px)`,
      }}>
        <Log s={s} />
      </Dock>

      {/* One bottom-anchored right column: what is being asked above the buttons, in the same
          stack, so the two can never overlap. With the analysis open the coach has the top. */}
      {!over && (
        <Dock name="table-actions" side="r" style={{
          ...RIGHT, bottom: 26, top: s.analysis ? 520 : 300,
          display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-end", gap: 12,
          pointerEvents: "none",
        }}>
          {mine && s.staged && (
            <div className="cut arrive dock-r" style={{ width: "100%", background: "var(--color-paper)", padding: "13px 15px", pointerEvents: "auto" }}>
              <div style={{ font: "600 13px var(--font-sans)", lineHeight: 1.35 }}>{label(s.staged, map)}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="act cut8 go" style={{ height: 36 }} onClick={() => void act(s.staged!)}>Play it</button>
                <button className="act cut8" style={{ height: 36 }} onClick={() => set({ staged: null })}>Cancel</button>
              </div>
            </div>
          )}
          {mine && !s.staged && panel && !discarding && (
            <div className="cut arrive dock-r" style={{
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
                {listed.map(({ a, group }) => (
                  <button key={actionKey(a)} className="act cut8"
                          style={{ height: 32, fontSize: 12.5, justifyContent: "flex-start" }}
                          onClick={() => (group
                            ? set({ pending: { title: GROUP[a[0]] ?? label(a, map), actions: group } })
                            : void act(a))}>
                    {group ? GROUP[a[0]] ?? label(a, map) : label(a, map)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9, flex: "0 0 auto", pointerEvents: "auto" }}>
            {offers.length > 0 && (
              <button className="act cut8" style={{ height: 42 }} disabled={!mine}
                      onClick={() => set({ offering: true })}>
                Offer a trade
              </button>
            )}
            {(["BUY_DEVELOPMENT_CARD", "ROLL", "END_TURN"] as const).map((t) => {
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
          </div>
        </Dock>
      )}
    </>
  );
}

export default function Table() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const over = !!v && v.winner >= 0;
  const seated = playing(s);

  // Looking back: the board shows that step's position, on the same board.
  const looking = s.step != null ? s.frames[s.step] : undefined;
  useEffect(() => {
    if (!looking) { set({ boardOverride: null }); return; }
    set({ boardOverride: { view: looking.view } });
    return () => set({ boardOverride: null });
  }, [looking]);

  if (!v || !map) return null;

  // The last thing that happened before the position on screen, if it was a roll.
  const at = shown(s);
  const before = s.frames[at - 1];
  const rolled = before && before.action?.[0] === "ROLL" && before.outcome ? before : null;

  return (
    <>
      {/* where the board goes; layout decides, BoardLayer parks on it */}
      <div data-anchor="table" />
      <Ring off={seated && !s.analysis && !over} />
      <GameStrip s={s} over={over} />
      {rolled && <Roll key={at - 1} frame={rolled} />}
      {seated ? <Seated s={s} over={over} /> : <Stands s={s} over={over} />}
      {over && <Ending s={s} />}
    </>
  );
}
