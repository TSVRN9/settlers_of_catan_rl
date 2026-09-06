// Move analysis: one decision, both bots on one ladder. Rank on the board is rank in the
// ladder — the persistent board parks at the (wider than Table's) `move` anchor, ringed on
// the net's first choice via `boardOverride`. Each row carries the net's reading and, beside
// it, where the heuristic ranked the same move; the disagreement between the two searches is
// argued with evidence for both candidates.
import { useEffect, useState } from "react";
import type { Canon, Decision } from "../engine";
import { fmtDelta, fmtPct, label, whom } from "../labels";
import { SEAT_FILL } from "../board/palette";
import Dock from "../Dock";
import { evidence, gap, narrate, noun, type Ctx } from "../coach";
import { rankedAt, rowAt, stopAutoplay, toggleAutoplay } from "../review";
import { get, set, useApp, you } from "../store";
import Strip from "./Strip";

const sortRoot = (d: Decision | null) =>
  (d ? [...d.root].filter(([, v]) => v != null).sort((a, b) => (b[1] as number) - (a[1] as number)) : []) as [Canon, number][];
const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}th`;

export default function Move() {
  const s = useApp();
  const map = s.map;
  const frames = s.frames;
  const step = s.step;
  const [net, setNet] = useState<Decision | null>(null);
  const [heur, setHeur] = useState<Decision | null>(null);

  useEffect(() => stopAutoplay, []);

  useEffect(() => {
    setNet(null);
    setHeur(null);
    if (step == null) return;
    void rankedAt(step, "vnet").then((d) => { if (get().step === step) setNet(d); });
    void rankedAt(step, "heuristic").then((d) => { if (get().step === step) setHeur(d); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const frame = step != null ? frames[step] : null;
  const netRanked = sortRoot(net), heurRanked = sortRoot(heur);
  const top = netRanked[0];
  const heurTop = heurRanked[0];

  useEffect(() => {
    if (!frame) { set({ boardOverride: null }); return; }
    set({ boardOverride: { view: frame.view, highlight: top?.[0] ?? null } });
    return () => set({ boardOverride: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, top?.[0] ? top[0].join(":") : null]);

  if (!map || step == null || !frame) {
    return (
      <div className="cap" style={{ position: "absolute", left: 34, top: 72, width: 360 }}>
        Nothing to review yet — play a turn first.
      </div>
    );
  }

  const me = you(s);
  const mover = frame.seat;
  const last = frames.length - 1;
  const ctx: Ctx = { map, view: frame.view, seat: mover, you: me };
  const stripFrom = Math.max(0, step - 2), stripTo = Math.min(last, step + 2);
  const around = Array.from({ length: stripTo - stripFrom + 1 }, (_, i) => stripFrom + i);
  const swing = (i: number) => (i < last ? (frames[i + 1].evals[frames[i].seat]?.win ?? 0) - (frames[i].evals[frames[i].seat]?.win ?? 0) : 0);
  const maxSwing = Math.max(0.01, ...around.map((i) => Math.abs(swing(i))));
  const heurRank = (a: Canon) => heurRanked.findIndex(([b]) => b.join(":") === a.join(":"));
  const disagree = net && heur && top && heurTop && top[0].join(":") !== heurTop[0].join(":");
  const heurRankInNet = heurTop ? netRanked.findIndex(([a]) => a.join(":") === heurTop[0].join(":")) : -1;

  return (
    <>
      <div data-anchor="move" />

      <Dock name="move-transport" side="t" style={{ position: "absolute", right: 30, top: 26, display: "flex", alignItems: "center", gap: 8 }}>
        <button className="act cut8" style={{ height: 30, width: 34, padding: 0 }} onClick={() => set({ step: Math.max(0, step - 1) })} disabled={step <= 0} aria-label="One step back">◀</button>
        <button className="act cut8 go" style={{ height: 30, minWidth: 70 }} onClick={() => toggleAutoplay()} disabled={step >= last}>{s.reviewPlaying ? "Pause" : "Play"}</button>
        <button className="act cut8" style={{ height: 30, width: 34, padding: 0 }} onClick={() => set({ step: Math.min(last, step + 1) })} disabled={step >= last} aria-label="One step on">▶</button>
        <span className="num" style={{ fontSize: 13, marginLeft: 6 }}><b className="d" style={{ fontSize: 15 }}>{step}</b> <span className="cap">of {last}</span></span>
      </Dock>

      <Dock name="move-strip" side="t" style={{ position: "absolute", left: 34, right: 34, top: 76 }}>
        <Strip frames={frames} step={step} you={me} onSeek={(at) => { stopAutoplay(); set({ step: at }); }} />
      </Dock>

      <Dock name="move-ladder" side="r" className="cut" style={{
        position: "absolute", right: 30, top: 122, bottom: 26, width: 710,
        background: "var(--color-paper)", padding: "13px 14px 12px", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="d" style={{ fontSize: 17, flex: 1 }}>What {whom(mover, me)} weighed</span>
          {net && <span className="cap" style={{ fontSize: 11 }}>two turns deep, {net.leaves.toLocaleString()} positions, {Math.round(net.ms)} ms</span>}
        </div>

        <div className="cap" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, marginTop: 10, padding: "0 6px" }}>
          <span style={{ width: 16, flex: "0 0 16px" }} />
          <span style={{ flex: 1 }} />
          <span style={{ width: 190, flex: "0 0 190px" }}>value net</span>
          <span style={{ width: 50 }} />
          <span style={{ width: 62, textAlign: "right" }}>heuristic</span>
        </div>
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 80 }}>
          {!net ? (
            <div className="cap arrive">Thinking…</div>
          ) : netRanked.length === 0 ? (
            <div className="cap">Nothing to weigh — one move is forced.</div>
          ) : (
            netRanked.map(([a, val], i) => {
              const h = heurRank(a);
              const theirs = heurTop && heurTop[0].join(":") === a.join(":");
              return (
                <div key={a.join(":")} className="arrive" style={{
                  display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, padding: "3px 6px", margin: "0 -6px",
                  boxShadow: theirs ? "inset 0 0 0 1.5px var(--color-pine)" : undefined,
                }}>
                  <span className="num" style={{ width: 16, flex: "0 0 16px", color: i === 0 ? "var(--color-wheat)" : "var(--color-moss)", fontWeight: 700 }}>{i + 1}</span>
                  <span style={{ flex: 1, fontWeight: i === 0 ? 600 : 400 }}>{label(a, map)}</span>
                  <span style={{ width: 190, height: 8, background: "var(--color-dust)", flex: "0 0 190px" }}>
                    <span className="track" style={{ display: "block", height: "100%", width: `${top ? (val / top[1]) * 100 : 0}%`, background: i === 0 ? "var(--color-wheat)" : "#c8b98a" }} />
                  </span>
                  <span className="d num" style={{ width: 50, textAlign: "right" }}>{fmtPct(val)}</span>
                  <span className="num" style={{ width: 62, textAlign: "right", color: theirs ? "var(--color-pine)" : "var(--color-moss)", fontWeight: theirs ? 700 : 400 }}>
                    {!heur ? "…" : h < 0 ? "—" : ordinal(h)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {net && heur && (top || heurTop) && (
          <div className="cut8 arrive dock-b" style={{ background: "var(--color-pine)", color: "var(--color-chalk)", padding: "12px 13px", marginTop: 12, fontSize: 12.5, lineHeight: 1.5 }}>
            {disagree && heurTop && top ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="d" style={{ fontSize: 15 }}>The two bots disagree here</span>
                  <span className="cap" style={{ color: "var(--color-dust)", fontSize: 11.5 }}>{heurRankInNet >= 0 ? `the net has it ${ordinal(heurRankInNet)}` : "not in the net's top"}</span>
                </div>
                <div style={{ marginTop: 6 }}>
                  The heuristic wants {noun(heurTop[0], ctx)}: {evidence(heurTop[0], ctx) || "it counts pips."} The net takes{" "}
                  <b style={{ color: "var(--color-wheat)" }}>{noun(top[0], ctx)}</b>: {evidence(top[0], ctx) || "it reads the position further out."}{" "}
                  {gap(top[0], heurTop[0], ctx)} It is <b style={{ color: "var(--color-wheat)" }}>{fmtDelta(top[1] - (netRanked[heurRankInNet]?.[1] ?? 0))}</b> ahead by the net's own reading.
                </div>
              </>
            ) : (
              <>The two bots agree: {noun((top ?? heurTop!)[0], ctx)}.</>
            )}
          </div>
        )}

        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--color-dust)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ font: "600 12.5px var(--font-sans)" }}>Steps either side</span>
            <span className="cap" style={{ fontSize: 11.5 }}>how much the mover's chance moved</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {around.map((i) => {
              const f = frames[i];
              const on = i === step;
              const r = rowAt(frames, i);
              const d = swing(i);
              return (
                <button key={i} className="cut8" style={{
                  flex: 1, minWidth: 0, padding: "7px 8px", textAlign: "left", border: 0, cursor: "pointer", font: "inherit",
                  background: on ? "var(--color-wheat)" : "var(--color-tint)", color: "var(--color-pine)",
                  transition: "background var(--t-feel) var(--ease)",
                }} onClick={() => set({ step: i })}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="num" style={{ fontSize: 10.5, opacity: 0.7 }}>{i}</span>
                    <i style={{ width: 7, height: 7, borderRadius: "50%", background: SEAT_FILL[f.seat], marginLeft: "auto" }} />
                  </div>
                  <div style={{ fontSize: 11, marginTop: 2, lineHeight: 1.3, height: 29, overflow: "hidden" }}>
                    {on ? "Deciding now" : r ? narrate(r, map, me) : "The end"}
                  </div>
                  <div style={{ height: 5, background: "rgba(18,33,31,.12)", marginTop: 5 }}>
                    <div className="track" style={{ height: "100%", width: `${(Math.abs(d) / maxSwing) * 100}%`, background: d >= 0 ? "var(--color-wood)" : "var(--color-brick)" }} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </Dock>
    </>
  );
}
