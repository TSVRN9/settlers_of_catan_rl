// One resource card, matching ViewTable.dc.html's own hand markup: a paper background, a
// colored bottom border naming the resource, and its glyph — the same GLYPH_MINI shapes the
// board's own tiles and port badges already draw (see Board.tsx's port-badge rendering),
// just refit to a small icon box. Every hand rendering in the app (Table, Console, Coach,
// Futures, Discard) draws through this, so the recipe — and the fix, if it's ever wrong
// again — lives in one place instead of five.
import { GLYPH_MINI, RES, RES_FILL } from "./palette";

const raw = (markup: string) => ({ __html: markup });

interface Props {
  resource: number;
  /** Omit for a single physical card (Discard's own cards, one box per card in hand) — there's
   *  nothing to count when the box already means "one of these." */
  count?: number;
  width: number;
  height: number;
  rotate?: number;
  dim?: boolean;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export default function Card({ resource, count, width, height, rotate, dim, selected, onClick, disabled }: Props) {
  const g = GLYPH_MINI[RES[resource]];
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className="cut8"
      title={RES[resource]}
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      style={{
        position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
        width, height, flex: `0 0 ${width}px`, background: "var(--color-paper)",
        border: 0, borderBottom: `${Math.max(3, Math.round(height / 20))}px solid ${RES_FILL[resource]}`,
        padding: 0, paddingBottom: Math.round(height * 0.08), font: "inherit", color: "inherit",
        cursor: disabled ? "default" : onClick ? "pointer" : "default",
        // A static card dims a little to mean "you have none of these"; an interactive one
        // (Discard's own cards) dims more to mean "not chosen" — two different questions,
        // so `selected` only enters into it when the card can actually be clicked.
        opacity: dim ? 0.4 : onClick && !selected ? 0.5 : 1,
        boxShadow: selected ? "inset 0 0 0 3px var(--color-pine)" : undefined,
        transform: rotate ? `rotate(${rotate}deg)` : undefined,
        transformOrigin: "bottom center",
      }}
    >
      <svg viewBox="0 0 32 32" width={Math.round(width * 0.43)} height={Math.round(width * 0.43)}
           style={{ position: "absolute", top: Math.round(height * 0.13), opacity: 0.85 }} aria-hidden="true">
        <g transform={`translate(16,16) scale(${g.k}) translate(${g.dx},${g.dy})`} dangerouslySetInnerHTML={raw(g.markup)} />
      </svg>
      {count != null && <span className="d num" style={{ fontSize: Math.max(11, Math.round(height * 0.22)) }}>{count}</span>}
    </Tag>
  );
}
