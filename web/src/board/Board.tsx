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
import React, { useMemo } from "react";
import type { Canon, MapView, View } from "../engine";
import { actionKey, SEAT_NAMES } from "../labels";
import type { Heat } from "../waiting";
import {
  CITY, CITY_DOOR, CITY_TOWER, C, DESERT_FILL, GLYPH, GLYPH_MINI, PORT_FILL,
  PORT_GENERIC_FILL, PORT_R, RES, RES_FILL, SEAT_FILL, SEAT_HI, SEAT_LO, SET, SET_ROOF,
  TAPER_IN, TAPER_OUT, TOKEN, CX, CY, R,
} from "./palette";
import { EDGES, PIPS, VIEWBOX, hex, nodeXY, portCentre, pts, tileCentre } from "./geometry";

/** Click targets are SVG shapes; this makes them focusable buttons for keyboard and
 *  screen-reader users. Lifted from the previous board, which had it right. */
const keyable = (fire: () => void, label: string) => ({
  role: "button" as const,
  tabIndex: 0,
  "aria-label": label,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
  },
});

const pipsOf = (n: number) => PIPS[n] ?? 0;
const raw = (markup: string) => ({ __html: markup });

interface Props {
  map: MapView;
  view: View;
  legal?: Canon[];
  onAction?: (a: Canon) => void;
  /** Several actions on one target — the caller decides how to ask. */
  onChoice?: (acts: Canon[]) => void;
  heat?: Heat;
  highlight?: Canon | null;
  /** Tiles an analysis reading is pointing at — Game analysis lights the tiles behind
   *  whichever attribution row is hovered. Independent of `highlight`, which marks one
   *  hypothetical action's own target. */
  litTiles?: number[];
  /** Withholds the pieces, so a deal can put the board down before the position. */
  hidePieces?: boolean;
  dealing?: boolean;
}

export default function Board({ map, view, legal = [], onAction, onChoice, heat, highlight, litTiles, hidePieces, dealing }: Props) {
  const centres = useMemo(() => map.tiles.map((t) => tileCentre(t.nodes)), [map]);

  // The deal resolves outward from the middle, so a tile's --i is its rank by distance from
  // the board's centre rather than its position in the map array.
  const rank = useMemo(() => {
    const order = centres.map((c, i) => [i, Math.hypot(c[0], c[1])] as const).sort((a, b) => a[1] - b[1]);
    const out = new Array<number>(centres.length);
    order.forEach(([i], r) => { out[i] = r; });
    return out;
  }, [centres]);

  const targets = useMemo(() => {
    const nodes = new Map<number, Canon>();
    const edges = new Map<number, Canon>();
    const tiles = new Map<number, Canon[]>();
    for (const a of legal) {
      if (a[0] === "BUILD_SETTLEMENT" || a[0] === "BUILD_CITY") nodes.set(a[1], a);
      else if (a[0] === "BUILD_ROAD") edges.set(a[1], a);
      else if (a[0] === "MOVE_ROBBER") tiles.set(a[1], [...(tiles.get(a[1]) ?? []), a]);
    }
    return { nodes, edges, tiles };
  }, [legal]);

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

  const hl = highlight ? actionKey(highlight) : null;
  const heatOf = (a: Canon) => heat?.[actionKey(a)];
  const fire = (a: Canon) => () => onAction?.(a);
  // A tile can carry several MOVE_ROBBER actions, one per victim. Firing the first silently
  // chose for you; now the choice is handed up when there is one to make.
  const fireTile = (acts: Canon[]) => () => (acts.length === 1 ? onAction?.(acts[0]) : onChoice?.(acts));

  const piece = (kind: "set" | "city", seat: number, x: number, y: number, key: string) => {
    const body = kind === "city" ? CITY : SET;
    const base = kind === "city" ? 10.5 : 8.8;
    const halfW = kind === "city" ? 13 : 9.5;
    // The plinth is the only shadow: the tile darkens where the piece stands.
    const plinth = hex(0, base + 0.5, halfW + 4).map(([px, pz]) => [px, (pz - (base + 0.5)) * 0.42 + base + 0.5] as [number, number]);
    return (
      <g key={key} className="pc" transform={`translate(${x.toFixed(2)},${(y - (kind === "city" ? 3 : 1)).toFixed(2)})`}>
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
  };

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
                return <line key={n} x1={x} y1={y} x2={vx} y2={vy} stroke={C.pine} strokeWidth="2" strokeLinecap="round" opacity="0.35" />;
              })}
              <circle cx={x} cy={y} r={PORT_R} fill={generic ? PORT_GENERIC_FILL : PORT_FILL[p.resource]} />
              {g && (
                <g opacity="0.55"
                   transform={`translate(${x.toFixed(2)},${(y - 5).toFixed(2)}) scale(${g.k}) translate(${g.dx},${g.dy})`}
                   dangerouslySetInnerHTML={raw(g.markup)} />
              )}
              <text x={x} y={y + 11} textAnchor="middle" fontSize="9" fontWeight="700" fill={C.pine}>
                {generic ? "3:1" : "2:1"}
              </text>
            </g>
          );
        })}
      </g>

      {/* the island */}
      <g className="tiles">
        {map.tiles.map((t, i) => (
          <polygon key={t.id} className="tl" style={{ ["--i" as string]: rank[i] }}
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
            <g key={t.id} className="tk" style={{ ["--i" as string]: rank[i] }}
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

      {!hidePieces && (
        <g className="pieces">
          {/* Roads run the whole edge with round caps, so a chain fuses into one line. */}
          {EDGES.map((_, e) => {
            const owner = view.road_owner[e];
            if (owner < 0) return null;
            const [a, b] = EDGES[e];
            const [x1, y1] = nodeXY(a), [x2, y2] = nodeXY(b);
            return <line key={`r${e}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SEAT_FILL[owner]} strokeWidth="5.4" strokeLinecap="round" />;
          })}
          {view.owner.map((owner, n) => {
            if (owner < 0) return null;
            const [x, y] = nodeXY(n);
            return piece(view.is_city[n] ? "city" : "set", owner, x, y, `p${n}`);
          })}
          {view.robber >= 0 && map.tiles[view.robber] && (() => {
            const [x, y] = centres[view.robber];
            return (
              <g transform={`translate(${x.toFixed(2)},${(y - 17).toFixed(2)})`}>
                <path d="M-6 0 L-6 -4 Q-6 -10 0 -10 Q6 -10 6 -4 L6 0 Z" fill={C.pine} />
                <circle cx="0" cy="-13" r="4.4" fill={C.pine} />
                <rect x="-8" y="0" width="16" height="3" fill={C.pine} />
              </g>
            );
          })()}
        </g>
      )}

      {/* The ring marking what a hypothetical action changed — independent of `legal`, since
          a clone board showing an already-applied action has none. */}
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

      {/* what you can do, drawn last so it sits on top of everything */}
      <g className="targets">
        {[...targets.tiles].map(([id, acts]) => {
          const [x, y] = centres[id];
          const h = Math.max(...acts.map((a) => heatOf(a) ?? 0));
          return (
            <polygon key={`t${id}`} points={pts(hex(x, y, R - 6))} fill={`rgba(226,174,63,${0.24 + 0.46 * h})`}
                     style={{ cursor: "pointer" }} onClick={fireTile(acts)}
                     {...keyable(fireTile(acts), acts.length > 1
                       ? `Move the robber to tile ${id} and choose whom to rob`
                       : `Move the robber to tile ${id}`)}>
              <title>{acts.length > 1 ? "Move the robber here, then choose whom to rob" : "Move the robber here"}</title>
            </polygon>
          );
        })}
        {[...targets.edges].map(([e, a]) => {
          const [n1, n2] = EDGES[e];
          const [x1, y1] = nodeXY(n1), [x2, y2] = nodeXY(n2);
          const h = heatOf(a) ?? 0;
          const on = hl === actionKey(a);
          return (
            <line key={`e${e}`} x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={on ? C.pine : `rgba(226,174,63,${0.55 + 0.4 * h})`} strokeWidth={on ? 7 : 5.4}
                  strokeLinecap="round" style={{ cursor: "pointer" }} onClick={fire(a)}
                  {...keyable(fire(a), `Build a road on edge ${e}`)}>
              <title>Build a road</title>
            </line>
          );
        })}
        {[...targets.nodes].map(([n, a]) => {
          const [x, y] = nodeXY(n);
          const h = heatOf(a) ?? 0;
          const on = hl === actionKey(a);
          return (
            <circle key={`n${n}`} cx={x} cy={y} r={on ? 10 : 8}
                    fill={on ? C.pine : `rgba(226,174,63,${0.62 + 0.35 * h})`}
                    style={{ cursor: "pointer" }} onClick={fire(a)}
                    {...keyable(fire(a), a[0] === "BUILD_CITY" ? `Upgrade node ${n} to a city` : `Build a settlement at node ${n}`)}>
              <title>{a[0] === "BUILD_CITY" ? "Upgrade to a city" : "Build a settlement"}</title>
            </circle>
          );
        })}
      </g>
    </svg>
  );
}
