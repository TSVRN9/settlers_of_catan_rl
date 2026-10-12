// The board, as the design canvas draws it, on live engine data.
//
// Everything here is board.mjs transcribed — the plinth as the only shadow, no stroke or
// outline on any piece, r16.5 number tokens with their pip rows, watermarks at 13%, roads
// that fuse into a chain, the lattice tapering away, no island outline, ports filled like
// tiles. What changed is where the content comes from: map.tiles instead of a fixture, and
// view.owner / is_city / road_owner instead of a hand-written position.
//
// The glyph markup is injected as raw SVG. It is generated at build time from our own
// design source by web/design/export-tokens.mjs, never from anything a user supplies.
import { useMemo } from "react";
import type { Canon, MapView, View } from "../engine";
import { actionKey, SEAT_NAMES } from "../labels";
import {
  CITY, CITY_DOOR, CITY_TOWER, C, DESERT_FILL, GLYPH, GLYPH_MINI, PORT_FILL,
  PORT_GENERIC_FILL, PORT_R, RES, RES_FILL, SEAT_FILL, SEAT_HI, SEAT_LO, SET, SET_ROOF,
  TAPER_IN, TAPER_OUT, TOKEN, CX, CY, R,
} from "./palette";
import { EDGES, PIPS, VIEWBOX, hex, nodeXY, portCentre, pts, tileCentre } from "./geometry";


const pipsOf = (n: number) => PIPS[n] ?? 0;
const raw = (markup: string) => ({ __html: markup });

interface Props {
  map: MapView;
  view: View;
  highlight?: Canon | null;
  /** Tiles an analysis reading is pointing at — Game analysis lights the tiles behind
   *  whichever attribution row is hovered. Independent of `highlight`, which marks one
   *  hypothetical action's own target. */
  litTiles?: number[];
  /** Withholds the pieces, so a deal can put the board down before the position. */
  hidePieces?: boolean;
  dealing?: boolean;
  /** A move shown before it is played — hovered in Futures — as the mover's own piece at
   *  half strength. */
  ghost?: Canon | null;
  /** The position this one is a hypothetical from: pieces not in it are new, and land. */
  since?: View | null;
  /** The robber is in someone's hand: the one on the board fades to where it was standing. */
  robberLifted?: boolean;
}

export default function Board({ map, view, highlight, litTiles, hidePieces, dealing, ghost, since, robberLifted }: Props) {
  const centres = useMemo(() => map.tiles.map((t) => tileCentre(t.nodes)), [map]);

  // The deal resolves outward from the middle, so a tile's --i is its rank by distance from
  // the board's centre rather than its position in the map array.
  const rank = useMemo(() => {
    const order = centres.map((c, i) => [i, Math.hypot(c[0], c[1])] as const).sort((a, b) => a[1] - b[1]);
    const out = new Array<number>(centres.length);
    order.forEach(([i], r) => { out[i] = r; });
    return out;
  }, [centres]);

  // The lattice the island sits on: the same loop that places the tiles, so it lines up by
  // construction. Opacity falls off with distance squared, so it thins away faster than it
  // starts, and the board reads as part of a surface rather than a shape on a page.
  const lattice = useMemo(() => {
    const taken = new Set(centres.map(([x, y]) => `${Math.round(x * 10)},${Math.round(y * 10)}`));
    const out: [number, number, number][] = [];
    for (let r = Math.floor((VIEWBOX.y - 40) / CY) - 1; r <= Math.ceil((VIEWBOX.y + VIEWBOX.h + 40) / CY) + 1; r++)
      for (let c = Math.floor((VIEWBOX.x - 40) / CX) - 1; c <= Math.ceil((VIEWBOX.x + VIEWBOX.w + 40) / CX) + 1; c++) {
        if (((c + r) % 2 + 2) % 2 !== 0) continue;
        const x = c * CX, y = r * CY;
        if (taken.has(`${Math.round(x * 10)},${Math.round(y * 10)}`)) continue;
        const d = Math.hypot(x, y);
        const o = d <= TAPER_IN ? 1 : Math.max(0, 1 - (d - TAPER_IN) / (TAPER_OUT - TAPER_IN));
        if (o > 0.02) out.push([x, y, +(o * o).toFixed(3)]);
      }
    return out;
  }, [centres]);

  return (
    <svg viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} role="img"
         aria-label="The board" className={`board-svg${dealing ? " dealing" : ""}`}>
      <desc>
        {`A ${map.tiles.length}-tile board. `}
        {view.winner >= 0 ? `${SEAT_NAMES[view.winner]} has won.` : `${SEAT_NAMES[view.current_player]} is on move.`}
      </desc>

      {/* the surface */}
      <g className="grid">
        {lattice.map(([x, y, o], i) => (
          <polygon key={i} points={pts(hex(x, y, R - 2.5))} fill="none" stroke={C.grid} strokeWidth="1.2" opacity={o} />
        ))}
      </g>

      {/* ports, under the island so any overlap hides behind a tile */}
      <g className="ports">
        {map.ports.map((p) => {
          const [x, y] = portCentre(p.nodes);
          const generic = p.resource < 0;
          const g = generic ? null : GLYPH_MINI[RES[p.resource]];
          return (
            <g className="pt" key={p.id}>
              {p.nodes.map((n) => {
                const [vx, vy] = nodeXY(n);
                return <line key={n} x1={x} y1={y} x2={vx} y2={vy} stroke={C.pine} strokeWidth="2.6" strokeLinecap="round" opacity="0.5" />;
              })}
              <circle cx={x} cy={y} r={PORT_R} fill={generic ? PORT_GENERIC_FILL : PORT_FILL[p.resource]} />
              {g && (
                <g opacity="0.55"
                   transform={`translate(${x.toFixed(2)},${(y - 5).toFixed(2)}) scale(${g.k}) translate(${g.dx},${g.dy})`}
                   dangerouslySetInnerHTML={raw(g.markup)} />
              )}
              <text x={x} y={generic ? y + 3.5 : y + 11} textAnchor="middle" fontSize="9" fontWeight="700" fill={C.pine}>
                {generic ? "3:1" : "2:1"}
              </text>
            </g>
          );
        })}
      </g>

      {/* the island */}
      <g className="tiles">
        {map.tiles.map((t, i) => (
          <polygon key={t.id} className="tl" data-tile={t.id} style={{ ["--i" as string]: rank[i] }}
                   points={pts(hex(centres[i][0], centres[i][1], R - 2.5))}
                   fill={t.resource < 0 ? DESERT_FILL : RES_FILL[t.resource]} />
        ))}
      </g>

      <g className="glyphs">
        {map.tiles.map((t, i) => {
          if (t.resource < 0) return null;
          const g = GLYPH[RES[t.resource]];
          if (!g) return null;
          return (
            <g key={t.id} className="gl" style={{ ["--i" as string]: rank[i] }} opacity="0.13"
               transform={`translate(${(centres[i][0] - g.origin[0]).toFixed(2)},${(centres[i][1] - g.origin[1]).toFixed(2)})`}
               dangerouslySetInnerHTML={raw(g.markup)} />
          );
        })}
      </g>

      {/* Numbers. The group carries the translate, and the pop animates the `scale`
          individual property, which applies first — so each token pops about its own tile
          rather than about the board's origin. */}
      <g className="tokens">
        {map.tiles.map((t, i) => {
          if (!t.number) return null;
          const hot = t.number === 6 || t.number === 8;
          const ink = hot ? C.wheat : C.chalk;
          const n = pipsOf(t.number);
          return (
            <g key={t.id} className="tk" data-tile={t.id} style={{ ["--i" as string]: rank[i] }}
               transform={`translate(${centres[i][0].toFixed(2)},${centres[i][1].toFixed(2)})`}>
              <polygon points={pts(hex(0, 0, TOKEN.r))} fill={C.pine} />
              <text y={TOKEN.base} textAnchor="middle" fontSize={TOKEN.font} fontWeight="700" fill={ink}>{t.number}</text>
              {Array.from({ length: n }, (_, k) => (
                <circle key={k} cx={((k - (n - 1) / 2) * TOKEN.pipGap).toFixed(2)} cy={TOKEN.pipCy} r={TOKEN.pipR} fill={ink} />
              ))}
            </g>
          );
        })}
      </g>

      {/* The ring marking what a hypothetical action changed — independent of `legal`, since
          a clone board showing an already-applied action has none. Under the pieces: a mark is
          about a place, and never sits on a piece. */}
      {highlight && (
        <g className="mark">
          {(highlight[0] === "BUILD_SETTLEMENT" || highlight[0] === "BUILD_CITY") && (() => {
            const [x, y] = nodeXY(highlight[1]);
            return <circle cx={x} cy={y} r={13} fill="none" stroke={C.pine} strokeWidth="2" />;
          })()}
          {highlight[0] === "BUILD_ROAD" && (() => {
            const [a, b] = EDGES[highlight[1]];
            const [x1, y1] = nodeXY(a), [x2, y2] = nodeXY(b);
            return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.pine} strokeWidth="9" strokeLinecap="round" opacity="0.4" />;
          })()}
          {highlight[0] === "MOVE_ROBBER" && map.tiles[highlight[1]] && (() => {
            const [x, y] = centres[highlight[1]];
            return <polygon points={pts(hex(x, y, R - 1))} fill="none" stroke={C.pine} strokeWidth="2.5" />;
          })()}
        </g>
      )}

      {litTiles && litTiles.length > 0 && (
        <g className="mark">
          {litTiles.map((t) => map.tiles[t] && (
            <polygon key={t} points={pts(hex(centres[t][0], centres[t][1], R - 1))} fill="none" stroke={C.wheat} strokeWidth="2.5" />
          ))}
        </g>
      )}

      {!hidePieces && (
        <g className="pieces">
          {/* A road's shadow, the plinth's counterpart: a road on a tile of its own colour — grey
              on ore, red on brick — is separated from it by the shade it casts, not an outline.
              The road's own width, offset down, so only its fall shows and never a rim. */}
          {EDGES.map((_, e) => {
            const owner = view.road_owner[e];
            if (owner < 0) return null;
            const [x1, y1] = nodeXY(EDGES[e][0]), [x2, y2] = nodeXY(EDGES[e][1]);
            const fresh = since ? since.road_owner[e] !== owner : false;
            return <line key={`rs${e}`} className={fresh ? "pc new" : "pc"} x1={x1} y1={y1 + 1.8} x2={x2} y2={y2 + 1.8}
                         stroke={C.pine} strokeOpacity="0.24" strokeWidth="5.4" strokeLinecap="round" />;
          })}
          {/* Roads run the whole edge with round caps, so a chain fuses into one line. */}
          {EDGES.map((_, e) => {
            const owner = view.road_owner[e];
            if (owner < 0) return null;
            const [a, b] = EDGES[e];
            const [x1, y1] = nodeXY(a), [x2, y2] = nodeXY(b);
            const fresh = since ? since.road_owner[e] !== owner : false;
            return <line key={`r${e}`} className={fresh ? "pc new" : "pc"} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SEAT_FILL[owner]} strokeWidth="5.4" strokeLinecap="round" />;
          })}
          {view.owner.map((owner, n) => {
            if (owner < 0) return null;
            const [x, y] = nodeXY(n);
            const fresh = since ? since.owner[n] !== owner || since.is_city[n] !== view.is_city[n] : false;
            return Piece(view.is_city[n] ? "city" : "set", owner, x, y, `p${n}${view.is_city[n] ? "c" : "s"}`, fresh ? "pc new" : "pc");
          })}
          {view.robber >= 0 && map.tiles[view.robber] && (() => {
            const [x, y] = centres[view.robber];
            return (
              <g className="robber" opacity={robberLifted ? 0.22 : 1} style={{ translate: `${x.toFixed(2)}px ${(y - 17).toFixed(2)}px` }}><RobberShape /></g>
            );
          })()}
          {/* a move before it is played: the mover's piece, at half strength */}
          {ghost && (ghost[0] === "BUILD_SETTLEMENT" || ghost[0] === "BUILD_CITY") && (() => {
            const [x, y] = nodeXY(ghost[1]);
            return <g className="ghost" key={`g${actionKey(ghost)}`}>{Piece(ghost[0] === "BUILD_CITY" ? "city" : "set", view.current_player, x, y, "ghost", "pc")}</g>;
          })()}
          {ghost && ghost[0] === "BUILD_ROAD" && (() => {
            const [a, b] = EDGES[ghost[1]];
            const [x1, y1] = nodeXY(a), [x2, y2] = nodeXY(b);
            return <line className="ghost pc" key={`g${actionKey(ghost)}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SEAT_FILL[view.current_player]} strokeWidth="5.4" strokeLinecap="round" />;
          })()}
          {ghost && ghost[0] === "MOVE_ROBBER" && map.tiles[ghost[1]] && (() => {
            const [x, y] = centres[ghost[1]];
            return (
              <g className="ghost" key={`g${actionKey(ghost)}`} style={{ translate: `${x.toFixed(2)}px ${(y - 17).toFixed(2)}px` }}><RobberShape /></g>
            );
          })()}
        </g>
      )}

    </svg>
  );
}

/** A settlement or city standing at (x, y), with its plinth — the board's only shadow. Shared
 *  with the piece in hand (Carry.tsx), so what you hold is exactly what lands. */
export function Piece(kind: "set" | "city", seat: number, x: number, y: number, key: string, cls = "pc") {
  const body = kind === "city" ? CITY : SET;
  const base = kind === "city" ? 10.5 : 8.8;
  const halfW = kind === "city" ? 13 : 9.5;
  // The plinth: the tile darkens where the piece stands.
  const plinth = hex(0, base + 0.5, halfW + 4).map(([px, pz]) => [px, (pz - (base + 0.5)) * 0.42 + base + 0.5] as [number, number]);
  return (
    <g key={key} className={cls} transform={`translate(${x.toFixed(2)},${(y - (kind === "city" ? 3 : 1)).toFixed(2)})`}>
      <polygon points={pts(plinth)} fill={C.pine} opacity="0.22" />
      <polygon points={pts(body as [number, number][])} fill={SEAT_FILL[seat]} />
      {kind === "city" ? (
        <>
          <polygon points={pts(CITY_TOWER as [number, number][])} fill={SEAT_HI[seat]} />
          <polygon points={pts(CITY_DOOR as [number, number][])} fill={SEAT_LO[seat]} />
        </>
      ) : (
        <polygon points={pts(SET_ROOF as [number, number][])} fill={SEAT_HI[seat]} />
      )}
    </g>
  );
}

/** The robber, standing on its base at the origin. */
export const RobberShape = () => (
  <>
    <path d="M-6 0 L-6 -4 Q-6 -10 0 -10 Q6 -10 6 -4 L6 0 Z" fill={C.pine} />
    <circle cx="0" cy="-13" r="4.4" fill={C.pine} />
    <rect x="-8" y="0" width="16" height="3" fill={C.pine} />
  </>
);
