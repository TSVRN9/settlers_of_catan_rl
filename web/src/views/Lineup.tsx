// The lineup is the whole setup: two to four seats, each a person or a bot, and the seed of
// the board they will play — which is already dealt behind this panel, so you are never
// configuring something you cannot see. Deal sits you down; there is no other way in.
import { useEffect, useRef, useState } from "react";
import type { BotKind, BotSpec } from "../engine";
import { deal, resume, start } from "../game";
import { BOT_INFO, BOT_NAMES, BOT_SHORT, SEAT_NAMES } from "../labels";
import Picker from "./Picker";
import { SEAT_FILL } from "../board/palette";
import Dock from "../Dock";
import { set, useApp } from "../store";

const ORDINAL = ["first", "second", "third", "fourth"];
const MAX = 4, MIN = 2;

/** `human` names the seat the readings are written from. It follows the first person at the
 *  table, or the seat just changed, or — with nobody seated — any real seat. */
const humanFor = (lineup: BotSpec[], prefer: number) => {
  if (lineup[prefer]?.kind === "human") return prefer;
  const found = lineup.findIndex((b) => b.kind === "human");
  return found >= 0 ? found : Math.min(prefer, lineup.length - 1);
};


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

  // Which seat's list is unfolded, and the card open beside one of its rows. `top` is the row's
  // offset in this Dock, the nearest positioned ancestor — nothing between them is positioned.
  const [open, setOpen] = useState<number | null>(null);
  const [info, setInfo] = useState<{ kind: BotKind; top: number } | null>(null);

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
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <Picker seat={i} spec={b} open={open === i} info={open === i ? info?.kind ?? null : null}
                        onOpen={(o) => { setOpen(o ? i : null); if (!o) setInfo(null); }}
                        onPick={(k) => setSeat(i, k)}
                        onInfo={(k, row) => setInfo(k && row ? { kind: k, top: row.offsetTop } : null)} />
                {n > MIN && (
                  <button className="act cut8" aria-label={`Take ${SEAT_NAMES[i]} out`} title="Take this seat out"
                          style={{ height: 36, padding: "0 11px", fontSize: 15, background: "var(--color-chalk)" }}
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

      {info && (
        <div key={info.kind} className="cut8 arrive dock-l" style={{
          position: "absolute", left: 352 + 12, top: info.top - 12, width: 304,
          background: "var(--color-paper)", padding: "13px 15px 12px", fontSize: 12.5, lineHeight: 1.5,
        }}>
          <div className="d" style={{ fontSize: 17, lineHeight: 1.2 }}>{BOT_SHORT[info.kind]}</div>
          <div className="cap" style={{ fontSize: 11.5, marginTop: 2 }}>{BOT_NAMES[info.kind]}</div>
          <div style={{ marginTop: 9, fontWeight: 600 }}>{BOT_INFO[info.kind].what}</div>
          <div style={{ marginTop: 4 }}>{BOT_INFO[info.kind].how}</div>
          {BOT_INFO[info.kind].measured && <div className="cap" style={{ marginTop: 9, fontSize: 11.5 }}>{BOT_INFO[info.kind].measured}</div>}
        </div>
      )}
    </Dock>
  );
}
