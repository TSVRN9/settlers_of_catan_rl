// The opening, shown as what it is: a draft. Every seat places a settlement and a road in seat
// order, then again in reverse — so the order is drawn as the snake it is, out along the top
// row and back along the bottom, each seat's two turns stacked in one column. A placed turn is
// solid, the turn being taken stands up, the rest wait faded.
//
// In the tray the opening has no hand and nothing to buy, so the building cards give way to the
// four pieces you place in it, in order.
import type { View } from "../engine";
import { SEAT_NAMES } from "../labels";
import { PieceIcon } from "./Build";

export { draft } from "../phone/pass";
import { draft } from "../phone/pass";

export function DraftOrder({ v, you }: { v: View; you: number }) {
  const n = v.n;
  const { turn } = draft(v);
  const cell = (seat: number, i: number) => {
    const state = i < turn ? "done" : i === turn ? "now" : "next";
    return (
      <span key={i} className={`draft-cell ${state}`} title={`${SEAT_NAMES[seat]}${seat === you ? " (you)" : ""}`}>
        <PieceIcon kind="settlement" seat={seat} size={state === "now" ? 32 : 24} />
      </span>
    );
  };
  return (
    <div className="draft" role="img" aria-label={`Opening: turn ${Math.min(turn + 1, 2 * n)} of ${2 * n}, ${SEAT_NAMES[v.current_player]} placing`}>
      <div className="draft-row">{Array.from({ length: n }, (_, s) => cell(s, s))}</div>
      <div className="draft-row">{Array.from({ length: n }, (_, s) => cell(s, 2 * n - 1 - s))}</div>
      {/* the U-turn: the second row reads back the way the first came */}
      <svg className="draft-turn" viewBox="0 0 14 30" aria-hidden="true">
        <path d="M0 4 H3 A11 11 0 0 1 3 26 H0" fill="none" stroke="var(--color-dust)" strokeWidth="2" strokeLinecap="round" />
        <path d="M4 22.5 L0 26 L4 29.5" fill="none" stroke="var(--color-dust)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Your four opening pieces in the order they go down; the one you are placing stands up. */
export function OpeningPieces({ v, seat, holding }: { v: View; seat: number; holding: boolean }) {
  const settlements = v.owner.filter((o) => o === seat).length;
  const roads = v.road_owner.filter((o) => o === seat).length;
  const done = settlements + roads;
  const yours = v.current_player === seat;
  return (
    <div className="opening" aria-label="Your opening pieces">
      {(["settlement", "road", "settlement", "road"] as const).map((kind, i) => {
        const state = i < done ? "done" : i === done && yours ? (holding ? "taken" : "now") : "next";
        return (
          <span key={i} className={`opiece ${state}`}>
            <PieceIcon kind={kind} seat={seat} size={34} />
          </span>
        );
      })}
    </div>
  );
}
