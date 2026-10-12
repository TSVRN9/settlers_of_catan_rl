// The four build cards: Road, Settlement, City, Dev card. Each carries its piece, its name and its cost as
// tokens, a resource's colour and glyph for each card it takes: solid when you hold it, a dust slot when you
// don't, so what you are short of is read off the card. A card whose build is not legal sinks. Press one to
// pick its piece up (drag it to the board, or tap and tap where it goes); the Dev card buys.
import type { PointerEvent } from "react";
import { act } from "../game";
import { COST } from "../coach";
import { GLYPH_MINI, RES, RES_FILL } from "../board/palette";
import { PieceIcon } from "../views/Build";
import { set, useApp, type Building } from "../store";
import { held } from "../waiting";

const KINDS = [
  { kind: "road", action: "BUILD_ROAD", name: "Road" },
  { kind: "settlement", action: "BUILD_SETTLEMENT", name: "Settlement" },
  { kind: "city", action: "BUILD_CITY", name: "City" },
  { kind: "dev", action: "BUY_DEVELOPMENT_CARD", name: "Dev card" },
] as const;

const raw = (markup: string) => ({ __html: markup });
/** One cost token: the resource's colour with its glyph, or a dust slot with the glyph faint. */
function Token({ r, have, w }: { r: number; have: boolean; w: number }) {
  const g = GLYPH_MINI[RES[r]];
  return (
    <span className="cut5 ph-tok" style={{ width: w, height: w + 3, background: have ? RES_FILL[r] : "var(--color-dust)" }}>
      <svg viewBox="0 0 32 32" width={w - 3} height={w - 3} aria-hidden="true" style={{ opacity: have ? 0.9 : 0.35 }}>
        <g transform={`translate(16,16) scale(${g.k}) translate(${g.dx},${g.dy})`} dangerouslySetInnerHTML={raw(g.markup)} />
      </svg>
    </span>
  );
}

export default function BuildCards({ sunk = false }: { sunk?: boolean }) {
  const s = useApp();
  const v = s.view!;
  const p = v.players[s.human];
  const left: Record<string, number> = { road: p.roads_available, settlement: p.settlements_available, city: p.cities_available };
  const h = held(s);
  const inHand = h && !h.auto ? h.kind : null;
  return (
    <div className="ph-build" role="group" aria-label="Build">
      {KINDS.map(({ kind, action, name }) => {
        const a = sunk ? undefined : s.legal.find((x) => x[0] === action);
        const taken = kind === inHand;
        const take = (e: PointerEvent) => {
          if (!a || kind === "dev" || e.button !== 0) return;
          e.preventDefault();
          set({ carry: { kind: kind as Building, drag: true, x0: e.clientX, y0: e.clientY }, robTile: null });
        };
        const tokens = COST[action].flatMap((n, r) => Array.from({ length: n }, (_, k) => ({ r, have: p.hand[r] > k })));
        const free = kind === "road" && v.is_road_building ? v.free_roads : 0;
        return (
          <button key={kind} className={`ph-bcard cut8${a ? " ready" : ""}${taken ? " taken" : ""}`} disabled={!a} onPointerDown={take}
                  aria-pressed={kind === "dev" ? undefined : taken}
                  onClick={(e) => {
                    if (!a) return;
                    if (kind === "dev") { void act(a); return; }
                    // A pointer already picked it up on the way down; a click with none before it is a keyboard
                    // or a screen reader, and picks it up to place from there.
                    if (!taken) set({ carry: { kind: kind as Building, drag: false, x0: 0, y0: 0, kbd: e.detail === 0 }, robTile: null });
                  }}
                  aria-label={kind === "dev" ? "Buy a development card" : `Pick up a ${name.toLowerCase()}`}>
            <span className="top">
              <PieceIcon kind={kind} seat={s.human} size={24} />
              {kind !== "dev" && left[kind] <= 2 && <span className="left num">{left[kind]} left</span>}
            </span>
            <span className="name">{name}</span>
            <span className="cost">
              {free ? <span className="num free">{free} free</span>
                : tokens.map((t, i) => <Token key={i} r={t.r} have={t.have} w={kind === "city" ? 13 : 15} />)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
