// Move analysis: one decision, both bots. Rank on the board is rank in the ladder — the
// persistent board parks at the (wider than Table's) `move` anchor, ringed on whichever row
// is being read, via `boardOverride`.
import { useEffect, useState } from "react";
import type { Canon, Decision } from "../engine";
import { label } from "../labels";
import { rankedAt } from "../review";
import { get, set, useApp } from "../store";

export default function Move() {
  const s = useApp();
  const map = s.map;
  const frames = s.review?.frames;
  const step = s.step;
  const [net, setNet] = useState<Decision | null>(null);
  const [heur, setHeur] = useState<Decision | null>(null);
  const [tab, setTab] = useState<"vnet" | "both">("vnet");

  useEffect(() => {
    setNet(null);
    setHeur(null);
    if (step == null) return;
    void rankedAt(step, "vnet").then((d) => { if (get().step === step) setNet(d); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (tab !== "both" || step == null || heur) return;
    void rankedAt(step, "heuristic").then((d) => { if (get().step === step) setHeur(d); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, step]);

  const frame = frames && step != null ? frames[step] : null;
  const ranked = net ? [...net.root].filter(([, v]) => v != null).sort((a, b) => (b[1] as number) - (a[1] as number)) : [];
  const heurTop = heur?.root.filter(([, v]) => v != null).sort((a, b) => (b[1] as number) - (a[1] as number))[0];

  useEffect(() => {
    if (!frame) { set({ boardOverride: null }); return; }
    set({ boardOverride: { view: frame.view, highlight: (ranked[0]?.[0] as Canon) ?? null } });
    return () => set({ boardOverride: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, ranked[0]?.[0] ? (ranked[0][0] as Canon).join(":") : null]);

  if (!map || !frames || step == null || !frame) {
    return (
      <div className="cap" style={{ position: "absolute", left: 34, top: 26, width: 360 }}>
        Nothing to review yet — play a turn first.
      </div>
    );
  }

  const top = ranked[0];
  const stripFrom = Math.max(0, step - 2), stripTo = Math.min(frames.length - 1, step + 2);
  const strip = Array.from({ length: stripTo - stripFrom + 1 }, (_, i) => stripFrom + i);

  return (
    <>
      <div data-anchor="move" />

      <div style={{ position: "absolute", left: 34, top: 26, width: 500 }}>
        <div className="d" style={{ fontSize: 19 }}>One decision, both bots</div>
        <div className="cap" style={{ marginTop: 4 }}>
          Step {step}. {net ? `${ranked.length} legal actions.` : "Thinking…"} Rank on the board is rank in the ladder.
        </div>
      </div>

      {top && (
        <div className="pill num" style={{ position: "absolute", left: 34, bottom: 200 }}>
          rank 1 — {(100 * (top[1] as number)).toFixed(1)}%
        </div>
      )}

      <div className="cut" style={{
        position: "absolute", right: 30, top: 92, bottom: 26, width: 460,
        background: "var(--color-paper)", padding: "13px 14px 12px", display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="d" style={{ fontSize: 15, flex: 1 }}>What the net weighed</span>
          {net && <span className="cap" style={{ fontSize: 11 }}>two turns deep, {net.leaves.toLocaleString()} positions, {Math.round(net.ms)} ms</span>}
        </div>

        <div style={{ display: "flex", gap: 2, marginTop: 11 }}>
          {(["vnet", "both"] as const).map((t) => (
            <button key={t} className="cut8" style={{
              padding: "6px 12px", font: "600 12px var(--font-sans)", border: 0, cursor: "pointer",
              background: tab === t ? "var(--color-pine)" : "#e4e8dd", color: tab === t ? "var(--color-chalk)" : "var(--color-moss)",
            }} onClick={() => setTab(t)}>
              {t === "vnet" ? "Value net" : "Both at once"}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5, overflowY: "auto", flex: 1 }}>
          {!net ? (
            <div className="cap">Thinking…</div>
          ) : ranked.length === 0 ? (
            <div className="cap">Nothing to weigh — one move is forced.</div>
          ) : (
            ranked.map(([a, val], i) => {
              const isHeurTop = tab === "both" && heurTop && (heurTop[0] as Canon).join(":") === (a as Canon).join(":");
              return (
                <div key={(a as Canon).join(":")} style={{
                  display: "flex", alignItems: "center", gap: 8, fontSize: 12.5,
                  background: isHeurTop ? "linear-gradient(90deg, rgba(226,174,63,.18), transparent)" : undefined,
                }}>
                  <span className="cap num" style={{ width: 14, flex: "0 0 14px", fontSize: 11.5 }}>{i + 1}</span>
                  <span style={{ flex: 1, fontWeight: i === 0 ? 600 : 400 }}>{label(a as Canon, map)}</span>
                  <span style={{ width: 90, height: 8, background: "var(--color-dust)", flex: "0 0 90px" }}>
                    <span style={{ display: "block", height: "100%", width: `${top ? ((val as number) / (top[1] as number)) * 100 : 0}%`, background: i === 0 ? "var(--color-wheat)" : "var(--color-dust)" }} />
                  </span>
                  <span className="d num" style={{ width: 46, textAlign: "right" }}>{(100 * (val as number)).toFixed(1)}%</span>
                  <span style={{ width: 13, fontSize: 12, color: "var(--color-moss)" }}>{i === 0 ? "✓" : isHeurTop ? "◇" : ""}</span>
                </div>
              );
            })
          )}
        </div>

        {tab === "both" && net && heur && ranked.length > 0 && heurTop && (heurTop[0] as Canon).join(":") !== (top?.[0] as Canon).join(":") && (
          <div className="cut8" style={{ background: "var(--color-pine)", color: "var(--color-chalk)", padding: "10px 11px", marginTop: 12, fontSize: 12 }}>
            The net would {label(top![0] as Canon, map).toLowerCase()}; the heuristic would {label(heurTop[0] as Canon, map).toLowerCase()} instead —
            a gap of {(100 * ((top![1] as number) - (heurTop[1] as number))).toFixed(1)} points by the net's own reading.
          </div>
        )}

        <div style={{ marginTop: "auto", paddingTop: 12 }}>
          <div className="cap" style={{ marginBottom: 8 }}>Steps either side</div>
          <div style={{ display: "flex", gap: 6 }}>
            {strip.map((i) => {
              const f = frames[i];
              const on = i === step;
              return (
                <button key={i} className="cut8" style={{
                  flex: 1, padding: "7px 8px", textAlign: "left", border: 0, cursor: "pointer",
                  background: on ? "var(--color-pine)" : "#e4e8dd", color: on ? "var(--color-chalk)" : "var(--color-pine)",
                }} onClick={() => set({ step: i })}>
                  <div className="num" style={{ fontSize: 10.5, opacity: 0.7 }}>{i}</div>
                  <div style={{ fontSize: 11, marginTop: 2, lineHeight: 1.3 }}>
                    {i === step ? "Deciding now" : f.action ? label(f.action, map) : "—"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
