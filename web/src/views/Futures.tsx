// The Futures: the third verb. Six candidate boards in a plain 3x2 grid — per
// web/design/canvas/ViewFutures.dc.html, all six are hypothetical previews, none of them
// the live position (that lives only in the left aside's own small thumbnail). The
// persistent board parks at slot 1 (the grid's top-left cell, [data-anchor="futures"]) and
// shows the top-ranked candidate's preview via `boardOverride`, so the "one board element
// never unmounted" architecture holds without inventing a seventh, uncaptioned board.
import { useEffect, useState } from "react";
import type { Canon, View } from "../engine";
import { act, live } from "../game";
import { fmtPct, label } from "../labels";
import { set, useApp } from "../store";
import Board from "../board/Board";
import Card from "../board/Card";

// The five non-anchor rects, from web/design/measured.json's ViewFutures.boards — the same
// left%/top%/width(min(cqw,cqh)) formula as every other [data-anchor] rect in index.css.
// Candidate slot 0 is [data-anchor="futures"] itself (29.688%, 28.234%), where the persistent
// board parks, showing that candidate's own preview.
const ANCHOR_RECT = { left: "29.688%", top: "28.234%" };
const RECTS = [
  { left: "55.472%", top: "28.234%" },
  { left: "81.257%", top: "28.234%" },
  { left: "29.688%", top: "60.780%" },
  { left: "55.472%", top: "60.780%" },
  { left: "81.257%", top: "60.780%" },
];
const CELL = { width: "min(14.375cqw, 23.739cqh)", aspectRatio: "511.56 / 488.4" } as const;
const THUMB = { left: "8.750%", top: "22.133%", width: "min(12.500cqw, 20.660cqh)", aspectRatio: "511.56 / 488.4" } as const;

export default function Futures() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const root = s.advice?.root.filter(([, val]) => val != null) ?? [];
  const top6 = [...root].sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 6) as [Canon, number][];
  const [previews, setPreviews] = useState<(View | null)[]>([]);

  useEffect(() => {
    setPreviews(top6.map(() => null));
    let cancelled = false;
    (async () => {
      const out: (View | null)[] = [];
      for (const [a] of top6) {
        try { out.push(await live.preview(a)); } catch { out.push(null); }
        if (cancelled) return;
        // The persistent board shows the top candidate the moment it's ready, rather than
        // waiting on the other five.
        if (out.length === 1 && out[0]) set({ boardOverride: { view: out[0], highlight: top6[0][0] } });
      }
      if (!cancelled) setPreviews(out);
    })();
    return () => { cancelled = true; set({ boardOverride: null }); };
    // top6's action keys are the real dependency; s.advice identity changes every decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.advice]);

  if (!v || !map) return null;

  const me = v.players[s.human];
  const mine = v.current_player === s.human && v.winner < 0;
  const liveWin = s.evals[s.human]?.win ?? 0;

  return (
    <>
      {/* The persistent board parks here, showing the top-ranked candidate's own preview —
          the grid's top-left cell, identical in kind to the other five. Its caption is drawn
          below, at this same rect, since the board itself isn't Futures' own element to size. */}
      <div data-anchor="futures" />
      {top6[0] && (
        <div style={{ position: "absolute", left: ANCHOR_RECT.left, top: ANCHOR_RECT.top, transform: "translate(-50%,-50%)", ...CELL }}>
          <div style={{ position: "absolute", left: "50%", top: -22, transform: "translateX(-50%)", width: 220, textAlign: "center", whiteSpace: "nowrap" }}>
            <span style={{ font: "600 12.5px var(--font-sans)" }}>{label(top6[0][0], map)}</span>{" "}
            <span className="d num" style={{ fontSize: 15 }}>{fmtPct(top6[0][1])}</span>
          </div>
          <div style={{ position: "absolute", left: "50%", bottom: -20, transform: "translateX(-50%)", fontSize: 12.5, whiteSpace: "nowrap", color: top6[0][1] - liveWin >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
            {top6[0][1] - liveWin >= 0 ? "+" : ""}{((top6[0][1] - liveWin) * 100).toFixed(1)}
          </div>
          <div style={{ position: "absolute", inset: -3, boxShadow: "0 0 0 2.5px var(--color-pine)", pointerEvents: "none" }} />
          <button aria-label={label(top6[0][0], map)} disabled={!mine} onClick={() => void act(top6[0][0])}
                  style={{ position: "absolute", inset: 0, background: "transparent", border: 0, cursor: mine ? "pointer" : "default" }} />
        </div>
      )}

      {/* where you stand now */}
      <div style={{ position: "absolute", left: 34, top: 26, bottom: 26, width: 268, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="cap">The board as it stands</div>
        <div className="cut" style={{ padding: 10, background: "var(--color-paper)" }}>
          <div style={{ position: "relative", ...THUMB, left: "auto", top: "auto", margin: "0 auto" }}>
            <Board map={map} view={v} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8 }}>
            <span style={{ font: "600 13px var(--font-sans)" }}>You, right now</span>
            <span className="d num" style={{ fontSize: 20 }}>{fmtPct(liveWin)}</span>
          </div>
        </div>

        <div className="cap">What you are holding</div>
        <div style={{ display: "flex" }}>
          {me.hand.map((n, i) => (
            <span key={i} style={{ marginLeft: i ? -12 : 0 }}>
              <Card resource={i} count={n} width={46} height={62} dim={n === 0} />
            </span>
          ))}
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {top6[0] && (
            <>
              <button className="act cut8 go" style={{ height: 44 }} disabled={!mine}
                      onClick={() => void act(top6[0][0])}>
                {label(top6[0][0], map)}
              </button>
              <button className="act cut8" style={{ height: 40 }} disabled={!mine}
                      onClick={() => void act(top6[0][0])}>
                Let the net decide for me
              </button>
            </>
          )}
        </div>
      </div>

      {/* the other five futures — the sixth (top-ranked) is the persistent board above */}
      {root.length === 0 ? (
        <div className="cap" style={{ position: "absolute", left: 352, top: 92, width: 400 }}>
          Nothing to branch on here — one move is forced.
        </div>
      ) : (
        <>
          <div className="cap" style={{ position: "absolute", left: 352, top: 26 }}>the ring on each marks what changed</div>
          {top6.slice(1).map(([a, val], j) => {
            const i = j + 1;
            const rect = RECTS[j];
            const pv = previews[i];
            const delta = val - liveWin;
            return (
              <div key={i} style={{ position: "absolute", left: rect.left, top: rect.top, transform: "translate(-50%,-50%)", ...CELL }}>
                <div style={{ position: "absolute", left: "50%", top: -22, transform: "translateX(-50%)", width: 220, textAlign: "center", whiteSpace: "nowrap" }}>
                  <span style={{ font: "600 12.5px var(--font-sans)" }}>{label(a, map)}</span>{" "}
                  <span className="d num" style={{ fontSize: 15, color: "var(--color-moss)" }}>{fmtPct(val)}</span>
                </div>
                {pv ? <Board map={map} view={pv} highlight={a} /> : <div style={{ width: "100%", height: "100%", background: "var(--color-dust)" }} />}
                <div style={{ position: "absolute", left: "50%", bottom: -20, transform: "translateX(-50%)", fontSize: 12.5, whiteSpace: "nowrap", color: delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>
                  {delta >= 0 ? "+" : ""}{(delta * 100).toFixed(1)}
                </div>
                <button aria-label={label(a, map)} disabled={!mine} onClick={() => void act(a)}
                        style={{ position: "absolute", inset: 0, background: "transparent", border: 0, cursor: mine ? "pointer" : "default" }} />
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
