// The shell: the spine, the stage, whichever view is current, and the one board.
//
// BoardLayer is a *sibling* of the view slot and is never conditional and never keyed. That
// is the whole structural claim of this redesign: swapping the view cannot take the game
// with it, the way the old tab router did.
import { useEffect } from "react";
import BoardLayer from "./board/BoardLayer";
import Lineup from "./views/Lineup";
import Table from "./views/Table";
import Console from "./views/Console";
import Coach from "./views/Coach";
import Futures from "./views/Futures";
import Game from "./views/Game";
import Move from "./views/Move";
import Handoff from "./views/Handoff";
import Discard from "./views/Discard";
import Spine from "./Spine";
import { act } from "./game";
import * as keys from "./keys";
import * as route from "./route";
import { currentView, set, useApp } from "./store";
import { heat, waiting } from "./waiting";

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
  const setup = s.phase === "lineup" || !s.map || !s.view;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Spine />

      <div className="stage">
        {/* Hotseat blurs everything below rather than unmounting it — a handoff is a curtain,
            not a navigation, so whatever view and step you were on is exactly where the next
            player's own turn resumes once they tap through. */}
        <div style={s.pendingHandoff != null ? { filter: "blur(8px)", opacity: 0.45, pointerEvents: "none" } : undefined}>
          {setup && <Lineup />}

          {!setup && view === "table" && <Table />}
          {!setup && view === "console" && <Console />}
          {!setup && view === "coach" && <Coach />}
          {!setup && view === "futures" && <Futures />}
          {!setup && view === "game" && <Game />}
          {!setup && view === "move" && <Move />}

          {/* The board outlives every view, and stays on screen behind the lineup once a game
              has been dealt — you are never configuring something you cannot see. */}
          {s.map && s.view && (
            <div style={setup ? { opacity: 0.45, transition: "opacity var(--t-panel) var(--ease)" } : undefined}>
              {setup && <div data-anchor="table" />}
              <BoardLayer
                view={setup ? "table" : view}
                map={s.map}
                gameView={s.boardOverride?.view ?? s.view}
                legal={!setup && view !== "futures" && view !== "game" && view !== "move" && s.view.current_player === s.human && s.view.winner < 0 ? s.legal : []}
                onAction={(a) => void act(a)}
                onChoice={(acts) => set({ pending: { title: `Move the robber to ${acts.length} choices — whom do you rob?`, actions: acts } })}
                heat={s.revealAll ? heat(s.advice) : undefined}
                highlight={s.boardOverride?.highlight ?? null}
                litTiles={s.boardOverride?.litTiles}
                hidePieces={s.phase === "dealing"}
                dealing={s.phase === "dealing"}
              />
            </div>
          )}
        </div>

        {/* Both render after the board in DOM order, on purpose — a modal sits in front of
            the board it covers, not behind it. Discard's own scrim dims but doesn't blur the
            board (the artboard's own point: "the board stays visible behind it"); Handoff's
            blur wrapper above already covers the case where the board itself must be hidden. */}
        {!setup && waiting(s)?.kind === "discard" && <Discard />}
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
