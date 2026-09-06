// Game analysis: who was winning, all game. The curve fills its panel and the click zone is
// the curve; hovering reads a step; the turning points sit on the axis. The persistent board
// parks at the small `game` anchor, fed whichever step is being looked at through
// `boardOverride`, with the mover's producing tiles outlined.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isStale } from "../engine";
import type { Attribution, LuckRoll } from "../engine";
import { fmtDelta, fmtPct, who, whom, whose } from "../labels";
import { SEAT_FILL } from "../board/palette";
import Dock from "../Dock";
import { groupText, narrate, num } from "../coach";
import { deciding, pointOfNoReturn, worstLuckWindow } from "../deciding";
import { attributionAt, events, luckRolls, luckTotals, openMoveAnalysis, rowAt, stopAutoplay, tilesForGroup, toggleAutoplay } from "../review";
import { get, set, useApp, you } from "../store";

const PANEL_TOP = 92, CHART_H = 156, SPLIT = 392;
const MARK = 15, MARK_ROW = 17, CAP_ROW = 14, GAP = 6;

/** Rows for things laid along one axis: each takes the first row where it does not touch
 *  what is already there. Returns -1 for something that would need more rows than allowed. */
function lanes(items: { x: number; w: number }[], max: number): number[] {
  const taken: [number, number][][] = [];
  return items.map(({ x, w }) => {
    const a = x - w / 2, b = x + w / 2;
    for (let r = 0; r < max; r++) {
      taken[r] ??= [];
      if (taken[r].every(([p, q]) => b + GAP <= p || a - GAP >= q)) { taken[r].push([a, b]); return r; }
    }
    return -1;
  });
}

const paper = { background: "var(--color-paper)", padding: "12px 14px" } as const;

export default function Game() {
  const s = useApp();
  const map = s.map;
  const frames = s.frames;
  const step = s.step;
  const [attr, setAttr] = useState<Attribution[] | null>(null);
  const [lit, setLit] = useState<{ group: string; seat: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The turning-point row being read in the panel, so its mark on the curve lights up.
  const [lift, setLift] = useState<number | null>(null);
  const [luck, setLuck] = useState<LuckRoll[] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  // The axis lays its markers and captions out in pixels, so it needs its own width.
  const axisRef = useRef<HTMLDivElement>(null);
  const [axisW, setAxisW] = useState(0);
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAxisW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => stopAutoplay, []);   // leaving the view stops any running autoplay

  // ~0.8 s of counterfactual replays on the review worker, and only once the game is over: a
  // running game's frames grow every batch, and keying this on their length would restart the
  // whole pass eight frames later, forever. It is a whole-game statement anyway.
  // A failure leaves the luck panel out rather than the view — everything else on this screen
  // reads frames the game already carries.
  const over = frames.length > 0 && frames[frames.length - 1].view.winner >= 0;
  useEffect(() => {
    if (!over) { setLuck(null); return; }
    let live = true;
    void luckRolls().then((r) => { if (live) setLuck(r); },
      (e) => { if (!isStale(e)) console.warn("luck pass failed", e); });
    return () => { live = false; };
  }, [over, frames.length]);

  const frame = frames && step != null ? frames[step] : null;
  const mover = frame?.seat ?? 0;

  useEffect(() => {
    setAttr(null);
    setLit(null);
    if (step == null || !frame) return;
    void attributionAt(step, mover).then((a) => { if (get().step === step) setAttr(a); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (!frame || !map) { set({ boardOverride: null }); return; }
    const tiles = lit ? tilesForGroup(map, frame.view, lit.group, lit.seat) : tilesForGroup(map, frame.view, "production", mover);
    set({ boardOverride: { view: frame.view, litTiles: tiles } });
    return () => set({ boardOverride: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, lit]);

  if (!map || step == null || !frame) {
    return (
      <div className="cap" style={{ position: "absolute", left: 34, top: 26, width: 360 }}>
        Nothing to review yet — play a turn first.
      </div>
    );
  }

  const me = you(s);
  const n = frame.view.n;
  const last = frames.length - 1;
  const ev = events(frames, me);
  const moments = deciding(frames);
  // Threshold-free, and null in the 15% of games where the last lead change is the winning move.
  const ponr = pointOfNoReturn(frames, frames[last].view.winner);
  function swingAt(i: number, seat: number) {
    const a = frames![Math.min(i + 1, last)].evals[seat]?.win ?? 0.5, b = frames![i].evals[seat]?.win ?? 0.5;
    return a - b;
  }
  // The axis: every marker gets a row (two adjacent steps stack rather than overlap); the six
  // biggest moments get a caption, laid out the same way, and a caption that would need a
  // third row is dropped — its marker keeps the text as a title.
  const px = (i: number) => (i / Math.max(1, last)) * axisW;
  const markRow = lanes(ev.map((e) => ({ x: px(e.step), w: MARK })), 3);
  const capW = (text: string) => text.length * 5.4 + 6;
  const bySwing = [...ev.keys()].sort((a, b) => Math.abs(swingAt(ev[b].step, ev[b].seat)) - Math.abs(swingAt(ev[a].step, ev[a].seat))).slice(0, 6);
  const capX = (i: number) => { const w = capW(ev[i].text); return Math.max(w / 2, Math.min(axisW - w / 2, px(ev[i].step))); };
  const capRowBy = lanes(bySwing.map((i) => ({ x: capX(i), w: capW(ev[i].text) })), 2);
  const capRow = new Map(bySwing.map((i, k) => [i, capRowBy[k]]));
  const markRows = Math.max(1, ...markRow.map((r) => r + 1));

  // The chart is drawn in step × percent units and stretched to its box, so a pointer's
  // x maps straight back to a step through the SVG's own matrix — the click zone is the curve.
  const toStep = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return step;
    const p = new DOMPoint(clientX, 0).matrixTransform(svg.getScreenCTM()!.inverse());
    return Math.max(0, Math.min(last, Math.round(p.x)));
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    stopAutoplay();
    set({ step: toStep(e.clientX) });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const at = toStep(e.clientX);
    if (dragging.current) set({ step: at });
    setHover(at);
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  const hf = hover != null ? frames[hover] : null;
  const band = hf ? (() => {
    const t = hf.view.current_turn;
    let a = hover!, b = hover!;
    while (a > 0 && frames[a - 1].view.current_turn === t) a--;
    while (b < last && frames[b + 1].view.current_turn === t) b++;
    return [a, b] as const;
  })() : null;
  const hoverRow = hover != null ? rowAt(frames, hover) : null;
  const nowRow = rowAt(frames, step);
  const nowDelta = swingAt(step, mover);
  // Totals only. A single roll's luck sits barely above the net's own noise, so nothing here
  // names one roll; the run below is five of them, and the panel shows per-seat sums.
  const lk = luck && luck.length ? luckTotals(luck, n) : null;
  const worstSeat = lk ? lk.totals.reduce((b, v, i) => (v < lk.totals[b] ? i : b), 0) : -1;
  const luckScale = lk ? Math.max(0.05, ...lk.curves.flat().map(Math.abs)) : 1;
  const luckRun = (() => {
    if (!luck || worstSeat < 0) return null;
    const w = worstLuckWindow(luck.map((r) => ({ step: r.step, luck: r.luck[worstSeat] ?? 0 })));
    return w && { ...w, seat: worstSeat };
  })();
  // What the same rolls paid everyone else. Reading this against the seat's own curve instead
  // would be wrong in a way that looks right: crossing a ROLL carries a systematic +0.009 to the
  // roller and −0.022 to each idle seat, so five consecutive rolls hold about −0.07 of pure
  // turn-order bookkeeping — larger than the gap anyone would be reading. Luck against luck is
  // the only comparison the decomposition supports.
  const runLuck = luckRun && luck ? (() => {
    const by = new Array<number>(n).fill(0);
    for (const r of luck) if (r.step >= luckRun.from && r.step <= luckRun.to)
      for (let k = 0; k < n; k++) by[k] += r.luck[k] ?? 0;
    return { by, best: by.reduce((b, v, i) => (v > by[b] ? i : b), 0) };
  })() : null;
  const inRun = luckRun != null && hover != null && hover >= luckRun.from && hover <= luckRun.to;
  // One set of words for the panel and the badge, so the two can never disagree.
  const runText = luckRun && lk && runLuck ? {
    head: `${whose(luckRun.seat, me)} worst five rolls`,
    span: `steps ${luckRun.from}\u2013${luckRun.to}`,
    totals: `${fmtDelta(luckRun.total)} across them, ${fmtDelta(lk.totals[luckRun.seat])} all game`,
    paid: runLuck.by[runLuck.best] > 0 && runLuck.best !== luckRun.seat
      ? `same rolls paid ${who(runLuck.best, me)} ${fmtDelta(runLuck.by[runLuck.best])}` : null,
  } : null;

  const rows = attr ? [...attr].filter((a) => Math.abs(a.delta) > 0.0005).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6) : [];
  const maxDelta = Math.max(0.01, ...rows.map((a) => Math.abs(a.delta)));
  const absSeat = (a: Attribution) => (a.seat < 0 ? -1 : (mover + a.seat) % n);

  return (
    <>
      <div data-anchor="game" />

      <Dock name="game-transport" side="t" className="cut" style={{ position: "absolute", right: 30, top: 26, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--color-paper)" }}>
        <button className="act cut8" style={{ height: 30, width: 34, padding: 0 }} onClick={() => set({ step: Math.max(0, step - 1) })} disabled={step <= 0} aria-label="One step back">◀</button>
        <button className="act cut8 go" style={{ height: 30, minWidth: 70 }} onClick={() => toggleAutoplay()} disabled={step >= last}>
          {s.reviewPlaying ? "Pause" : "Play"}
        </button>
        <button className="act cut8" style={{ height: 30, width: 34, padding: 0 }} onClick={() => set({ step: Math.min(last, step + 1) })} disabled={step >= last} aria-label="One step on">▶</button>
        <span className="num" style={{ fontSize: 13, margin: "0 6px" }}><b className="d" style={{ fontSize: 15 }}>{step}</b> <span className="cap">of {last}</span></span>
        <button className="act cut8" style={{ height: 30, fontSize: 11.5 }}
                onClick={() => void navigator.clipboard.writeText(location.href)}>
          Copy a link to this step
        </button>
      </Dock>

      <Dock name="game-curve" side="t" className="cut" style={{ position: "absolute", left: 34, right: 34, top: PANEL_TOP, height: SPLIT - PANEL_TOP - 14, ...paper }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span className="d" style={{ fontSize: 17 }}>Who is winning, all game</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
            {frame.view.players.map((_, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                <i style={{ width: 8, height: 8, borderRadius: "50%", background: SEAT_FILL[i], display: "inline-block" }} />
                {who(i, me)} <b className="num">{fmtPct(frame.evals[i]?.win)}</b>
              </span>
            ))}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <div className="cap num" style={{ width: 26, flex: "0 0 26px", height: CHART_H, display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 10.5, textAlign: "right", lineHeight: 1 }}>
            {[100, 75, 50, 25, 0].map((p) => <span key={p}>{p}</span>)}
          </div>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <svg ref={svgRef} viewBox={`0 0 ${Math.max(1, last)} 100`} preserveAspectRatio="none" width="100%" height={CHART_H}
                 style={{ display: "block", cursor: "col-resize", touchAction: "none" }}
                 onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)}>
              {[0, 25, 50, 75, 100].map((p) => (
                <line key={p} x1={0} x2={last} y1={100 - p} y2={100 - p} stroke="var(--color-dust)" strokeWidth={p === 50 ? 1.5 : 1}
                      strokeDasharray={p === 50 ? "3 3" : undefined} vectorEffect="non-scaling-stroke" />
              ))}
              {band && <rect x={band[0]} y={0} width={Math.max(0.5, band[1] - band[0])} height={100} fill="var(--color-wheat)" opacity={0.18} />}
              {/* The stretch where the dice were worst to one seat: five rolls, not the maximum
                  drawdown, whose median span is 42% of the game — most of the match, not a story. */}
              {luckRun && (
                <rect x={luckRun.from} y={0} width={Math.max(0.5, luckRun.to - luckRun.from)} height={100}
                      fill={SEAT_FILL[luckRun.seat]} opacity={inRun ? 0.2 : 0.12} />
              )}
              {/* Every deciding move, full height so it cannot be missed, with the stretch the move
                  actually moved drawn solid over it: the dash marks the moment, the solid part is
                  its size. Dash arrays are in y-units — the viewBox is stretched on x and
                  `non-scaling-stroke` fixes width only — so "4 3" reads about 6px on, 5px off at
                  CHART_H. The dot is an ellipse for the same reason: a circle would not be one. */}
              {moments.map((m) => {
                const y0 = 100 - 100 * (frames[m.step].evals[m.seat]?.win ?? 0.5);
                const y1 = 100 - 100 * (frames[m.step + 1].evals[m.seat]?.win ?? 0.5);
                const on = step === m.step || lift === m.step;
                return (
                  <g key={`d${m.step}`}>
                    <line x1={m.step} x2={m.step} y1={0} y2={100} stroke={SEAT_FILL[m.seat]}
                          strokeWidth={on ? 1.6 : 1.2} strokeDasharray="4 3" opacity={on ? 0.9 : 0.5}
                          vectorEffect="non-scaling-stroke" />
                    <line x1={m.step} x2={m.step} y1={y0} y2={y1} stroke={SEAT_FILL[m.seat]}
                          strokeWidth={on ? 3.5 : 2.5} vectorEffect="non-scaling-stroke">
                      <title>{`Step ${m.step}: ${fmtDelta(m.delta)} to ${who(m.seat, me)}`}</title>
                    </line>
                    {axisW > 0 && (
                      <ellipse cx={m.step} cy={y1} rx={(on ? 3 : 2.2) * Math.max(1, last) / axisW}
                               ry={(on ? 3 : 2.2) * 100 / CHART_H} fill={SEAT_FILL[m.seat]} />
                    )}
                  </g>
                );
              })}
              {/* The step after which the winner never trailed again. Moss and finely dotted, so it
                  cannot be read as the solid pine current-step line below. */}
              {ponr != null && (
                <line x1={ponr} x2={ponr} y1={0} y2={100} stroke="var(--color-moss)" strokeWidth={1}
                      strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
              )}
              {frame.view.players.map((_, seat) => (
                <polyline key={seat} fill="none" stroke={SEAT_FILL[seat]} strokeWidth={seat === me ? 2.4 : 1.5}
                          opacity={seat === me || me < 0 ? 1 : 0.65} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
                          points={frames.map((f, i) => `${i},${100 - 100 * (f.evals[seat]?.win ?? 0.5)}`).join(" ")} />
              ))}
              <line x1={step} x2={step} y1={0} y2={100} stroke="var(--color-pine)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </svg>

            {/* the turning points, on the axis */}
            <div ref={axisRef} style={{ position: "relative", height: markRows * MARK_ROW + 2 * CAP_ROW + 2, marginTop: 4 }}>
              {ev.map((e, i) => (
                <button key={`m${e.step}-${i}`} className="num" title={e.text} onClick={() => set({ step: e.step })} style={{
                  position: "absolute", left: px(e.step), top: markRow[i] * MARK_ROW, transform: "translateX(-50%)",
                  width: MARK, height: MARK, borderRadius: "50%", border: 0, padding: 0, cursor: "pointer",
                  background: SEAT_FILL[e.seat], color: e.seat === 3 ? "var(--color-pine)" : "var(--color-chalk)", font: "700 9px var(--font-sans)",
                }}>{e.letter}</button>
              ))}
              {ponr != null && (
                <div className="cap" title="After this the winner never trailed again" style={{
                  position: "absolute", left: px(ponr), top: -3, transform: "translateX(-50%)",
                  fontSize: 9, lineHeight: 1, color: "var(--color-moss)", pointerEvents: "none",
                }}>&#9650;</div>
              )}
              {axisW > 0 && ev.map((e, i) => {
                const r = capRow.get(i);
                if (r == null || r < 0) return null;
                return (
                  <div key={`c${e.step}-${i}`} className="cap" style={{
                    position: "absolute", left: capX(i), top: markRows * MARK_ROW + 2 + r * CAP_ROW, transform: "translateX(-50%)",
                    fontSize: 10.5, lineHeight: 1, whiteSpace: "nowrap",
                  }}>{e.text}</div>
                );
              })}
            </div>

            {hf && (
              <div className="cut8" style={{
                position: "absolute", top: 8, left: `${(hover! / Math.max(1, last)) * 100}%`,
                transform: hover! / Math.max(1, last) > 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
                background: "var(--color-pine)", color: "var(--color-chalk)", padding: "9px 11px", width: 200, pointerEvents: "none", fontSize: 12, lineHeight: 1.45,
              }}>
                {inRun && runText && (
                  <div className="cut8" style={{
                    background: SEAT_FILL[luckRun!.seat], color: luckRun!.seat === 3 ? "var(--color-pine)" : "var(--color-chalk)",
                    padding: "5px 7px", marginBottom: 8, fontSize: 11, lineHeight: 1.4,
                  }}>
                    <b>{runText.head}</b><br />{runText.totals}
                    {runText.paid && <><br />{runText.paid}</>}
                  </div>
                )}
                <div className="cap" style={{ color: "var(--color-dust)", fontSize: 11.5 }}>Step {hover}, turn {hf.view.num_turns}, {who(hf.seat, me)} to move</div>
                {hf.view.players.map((_, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <i style={{ width: 7, height: 7, borderRadius: "50%", background: SEAT_FILL[i] }} />
                    <span style={{ flex: 1, fontWeight: i === hf.seat ? 600 : 400 }}>{who(i, me)}</span>
                    <span className="num" style={{ fontWeight: i === hf.seat ? 700 : 400 }}>{fmtPct(hf.evals[i]?.win)}</span>
                  </div>
                ))}
                {hoverRow && <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(238,240,233,.25)" }}>{narrate(hoverRow, map, me)}</div>}
              </div>
            )}
          </div>
        </div>
      </Dock>

      {/* The board parks below this, at [data-anchor="game"]. */}
      <Dock name="game-position" side="l" style={{ position: "absolute", left: 34, top: SPLIT, width: 420, display: "flex", alignItems: "baseline", gap: 12 }}>
        <span className="d" style={{ fontSize: 17 }}>The position now</span>
        <span className="cap" style={{ fontSize: 12 }}>
          {lit ? `outlined: ${groupText({ group: lit.group, seat: (lit.seat - mover + n) % n, delta: 0 }, mover, n, me)}`
               : `outlined: the ${num(tilesForGroup(map, frame.view, "production", mover).length)} tiles ${whom(mover, me)} draw${mover === me ? "" : "s"} from`}
        </span>
      </Dock>

      <Dock name="game-lean" side="b" className="cut" style={{ position: "absolute", left: 490, right: 396, top: SPLIT, bottom: 26, ...paper, overflowY: "auto" }}>
        <div className="d" style={{ fontSize: 15 }}>What the net is leaning on</div>
        <div className="cap" style={{ fontSize: 12, marginTop: 4 }}>
          What {whose(mover, me)} reading would lose without each: green carries {mover === me ? "you" : "them"}, red works against {mover === me ? "you" : "them"}.
        </div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
          {!attr && <div className="cap arrive">Reading the position…</div>}
          {attr && rows.length === 0 && <div className="cap">Nothing to weigh here.</div>}
          {rows.map((a) => {
            const on = lit?.group === a.group && lit.seat === absSeat(a);
            return (
              <div key={`${a.seat}:${a.group}`} className="arrive"
                   onMouseEnter={() => setLit({ group: a.group, seat: absSeat(a) })}
                   onMouseLeave={() => setLit((g) => (g?.group === a.group ? null : g))}
                   style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12.5, cursor: "default", background: on ? "var(--color-tint)" : undefined, padding: "3px 6px", margin: "0 -6px" }}>
                <span style={{ width: 150, flex: "0 0 150px", fontWeight: on ? 600 : 400 }}>{groupText(a, mover, n, me)}</span>
                <span style={{ position: "relative", flex: 1, height: 8, background: "var(--color-dust)" }}>
                  <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1.5, background: "var(--color-pine)" }} />
                  <span className="track" style={{
                    position: "absolute", top: 0, bottom: 0,
                    ...(a.delta < 0
                      ? { right: "50%", width: `${50 * Math.abs(a.delta) / maxDelta}%`, background: "var(--color-wood)" }
                      : { left: "50%", width: `${50 * Math.abs(a.delta) / maxDelta}%`, background: "var(--color-brick)" }),
                  }} />
                </span>
                <span className="d num" style={{ width: 46, textAlign: "right", color: a.delta < 0 ? "var(--color-wood)" : "var(--color-brick)" }}>{fmtDelta(a.delta)}</span>
              </div>
            );
          })}
        </div>
      </Dock>

      <Dock name="game-turns" side="r" className="cut" style={{ position: "absolute", right: 30, bottom: 26, width: 356, top: SPLIT, ...paper, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span className="d" style={{ fontSize: 15 }}>Where the game turned</span>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
          {moments.length === 0 && (
            <div className="cap" style={{ fontSize: 12.5 }}>No single move decided this one.</div>
          )}
          {moments.map((m) => {
            const row = rowAt(frames, m.step);
            const on = step === m.step;
            return (
              <button key={m.step} className="cut8" onClick={() => set({ step: m.step })}
                      onMouseEnter={() => setLift(m.step)} onMouseLeave={() => setLift((k) => (k === m.step ? null : k))}
                      style={{
                display: "flex", alignItems: "center", gap: 9, textAlign: "left", border: 0, cursor: "pointer", padding: "7px 8px",
                background: on || lift === m.step ? "var(--color-tint)" : "transparent", font: "inherit", color: "inherit",
              }}>
                <span className="cap num" style={{ width: 30, flex: "0 0 30px", fontSize: 11.5 }}>{m.step}</span>
                <i style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px", background: SEAT_FILL[m.seat] }} />
                <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.35 }}>{row ? narrate(row, map, me) : "—"}</span>
                <span className="d num" style={{ color: m.delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>{fmtDelta(m.delta)}</span>
              </button>
            );
          })}
        </div>
        {lk && (
          <div style={{ marginTop: 16 }}>
            <div className="d" style={{ fontSize: 14 }}>How the dice fell</div>
            {frame.view.players.map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 12 }}>
                <i style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px", background: SEAT_FILL[i] }} />
                <span style={{ flex: 1, fontWeight: i === worstSeat ? 600 : 400 }}>{who(i, me)}</span>
                <svg viewBox={`0 0 ${Math.max(1, lk.curves[i].length - 1)} 100`} preserveAspectRatio="none"
                     width={56} height={14} style={{ flex: "0 0 56px", display: "block" }}>
                  <line x1={0} x2={Math.max(1, lk.curves[i].length - 1)} y1={50} y2={50}
                        stroke="var(--color-dust)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <polyline fill="none" stroke={SEAT_FILL[i]} strokeWidth={1.4} vectorEffect="non-scaling-stroke"
                            points={lk.curves[i].map((v, k) => `${k},${50 - 50 * (v / luckScale)}`).join(" ")} />
                </svg>
                <span className="num d" style={{ width: 44, textAlign: "right", color: lk.totals[i] >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
                  {fmtDelta(lk.totals[i])}
                </span>
              </div>
            ))}
            {runText && (
              <div className="cap" style={{ fontSize: 11.5, marginTop: 7, lineHeight: 1.5 }}>
                Shaded on the curve: {runText.head}, {runText.span}.<br />
                {runText.totals}{runText.paid && <> &#183; {runText.paid}</>}.
              </div>
            )}
          </div>
        )}
        <div className="cut8" style={{ marginTop: "auto", background: "var(--color-tint)", padding: "10px 12px", fontSize: 12.5, lineHeight: 1.45 }}>
          {nowRow
            ? <>At this step {narrate(nowRow, map, me).replace(/^./, (c) => c.toLowerCase())} — worth <b className="num">{fmtDelta(nowDelta)}</b> to {whom(mover, me)}.</>
            : frame.view.winner >= 0 ? <>The game ends here: {who(frame.view.winner, me)} won.</> : <>This is the live position, {whom(mover, me)} to move.</>}
          {nowRow && (
            <div style={{ marginTop: 8 }}>
              <button className="act cut8" style={{ height: 30, fontSize: 12 }} onClick={() => openMoveAnalysis(step)}>Open this decision</button>
            </div>
          )}
        </div>
      </Dock>
    </>
  );
}
