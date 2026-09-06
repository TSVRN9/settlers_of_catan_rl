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
import Offer from "./views/Offer";
import Spine, { NAME } from "./Spine";
import { toLineup } from "./game";
import * as keys from "./keys";
import * as route from "./route";
import { currentView, playing, set, useApp } from "./store";
import { heat, waiting } from "./waiting";

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
  const title = view === "table" ? `Turn ${shown.num_turns}` : NAME[view];
  const back = view === "table" ? toLineup : route.pop;
  return (
    <button className="head" style={{ viewTransitionName: "head" } as CSSProperties} onClick={back}
            title={view === "table" ? "Back to the lineup" : "Back"}>
      <span className="chev" aria-hidden="true">‹</span>
      <span className="d">{title}</span>
    </button>
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
  const view = currentView(s);
  const setup = s.phase === "lineup";
  // A view reads the override only while it owns it, so leaving one analysis view for
  // another never shows the live position in between.
  const override = !setup && OWNS_OVERRIDE.has(view) ? s.boardOverride : null;
  const mine = !setup && playing(s) && s.view?.current_player === s.human && s.view.winner < 0 && s.step == null;
  // A board move is staged, never played from a click: the piece appears as a ghost and the
  // Table asks. Hovering a target previews it the same way.
  const live = view === "table" || view === "futures";

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
                legal={mine && view === "table" ? s.legal : []}
                onAction={(a) => set({ staged: a, hover: null })}
                onHover={(a) => set({ hover: a })}
                onChoice={(acts) => set({ pending: { title: `Move the robber there — whom do you rob?`, actions: acts } })}
                heat={s.revealAll ? heat(s.advice) : undefined}
                highlight={override?.highlight ?? (live ? s.mark : null)}
                ghost={live && mine ? s.staged ?? s.hover : null}
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
        {!setup && s.offering && <Offer />}
        <Handoff />
      </div>

      {/* No artboard exists below 1024, so the app says so rather than inventing a layout. */}
      <div className="narrow">
        <div>
          <div className="d" style={{ fontSize: 21 }}>The board needs a wider window</div>
          <div className="cap" style={{ marginTop: 8, maxWidth: 300 }}>
            Four seats, nineteen tiles and a value net's reading of all of it. About a
            thousand pixels across is the least it can be shown in.
          </div>
        </div>
      </div>

      <div className="sr" role="status" aria-live="polite">{s.error ?? ""}</div>
    </div>
  );
}
