// One resource card, matching ViewTable.dc.html's own hand markup: a paper background, a
// colored bottom border naming the resource, and its glyph — the same GLYPH_MINI shapes the
// board's own tiles and port badges already draw (see Board.tsx's port-badge rendering),
// just refit to a small icon box. Every hand rendering in the app (Table, Console, Coach,
// Futures, Discard) draws through this, so the recipe — and the fix, if it's ever wrong
// again — lives in one place instead of five.
import { DEV_CARDS } from "../labels";
import { GLYPH_MINI, RES, RES_FILL } from "./palette";

const raw = (markup: string) => ({ __html: markup });

interface Props {
  /** A resource card by index, or — with `dev` — a development card by kind. */
  resource?: number;
  dev?: number;
  /** A change to the count, floated off the card; `deltaKey` restarts it for a new change. */
  delta?: number;
  deltaKey?: number;
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

export default function Card({ resource = 0, dev, count, width, height, rotate, dim, selected, onClick, disabled, delta, deltaKey }: Props) {
  const g = dev == null ? GLYPH_MINI[RES[resource]] : null;
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className="cut8 card"
      title={dev == null ? RES[resource] : DEV_CARDS[dev]}
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      style={{
        position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
        width, height, flex: `0 0 ${width}px`, background: "var(--color-paper)",
        border: 0, borderBottom: `${Math.max(3, Math.round(height / 20))}px solid ${dev == null ? RES_FILL[resource] : "var(--color-pine)"}`,
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
      {g ? (
        <svg viewBox="0 0 32 32" width={Math.round(width * 0.43)} height={Math.round(width * 0.43)}
             style={{ position: "absolute", top: Math.round(height * 0.13), opacity: 0.85 }} aria-hidden="true">
          <g transform={`translate(16,16) scale(${g.k}) translate(${g.dx},${g.dy})`} dangerouslySetInnerHTML={raw(g.markup)} />
        </svg>
      ) : (
        <span className="d" aria-hidden="true" style={{ position: "absolute", top: Math.round(height * 0.14), fontSize: Math.round(width * 0.42), opacity: 0.8 }}>
          {DEV_CARDS[dev!][0]}
        </span>
      )}
      {count != null && <span key={count} className="d num bump" style={{ fontSize: Math.max(11, Math.round(height * 0.22)) }}>{count}</span>}
      {delta ? (
        <span key={deltaKey} className="d num gain" style={{ color: delta > 0 ? "var(--color-wood)" : "var(--color-brick)", fontSize: Math.max(12, Math.round(height * 0.2)) }}>
          {delta > 0 ? `+${delta}` : `−${-delta}`}
        </span>
      ) : null}
    </Tag>
  );
}
