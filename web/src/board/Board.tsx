import React, { useMemo } from "react";
import type { Canon, MapView, View } from "../engine";
import { EDGES, NODE_XY, PORTS, S, TILES, VIEWBOX, px } from "./geometry";
import { RESOURCES, SEAT_COLORS, actionKey } from "../labels";

const TILE_FILL = ["#3f7d3a", "#b7472a", "#9ccc65", "#e6b422", "#8d8d94"];
const TILE_FILL_DESERT = "#e8d9a8";
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

export interface Heat { [key: string]: number } // actionKey -> 0..1 intensity (root EV rank)

/** Click targets are SVG shapes; this makes them focusable buttons for keyboard and screen-reader users. */
const keyable = (fire: () => void, label: string) => ({
  role: "button" as const,
  tabIndex: 0,
  "aria-label": label,
  onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } },
});

interface Props {
  map: MapView;
  view: View;
  legal?: Canon[];
  onAction?: (a: Canon) => void;
  heat?: Heat;
  highlight?: Canon | null;
  lastAction?: Canon | null;
  className?: string;
}

/** SVG hex board. Legal build / robber actions become click targets; `heat` tints them by the bot's ranking. */
export default function Board({ map, view, legal = [], onAction, heat, highlight, lastAction, className }: Props) {
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
  const hl = highlight ? actionKey(highlight) : null;
  const last = lastAction ? actionKey(lastAction) : null;
  const heatOf = (a: Canon) => (heat ? heat[actionKey(a)] : undefined);

  return (
    <svg viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} className={className ?? "w-full h-auto"} role="img" aria-label="Catan board">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1" floodOpacity="0.35" /></filter>
      </defs>
      {/* sea */}
      <rect x={VIEWBOX.x} y={VIEWBOX.y} width={VIEWBOX.w} height={VIEWBOX.h} rx={16} fill="#8ecae6" className="dark:opacity-80" />
      {/* tiles */}
      {TILES.map((t) => {
        const mt = map.tiles[t.id];
        const pts = t.nodes.map((n) => px(NODE_XY[n]).join(",")).join(" ");
        const [cx, cy] = px(t.center);
        const robber = view.robber === t.id;
        const acts = targets.tiles.get(t.id);
        const h = acts ? Math.max(...acts.map((a) => heatOf(a) ?? 0)) : 0;
        return (
          <g key={t.id}>
            <polygon points={pts} fill={mt.resource < 0 ? TILE_FILL_DESERT : TILE_FILL[mt.resource]} stroke="#f1e9d2" strokeWidth={2} />
            {mt.resource >= 0 && (
              <g>
                <circle cx={cx} cy={cy} r={S * 0.3} fill="#fbf4dc" stroke="#7c6a3c" strokeWidth={1} filter="url(#shadow)" />
                <text x={cx} y={cy + S * 0.09} textAnchor="middle" fontSize={S * 0.3} fontWeight={700} fill={mt.number === 6 || mt.number === 8 ? "#b91c1c" : "#1c1917"}>{mt.number}</text>
                <g>
                  {Array.from({ length: PIPS[mt.number] ?? 0 }).map((_, i, arr) => (
                    <circle key={i} cx={cx + (i - (arr.length - 1) / 2) * S * 0.07} cy={cy + S * 0.19} r={S * 0.025} fill={mt.number === 6 || mt.number === 8 ? "#b91c1c" : "#1c1917"} />
                  ))}
                </g>
              </g>
            )}
            {robber && (
              <g transform={`translate(${cx + S * 0.38},${cy - S * 0.42})`} filter="url(#shadow)">
                <ellipse cx={0} cy={S * 0.12} rx={S * 0.14} ry={S * 0.18} fill="#1c1917" />
                <circle cx={0} cy={-S * 0.1} r={S * 0.11} fill="#1c1917" />
              </g>
            )}
            {acts && (
              <polygon points={pts} fill={h ? `rgba(245,158,11,${0.25 + 0.55 * h})` : "rgba(255,255,255,0.35)"} stroke={hl && acts.some((a) => actionKey(a) === hl) ? "#f59e0b" : "#fff"} strokeWidth={hl && acts.some((a) => actionKey(a) === hl) ? 4 : 2} strokeDasharray="6 4" className="cursor-pointer focus:outline-none" {...keyable(() => onAction?.(acts[0]), `Move robber to tile ${t.id}`)} onClick={() => onAction?.(acts[0])} data-tile={t.id}>
                <title>{`Move robber here (${RESOURCES[mt.resource] ?? "desert"} ${mt.number || ""})`}</title>
              </polygon>
            )}
          </g>
        );
      })}
      {/* ports */}
      {PORTS.map((p) => {
        const mp = map.ports[p.id];
        const [cx, cy] = px(p.center);
        return (
          <g key={p.id}>
            {p.nodes.map((n) => { const [nx, ny] = px(NODE_XY[n]); return <line key={n} x1={cx} y1={cy} x2={nx} y2={ny} stroke="#8b5e3c" strokeWidth={3} strokeLinecap="round" opacity={0.8} />; })}
            <circle cx={cx} cy={cy} r={S * 0.26} fill="#fff7e6" stroke="#8b5e3c" strokeWidth={1.5} />
            <text x={cx} y={cy + S * 0.08} textAnchor="middle" fontSize={S * 0.22} fontWeight={700} fill="#5b3a1e">{mp.resource < 0 ? "3:1" : `2:1`}</text>
            {mp.resource >= 0 && <rect x={cx - S * 0.12} y={cy + S * 0.13} width={S * 0.24} height={S * 0.09} rx={2} fill={TILE_FILL[mp.resource]} />}
          </g>
        );
      })}
      {/* roads */}
      {EDGES.map(([a, b], e) => {
        const owner = view.road_owner[e];
        const [ax, ay] = px(NODE_XY[a]);
        const [bx, by] = px(NODE_XY[b]);
        const act = targets.edges.get(e);
        const h = act ? heatOf(act) : undefined;
        const isHl = act && hl === actionKey(act);
        const isLast = last && lastAction?.[0] === "BUILD_ROAD" && lastAction[1] === e;
        return (
          <g key={e}>
            {owner >= 0 && <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#1c1917" strokeWidth={S * 0.2} strokeLinecap="round" />}
            {owner >= 0 && <line x1={ax} y1={ay} x2={bx} y2={by} stroke={SEAT_COLORS[owner]} strokeWidth={S * 0.13} strokeLinecap="round" />}
            {isLast && <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#fbbf24" strokeWidth={S * 0.26} strokeLinecap="round" opacity={0.5} />}
            {act && (
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke={h != null ? `rgba(245,158,11,${0.35 + 0.65 * h})` : isHl ? "#f59e0b" : "rgba(255,255,255,0.75)"} strokeWidth={isHl ? S * 0.22 : S * 0.16} strokeLinecap="round" strokeDasharray={h == null && !isHl ? "5 4" : undefined} className="cursor-pointer focus:outline-none" {...keyable(() => onAction?.(act), `Build road ${a}-${b}`)} onClick={() => onAction?.(act)}>
                <title>Build road</title>
              </line>
            )}
          </g>
        );
      })}
      {/* buildings */}
      {NODE_XY.map((p, n) => {
        const owner = view.owner[n];
        const [x, y] = px(p);
        const act = targets.nodes.get(n);
        const h = act ? heatOf(act) : undefined;
        const isHl = act && hl === actionKey(act);
        const isLast = lastAction && (lastAction[0] === "BUILD_SETTLEMENT" || lastAction[0] === "BUILD_CITY") && lastAction[1] === n;
        return (
          <g key={n}>
            {isLast && <circle cx={x} cy={y} r={S * 0.34} fill="#fbbf24" opacity={0.5} />}
            {owner >= 0 && (view.is_city[n]
              ? <g filter="url(#shadow)"><rect x={x - S * 0.24} y={y - S * 0.14} width={S * 0.48} height={S * 0.3} rx={2} fill={SEAT_COLORS[owner]} stroke="#1c1917" strokeWidth={1.5} /><polygon points={`${x - S * 0.24},${y - S * 0.14} ${x - S * 0.1},${y - S * 0.3} ${x + S * 0.04},${y - S * 0.14}`} fill={SEAT_COLORS[owner]} stroke="#1c1917" strokeWidth={1.5} /></g>
              : <g filter="url(#shadow)"><polygon points={`${x - S * 0.17},${y - S * 0.05} ${x},${y - S * 0.22} ${x + S * 0.17},${y - S * 0.05} ${x + S * 0.17},${y + S * 0.15} ${x - S * 0.17},${y + S * 0.15}`} fill={SEAT_COLORS[owner]} stroke="#1c1917" strokeWidth={1.5} /></g>)}
            {act && (
              <circle cx={x} cy={y} r={isHl ? S * 0.26 : S * 0.2} fill={h != null ? `rgba(245,158,11,${0.35 + 0.65 * h})` : "rgba(255,255,255,0.8)"} stroke={isHl ? "#b45309" : "#57534e"} strokeWidth={isHl ? 3 : 1.5} strokeDasharray={h == null && !isHl ? "3 3" : undefined} className="cursor-pointer focus:outline-none" {...keyable(() => onAction?.(act), act[0] === "BUILD_CITY" ? `Upgrade node ${n} to a city` : `Build settlement at node ${n}`)} onClick={() => onAction?.(act)}>
                <title>{act[0] === "BUILD_CITY" ? "Upgrade to city" : "Build settlement"}</title>
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}
