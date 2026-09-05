// The one board instance. Mounted once, never unmounted, never keyed, never inside a
// branch — that is what makes a view change a movement rather than a rebuild.
//
// Where it goes is decided by layout, not by arithmetic here: each view drops an empty
// [data-anchor] positioned by ordinary responsive CSS, and this measures it. So the board
// is responsive for free, and the artboard's measured rects survive as the CSS percentages
// they came from.
//
// The travel is FLIP: park on the new anchor with no transition, then animate one transform
// back from where it was. Nothing relayouts mid-flight. Under reduced motion the function
// returns early — the board still changes size, it just arrives there.
import { useEffect, useLayoutEffect, useRef } from "react";
import Board from "./Board";
import type { Canon, MapView, View } from "../engine";
import type { Heat } from "../waiting";
import type { ViewName } from "../store";

interface Props {
  view: ViewName;
  map: MapView;
  gameView: View;
  legal?: Canon[];
  onAction?: (a: Canon) => void;
  onChoice?: (acts: Canon[]) => void;
  heat?: Heat;
  highlight?: Canon | null;
  litTiles?: number[];
  hidePieces?: boolean;
  dealing?: boolean;
}

export default function BoardLayer({ view, map, gameView, ...rest }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const last = useRef<DOMRect | null>(null);

  const park = (animate: boolean) => {
    const node = el.current;
    const anchor = document.querySelector<HTMLElement>(`[data-anchor="${view}"]`);
    if (!node || !anchor) return;
    const stage = anchor.offsetParent as HTMLElement | null;
    if (!stage) return;
    const from = last.current ?? node.getBoundingClientRect();
    const to = anchor.getBoundingClientRect();
    const base = stage.getBoundingClientRect();

    node.style.transition = "none";
    node.style.left = `${to.left - base.left}px`;
    node.style.top = `${to.top - base.top}px`;
    node.style.width = `${to.width}px`;
    node.style.transform = "";
    last.current = to;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduced || from.width === 0 || to.width === 0) return;
    if (Math.abs(from.left - to.left) < 0.5 && Math.abs(from.top - to.top) < 0.5 && Math.abs(from.width - to.width) < 0.5) return;

    const k = from.width / to.width;
    node.style.transformOrigin = "top left";
    node.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})`;
    node.getBoundingClientRect();                       // flush, so the next line animates
    node.style.transition = "transform var(--t-board) var(--ease)";
    node.style.transform = "";
  };

  useLayoutEffect(() => { park(true); }, [view]);

  useEffect(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-anchor="${view}"]`);
    const stage = anchor?.offsetParent as HTMLElement | null;
    if (!stage) return;
    const ro = new ResizeObserver(() => { last.current = null; park(false); });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [view]);

  return (
    <div id="board-layer" ref={el}>
      <Board map={map} view={gameView} {...rest} />
    </div>
  );
}
