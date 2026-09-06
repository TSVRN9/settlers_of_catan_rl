// The one board instance. Mounted once, never unmounted, never keyed, never inside a
// branch — that is what makes a view change a movement rather than a rebuild.
//
// Where it goes is decided by layout, not by arithmetic here: each view drops an empty
// [data-anchor] positioned by ordinary responsive CSS, and this parks the board on it. So
// the board is responsive for free, and the artboard's measured rects survive as the CSS
// percentages they came from.
//
// The travel between two anchors is the browser's: the layer carries
// `view-transition-name: board`, so a navigation (see store.transition) animates its box
// from the old rect to the new one over --t-board. There is no second animation system.
import { useEffect, useLayoutEffect, useRef } from "react";
import Board from "./Board";
import type { Canon, MapView, View } from "../engine";
import type { Heat } from "../waiting";
import type { ViewName } from "../store";

interface Props {
  view: ViewName;
  map: MapView;
  gameView: View;
  /** Behind the lineup: the board being configured, at half strength. On the layer itself
   *  so the view transition's snapshot carries it. */
  dim?: boolean;
  legal?: Canon[];
  onAction?: (a: Canon) => void;
  onChoice?: (acts: Canon[]) => void;
  heat?: Heat;
  highlight?: Canon | null;
  litTiles?: number[];
  hidePieces?: boolean;
  dealing?: boolean;
  ghost?: Canon | null;
  since?: View | null;
  onHover?: (a: Canon | null) => void;
}

export default function BoardLayer({ view, map, gameView, dim, ...rest }: Props) {
  const el = useRef<HTMLDivElement>(null);
  /** The last box written. An anchor can move without the view changing or the stage
   *  resizing — --board-x does exactly that when the coach opens — so parking runs on
   *  every render; this is what keeps that from rewriting the same box hundreds of times
   *  and, worse, restarting the CSS transition on sub-pixel drift. */
  const at = useRef({ left: NaN, top: NaN, width: NaN });

  const park = () => {
    const node = el.current;
    const anchor = document.querySelector<HTMLElement>(`[data-anchor="${view}"]`);
    if (!node || !anchor) return;
    const stage = anchor.offsetParent as HTMLElement | null;
    if (!stage) return;
    const to = anchor.getBoundingClientRect();
    const base = stage.getBoundingClientRect();
    const left = to.left - base.left, top = to.top - base.top, width = to.width;
    if (left === at.current.left && top === at.current.top && width === at.current.width) return;
    at.current = { left, top, width };
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${width}px`;
  };

  // Every render, not just every view: layout decides where the board goes, and layout
  // changes for reasons this component cannot enumerate.
  useLayoutEffect(park);

  useEffect(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-anchor="${view}"]`);
    const stage = anchor?.offsetParent as HTMLElement | null;
    if (!stage) return;
    // A resize is not a move: park without the transition, or the board lags the pointer
    // all the way through a window drag.
    const ro = new ResizeObserver(() => {
      const node = el.current;
      if (!node) { park(); return; }
      node.style.transition = "none";
      park();
      void node.offsetWidth;                 // flush, so the next real move animates again
      node.style.transition = "";
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [view]);

  return (
    <div id="board-layer" ref={el} style={{ opacity: dim ? 0.45 : 1 }}>
      <Board map={map} view={gameView} {...rest} />
    </div>
  );
}
