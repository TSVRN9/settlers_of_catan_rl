// The Futures: every legal move as a board you can read. The live board travels to "the board
// as it stands" on the left; to its right, the six best candidates are clones of it with the
// move applied, the new piece landing. Hovering one ghosts the move on the live board; choosing
// one stages it there, and the aside asks.
import { useEffect, useState } from "react";
import type { Canon, View } from "../engine";
import { act, live } from "../game";
import { actionKey, fmtDelta, fmtPct, label, who } from "../labels";
import { RES_FILL } from "../board/palette";
import { COST } from "../coach";
import { playing, set, useApp, you } from "../store";
import Dock from "../Dock";
import Board from "../board/Board";
import Card from "../board/Card";

/** The live board's slot, the same measure as its anchor in index.css. */
const SLOT = "min(20.8cqw, 34.4cqh)";

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
        setPreviews([...out]);
      }
    })();
    return () => { cancelled = true; set({ hover: null }); };
    // top6's action keys are the real dependency; s.advice identity changes every decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.advice]);

  if (!v || !map) return null;

  const me = v.players[s.human];
  const mine = playing(s) && v.current_player === s.human && v.winner < 0;
  const liveWin = s.evals[s.human]?.win ?? 0;
  const stagedKey = s.staged ? actionKey(s.staged) : null;
  const stagedVal = s.staged ? top6.find(([a]) => actionKey(a) === stagedKey)?.[1] : undefined;

  return (
    <>
      {/* the board as it stands parks here */}
      <div data-anchor="futures" />

      <Dock name="futures-aside" side="l" style={{ position: "absolute", left: 34, top: `calc(72px + ${SLOT} * 0.955 + 16px)`, width: SLOT, bottom: 26, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ font: "600 13px var(--font-sans)" }}>{who(s.human, you(s))}, as it stands</span>
          <span className="d num" style={{ fontSize: 20 }}>{fmtPct(liveWin)}</span>
        </div>
        <div style={{ display: "flex" }}>
          {me.hand.map((n, i) => (
            <span key={i} style={{ marginLeft: i ? -12 : 0 }}>
              <Card resource={i} count={n} width={44} height={60} dim={n === 0} />
            </span>
          ))}
        </div>

        <div style={{ marginTop: "auto" }}>
          {s.staged && mine ? (
            <div className="cut arrive dock-b" style={{ background: "var(--color-paper)", padding: "12px 13px" }}>
              <div style={{ font: "600 13px var(--font-sans)", lineHeight: 1.35 }}>{label(s.staged, map)}</div>
              {stagedVal != null && (
                <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className="d num" style={{ fontSize: 17 }}>{fmtPct(stagedVal)}</span>
                  <span className="d num" style={{ fontSize: 12.5, color: stagedVal - liveWin >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>{fmtDelta(stagedVal - liveWin)}</span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="act cut8 go" style={{ height: 38 }} onClick={() => void act(s.staged!)}>Play it</button>
                <button className="act cut8" style={{ height: 38 }} onClick={() => set({ staged: null })}>Cancel</button>
              </div>
            </div>
          ) : top6[0] ? (
            <button className="act cut8" style={{ height: 40, width: "100%" }} disabled={!mine} onClick={() => set({ staged: top6[0][0] })}>
              Let the net choose
            </button>
          ) : null}
        </div>
      </Dock>

      {root.length === 0 ? (
        <Dock name="futures-none" side="t" className="cap" style={{ position: "absolute", left: `calc(34px + ${SLOT} + 28px)`, top: 72 }}>
          Nothing to branch on — one move is forced.
        </Dock>
      ) : (
        <Dock name="futures-grid" side="r" style={{
          position: "absolute", left: `calc(34px + ${SLOT} + 28px)`, right: 34, top: 72, bottom: 26,
          display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))", gap: "14px 28px",
        }}>
          {top6.map(([a, val], i) => {
            const pv = previews[i];
            const delta = val - liveWin;
            const key = actionKey(a);
            const on = stagedKey === key;
            const vpUp = pv ? pv.players[s.human].vp - me.vp : 0;
            const cost = COST[a[0]];
            return (
              <div key={key} className="cell arrive" role="button" tabIndex={0} aria-label={label(a, map)} aria-pressed={on}
                   style={{ transitionDelay: `${i * 45}ms`, cursor: mine ? "pointer" : "default", boxShadow: on ? "0 0 0 2.5px var(--color-pine)" : undefined, padding: 6, margin: -6, display: "flex", flexDirection: "column", minHeight: 0 }}
                   onMouseEnter={() => mine && set({ hover: a })} onMouseLeave={() => set({ hover: null })}
                   onClick={() => mine && set({ staged: a, hover: null })}
                   onKeyDown={(e) => { if (mine && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); set({ staged: a }); } }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, lineHeight: 1.25, minWidth: 0 }}>
                  <span className="d num" style={{ fontSize: 16, flex: "0 0 auto", color: i === 0 ? "var(--color-pine)" : "var(--color-moss)" }}>{fmtPct(val)}</span>
                  <span style={{ font: `${i === 0 ? 600 : 500} 12.5px var(--font-sans)`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: i === 0 ? "var(--color-pine)" : "var(--color-moss)" }}>{label(a, map)}</span>
                </div>
                {/* The board is sized by the height the row gives it, so two rows always fit. */}
                <div style={{ position: "relative", flex: 1, minHeight: 0, aspectRatio: "511.56 / 488.4", maxWidth: "100%", margin: "4px auto 0" }}>
                  {pv ? <Board map={map} view={pv} highlight={a} since={v} /> : <div style={{ width: "100%", height: "100%", background: "var(--color-dust)", opacity: 0.5 }} />}
                </div>
                <div className="num" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, fontSize: 12 }}>
                  <span className="d" style={{ color: delta >= 0 ? "var(--color-wood)" : "var(--color-brick)" }}>{fmtDelta(delta)}</span>
                  {vpUp > 0 && <span style={{ font: "600 12px var(--font-sans)" }}>+{vpUp} VP</span>}
                  {cost && (
                    <span style={{ display: "inline-flex", gap: 3, marginLeft: "auto" }}>
                      {cost.flatMap((n, r) => Array.from({ length: n }, (_, k) => (
                        <i key={`${r}-${k}`} style={{ width: 7, height: 7, borderRadius: "50%", background: RES_FILL[r] }} />
                      )))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </Dock>
      )}
    </>
  );
}
