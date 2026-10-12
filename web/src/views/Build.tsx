// The building-costs card, made four real cards in the tray: road, settlement, city,
// development. A card you can build from stands up out of the rim with your piece on it; one
// you can't sits down in it, its missing resources hollowed out of the cost. Take the piece —
// drag it to the board, or click to pick it up and click where it goes. The development card
// has nowhere to go, so pressing it buys.
//
// Every card reads the engine rather than restating a rule: it stands up exactly when an action
// of its kind is legal, which already folds in cost, supply and placement.
import type { PointerEvent } from "react";
import type { Canon, View } from "../engine";
import { act } from "../game";
import { COST } from "../coach";
import { CITY, CITY_DOOR, CITY_TOWER, RES_FILL, SEAT_FILL, SEAT_HI, SEAT_LO, SET, SET_ROOF } from "../board/palette";
import { pts } from "../board/geometry";
import { set, type Building, type Carry } from "../store";

const KINDS = [
  { kind: "road", action: "BUILD_ROAD", name: "Road" },
  { kind: "settlement", action: "BUILD_SETTLEMENT", name: "Settlement" },
  { kind: "city", action: "BUILD_CITY", name: "City" },
  { kind: "dev", action: "BUY_DEVELOPMENT_CARD", name: "Development card" },
] as const;

/** The warm grey seat is lighter than the chalk ground can carry at icon size (on the board a
 *  plinth or a shadow carries it), so off the board its icons are drawn a shade deeper. */
const GREY = 3;
export function PieceIcon({ kind, seat, size = 38 }: { kind: string; seat: number; size?: number }) {
  const deep = seat === GREY;
  const [body, roof] = deep ? [SEAT_LO[seat], SEAT_FILL[seat]] : [SEAT_FILL[seat], SEAT_HI[seat]];
  return (
    <svg viewBox="-16 -14 32 28" width={size} height={size * 0.875} aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
      {kind === "road" && <line x1="-12" y1="7" x2="12" y2="-7" stroke={body} strokeWidth="5.4" strokeLinecap="round" />}
      {kind === "settlement" && <>
        <polygon points={pts(SET as [number, number][])} fill={body} />
        <polygon points={pts(SET_ROOF as [number, number][])} fill={roof} />
      </>}
      {kind === "city" && <>
        <polygon points={pts(CITY as [number, number][])} fill={body} />
        <polygon points={pts(CITY_TOWER as [number, number][])} fill={roof} />
        <polygon points={pts(CITY_DOOR as [number, number][])} fill={SEAT_LO[seat]} />
      </>}
      {kind === "dev" && <>
        <rect x="-8" y="-11" width="16" height="22" rx="1.5" fill="var(--color-pine)" />
        <rect x="-5" y="-8" width="10" height="10" rx="1" fill="var(--color-chalk)" opacity=".85" />
      </>}
    </svg>
  );
}

export default function Build({ view, seat, legal, carry }: { view: View; seat: number; legal: Canon[]; carry: Carry | null }) {
  const p = view.players[seat];
  const left: Record<string, number> = { road: p.roads_available, settlement: p.settlements_available, city: p.cities_available };
  // Your own turn, after the roll — the only time a card sitting down needs a reason.
  const turnOpen = legal.some((x) => x[0] === "END_TURN");
  return (
    <div className="build" role="group" aria-label="Build">
      {KINDS.map(({ kind, action, name }) => {
        const a = legal.find((x) => x[0] === action);
        const inHand = carry?.kind === kind;
        const take = (e: PointerEvent) => {
          if (!a || kind === "dev" || e.button !== 0) return;
          e.preventDefault();
          // Pressing the card of the piece already in hand puts it back.
          if (inHand && !carry!.drag) { set({ carry: null }); return; }
          set({ carry: { kind: kind as Building, drag: true, x0: e.clientX, y0: e.clientY }, robTile: null });
        };
        // Pips: one per card of the cost, hollowed where your hand runs short.
        const pips = COST[action].flatMap((n, r) => Array.from({ length: n }, (_, k) => ({ r, held: p.hand[r] > k })));
        // Road Building's roads cost nothing, so the road card says so instead of its price.
        const free = kind === "road" && view.is_road_building ? view.free_roads : 0;
        // Paid for but going nowhere — no legal corner or edge left, or no cards in the deck —
        // is a different reason to sit down than being short, so the card says which.
        const stuck = !a && turnOpen && pips.every((x) => x.held);
        return (
          <button key={kind} className={`cut8 bcard${a ? " ready" : ""}${inHand ? " taken" : ""}`} disabled={!a}
                  aria-label={kind === "dev" ? `Buy a ${name.toLowerCase()}` : `Pick up a ${name.toLowerCase()}`}
                  title={name} aria-pressed={kind === "dev" ? undefined : inHand}
                  onPointerDown={take}
                  // A keyboard press (detail 0) picks the piece up to place with the keyboard; a
                  // pointer press was already handled on the way down.
                  onClick={(e) => {
                    if (!a) return;
                    if (kind === "dev") { void act(a); return; }
                    if (e.detail === 0) set({ carry: inHand ? null : { kind: kind as Building, drag: false, x0: 0, y0: 0, kbd: true } });
                  }}>
            <span className="bpiece"><PieceIcon kind={kind} seat={seat} /></span>
            {free ? <span className="bnote">{free} free</span>
              : stuck ? <span className="bnote">{kind === "dev" ? "none left" : "no room"}</span>
              : <span className="bcost">
                  {pips.map(({ r, held }, i) => <i key={i} className={held ? undefined : "short"} style={{ ["--c" as string]: RES_FILL[r] }} />)}
                </span>}
            {/* The supply only matters once it runs short, so it shows then. */}
            {kind !== "dev" && left[kind] <= 2 && <span className="bleft">{left[kind]} left</span>}
          </button>
        );
      })}
    </div>
  );
}
