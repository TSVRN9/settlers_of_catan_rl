// Game analysis: the whole game's win-probability curve, and attribution rows that light the
// board on hover. The persistent board parks at the small `game` anchor, fed whichever step
// is being looked at through `boardOverride`.
import { useEffect, useRef, useState } from "react";
import type { Attribution, MapView, View } from "../engine";
import { SEAT_NAMES, fmtPct, label } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { EDGES } from "../board/geometry";
import { attributionAt, openMoveAnalysis, stopAutoplay, toggleAutoplay, topSwings } from "../review";
import { get, set, useApp } from "../store";

const GW = 880, GH = 200, PAD = 8;

/** The tiles an attribution group is actually about — "production"/"buildings" light the
 *  seat's own settled tiles, "roads" its road tiles, "robber" the robbed one. Everything
 *  else ("hand", "devs", "score", "bank") has no board location, so it lights nothing. */
function tilesForGroup(map: MapView, v: View, group: string, seat: number): number[] {
  if (group === "robber") return v.robber >= 0 ? [v.robber] : [];
  if (seat < 0) return [];
  let nodes: number[] = [];
  if (group === "production" || group === "buildings") {
    nodes = v.owner.flatMap((o, n) => (o === seat ? [n] : []));
  } else if (group === "roads") {
    nodes = EDGES.flatMap((e, i) => (v.road_owner[i] === seat ? e : []));
  } else {
    return [];
  }
  const nodeSet = new Set(nodes);
  return map.tiles.flatMap((t, i) => (t.nodes.some((n) => nodeSet.has(n)) ? [i] : []));
}

export default function Game() {
  const s = useApp();
  const map = s.map;
  const frames = s.review?.frames;
  const step = s.step;
  const [attr, setAttrState] = useState<Attribution[] | null>(null);
  const [litGroup, setLitGroup] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => stopAutoplay, []);   // leaving the view stops any running autoplay

  useEffect(() => {
    setAttrState(null);
    setLitGroup(null);
    if (step == null) return;
    void attributionAt(step, s.human).then((a) => { if (get().step === step) setAttrState(a); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const frame = frames && step != null ? frames[step] : null;

  useEffect(() => {
    if (!frame || !map) { set({ boardOverride: null }); return; }
    const lit = litGroup ? tilesForGroup(map, frame.view, litGroup, s.human) : undefined;
    set({ boardOverride: { view: frame.view, litTiles: lit } });
    return () => set({ boardOverride: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, litGroup]);

  if (!map || !frames || step == null || !frame) {
    return (
      <div className="cap" style={{ position: "absolute", left: 34, top: 26, width: 360 }}>
        Nothing to review yet — play a turn first.
      </div>
    );
  }

  const last = frames.length - 1;
  const mine = attr ? attr.filter((a) => a.seat === 0) : [];
  const maxDelta = Math.max(0.01, ...mine.map((a) => Math.abs(a.delta)));

  // "Where the game turned": the biggest single-step swings in the human's own win%.
  const swings = topSwings(frames, s.human, 5);

  const x = (i: number) => PAD + (i / last) * (GW - 2 * PAD);
  const y = (p: number) => PAD + (1 - p) * (GH - 2 * PAD);
  const scrub = (clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    set({ step: Math.round(frac * last) });
  };

  return (
    <>
      <div data-anchor="game" />

      <div style={{ position: "absolute", left: 34, top: 26, width: 600 }}>
        <div className="d" style={{ fontSize: 19 }}>You're {last} steps into this game</div>
        <div className="cap" style={{ marginTop: 4 }}>
          Scrub anywhere on the curve and the board follows. The marks are the moments the number moved most.
        </div>
      </div>

      <div className="cut" style={{ position: "absolute", right: 30, top: 26, display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--color-paper)" }}>
        <button className="act cut8" style={{ height: 30, width: 30, padding: 0 }} onClick={() => set({ step: Math.max(0, step - 1) })} disabled={step <= 0}>◀</button>
        <button className="act cut8" style={{ height: 30, width: 30, padding: 0 }} onClick={() => toggleAutoplay()} disabled={step >= last}>
          {s.reviewPlaying ? "❚❚" : "▶"}
        </button>
        <button className="act cut8" style={{ height: 30, width: 30, padding: 0 }} onClick={() => set({ step: Math.min(last, step + 1) })} disabled={step >= last}>▶</button>
        <span className="num cap" style={{ fontSize: 12 }}>{step} of {last}</span>
        <button className="act cut8" style={{ height: 30, fontSize: 11.5 }}
                onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#/g/${s.seed}/step/${step}`)}>
          Copy a link to this step
        </button>
      </div>

      <div className="cut" style={{ position: "absolute", left: 34, right: 34, top: 92, height: GH + 30, background: "var(--color-paper)", padding: "10px 12px" }}>
        <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
          {frame.view.players.map((_, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
              <i style={{ width: 8, height: 8, background: SEAT_FILL[i], display: "inline-block" }} />
              {i === s.human ? "You" : SEAT_NAMES[i]} {fmtPct(frame.evals[i]?.win)}
            </span>
          ))}
        </div>
        <svg ref={svgRef} viewBox={`0 0 ${GW} ${GH}`} width="100%" height={GH} style={{ display: "block", cursor: "pointer" }}
             onClick={(e) => scrub(e.clientX)}>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <line key={p} x1={PAD} x2={GW - PAD} y1={y(p)} y2={y(p)} stroke="var(--color-dust)" strokeWidth={p === 0.5 ? 1.5 : 1} strokeDasharray={p === 0.5 ? "3 3" : undefined} />
          ))}
          {swings.map((sw) => (
            <line key={sw.step} x1={x(sw.step)} x2={x(sw.step)} y1={PAD} y2={GH - PAD} stroke="var(--color-moss)" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
          ))}
          {frame.view.players.map((_, seat) => (
            <polyline key={seat} fill="none" stroke={SEAT_FILL[seat]} strokeWidth={seat === s.human ? 2.4 : 1.4}
                      opacity={seat === s.human ? 1 : 0.65}
                      points={frames.map((f, i) => `${x(i)},${y(f.evals[seat]?.win ?? 0.5)}`).join(" ")} />
          ))}
          <line x1={x(step)} x2={x(step)} y1={PAD} y2={GH - PAD} stroke="var(--color-pine)" strokeWidth={1.5} />
        </svg>
      </div>

      {/* Wide enough to contain [data-anchor="game"]'s own rect (17.639%/70.940%, up to
          ~46.560cqh across) — the persistent board paints above this panel's own content,
          so anything to its right has to clear the anchor's right edge or the board bleeds
          over it. */}
      <div className="cut" style={{ position: "absolute", left: 34, bottom: 26, width: 440, top: 92 + GH + 30 + 14, background: "var(--color-paper)", padding: "12px 13px", overflowY: "auto" }}>
        <div className="d" style={{ fontSize: 14 }}>The position at {step}</div>
        <div className="cap" style={{ marginTop: 6 }}>The board above is showing this moment.</div>
      </div>

      <div className="cut" style={{ position: "absolute", left: 490, bottom: 26, right: 396, top: 92 + GH + 30 + 14, background: "var(--color-paper)", padding: "12px 13px", overflowY: "auto" }}>
        <div className="d" style={{ fontSize: 14 }}>What the net is leaning on</div>
        <div className="cap" style={{ fontSize: 11.5, marginTop: 2 }}>leave one group out, and see how far the number moves</div>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {mine.length === 0 && <div className="cap">Nothing to weigh here.</div>}
          {mine.map((a) => (
            <div key={a.group} onMouseEnter={() => setLitGroup(a.group)} onMouseLeave={() => setLitGroup((g) => (g === a.group ? null : g))}
                 style={{ fontSize: 12, cursor: "default" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: litGroup === a.group ? 600 : 400 }}>{a.group}</span>
                <span className="d num" style={{ color: a.delta < 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
                  {a.delta >= 0 ? "+" : ""}{(100 * a.delta).toFixed(1)}
                </span>
              </div>
              <div style={{ position: "relative", height: 6, background: "var(--color-dust)", marginTop: 3 }}>
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--color-moss)" }} />
                <div style={{
                  position: "absolute", top: 0, bottom: 0,
                  ...(a.delta < 0
                    ? { right: "50%", width: `${50 * Math.abs(a.delta) / maxDelta}%`, background: "var(--color-wood)" }
                    : { left: "50%", width: `${50 * Math.abs(a.delta) / maxDelta}%`, background: "var(--color-brick)" }),
                }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="cut" style={{ position: "absolute", right: 30, bottom: 26, width: 356, top: 92 + GH + 30 + 14, background: "var(--color-paper)", padding: "12px 13px", overflowY: "auto" }}>
        <div className="d" style={{ fontSize: 14 }}>Where the game turned</div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {swings.map((sw) => (
            <button key={sw.step} className="cut8" style={{ textAlign: "left", border: 0, cursor: "pointer", background: "#e4e8dd", padding: "7px 9px" }}
                    onClick={() => openMoveAnalysis(sw.step - 1)}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span className="num" style={{ opacity: 0.7 }}>step {sw.step}</span>
                <span className="d num" style={{ color: sw.delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
                  {sw.delta >= 0 ? "+" : ""}{(100 * sw.delta).toFixed(1)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, marginTop: 2 }}>{sw.action ? label(sw.action, map) : "—"}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
