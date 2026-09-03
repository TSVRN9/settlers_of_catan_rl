// Board geometry from tools/dump_engine_consts.py (unit-radius pointy-top hexes; node ids are the engine's).
import topo from "../data/topology.json";

export const NODE_XY = topo.node_xy as [number, number][];
export const TILES = topo.tiles as { id: number; coord: number[]; nodes: number[]; center: [number, number] }[];
export const PORTS = topo.ports as { id: number; coord: number[]; direction: string; nodes: number[]; center: [number, number] }[];
export const EDGES = topo.edges as [number, number][];

export const S = 44; // px per unit
const xs = [...NODE_XY.map((p) => p[0]), ...PORTS.map((p) => p.center[0])];
const ys = [...NODE_XY.map((p) => p[1]), ...PORTS.map((p) => p.center[1])];
const pad = 1.1;
export const VIEWBOX = {
  x: (Math.min(...xs) - pad) * S,
  y: (Math.min(...ys) - pad) * S,
  w: (Math.max(...xs) - Math.min(...xs) + 2 * pad) * S,
  h: (Math.max(...ys) - Math.min(...ys) + 2 * pad) * S,
};
export const px = (p: [number, number]) => [p[0] * S, p[1] * S] as [number, number];
export const edgeMid = (e: number): [number, number] => {
  const [a, b] = EDGES[e];
  return px([(NODE_XY[a][0] + NODE_XY[b][0]) / 2, (NODE_XY[a][1] + NODE_XY[b][1]) / 2]);
};
