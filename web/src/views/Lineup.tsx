// The lineup is the whole setup: two to four seats, each a person or a bot, and the seed of
// the board they will play — which is already dealt behind this panel, so you are never
// configuring something you cannot see. Deal sits you down; there is no other way in.
import { useEffect, useRef, useState } from "react";
import type { BotKind, BotSpec } from "../engine";
import { deal, resume, start } from "../game";
import { BOT_SHORT, SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";
import Dock from "../Dock";
import { set, useApp } from "../store";

const KINDS: BotKind[] = ["human", "vnet", "heuristic", "random"];
const ORDINAL = ["first", "second", "third", "fourth"];
const MAX = 4, MIN = 2;

/** `human` names the seat the readings are written from. It follows the first person at the
 *  table, or the seat just changed, or — with nobody seated — any real seat. */
const humanFor = (lineup: BotSpec[], prefer: number) => {
  if (lineup[prefer]?.kind === "human") return prefer;
  const found = lineup.findIndex((b) => b.kind === "human");
  return found >= 0 ? found : Math.min(prefer, lineup.length - 1);
};

const chevron = (
  <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true" style={{ flex: "0 0 9px" }}>
    <path d="M0 0 L4.5 5 L9 0" fill="none" stroke="var(--color-moss)" strokeWidth="1.5" />
  </svg>
);

export default function Lineup() {
  const s = useApp();
  const n = s.lineup.length;
  // A game left behind this panel, still in play on the board it was dealt: it can be
  // gone back to, and Deal says it would be a new one.
  const behind = !!s.view && s.view.steps > 0 && s.view.winner < 0 && !!s.dealt && s.dealt.seed === s.seed && s.dealt.n === n;

  // The board behind is dealt for this seed and this many seats. A finished game with the
  // same seed stays on screen as it ended; Deal re-deals it.
  useEffect(() => {
    const d = s.dealt;
    if (!d || d.seed !== s.seed || d.n !== n) void deal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.seed, n]);

  // The seed field commits after a pause, so typing a five-digit number deals once.
  const [seedText, setSeedText] = useState(String(s.seed));
  useEffect(() => { setSeedText(String(s.seed)); }, [s.seed]);
  const timer = useRef<number | undefined>(undefined);
  const onSeed = (text: string) => {
    setSeedText(text);
    window.clearTimeout(timer.current);
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v)) timer.current = window.setTimeout(() => set({ seed: Math.floor(Math.abs(v)) }), 300);
  };

  const setSeat = (i: number, kind: BotKind) => {
    const lineup = s.lineup.map((b, j) => (j === i ? { ...b, kind } : b));
    set({ lineup, human: humanFor(lineup, i) });
  };
  const addSeat = () => {
    const lineup: BotSpec[] = [...s.lineup, { kind: "heuristic", depth: 2 }];
    set({ lineup, human: humanFor(lineup, s.human) });
  };
  const removeSeat = (i: number) => {
    const lineup = s.lineup.filter((_, j) => j !== i);
    set({ lineup, human: humanFor(lineup, Math.min(s.human, lineup.length - 1)) });
  };

  return (
    <Dock name="lineup" side="l" style={{ position: "absolute", left: 34, top: 30, width: 352, zIndex: 1 }}>
      <div className="d" style={{ fontSize: 29, lineHeight: 1.1 }}>Who is playing</div>
      <div className="cut" style={{ marginTop: 20, background: "var(--color-paper)", padding: "16px 17px" }}>
        <div style={{ font: "600 12.5px var(--font-sans)" }}>Seats</div>
        <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 6 }}>
          {s.lineup.map((b, i) => {
            const person = b.kind === "human";
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <label className="cut8 chip" style={{
                  position: "relative", flex: 1, display: "flex", alignItems: "center", gap: 10,
                  background: "var(--color-chalk)", padding: "9px 11px", cursor: "pointer",
                }}>
                  <span style={{ width: 12, height: 12, flex: "0 0 12px", background: SEAT_FILL[i] }} />
                  <span style={{ flex: 1, font: `${person ? 600 : 500} 13.5px var(--font-sans)` }}>
                    {person ? SEAT_NAMES[i] : BOT_SHORT[b.kind]}
                  </span>
                  <span className="cap" style={{ fontSize: 12 }}>{person ? "person" : `bot · depth ${b.depth}`}</span>
                  {chevron}
                  <select value={b.kind} onChange={(e) => setSeat(i, e.target.value as BotKind)}
                          aria-label={`${SEAT_NAMES[i]} is`}
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}>
                    {KINDS.map((k) => <option key={k} value={k}>{BOT_SHORT[k]}</option>)}
                  </select>
                </label>
                {n > MIN && (
                  <button className="act cut8" aria-label={`Take ${SEAT_NAMES[i]} out`} title="Take this seat out"
                          style={{ height: "auto", padding: "0 11px", fontSize: 15, background: "var(--color-chalk)" }}
                          onClick={() => removeSeat(i)}>×</button>
                )}
              </div>
            );
          })}
          {n < MAX && (
            <button className="cut8 chip" onClick={addSeat}
                    style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--color-chalk)", padding: "9px 11px",
                             border: 0, cursor: "pointer", opacity: 0.55, font: "inherit", color: "inherit", textAlign: "left" }}>
              <span style={{ width: 12, height: 12, flex: "0 0 12px", background: SEAT_FILL[n] }} />
              <span style={{ flex: 1, font: "600 13.5px var(--font-sans)" }}>Add a {ORDINAL[n]} seat</span>
              <span className="cap" style={{ fontSize: 14 }}>+</span>
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
          <span className="cap">Board seed</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="text" inputMode="numeric" value={seedText} onChange={(e) => onSeed(e.target.value)}
                   aria-label="Board seed" className="num"
                   style={{ width: 84, font: "600 13px var(--font-sans)", background: "var(--color-chalk)", border: 0, padding: "5px 8px", textAlign: "right" }} />
            <button className="act cut8" style={{ height: 26, padding: "0 9px", fontSize: 12, background: "var(--color-chalk)" }}
                    onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}>Re-deal</button>
          </span>
        </div>
      </div>

      <button className="act go cut8" style={{ marginTop: 11, width: "100%" }} onClick={() => void start()}
              disabled={s.status === "thinking" && !s.map}>
        {behind ? "Deal a new game" : "Deal"}
      </button>
      {behind && (
        <button className="act cut8 arrive" style={{ marginTop: 8, width: "100%" }} onClick={() => void resume()}>
          Back to the game — turn {s.view!.num_turns}
        </button>
      )}

      {s.error && <div className="cap" style={{ marginTop: 12, color: "var(--color-warn)" }}>{s.error}</div>}
    </Dock>
  );
}
