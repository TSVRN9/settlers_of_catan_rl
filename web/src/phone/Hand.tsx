// You: your row (colour, points, and with Eval on your chance), then your hand. The hand is one stack per
// resource, in fixed order, drawn at most four deep with the count on top; your development cards fan at
// the right. Holding a build card lifts the cards it spends out of their stacks, into the space your row
// gives up while you hold it, with a faint card for each one you are short.
import Card from "../board/Card";
import { SEAT_FILL } from "../board/palette";
import { COST } from "../coach";
import { DEV_CARDS } from "../labels";
import { act } from "../game";
import { playing, set, useApp } from "../store";
import { held, heldAction } from "../waiting";
import { pct, useMetrics } from "./usePhone";

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
      <span className="nm">You</span>
      <span className="d num vp">{v.players[s.human].vp}</span>
      {s.evalShown && <>
        <div className="bar"><i style={{ width: `${(win ?? 0) * 100}%`, background: SEAT_FILL[s.human] }} /></div>
        <span className="num pct">{pct(win)}</span>
      </>}
    </div>
  );
}

export function Hand() {
  const s = useApp();
  const { cw, ch } = useMetrics();
  const v = s.view!;
  const me = v.players[s.human];
  const cost = spending(s);
  const mine = playing(s) && v.current_player === s.human && s.step == null && s.pendingHandoff == null;
  // Every playable development card's actions: the pile opens them as a list (Milestone 2 gives each card its
  // own drag or picker). Knight and Road Building then hand you a piece and Carry takes over.
  const plays = mine ? s.legal.filter((a) => (PLAY as readonly (string | null)[]).includes(a[0])) : [];
  const kinds = me.devs.flatMap((n, k) => (n > 0 ? [k] : []));
  const dw = Math.round(cw * 0.8), dh = Math.round(ch * 0.84), step = 8;
  return (
    <div className="ph-hand" style={{ height: ch + (DEEP - 1) * STEP }}>
      {me.hand.map((n, r) => {
        const need = cost?.[r] ?? 0, up = Math.min(need, n), short = need - up, rest = n - up;
        const shown = Math.min(rest, DEEP);
        return (
          <span key={r} data-res={r} className="ph-stack" style={{ width: cw, height: ch, marginTop: Math.max(Math.min(n, DEEP) - 1, 0) * STEP }}>
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
          </span>
        );
      })}
      {kinds.length > 0 && (
        <button className={`ph-devs${plays.length ? " live" : ""}`} disabled={!plays.length}
                style={{ width: Math.max(44, dw + step * (kinds.length - 1)), height: Math.max(44, dh) }}
                onClick={() => set({ pending: { title: "Development cards", actions: plays } })}
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
