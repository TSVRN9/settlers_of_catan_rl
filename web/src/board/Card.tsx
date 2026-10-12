// One resource card, matching ViewTable.dc.html's own hand markup: a paper background, a
// colored bottom border naming the resource, and its glyph — the same GLYPH_MINI shapes the
// board's own tiles and port badges already draw (see Board.tsx's port-badge rendering),
// just refit to a small icon box. Every hand rendering in the app (Table, Console, Coach,
// Futures, Discard) draws through this, so the recipe — and the fix, if it's ever wrong
// again — lives in one place instead of five.
import { DEV_CARDS } from "../labels";
import { GLYPH_MINI, RES, RES_FILL } from "./palette";

const raw = (markup: string) => ({ __html: markup });

const INK = "var(--color-pine)";
/** One mark per development card, in deck order: knight, year of plenty, monopoly, road
 *  building, victory point. Filled shapes in the card's ink, like the resource glyphs. */
const DEV_GLYPH = [
  <path key="k" d="M16 3 L27 7.5 V15.5 C27 22 22 26.5 16 29 C10 26.5 5 22 5 15.5 V7.5 Z" fill={INK} />,
  <g key="y"><rect x="6" y="5" width="13" height="18" rx="1.5" fill={INK} opacity=".45" />
    <rect x="13" y="9" width="13" height="18" rx="1.5" fill={INK} /></g>,
  <path key="m" d="M4 25 L6.5 9 L12 16 L16 6 L20 16 L25.5 9 L28 25 Z" fill={INK} />,
  <g key="r" stroke={INK} strokeWidth="4.2" strokeLinecap="round"><path d="M5 15 L17 8" /><path d="M15 25 L27 18" /></g>,
  <path key="v" d="M16 3 L19.6 11.6 L28.9 12.4 L21.8 18.4 L24 27.5 L16 22.6 L8 27.5 L10.2 18.4 L3.1 12.4 L12.4 11.6 Z" fill={INK} />,
];

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
        // Chosen is pulled up out of the row, the way a card is drawn from a hand — never ringed.
        transform: [rotate ? `rotate(${rotate}deg)` : "", selected ? "translateY(-12px)" : ""].join(" ").trim() || undefined,
        transition: "transform var(--t-feel) var(--ease), opacity var(--t-feel) var(--ease), translate var(--t-feel) var(--ease)",
        transformOrigin: "bottom center",
      }}
    >
      {g ? (
        <svg viewBox="0 0 32 32" width={Math.round(width * 0.43)} height={Math.round(width * 0.43)}
             style={{ position: "absolute", top: Math.round(height * 0.13), opacity: 0.85 }} aria-hidden="true">
          <g transform={`translate(16,16) scale(${g.k}) translate(${g.dx},${g.dy})`} dangerouslySetInnerHTML={raw(g.markup)} />
        </svg>
      ) : (
        <svg viewBox="0 0 32 32" width={Math.round(width * 0.5)} height={Math.round(width * 0.5)}
             style={{ position: "absolute", top: Math.round(height * 0.12), opacity: 0.85 }} aria-hidden="true">
          {DEV_GLYPH[dev!]}
        </svg>
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
