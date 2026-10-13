// You: your row (colour, points, and with Eval on your chance), then your hand. The hand is one stack per
// resource, in fixed order, drawn at most four deep with the count on top; your development cards fan at
// the right. Holding a build card lifts the cards it spends out of their stacks, into the space your row
// gives up while you hold it, with a faint card for each one you are short.
import type { CSSProperties, ReactNode } from "react";
import Card from "../board/Card";
import { SEAT_FILL } from "../board/palette";
import { COST } from "../coach";
import { DEV_CARDS, RESOURCES, SEAT_NAMES } from "../labels";
import { act } from "../game";
import { playing, set, useApp } from "../store";
import { held, heldAction } from "../waiting";
import { pct, useMetrics } from "./usePhone";
import { inSlots, lifted } from "./drafts";
import { pickDiscard, useSlabMode } from "./Slab";

const DEEP = 4, STEP = 5, LIFT = 30;
const PLAY = ["PLAY_KNIGHT_CARD", "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_ROAD_BUILDING", null] as const;

/** What the held build card would spend, per resource, or null when nothing is picked up off a card. */
function spending(s: ReturnType<typeof useApp>): number[] | null {
  const h = held(s);
  return h && !h.auto ? COST[heldAction(h.kind)] ?? null : null;
}

export function YouRow() {
  const s = useApp();
  const v = s.view!;
  const win = s.evals[s.human]?.win;
  return (
    <div className="ph-you" style={{ opacity: spending(s) ? 0 : 1 }}>
      <i className="sw" style={{ background: SEAT_FILL[s.human] }} />
      <span className="nm">{s.lineup.filter((b) => b.kind === "human").length > 1 ? SEAT_NAMES[s.human] : "You"}</span>
      <span className="d num vp">{v.players[s.human].vp}</span>
      {s.evalShown && <>
        <div className="bar"><i style={{ width: `${(win ?? 0) * 100}%`, background: SEAT_FILL[s.human] }} /></div>
        <span className="num pct">{pct(win)}</span>
      </>}
    </div>
  );
}

/** One resource's stack: a button while the phase takes cards off the hand (the builder, a discard). */
function Stack({ r, tap, verb, style, children }: { r: number; tap: ((r: number) => void) | null; verb: string; style: CSSProperties; children: ReactNode }) {
  return tap
    ? <button data-res={r} className="ph-stack tap" style={style} onClick={() => tap(r)} aria-label={`${verb} one ${RESOURCES[r].toLowerCase()}`}>{children}</button>
    : <span data-res={r} className="ph-stack" style={style}>{children}</span>;
}

export function Hand() {
  const s = useApp();
  const { cw, ch } = useMetrics();
  const v = s.view!;
  const me = v.players[s.human];
  const mode = useSlabMode();
  const cost = lifted({ mode, cost: spending(s), give: s.offerDraft.give, asked: v.prompt === "DECIDE_TRADE" ? v.current_trade.slice(5, 10) : null });
  const slotted = mode === "discard" ? inSlots(s.discardPick) : null;
  const mine = playing(s) && v.current_player === s.human && s.step == null && s.pendingHandoff == null;
  // The pile lifts when a card in it can be played, and opens into the slab on your turn (phone/Slab.tsx DevSheet).
  const plays = mine ? s.legal.filter((a) => (PLAY as readonly (string | null)[]).includes(a[0])) : [];
  const sheetable = mine && v.prompt === "PLAY_TURN" && !v.is_resolving_trade;
  const kinds = me.devs.flatMap((n, k) => (n > 0 ? [k] : []));
  const dw = Math.round(cw * 0.8), dh = Math.round(ch * 0.84), step = 8;
  // In the builder a stack gives one card to the offer; in a discard it puts one in the next slot.
  const tap = mode === "builder" ? (r: number) => {
    const { give, want } = s.offerDraft;
    if (give[r] >= me.hand[r] || want[r] > 0) return;
    set({ offerDraft: { give: give.map((n, i) => (i === r ? n + 1 : n)), want } });
  } : mode === "discard" ? (r: number) => pickDiscard(r) : null;
  return (
    <div className="ph-hand" style={{ height: ch + (DEEP - 1) * STEP }}>
      {me.hand.map((n, r) => {
        const have = n - (slotted?.[r] ?? 0);
        const need = cost[r], up = Math.min(need, have), short = need - up, rest = have - up;
        const shown = Math.min(rest, DEEP);
        return (
          <Stack key={r} r={r} tap={tap} verb={mode === "discard" ? "Discard" : "Give"} style={{ width: cw, height: ch, marginTop: Math.max(Math.min(have, DEEP) - 1, 0) * STEP }}>
            {Array.from({ length: shown }, (_, i) => (
              <span key={i} className="ph-card" style={{ top: -(shown - 1 - i) * STEP, filter: i < shown - 1 ? "brightness(.93)" : undefined }}>
                <Card resource={r} count={i === shown - 1 ? rest : undefined} width={cw} height={ch} />
              </span>
            ))}
            {rest === 0 && <span className="ph-card empty cut8" style={{ width: cw, height: ch }} />}
            {Array.from({ length: up + short }, (_, j) => (
              <span key={`l${j}`} className={`ph-card lifted${j >= up ? " short" : ""}`}
                    style={{ left: j * 7, top: -LIFT + Math.abs(j - (up + short - 1) / 2) * 2, rotate: `${(j - (up + short - 1) / 2) * 5}deg` }}>
                <Card resource={r} width={cw} height={ch} />
              </span>
            ))}
          </Stack>
        );
      })}
      {kinds.length > 0 && (
        <button className={`ph-devs${plays.length ? " live" : ""}`} disabled={!sheetable}
                style={{ width: Math.max(44, dw + step * (kinds.length - 1)), height: Math.max(44, dh) }}
                onClick={() => set({ devSheet: { dev: null, first: null } })}
                aria-label={`Development cards: ${kinds.map((k) => `${me.devs[k]} ${DEV_CARDS[k]}`).join(", ")}`}>
          {kinds.map((k, i) => (
            <span key={k} className="ph-dev" style={{ left: i * step, rotate: `${(i - (kinds.length - 1) / 2) * 4}deg` }}>
              <Card dev={k} count={me.devs[k]} width={dw} height={dh} />
            </span>
          ))}
        </button>
      )}
    </div>
  );
}
