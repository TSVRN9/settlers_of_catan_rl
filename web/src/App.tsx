// The shell: the spine, the stage, whichever view is current, and the one board.
//
// BoardLayer is a *sibling* of the view slot and is never conditional and never keyed. That
// is the whole structural claim of this redesign: swapping the view cannot take the game
// with it, the way the old tab router did.
import { useEffect, type CSSProperties } from "react";
import BoardLayer from "./board/BoardLayer";
import Lineup from "./views/Lineup";
import Table from "./views/Table";
import Futures from "./views/Futures";
import Game from "./views/Game";
import Move from "./views/Move";
import Handoff from "./views/Handoff";
import Discard from "./views/Discard";
import Spine, { NAME } from "./Spine";
import { act, toLineup } from "./game";
import { roundOf } from "./labels";
import * as keys from "./keys";
import * as route from "./route";
import { currentView, playing, set, useApp } from "./store";
import { heat, held, waiting } from "./waiting";
import Phone from "./phone/Phone";
import { usePhone } from "./phone/usePhone";

/** The views that put something other than the live position on the board (the Table only
 *  while the stands look back at a step). */
const OWNS_OVERRIDE = new Set(["table", "futures", "game", "move"]);

/** The header: what this screen is, and the way back one page. One element on every
 *  screen (`view-transition-name: head`), so a navigation crossfades its word while the
 *  panels dock — it stays, its word changes. On the Table the word is the turn, and back is
 *  the lineup, where the game waits behind the panel until it is dealt over. */
function Head() {
  const s = useApp();
  const view = currentView(s);
  if (s.phase === "lineup" || !s.view) return null;
  const shown = view === "table" && s.step != null ? s.frames[s.step]?.view ?? s.view : s.view;
  // The engine counts every seat's turn, the opening's placements included, so "Turn 6" was the
  // first roll of a four-seat game. The head counts rounds of the table from the first roll.
  const title = view !== "table" ? NAME[view] : roundOf(s.frames, shown);
  const back = view === "table" ? toLineup : route.pop;
  // The title names the screen; only the chevron leaves it — a headline that took you out of a
  // game in progress was a trap.
  return (
    <div className="head" style={{ viewTransitionName: "head" } as CSSProperties}>
      <button className="chev" onClick={back} aria-label={view === "table" ? "Back to the lineup" : "Back"}
              title={view === "table" ? "Back to the lineup" : "Back"}>‹</button>
      <h1 className="d">{title}</h1>
    </div>
  );
}

export default function App() {
  // Both installs return their own uninstall: StrictMode invokes this twice in dev, and two
  // sets of listeners make Escape pop two crumbs and the seat keys cancel themselves out.
  useEffect(() => {
    const offRoute = route.install();
    const offKeys = keys.install();
    route.sync();
    return () => { offRoute(); offKeys(); };
  }, []);

  const s = useApp();
  // Below the desktop's width the phone tree takes over (phone/Phone.tsx); same store, same game.
  const phone = usePhone();
  if (phone) return <><Phone /><div className="sr" role="status" aria-live="polite">{s.error ?? ""}</div></>;
  const view = currentView(s);
  const setup = s.phase === "lineup";
  // A view reads the override only while it owns it, so leaving one analysis view for
  // another never shows the live position in between.
  const override = !setup && OWNS_OVERRIDE.has(view) ? s.boardOverride : null;
  const mine = !setup && playing(s) && s.view?.current_player === s.human && s.view.winner < 0 && s.step == null;
  const live = view === "table" || view === "futures";
  // The piece in hand, on the Table only: the game's own (the opening, the robber) or one
  // picked up off a building card. With nothing in hand the board offers nothing.
  const inHand = !setup && view === "table" ? held(s) : null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Spine />

      <div className="stage">
        {/* Hotseat blurs everything below rather than unmounting it — a handoff is a curtain,
            not a navigation, so whatever view and step you were on is exactly where the next
            player's own turn resumes once they tap through. */}
        <div className={`curtain${s.pendingHandoff != null ? " down" : ""}`}>
          <Head />
          {setup && <Lineup />}

          {/* The board outlives every view, and is on screen behind the lineup too — it is
              the board being configured, so you are never choosing settings for something you
              cannot see. It renders before the views on purpose: nothing here carries a
              z-index, so DOM order is the stacking order, and a view's panels have to win
              over the board they are laid across (Move's ladder does, at every width). */}
          {s.map && s.view && (
            <>
              {setup && <div data-anchor="table" />}
              <BoardLayer
                view={setup ? "table" : view}
                dim={setup}
                map={s.map}
                gameView={override?.view ?? s.view}
                carry={mine && view === "table" && (inHand || s.revealAll) ? {
                  map: s.map, view: s.view, legal: s.legal, seat: s.human, held: inHand, robTile: s.robTile,
                  heat: s.analysis || s.revealAll ? heat(s.advice) : undefined, reveal: s.revealAll && !inHand,
                  onPlace: (a) => void act(a),
                  onRobTile: (t) => set({ robTile: t }),
                  onDrop: () => set({ carry: null }),
                  onClickCarry: () => set((cur) => (cur.carry ? { carry: { ...cur.carry, drag: false } } : {})),
                } : null}
                highlight={override?.highlight ?? (live ? s.mark : null)}
                ghost={view === "futures" && mine ? s.hover : null}
                litTiles={override?.litTiles}
                hidePieces={s.reveal}
                dealing={s.reveal}
              />
            </>
          )}

          {!setup && view === "table" && <Table />}
          {!setup && view === "futures" && <Futures />}
          {!setup && view === "game" && <Game />}
          {!setup && view === "move" && <Move />}
        </div>

        {/* Both render after the board in DOM order, on purpose — a modal sits in front of
            the board it covers, not behind it. Discard's own scrim dims but doesn't blur the
            board (the artboard's own point: "the board stays visible behind it"); Handoff's
            blur wrapper above already covers the case where the board itself must be hidden. */}
        {!setup && waiting(s)?.kind === "discard" && <Discard />}
        <Handoff />
      </div>

      <div className="sr" role="status" aria-live="polite">{s.error ?? ""}</div>
    </div>
  );
}
