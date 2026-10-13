// Your grade beside the piece you just set down (spec "Set down"): only while that move is the last one played, only
// with Eval on, never under a pass-and-play cover. On open board to the right of the piece; it doesn't take taps.
import { useLayoutEffect, useState } from "react";
import { EDGES, nodeXY, tileCentre } from "../board/geometry";
import { GRADE_INK, onBoard, showLive } from "../grade";
import { useApp, you } from "../store";

export default function GradeTag({ covered }: { covered: boolean }) {
  const s = useApp();
  const k = s.frames.length - 2;
  const g = s.grades[k], f = s.frames[k];
  const live = !!g && !!f?.action && showLive(k, s.frames.length) && onBoard(f.action) && f.seat === you(s) && s.evalShown && !covered && s.step == null;
  const [at, setAt] = useState<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (!live || !f?.action || !s.map) { setAt(null); return; }
    const a = f.action;
    const p: [number, number] = a[0] === "BUILD_ROAD"
      ? (([u, v]) => { const [x1, y1] = nodeXY(u), [x2, y2] = nodeXY(v); return [(x1 + x2) / 2, (y1 + y2) / 2] as [number, number]; })(EDGES[a[1]])
      : a[0] === "MOVE_ROBBER" ? tileCentre(s.map.tiles[a[1]].nodes) : nodeXY(a[1]);
    const svg = document.querySelector<SVGSVGElement>("#board-layer svg");
    const ctm = svg?.getScreenCTM();
    if (!ctm) { setAt(null); return; }
    const q = new DOMPoint(p[0] + 14, p[1]).matrixTransform(ctm);
    setAt([q.x, q.y]);
  }, [live, k, s.map]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!live || !at) return null;
  return <span className="ph-gradetag cut5 arrive" style={{ left: at[0], top: at[1], background: GRADE_INK[g.grade] }}>{g.grade}</span>;
}
