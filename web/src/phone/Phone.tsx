// The phone: "around the table" (docs/superpowers/specs/2026-10-11-mobile-ui-design.md). Opponents across
// the top, the board, then you: your row, your hand and the slab whose job changes with the phase.
import { useEffect } from "react";
import BoardLayer from "../board/BoardLayer";
import PhoneLineup from "./Lineup";
import { act } from "../game";
import { playing, set, shown, useApp, you } from "../store";
import { held } from "../waiting";
import TopBar from "./TopBar";
import Chips from "./Chips";
import { Hand, YouRow } from "./Hand";
import Slab from "./Slab";
import Result from "./Result";
import Watch from "./Watch";
import Review, { ReviewBar, reviewBoard } from "./Review";
import GradeTag from "./GradeTag";
import Cover, { useCover } from "./Cover";
import { letGo } from "./pass";
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
  const over = !setup && !!s.view && s.view.winner >= 0;
  const reviewing = !setup && s.review && !!s.view;
  const watching = !setup && (!playing(s) || reviewing);
  const rb = reviewing ? reviewBoard(s) : null;
  const cover = useCover();                  // null at the lineup: only a game in play is covered
  // The phone is between people the moment a cover rises: from then on every person's decision, the last holder's
  // own included, comes through a cover until someone taps Show hand.
  // Where the holder let go is where their next replay starts: after their own last move, whatever is played for
  // them (a declined offer) once it has left their hands.
  useEffect(() => {
    if (!cover || s.holder == null) return;
    set({ holder: null, gaveUp: letGo(s.frames, s.holder, s.gaveUp) });
  }, [cover?.seat, s.holder]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ph">
      {/* Watching, nobody sits at the bottom: the seats are the standings there, not chips. A shared game still
          loading shows the wordmark. */}
      {setup || !s.view ? <div className="ph-word d">Catan RL</div> : reviewing ? <ReviewBar /> : <><TopBar />{!watching && <Chips />}</>}
      {/* A tap on the board hurries the bots until you are asked something (spec "Another seat's turn"). With a
          piece in hand the tap is Carry's, on its own layer above this. */}
      <div className="ph-board" onClick={() => { if (!setup && playing(s) && !mine && s.pendingHandoff == null && !s.hurry) set({ hurry: true }); }}>
        <div data-anchor="table" className="ph-anchor" />
      </div>
      {s.map && s.view && (
        <BoardLayer view="table" map={s.map} gameView={shown(s).view!} since={rb?.since} ghost={rb?.ghost} ghostSeat={rb?.ghostSeat}
          carry={mine && inHand && !cover ? {
            map: s.map, view: s.view, legal: s.legal, seat: s.human, held: inHand, robTile: s.robTile, reveal: false,
            snapPx: 24, liftPx: 56, keepOnMiss: true,
            onPlace: (a) => void act(a), onRobTile: (t) => set({ robTile: t }),
            onDrop: () => set({ carry: null }),
            onClickCarry: () => set((cur) => (cur.carry ? { carry: { ...cur.carry, drag: false } } : {})),
          } : null}
          hidePieces={s.reveal} dealing={s.reveal} />
      )}
      {!setup && s.map && s.view && <Fx frames={s.frames} at={Math.max(0, Math.min(s.step ?? s.view.steps, s.frames.length - 1))} map={s.map} you={viewerNow(you(s), cover?.seat ?? s.pendingHandoff)} />}
      {!setup && !reviewing && s.view && <GradeTag covered={!!cover || s.pendingHandoff != null} />}
      {setup ? <PhoneLineup />
        : reviewing ? <div className="ph-seat ph-watch"><Review /></div>
        : watching ? <div className="ph-seat ph-watch">{s.view && <><Watch />{over && <Result />}</>}</div>
        : <div className="ph-seat">{s.view && <>
          {/* Hidden, not removed, during a handoff (the next person must not see this hand) and under the result:
              either way the board must not move. */}
          <div style={{ visibility: s.pendingHandoff == null && !over && !cover ? undefined : "hidden" }}><YouRow /><Hand /></div>
          <div inert={!!cover} style={{ visibility: cover ? "hidden" : undefined }}><Slab /></div>
          {over && <Result />}
          {cover && !over && <Cover cover={cover} />}
        </>}</div>}
    </div>
  );
}
