// The piece in your hand, over the board.
//
// At rest the board shows nothing you could do — no field of dots. Pick a piece up (drag it off
// its building card, or click the card), or have the game put one in your hand (the opening,
// the robber, Road Building), and only then do the places it can go show, as sockets that swell
// as the pointer comes near. The piece snaps to the nearest one; letting go of a drag, or a
// click, sets it down there. Nothing asks you to confirm: setting a piece down is the decision.
//
// Its own layer, laid exactly over the board with the same viewBox, because it re-renders on
// every pointer move and the board underneath — tiles, lattice, tokens — should not.
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Canon, MapView, View } from "../engine";
import { actionKey, label } from "../labels";
import type { Heat, Held } from "../waiting";
import { heldAction } from "../waiting";
import { C, R, SEAT_FILL } from "./palette";
import { EDGES, PIPS, VIEWBOX, hex, nodeXY, pts, tileCentre } from "./geometry";
import { Piece, RobberShape } from "./Board";

interface Spot { a: Canon; key: string; x: number; y: number; edge?: [number, number, number, number]; tile?: number; victim?: number }

/** How near (board units) the pointer must be for a piece to snap, and how far off a socket
 *  starts to answer it. A hex side is 44; an edge is measured to its nearest point, not its
 *  middle, so a press anywhere along a road's length takes it. */
const SNAP = { node: 26, edge: 15, tile: 40, victim: 24 };
const REACH = 132;
/** A victim's chip: how far above its building it floats, and its size, in board units. */
const CHIP_LIFT = 20;
const CHIP = { w: 22, h: 18, cut: 4 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** What a place is worth on the table's public numbers, 0..1, so a socket at rest says
 *  something before the pointer arrives: a corner by the pips it touches (a road by the better
 *  corner it reaches), a robber tile by the pips it takes off the other seats less what it
 *  takes off yours. Read straight off the board — no search, nothing hidden. */
function worthOf(map: MapView, view: View, seat: number) {
  const pipsAt = new Map<number, number>();
  for (const t of map.tiles) for (const n of t.nodes) pipsAt.set(n, (pipsAt.get(n) ?? 0) + (PIPS[t.number] ?? 0));
  const corner = (n: number) => Math.min(1, (pipsAt.get(n) ?? 0) / 13);
  const harm = map.tiles.map((t) => t.nodes.reduce((h, n) => {
    const o = view.owner[n];
    if (o < 0) return h;
    const w = (view.is_city[n] ? 2 : 1) * (PIPS[t.number] ?? 0);
    return h + (o === seat ? -w : w);
  }, 0));
  const most = Math.max(1, ...harm);
  return (sp: { a: Canon; tile?: number; victim?: number }) => {
    if (sp.victim != null) return 1;
    if (sp.tile != null) return clamp01(harm[sp.tile] / most);
    if (sp.a[0] === "BUILD_ROAD") { const [a, b] = EDGES[sp.a[1]]; return Math.max(corner(a), corner(b)) * 0.8; }
    return corner(sp.a[1]);
  };
}

/** A seat to rob, as a chip in its colour over its building with the cards it holds — a seat's
 *  swatch, the rail's own mark, not a ring or a halo around the piece. */
function VictimChip(x: number, y: number, seat: number, n: number, scale: number) {
  const { w, h, cut } = CHIP;
  const shape = `${-w / 2 + cut},${-h / 2} ${w / 2},${-h / 2} ${w / 2},${h / 2 - cut} ${w / 2 - cut},${h / 2} ${-w / 2},${h / 2} ${-w / 2},${-h / 2 + cut}`;
  return (
    <g style={{ translate: `${x.toFixed(2)}px ${y.toFixed(2)}px`, scale: String(scale), transition: "scale var(--t-feel) var(--ease)" }}>
      <polygon points={shape} fill={SEAT_FILL[seat]} style={{ filter: "drop-shadow(0 2px 2px rgba(18,33,31,.3))" }} />
      <text x="0" y="4.2" textAnchor="middle" fill={C.chalk} style={{ font: "700 12px var(--font-display)" }}>{n}</text>
    </g>
  );
}

export interface CarryProps {
  map: MapView; view: View; legal: Canon[]; seat: number;
  held: Held | null;
  /** The robber is down on a tile with several seats to rob; the sockets are now those seats. */
  robTile: number | null;
  heat?: Heat;
  /** Space: every legal placement shown at once, as a reading, not a control. */
  reveal: boolean;
  onPlace: (a: Canon) => void;
  onRobTile: (tile: number | null) => void;
  onDrop: () => void;
  onClickCarry: () => void;
  /** Touch (the phone): the least snap radius in screen px, whatever the board's scale — a fingertip, not a
   *  cursor. */
  snapPx?: number;
  /** Touch: while dragging, the piece and the point it snaps from ride this many px above the finger, so
   *  the finger never hides where it would land. A tap places where it lands. */
  liftPx?: number;
  /** Touch: a drag let go among the places but on none of them keeps the piece in hand rather than
   *  putting it back. */
  keepOnMiss?: boolean;
  /** The piece in hand has just found a spot (the phone's snap tick). */
  onSnap?: () => void;
}

export default function Carry({ map, view, legal, seat, held, robTile, heat, reveal, onPlace, onRobTile, onDrop, onClickCarry, snapPx = 0, liftPx = 0, keepOnMiss = false, onSnap }: CarryProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [ptr, setPtr] = useState<{ cx: number; cy: number } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const centres = useMemo(() => map.tiles.map((t) => tileCentre(t.nodes)), [map]);
  const worth = useMemo(() => worthOf(map, view, seat), [map, view, seat]);

  const spots: Spot[] = useMemo(() => {
    const kinds = held ? [heldAction(held.kind)] : reveal ? ["BUILD_ROAD", "BUILD_SETTLEMENT", "BUILD_CITY", "MOVE_ROBBER"] : [];
    const out: Spot[] = [];
    if (held?.kind === "robber" && robTile != null) {
      // Whom to rob: one socket under each victim's own building on that tile.
      for (const a of legal) {
        if (a[0] !== "MOVE_ROBBER" || a[1] !== robTile || a[2] < 0) continue;
        const node = map.tiles[robTile].nodes.find((n) => view.owner[n] === a[2]);
        if (node == null) continue;
        const [x, y] = nodeXY(node);
        // The chip that stands for the seat floats just above its building.
        out.push({ a, key: actionKey(a), x, y: y - CHIP_LIFT, victim: a[2] });
      }
      return out;
    }
    const tiles = new Set<number>();
    for (const a of legal) {
      if (!kinds.includes(a[0])) continue;
      if (a[0] === "BUILD_ROAD") {
        const [n1, n2] = EDGES[a[1]];
        const [x1, y1] = nodeXY(n1), [x2, y2] = nodeXY(n2);
        out.push({ a, key: actionKey(a), x: (x1 + x2) / 2, y: (y1 + y2) / 2, edge: [x1, y1, x2, y2] });
      } else if (a[0] === "MOVE_ROBBER") {
        if (tiles.has(a[1])) continue;                 // one socket per tile; whom comes after
        tiles.add(a[1]);
        const [x, y] = centres[a[1]];
        out.push({ a, key: `tile:${a[1]}`, x, y, tile: a[1] });
      } else {
        const [x, y] = nodeXY(a[1]);
        out.push({ a, key: actionKey(a), x, y });
      }
    }
    return out;
  }, [held, reveal, robTile, legal, map, view, centres]);

  // The pointer, wherever it is — a drag starts over the tray, not over the board.
  useEffect(() => {
    if (!held) { setPtr(null); return; }
    // The pointer moving takes over from the keyboard's choice.
    const move = (e: PointerEvent) => { setPtr({ cx: e.clientX, cy: e.clientY }); setFocus(null); };
    addEventListener("pointermove", move);
    return () => removeEventListener("pointermove", move);
  }, [held]);

  /** `lift`: a dragged piece's point, `liftPx` above the pointer. */
  const toBoard = (cx: number, cy: number, lift = false) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(cx, cy - (lift ? liftPx : 0)).matrixTransform(m.inverse());
    return [p.x, p.y] as const;
  };
  const at = ptr ? toBoard(ptr.cx, ptr.cy, !!held?.drag) : null;

  /** Screen px per board unit, for radii that must be a fingertip wide whatever the board's scale. */
  const pxPerUnit = () => { const b = svg.current?.getBoundingClientRect(); return b && b.width ? b.width / VIEWBOX.w : 1; };
  const radius = (sp: Spot) => Math.max(sp.victim != null ? SNAP.victim : sp.tile != null ? SNAP.tile : sp.edge ? SNAP.edge : SNAP.node, snapPx / pxPerUnit());
  /** How far a point is from a spot: an edge's nearest point, anything else its centre. */
  const dist = (sp: Spot, p: readonly [number, number]) => {
    if (!sp.edge) return Math.hypot(sp.x - p[0], sp.y - p[1]);
    const [x1, y1, x2, y2] = sp.edge;
    const k = Math.max(0, Math.min(1, ((p[0] - x1) * (x2 - x1) + (p[1] - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
    return Math.hypot(x1 + k * (x2 - x1) - p[0], y1 + k * (y2 - y1) - p[1]);
  };
  /** The spot a point on the board snaps to, if any. One rule for the preview, the click and
   *  the end of a drag, so what snaps is exactly what a press places. */
  const snapAt = (p: readonly [number, number] | null) => {
    if (!p) return null;
    let best: Spot | null = null, bd = Infinity;
    for (const sp of spots) {
      const d = dist(sp, p) / radius(sp);
      if (d < 1 && d < bd) { best = sp; bd = d; }
    }
    return best;
  };
  /** Whether a point is among the places at all — a press there that misses every socket is a
   *  near miss, not a decision to put the piece back. */
  const amongSpots = (p: readonly [number, number] | null) => !!p && spots.some((sp) => dist(sp, p) < REACH / 2);
  const near = !held ? null : focus ? spots.find((sp) => sp.key === focus) ?? null : snapAt(at);
  // Each spot the piece settles on ticks once, as it arrives there.
  const snapped = near?.key;
  useEffect(() => { if (snapped != null) onSnap?.(); }, [snapped]);  // eslint-disable-line react-hooks/exhaustive-deps

  const place = (sp: Spot) => {
    setFocus(null);
    if (sp.tile != null) {
      const victims = legal.filter((a) => a[0] === "MOVE_ROBBER" && a[1] === sp.tile);
      if (victims.length > 1) { onRobTile(sp.tile); return; }
      onPlace(victims[0]);
      return;
    }
    onPlace(sp.a);
  };

  // Picked up from the keyboard: hand focus to the places it can go, best first, since they sit
  // in the board's layer and Tab from the tray would walk away from them.
  const kbd = held?.kbd === true;
  useEffect(() => {
    if (!kbd) return;
    const best = [...spots].sort((a, b) => worth(b) - worth(a))[0];
    if (best) svg.current?.querySelector<SVGGElement>(`[data-key="${best.key}"]`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbd]);

  // A drag ends where the pointer comes up. A press that never travelled was a click: the piece
  // stays in hand and follows the pointer instead.
  const dragEnded = useRef(false);
  useEffect(() => {
    if (!held?.drag) return;
    const up = (e: PointerEvent) => {
      dragEnded.current = true;
      setTimeout(() => { dragEnded.current = false; });
      // A finger wobbles more than a mouse: on touch a tap may travel 10px and still be a tap.
      if (Math.hypot(e.clientX - held.x0, e.clientY - held.y0) < (snapPx ? 10 : 6)) { onClickCarry(); return; }
      const p = toBoard(e.clientX, e.clientY, true);
      const hit = snapAt(p);
      if (hit) place(hit);
      // Kept in hand, it stays where it was let go — lifted — or the preview would drop onto the spot under
      // the finger and look placed.
      else if (keepOnMiss && amongSpots(p)) { setPtr({ cx: e.clientX, cy: e.clientY - liftPx }); onClickCarry(); }
      else onDrop();
    };
    // A system gesture can take the pointer mid-drag; the piece goes back rather than staying mid-drag.
    const cancel = () => onDrop();
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
    return () => { removeEventListener("pointerup", up); removeEventListener("pointercancel", cancel); };
  });

  // Where the click landed, not where the pointer last moved: a tap, or a click with no move
  // before it, has no pointermove to go on — reading the last one placed pieces in the wrong
  // spot or dropped them.
  const tapAt = (cx: number, cy: number) => {
    if (!held) return;
    setPtr({ cx, cy });
    const p = toBoard(cx, cy);
    const hit = snapAt(p);
    if (hit) place(hit);
    else if (robTile != null) onRobTile(null);
    else if (!held.auto && !amongSpots(p)) onDrop();
  };
  // A touch places on the finger's lift, not on a click: browsers may drop or delay the click after a touch
  // (headless Chromium sends none at all), and the click that does follow is then ignored.
  const touchedAt = useRef(0);
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!held || held.drag || e.pointerType === "mouse") return;
    touchedAt.current = Date.now();
    tapAt(e.clientX, e.clientY);
  };
  const onClick = (e: MouseEvent) => {
    if (!held || dragEnded.current || Date.now() - touchedAt.current < 700) return;
    tapAt(e.clientX, e.clientY);
  };

  if (!held && !reveal) return null;
  const few = spots.length <= 4;
  const cards = (seat: number) => view.players[seat].hand.reduce((a, b) => a + b, 0);
  const ink = held?.kind === "robber" ? C.pine : SEAT_FILL[seat];
  const keyable = (sp: Spot) => ({
    role: "button" as const, tabIndex: held ? 0 : -1, "aria-label": label(sp.a, map), "data-key": sp.key,
    // The socket under the piece steps aside but stays mounted: it may hold the keyboard's focus.
    opacity: near?.key === sp.key ? 0 : undefined,
    // Only a keyboard focus chooses: a click also focuses, and must not pin the piece there.
    onFocus: (e: FocusEvent) => { if ((e.currentTarget as Element).matches(":focus-visible")) setFocus(sp.key); }, onBlur: () => setFocus((f) => (f === sp.key ? null : f)),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); place(sp); } },
  });

  // The board's on-screen scale, so the floating piece is the size it will land at.
  const box = svg.current?.getBoundingClientRect();
  // A piece the game handed you rides the pointer over the board only; one you took from the
  // tray goes wherever your hand goes.
  const overBoard = (p: { cx: number; cy: number }) =>
    !!box && p.cx > box.left && p.cx < box.right && p.cy > box.top && p.cy < box.bottom;
  const k = box ? box.width / VIEWBOX.w : 1;
  const robbed = robTile != null ? centres[robTile] : null;

  return (
    <>
      <svg ref={svg} className={`carry${held ? " holding" : ""}${held?.drag ? " dragging" : ""}`}
           viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} onClick={onClick} onPointerUp={onPointerUp}
           aria-label={held ? "Places for the piece in hand" : undefined}>
        {/* the board answers the hand: every socket swells with the pointer's nearness */}
        {spots.map((sp) => {
          const t = held ? (at ? clamp01(1 - dist(sp, at) / REACH) : 0) : 1;
          // At rest a socket shows what the place is worth (the coach's reading when the analysis
          // is open, the board's public numbers otherwise); the pointer's nearness swells it.
          // With only a handful of places left, every one is worth seeing whatever it pays —
          // a lone legal corner shown at its low worth was a hunt across the board.
          const h = Math.max(few ? 0.75 : 0, heat?.[sp.key] ?? worth(sp));
          // At rest a socket's strength is its worth, squared: the few places worth having are
          // plain to see before the pointer goes looking, the many poor ones stay a murmur.
          const o = Math.min(1, 0.08 + 0.64 * h * h + 0.4 * t);
          if (sp.victim != null) {
            // Whom to rob is a choice between hands, so each seat's chip carries its card count.
            return (
              <g key={sp.key} {...keyable(sp)} className="socket victim">
                {VictimChip(sp.x, sp.y, sp.victim, cards(sp.victim), 1 + 0.12 * t)}
              </g>
            );
          }
          if (sp.tile != null) {
            const [x, y] = centres[sp.tile];
            return (
              <g key={sp.key} {...keyable(sp)} className="socket">
                <polygon points={pts(hex(x, y, R - 7))} fill={C.chalk} opacity={0.05 + 0.18 * h + 0.25 * t} />
                <circle cx={x} cy={y - 24} r={1.4 + 3.4 * h + 1.6 * t} fill={C.pine} opacity={o} />
              </g>
            );
          }
          if (sp.edge) {
            const [x1, y1, x2, y2] = sp.edge;
            // A stub of the road, never the road: even fully swollen it stops short of both
            // corners and stays thinner than a built one, so a socket is not mistaken for a piece.
            const f = 0.14 + 0.12 * h + 0.12 * t;
            return (
              <g key={sp.key} {...keyable(sp)} className="socket">
                <line x1={sp.x + (x1 - sp.x) * f * 2} y1={sp.y + (y1 - sp.y) * f * 2} x2={sp.x + (x2 - sp.x) * f * 2} y2={sp.y + (y2 - sp.y) * f * 2}
                      stroke={ink} strokeWidth={2.4 + 1.2 * h + 1 * t} strokeLinecap="round" opacity={o} />
              </g>
            );
          }
          return (
            <g key={sp.key} {...keyable(sp)} className="socket">
              <circle cx={sp.x} cy={sp.y} r={1.6 + 4.8 * h + 3 * t} fill={ink} opacity={o} />
            </g>
          );
        })}

        {/* the robber waits on its tile while you choose whom */}
        {robbed && (
          <g className="held-piece" style={{ translate: `${robbed[0].toFixed(2)}px ${(robbed[1] - 17).toFixed(2)}px` }}><RobberShape /></g>
        )}

        {/* the piece in hand, snapped to the place it would land */}
        {held && near && (
          <g key={near.key} className="held-piece snap">
            {near.victim != null ? (
              VictimChip(near.x, near.y, near.victim, cards(near.victim), 1.3)
            ) : near.tile != null ? (
              <g style={{ translate: `${centres[near.tile][0].toFixed(2)}px ${(centres[near.tile][1] - 17).toFixed(2)}px` }}><RobberShape /></g>
            ) : near.edge ? (
              <line x1={near.edge[0]} y1={near.edge[1]} x2={near.edge[2]} y2={near.edge[3]} stroke={ink} strokeWidth="5.4" strokeLinecap="round" />
            ) : (
              Piece(held.kind === "city" ? "city" : "set", seat, near.x, near.y, "held")
            )}
          </g>
        )}
      </svg>

      {/* Off the sockets, the piece rides with the pointer — over the tray too, mid-drag. */}
      {held && ptr && !near && robTile == null && (!held.auto || overBoard(ptr)) && (
        <svg className="afloat" viewBox="-22 -22 44 44" aria-hidden="true"
             // Sized inline: the board layer's own `svg { width: 100% }` would otherwise win.
             style={{ left: ptr.cx - 22 * k, top: ptr.cy - (held.drag ? liftPx : 0) - 22 * k, width: 44 * k, height: 44 * k }}>
          {held.kind === "robber" ? <g transform="translate(0,8)"><RobberShape /></g>
            // Held level, an angle no edge on the board has, so a road in hand never passes for
            // one already set down.
            : held.kind === "road" ? <line x1="-15" y1="0" x2="15" y2="0" stroke={ink} strokeWidth="5.4" strokeLinecap="round" />
            : Piece(held.kind === "city" ? "city" : "set", seat, 0, 0, "afloat")}
        </svg>
      )}
    </>
  );
}
