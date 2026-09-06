// The spine: one 28px line, and the only permanent chrome in the app.
//
// Left, the path — where you are and, in every crumb before the last, the way back to it.
// Then the turn, which is a door into the whole-game analysis rather than a crumb. Right,
// whatever is waiting for you, derived from the same snapshot everything else reads, which
// is how a seven or a trade offer reaches you three views deep in analysis.
import { SEAT_NAMES } from "./labels";
import { SEAT_FILL } from "./board/palette";
import { to, toRoot } from "./route";
import { openGameAnalysis } from "./review";
import { currentView, useApp, type ViewName } from "./store";
import { waiting } from "./waiting";

const REVIEW = new Set<ViewName>(["game", "move"]);

/** What each view is called — the crumb, and the header's word. */
export const NAME: Record<ViewName, string> = {
  table: "Table",
  futures: "Every legal move",
  game: "The whole game",
  move: "One decision",
};

export default function Spine() {
  const s = useApp();
  // At the setup there is nothing in progress to report, even though the last game's final
  // position is still on screen behind it.
  const w = s.phase === "lineup" ? null : waiting(s);
  const seat = w ? w.seat : s.human;

  return (
    <div className="spine">
      {s.crumbs.map((c, i) => {
        const last = i === s.crumbs.length - 1;
        const label = c === "game" && s.step != null ? `Step ${s.step}` : NAME[c];
        return (
          <span key={`${c}${i}`}>
            {i > 0 && <span className="sep">›</span>}
            <button className={`crumb${last ? " now" : ""}`} disabled={last}
                    onClick={() => to(i)} aria-current={last ? "page" : undefined}>
              {label}
            </button>
          </span>
        );
      })}

      {s.view && s.phase !== "lineup" && !REVIEW.has(currentView(s)) && (
        <button className="step num" onClick={() => openGameAnalysis()}
                title="Open the whole game at this turn">
          turn {s.view.num_turns}
        </button>
      )}

      {w && (
        w.loud ? (
          <button className="warn loud" onClick={toRoot} title="Back to the table">
            <i style={{ background: SEAT_FILL[seat] }} />
            {w.text}
          </button>
        ) : (
          <span className="warn">
            <i style={{ background: SEAT_FILL[seat] }} />
            {w.text}
            <span className="sr">{`, ${SEAT_NAMES[seat]}`}</span>
          </span>
        )
      )}
    </div>
  );
}
