// The lineup is the whole setup: two to four seats, each a person or a bot, and the seed
// of the board they will play. Deal starts the game; there is no other way in, and no way
// to start another one until this one ends.
import type { BotKind } from "../engine";
import { start } from "../game";
import { BOT_SHORT, SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";
import { set, useApp } from "../store";

const KINDS: BotKind[] = ["human", "vnet", "heuristic", "random"];

export default function Lineup() {
  const s = useApp();

  const setSeat = (i: number, kind: BotKind) => {
    const lineup = s.lineup.map((b, j) => (j === i ? { ...b, kind } : b));
    // More than one seat can be "human" — that's the hotseat, and the handoff gate is what
    // keeps them from seeing each other's hands mid-game. `human` just names whichever one
    // the readings are written from right now; it moves on its own once play starts. A lineup
    // with nobody in it is legal too — that is what watching is — so this still has to fall
    // back to a real seat when the last human is removed, or nothing indexes past the end of
    // the players array.
    const found = lineup.findIndex((b) => b.kind === "human");
    set({ lineup, human: kind === "human" ? i : found >= 0 ? found : i });
  };

  return (
    <div style={{ position: "absolute", left: 34, top: 30, width: 380 }}>
      <div className="d" style={{ fontSize: 23, lineHeight: 1.15 }}>Who is playing</div>
      <div className="cap" style={{ marginTop: 8 }}>
        Four seats, each a person or a bot. The seed is the board: the same number deals the
        same island every time. Put more than one person at the table and a handoff screen
        covers each hand between turns. Take yourself out of every seat and you are watching
        rather than playing.
      </div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 6 }}>
        {s.lineup.map((b, i) => (
          <div key={i} className="cut8"
               style={{ display: "flex", alignItems: "center", gap: 11, background: "var(--color-paper)", padding: "9px 12px" }}>
            <span style={{ width: 13, height: 13, flex: "0 0 13px", background: SEAT_FILL[i] }} />
            <span style={{ flex: 1, font: "600 13.5px var(--font-sans)" }}>{SEAT_NAMES[i]}</span>
            <select value={b.kind} onChange={(e) => setSeat(i, e.target.value as BotKind)}
                    aria-label={`${SEAT_NAMES[i]} is`}
                    style={{ font: "500 12.5px var(--font-sans)", background: "transparent", border: 0, color: "var(--color-pine)" }}>
              {KINDS.map((k) => <option key={k} value={k}>{BOT_SHORT[k]}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <span className="cap">Board seed</span>
        <input type="number" value={s.seed} onChange={(e) => set({ seed: Number(e.target.value) })}
               aria-label="Board seed"
               style={{ width: 96, font: "600 13px var(--font-sans)", background: "var(--color-paper)", border: 0, padding: "5px 8px" }} />
        <button className="act cut8" style={{ height: 30, fontSize: 12.5 }}
                onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}>Re-deal</button>
      </div>

      <button className="act go cut8" style={{ marginTop: 14, width: "100%" }}
              onClick={() => void start()}>Deal</button>

      {s.error && <div className="cap" style={{ marginTop: 12, color: "var(--color-warn)" }}>{s.error}</div>}
    </div>
  );
}
