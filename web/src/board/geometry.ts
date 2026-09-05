// Board geometry, derived from the map the engine hands over rather than from array order.
//
// The old version indexed topology.tiles[t.id] and topology.ports[p.id], which assumed the
// Rust map_json() ordering matched the Python dump's. Nothing validated that and it broke
// once already (commit 27ea5c4). But map_json() carries `nodes` for every tile and port,
// and node ids *are* the engine's, so everything below is computed from those and the
// ordering stops mattering.
import topo from "../data/topology.json";

export const NODE_XY = topo.node_xy as [number, number][];
export const EDGES = topo.edges as [number, number][];

/** px per unit hex radius, the same 44 the design canvas uses. */
export const S = 44;

/** The design's own box: ports at 5.196 units plus room for a 16-unit badge. Every measured
 *  board width in web/design/measured.json maps onto it exactly (574/511.56 = 1.1220). */
export const VIEWBOX = { x: -236.72, y: -244.2, w: 511.56, h: 488.4 };

export const px = (p: [number, number]): [number, number] => [p[0] * S, p[1] * S];

export const nodeXY = (n: number): [number, number] => px(NODE_XY[n]);

/** A tile's centre is the mean of its six corners. */
export function tileCentre(nodes: number[]): [number, number] {
  let x = 0, y = 0;
  for (const n of nodes) { x += NODE_XY[n][0]; y += NODE_XY[n][1]; }
  return [(x / nodes.length) * S, (y / nodes.length) * S];
}

/** A port sits one hex radius off its own coastal edge, on the seaward side: the apex of the
 *  equilateral triangle standing on its two dock nodes, taken away from the island. */
export function portCentre(nodes: number[]): [number, number] {
  const [a, b] = [nodeXY(nodes[0]), nodeXY(nodes[1])];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const h = (Math.sqrt(3) / 2) * len;              // the apex height of that triangle
  const px1: [number, number] = [mx - (dy / len) * h, my + (dx / len) * h];
  const px2: [number, number] = [mx + (dy / len) * h, my - (dx / len) * h];
  return Math.hypot(px1[0], px1[1]) > Math.hypot(px2[0], px2[1]) ? px1 : px2;
}

/** Pointy-top corners, matching the design's hex(): first corner straight up. */
export function hex(cx: number, cy: number, r = S): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });
}

export const pts = (ps: [number, number][]) => ps.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

export const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
