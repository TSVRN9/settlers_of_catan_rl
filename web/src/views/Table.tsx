// The Table: the game itself, and the view you play from — or watch from.
//
// The board sits in the middle with the game so far as a strip above it. Seated, the
// furniture docks around it: the seats and, under them, what has happened, down the left; your
// tray along the bottom, centred under the board; what is being asked of you (a trade, an
// offer, the odd action nothing else covers) in a column on the right, just above the tray's
// turn controls; and — folded against the right edge — the analysis: a zone that opens to draw
// the ring of readings in around the board and dock the coach's column beside it. In the
// stands — a lineup with nobody in it — the game is a playback: the same left column, a
// transport bottom-right with the dice, the ring always out, and nothing that asks you to play.
//
// The board itself is the app's single instance; this view only says where it goes, with the
// anchor below.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { act, advise, seek, setPace, start, stepOnce, toLineup, togglePause } from "../game";
import { GROUP, PROMPTS, actionKey, fmtDelta, label, roundOf, rows, turnSeat, who, type Row } from "../labels";
import { SEAT_FILL } from "../board/palette";
import Dock from "../Dock";
import { isAnswer, logLine, narrate, newsworthy, offerAnswers, titleHolder, titleText } from "../coach";
import { openGameAnalysis, openMoveAnalysis, rowAt, turns } from "../review";
import { playing, set, useApp, you, type Pace, type State } from "../store";
import { waiting } from "../waiting";
import Coach from "./Coach";
import Ring from "./Ring";
import Seats from "./Seats";
import Strip from "./Strip";
import Tray, { OfferOut, Thrown, TradeOffer } from "./Tray";
import Offer from "./Offer";
import Fx from "./Fx";

/** The board takes builds and the robber; the column takes the standing actions. Everything
 *  else the engine offers goes to the panel, in full — a position with no surface for one of
 *  its legal actions is a position you cannot play. */
const ONBOARD = new Set(["BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "MOVE_ROBBER"]);
/** The tray's own: the dice, the end of the turn, the building and development cards, and the
 *  trade builder (offers to players and to the bank). */
const INTRAY = new Set(["BUY_DEVELOPMENT_CARD", "ROLL", "END_TURN", "OFFER_TRADE", "MARITIME_TRADE",
                        "PLAY_KNIGHT_CARD", "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_ROAD_BUILDING"]);
/** The answers the trade-offer panel carries. */
const ANSWER = new Set(["ACCEPT_TRADE", "REJECT_TRADE"]);
/** The right column sits beside the analysis fold, which owns the last 84px of the edge. Its
 *  numbers live in index.css (--ask-r, --ask-w), where the board's sizing reserves the room. */
const RIGHT = { position: "absolute", right: "var(--ask-r)", width: "var(--ask-w)" } as const;
/** The seek bar: board-width up to a reading length, but centred on the screen and staying
 *  there. It deliberately does not track --board-x — the board slides aside for the coach and
 *  the transport it is read against should not slide with it. */
const STRIP_W = "min(var(--board-w), 620px)";
const STRIP_X = { left: `calc(var(--strip-x) - ${STRIP_W} / 2)`, width: STRIP_W } as const;
/** The left column — the seats, and under them the log — and how far above the floor it stops:
 *  seated, the tray's height. */
const COLUMN = { position: "absolute", left: 34, top: 72, width: "calc(var(--rail-r) - 48px)", display: "flex", flexDirection: "column", gap: 20 } as const;
const TRAY_H = 150;

/** The index of the position on screen: the playhead in the stands, the step being looked
 *  back at, or the live position. */
const shown = (s: State) => Math.max(0, Math.min(s.step ?? s.view!.steps, s.frames.length - 1));

/** What happened, newest first, straight under the seats it happened to, filling the column
 *  down to the tray and scrolling past that. */
const LOG_ROWS = 60;
function Log({ s }: { s: State }) {
  const upTo = shown(s);
  const { frames, map } = s;
  const me = you(s);
  const rows = useMemo(() => {
    const out: { i: number; text: string; seat: number; you: boolean }[] = [];
    // Since your last turn ended: what happened to you in it stays in view until you are back.
    let since = -1;
    for (let i = upTo - 1; i >= 0; i--) if (frames[i].seat === me && frames[i].action?.[0] === "END_TURN") { since = i; break; }
    for (let i = upTo - 1; i >= 0 && out.length < LOG_ROWS; i--) {
      // Longest Road and Largest Army change hands without an action of their own.
      const a = frames[i]?.view, b = frames[i + 1]?.view;
      if (a && b) for (const kind of ["road", "army"] as const) {
        const from = titleHolder(a, kind), to = titleHolder(b, kind);
        if (from !== to) out.push({ i, text: titleText(kind, from, to, me), seat: to >= 0 ? to : from, you: me >= 0 && i > since && (from === me || to === me) });
      }
      const row = rowAt(frames, i);
      if (!row || !newsworthy(row.action) || isAnswer(row.action) || !map) continue;
      // About you: another seat's move that cost you cards (robber, monopoly) or traded with you.
      const hit = me >= 0 && row.seat !== me && i > since
        && ((row.gains[me] ?? []).some((n) => n < 0) || (row.action[0] === "CONFIRM_TRADE" && row.action[1] === me));
      out.push({ i, text: logLine(row, map, me, frames, i), seat: row.seat, you: hit });
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
    const ro = new ResizeObserver(read);          // a resize can end the clipping
    ro.observe(el);
    return () => { el.removeEventListener("scroll", read); ro.disconnect(); };
  });
  if (!map) return null;
  return (
    <div className="log" ref={box}>
      {rows.length === 0 && <div className="cap">Nothing has happened yet.</div>}
      {rows.map(({ i, text, seat, you: hit }, k) => (
        <div key={`${i}:${text}`} className={`line${hit ? " you" : ""}`} style={{ display: "flex", gap: 8, lineHeight: 1.4, fontSize: k === 0 ? 13.5 : 12.5, color: k === 0 || hit ? "var(--color-pine)" : "var(--color-moss)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 7px", marginTop: 6, background: SEAT_FILL[seat] }} />
          <span>{text}</span>
        </div>
      ))}
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
      {/* The step is always there — it is how a move is found again. Seated at the live position
          the head and the spine already say the round and whose turn, so the caption doesn't. */}
      <div className="cap num" style={{ marginTop: 6, fontSize: 11.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>step {at} of {last}{done || playing(s) ? "" : " so far"}{looking || !playing(s) ? `, ${roundOf(s.frames, f.view).toLowerCase()}` : ""}</span>
        {!done && (looking || !playing(s)) && (() => {
          const turn = turnSeat(f.view);
          return (
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <i style={{ width: 7, height: 7, flex: "0 0 7px", background: SEAT_FILL[turn] }} />
              {who(turn, you(s))} {turn === you(s) ? "are" : "is"} up
            </span>
          );
        })()}
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
        {who(v.winner, me)} won in {roundOf(frames, v).toLowerCase()}
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
  // The rail reads the position on screen, like the board — seeking back shows those hands.
  const pv = s.frames[shown(s)]?.view ?? s.view!;
  const at = shown(s);
  return (
    <>
      <Dock name="table-seats" side="l" style={{ ...COLUMN, bottom: 26 }}>
        <Seats players={pv.players} you={-1} open current={turnSeat(pv)} stats={!pv.initial_phase} />
        <Log s={s} />
      </Dock>
      {!over && (
        <Dock name="table-transport" side="r" style={{ position: "absolute", right: 34, bottom: 26, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9 }}>
          {/* The dice land here, by the controls that drive the game — never over the tiles a
              roll is about to light. */}
          <Thrown frames={s.frames} at={at} live={s.step == null} />
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
  const discarding = waiting(s)?.kind === "discard";
  // A trade put to you gets its own panel, drawn as cards; so does your own offer going round,
  // and the one you are putting together.
  const offered = v.prompt === "DECIDE_TRADE" && v.current_player === s.human;
  const out = !offered && s.step == null ? offerAnswers(s.frames, shown(s), s.human) : null;
  const building = mine && s.offering;
  const rest = s.legal.filter((a) => !ONBOARD.has(a[0]) && !INTRAY.has(a[0]) && !(offered && ANSWER.has(a[0]))
                                  && !(out && (a[0] === "CONFIRM_TRADE" || a[0] === "CANCEL_TRADE")));
  // Inside a drill-down the group is already the whole list; outside it, fold the long ones.
  const listed: Row[] =
    s.pending ? s.pending.actions.map((a) => ({ a, group: null })) : rows(rest);
  const panel = s.pending ?? (rest.length
    ? {
        title: PROMPTS[v.prompt] ? `You have to ${PROMPTS[v.prompt]}`
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
      {/* Every seat, yours included — table information you can see across a real table — and
          under them, what they did. */}
      <Dock name="table-seats" side="l" style={{ ...COLUMN, bottom: TRAY_H }}>
        <Seats players={v.players} you={s.human} open={s.analysis} current={turnSeat(v)} stats={!v.initial_phase} />
        <Log s={s} />
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

      {/* The tray along the rim, centred under the board: the building cards, your hand, and the
          turn — what is happening, the trade, the dice, the end. */}
      <Dock name="table-tray" side="b" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: TRAY_H, pointerEvents: "none" }}>
        <Tray s={s} me={hand} mine={mine} over={over} at={at} gains={gains} devGains={devGains} />
      </Dock>

      {/* What is being asked, right above the tray's turn controls: a trade put to you, your own
          offer going round, the one you are building, or any legal action nothing else on the
          table covers. Bottom-anchored so it grows upward. */}
      {!over && !discarding && ((mine && (offered || panel || building)) || out) && (
        <Dock name="table-actions" side="r" style={{
          ...RIGHT, bottom: TRAY_H, top: s.analysis ? 520 : 96,
          display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-end", gap: 12,
          pointerEvents: "none",
        }}>
          {offered && mine && !building && <TradeOffer v={v} legal={s.legal} />}
          {out && <OfferOut out={out} v={v} legal={mine ? s.legal : []} />}
          {building && !out && <Offer />}
          {mine && panel && !building && (
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

  const at = shown(s);

  return (
    <>
      {/* where the board goes; layout decides, BoardLayer parks on it */}
      <div data-anchor="table" data-fit={seated ? "seated" : undefined} />
      <Ring off={seated && !s.analysis && !over} />
      {/* The opening's own furniture — the draft order — sits in the tray; a strip of a game
          that has barely started is only an empty bar. */}
      {!(seated && v.initial_phase && s.step == null) && <GameStrip s={s} over={over} />}
      {s.step == null && (seated || s.pace !== "fast") && <Fx frames={s.frames} at={at} map={map} you={you(s)} />}
      {seated ? <Seated s={s} over={over} /> : <Stands s={s} over={over} />}
      {over && <Ending s={s} />}
    </>
  );
}
