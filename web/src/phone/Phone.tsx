// The phone: "around the table" (docs/superpowers/specs/2026-10-11-mobile-ui-design.md). Opponents across
// the top, the board, then you: your row, your hand and the slab whose job changes with the phase.
import { useEffect } from "react";
import BoardLayer from "../board/BoardLayer";
import Lineup from "../views/Lineup";
import { act } from "../game";
import { playing, set, useApp, you } from "../store";
import { held } from "../waiting";
import TopBar from "./TopBar";
import Chips from "./Chips";
import { Hand, YouRow } from "./Hand";
import Slab from "./Slab";
import Fx from "../views/Fx";
import { viewerNow } from "./slab";
import "./phone.css";

export default function Phone() {
  const s = useApp();
  // The phone has no look-back yet (the review is Milestone 6): arriving from a desktop view that was looking
  // at an earlier step, come back to the live table, or the turn has no controls.
  useEffect(() => { if (s.step != null || s.crumbs.length > 1) set({ step: null, crumbs: ["table"], boardOverride: null }); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const setup = s.phase === "lineup";
  const mine = !setup && playing(s) && s.view?.current_player === s.human && s.view.winner < 0 && s.step == null;
  const inHand = setup ? null : held(s);
  return (
    <div className="ph">
      {!setup && s.view && <><TopBar /><Chips /></>}
      {/* A tap on the board hurries the bots until you are asked something (spec "Another seat's turn"). With a
          piece in hand the tap is Carry's, on its own layer above this. */}
      <div className="ph-board" onClick={() => { if (!setup && playing(s) && !mine && !s.hurry) set({ hurry: true }); }}>
        <div data-anchor="table" className="ph-anchor" />
      </div>
      {s.map && s.view && (
        <BoardLayer view="table" dim={setup} map={s.map} gameView={s.view}
          carry={mine && inHand ? {
            map: s.map, view: s.view, legal: s.legal, seat: s.human, held: inHand, robTile: s.robTile, reveal: false,
            snapPx: 24, liftPx: 56, keepOnMiss: true,
            onPlace: (a) => void act(a), onRobTile: (t) => set({ robTile: t }),
            onDrop: () => set({ carry: null }),
            onClickCarry: () => set((cur) => (cur.carry ? { carry: { ...cur.carry, drag: false } } : {})),
          } : null}
          hidePieces={s.reveal} dealing={s.reveal} />
      )}
      {!setup && s.map && s.view && s.step == null && <Fx frames={s.frames} at={Math.max(0, Math.min(s.view.steps, s.frames.length - 1))} map={s.map} you={viewerNow(you(s), s.pendingHandoff)} />}
      {setup ? <div className="ph-setup"><Lineup /></div> : <div className="ph-seat">{s.view && <>{/* Hidden, not removed, during a handoff: the next person must not see this hand, and the board must not move. */}<div style={{ visibility: s.pendingHandoff == null ? undefined : "hidden" }}><YouRow /><Hand /></div><Slab /></>}</div>}
    </div>
  );
}
