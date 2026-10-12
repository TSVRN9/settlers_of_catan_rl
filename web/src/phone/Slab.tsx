// The slab under your hand: one footprint whose job changes with the phase (phone/slab.ts decides which).
// Milestone 1 designs the roll, building and someone else's turn; every other position falls back to a list
// of its legal actions, so a whole game can be played on a phone before those phases get their own design.
import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { act, confirmHandoff, toLineup } from "../game";
import { newsworthy, narrate } from "../coach";
import { SEAT_FILL } from "../board/palette";
import { fmtDelta, label, SEAT_NAMES } from "../labels";
import { rowAt } from "../review";
import { playing, set, useApp, you } from "../store";
import { held } from "../waiting";
import { Die } from "../views/Tray";
import { PieceIcon } from "../views/Build";
import BuildCards from "./BuildCards";
import { slabMode, viewerNow } from "./slab";
import { useMetrics } from "./usePhone";
import type { Canon } from "../engine";

const SETTLE_MS = 400;

/** Every action of a position as a button: the fallback, and the list a Trade or a dev card opens. */
function Actions({ actions, onBack }: { actions: Canon[]; onBack?: () => void }) {
  const s = useApp();
  return (
    <div className="ph-list">
      {onBack && <button className="ph-act cut8 back" onClick={onBack}>‹ Back</button>}
      {actions.map((a, i) => (
        <button key={i} className="ph-act cut8" onClick={() => { set({ pending: null }); void act(a); }}>{label(a, s.map ?? undefined)}</button>
      ))}
    </div>
  );
}

/** The last few moves, newest on top, each with what it did to its own seat's chance (Eval on). */
function Moves() {
  const s = useApp();
  const rows: { i: number; seat: number; text: string; d: number | null }[] = [];
  for (let i = s.frames.length - 2; i >= 0 && rows.length < 3; i--) {
    const f = s.frames[i], row = rowAt(s.frames, i);
    if (!row || !f.action || !newsworthy(f.action) || !s.map) continue;
    const a = f.evals[f.seat]?.win, b = s.frames[i + 1].evals[f.seat]?.win;
    rows.push({ i, seat: f.seat, text: narrate(row, s.map, viewerNow(you(s), s.pendingHandoff)), d: a != null && b != null ? b - a : null });
  }
  return (
    <div className="ph-moves">
      {rows.map((r, k) => (
        <div key={r.i} className={`ph-move cut5${k ? "" : " new line"}`}>
          <i className="sw" style={{ background: SEAT_FILL[r.seat] }} />
          <span className="tx">{r.text}</span>
          {s.evalShown && r.d != null && Math.abs(r.d) >= 0.005 && <span className={`num dl ${r.d > 0 ? "up" : "dn"}`}>{fmtDelta(r.d)}</span>}
        </div>
      ))}
    </div>
  );
}

export default function Slab() {
  const s = useApp();
  const { tileH, btnH } = useMetrics();
  const v = s.view!;
  const mine = playing(s) && v.current_player === s.human && v.winner < 0 && s.step == null;
  const legal = s.legal.map((a) => a[0]);
  const mode = slabMode({ over: v.winner >= 0, mine, opening: v.initial_phase, prompt: v.prompt, legal, handoff: s.pendingHandoff != null, offerOut: false, builder: false, sheet: null });
  const of = (k: string) => s.legal.find((a) => a[0] === k);
  const H = tileH + 10 + btnH;

  const body = (() => {
    if (mine && s.pending) return <Actions actions={s.pending.actions} onBack={() => set({ pending: null })} />;
    switch (mode) {
      case "roll": {
        const roll = of("ROLL")!;
        return (
          <button className="ph-roll-slab cut" onClick={() => void act(roll)} aria-label="Roll the dice">
            <span className="dice"><Die n={4} size={54} /><Die n={2} size={54} /></span>
            <span className="d">Roll</span>
          </button>
        );
      }
      case "build": {
        // Trade in Milestone 1 is the bank and the ports; offers to the table get their builder in Milestone 2.
        const bank = s.legal.filter((a) => a[0] === "MARITIME_TRADE");
        const end = of("END_TURN");
        return (
          <div className="ph-build-slab">
            <BuildCards sunk={v.prompt === "MOVE_ROBBER"} />
            <div className="ph-row" style={{ height: btnH }}>
              <button className="ph-btn cut8" disabled={!bank.length} onClick={() => set({ pending: { title: "Trade", actions: bank } })}>Trade</button>
              <button className="ph-btn go cut8" disabled={!end} onClick={() => end && void act(end)}>End turn</button>
            </div>
          </div>
        );
      }
      case "opening": {
        const h = held(s);
        const kind = h?.kind === "road" ? "road" : "settlement";
        return (
          <div className="ph-supply cut">
            <span className="now"><PieceIcon kind={kind} seat={s.human} size={64} /></span>
            <span className="next"><PieceIcon kind={kind === "road" ? "settlement" : "road"} seat={s.human} size={44} /></span>
          </div>
        );
      }
      case "bots":
        return (
          <div className="ph-bots">
            <Moves />
            {s.pendingHandoff != null && (
              <button className="ph-btn go cut8" style={{ height: btnH }} onClick={confirmHandoff}>
                {SEAT_NAMES[s.pendingHandoff]}: show hand
              </button>
            )}
          </div>
        );
      case "over":
        return (
          <div className="ph-over">
            <span className="d" style={{ color: SEAT_FILL[v.winner] }}>{SEAT_NAMES[v.winner]} won</span>
            <button className="ph-btn go cut8" style={{ height: btnH }} onClick={toLineup}>New game</button>
          </div>
        );
      default:
        return <Actions actions={s.legal} />;
    }
  })();

  // A tap that lands just after the slab changed under the finger was aimed at what used to be there
  // (a quick second tap in the fallback list would otherwise land on End turn): drop it. Keyboard activation
  // (detail 0) is aimed at the focused button, so it always goes through.
  const sig = `${mode}|${s.pending ? s.pending.actions.length : ""}|${s.legal.length}`;
  const changed = useRef({ sig, at: 0 });
  useLayoutEffect(() => { if (changed.current.sig !== sig) changed.current = { sig, at: performance.now() }; }, [sig]);
  const stale = (e: MouseEvent) => { if (e.detail > 0 && performance.now() - changed.current.at < SETTLE_MS) { e.stopPropagation(); e.preventDefault(); } };

  return <div className="ph-slab" style={{ height: H }} onClickCapture={stale}>{body}</div>;
}
