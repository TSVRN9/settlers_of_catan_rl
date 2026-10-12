// The slab under your hand: one footprint whose job changes with the phase (phone/slab.ts decides which).
// Milestone 1 designs the roll, building and someone else's turn; every other position falls back to a list
// of its legal actions, so a whole game can be played on a phone before those phases get their own design.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { act, confirmHandoff, discardAll, live, toLineup } from "../game";
import Card from "../board/Card";
import { newsworthy, narrate } from "../coach";
import { SEAT_FILL } from "../board/palette";
import { bankFor, bundleText, canOffer, fmtDelta, label, packBundle, RESOURCES, SEAT_NAMES } from "../labels";
import { rowAt } from "../review";
import { get, playing, set, useApp, viewer, you } from "../store";
import { canPick, inSlots } from "./drafts";
import { held } from "../waiting";
import { Die } from "../views/Tray";
import { PieceIcon } from "../views/Build";
import BuildCards, { Token } from "./BuildCards";
import { slabMode, viewerNow, type SlabMode } from "./slab";
import { useMetrics } from "./usePhone";
import type { Canon, Evaluation } from "../engine";

const SETTLE_MS = 400;

/** The discard slots played, one card per action (`discardAll`); the slots empty whatever happens. */
let discarding = false;
async function commitDiscard(pick: number[]) {
  if (discarding) return;
  discarding = true;
  try { await discardAll(inSlots(pick)); } finally { discarding = false; set({ discardPick: [] }); }
}

/** A tap on a hand stack during a discard: that resource into the next free slot. Filling the last slot by
 *  hand commits (spec "Discard on a 7"); Suggest only fills, so the engine's pick is seen before it goes. */
export function pickDiscard(r: number) {
  const s = get();
  const v = s.view!;
  const need = v.discard_counts[s.human];
  if (discarding || !canPick(s.discardPick, need, v.players[s.human].hand, r)) return;
  const next = [...s.discardPick, r];
  set({ discardPick: next });
  if (next.length === need) void commitDiscard(next);
}

/** The discard: "Discard" and its slots, the cards already chosen grouped by resource (tap one to take it
 *  back), the empty slots after them; when they can't all sit in a row at a tappable size, the empties
 *  become one slot with their count. With Eval on, Suggest fills them with the engine's pick. */
function DiscardSlab() {
  const s = useApp();
  const v = s.view!;
  const { ch, tileH, btnH } = useMetrics();
  const pick = s.discardPick;
  // `need` falls as the commit plays its cards one by one; the slots stay as they were chosen meanwhile.
  const slots = Math.max(v.discard_counts[s.human], pick.length);
  const zoneH = s.evalShown ? tileH : tileH + 10 + btnH;
  const w = 44, h = Math.min(Math.round(ch * 0.88), zoneH - 16);
  const groups = inSlots(pick).flatMap((n, r) => (n > 0 ? [{ r, n }] : []));
  const empties = slots - pick.length;
  const fit = Math.floor((Math.min(innerWidth, 999) - 32 - 24 - 84 + 6) / (w + 6));
  const back = (r: number) => {
    if (discarding) return;
    const i = pick.lastIndexOf(r);
    set({ discardPick: pick.filter((_, k) => k !== i) });
  };
  const suggest = async () => {
    const picks = await live.suggestDiscards("vnet", 2);
    if (get().view?.prompt === "DISCARD" && !discarding) set({ discardPick: picks.map((a) => a[1]) });
  };
  return (
    <div className="ph-discard-slab">
      <div className="ph-discard cut8" style={{ height: zoneH }}>
        <span className="d">Discard</span>
        {groups.map(({ r, n }) => (
          <button key={r} className="ph-slot full" style={{ width: w, height: h }} onClick={() => back(r)} aria-label={`Keep one ${RESOURCES[r].toLowerCase()}`}>
            <Card resource={r} count={n > 1 ? n : undefined} width={w} height={h} />
          </button>
        ))}
        {groups.length + empties <= fit
          ? Array.from({ length: empties }, (_, k) => <span key={k} className="ph-slot cut8" style={{ width: w, height: h }} />)
          : empties > 0 && <span className="ph-slot cut8 num" style={{ width: w, height: h }}>{empties}</span>}
      </div>
      {s.evalShown && (
        <div className="ph-row" style={{ height: btnH }}>
          {empties === 0 && slots > 0
            ? <button className="ph-btn go cut8" onClick={() => void commitDiscard(pick)}>Discard</button>
            : <button className="ph-btn cut8" onClick={() => void suggest()}>Suggest</button>}
        </div>
      )}
    </div>
  );
}

/** An offer to you (or a counter to yours): the cards that would change hands and, with Eval on, what accepting
 *  does to your chance and the offerer's. Keyed on the trade, so a haggled re-offer lands as a new one. */
function OfferIn() {
  const s = useApp();
  const v = s.view!;
  const t = v.current_trade;
  const from = t[10];
  const { cw, ch, btnH } = useMetrics();
  const key = t.join(",");
  const [after, setAfter] = useState<{ key: string; evals: Evaluation[] } | null>(null);
  useEffect(() => {
    if (!s.evalShown) return;
    let on = true;
    live.acceptedReadings(viewer(s)).then((r) => { if (on) setAfter({ key, evals: s.showHidden ? r.full : r.pub }); }, () => {});
    return () => { on = false; };
  }, [key, s.evalShown, s.showHidden]);  // eslint-disable-line react-hooks/exhaustive-deps
  const accept = s.legal.find((a) => a[0] === "ACCEPT_TRADE"), reject = s.legal.find((a) => a[0] === "REJECT_TRADE");
  const w = Math.round(cw * 0.8), h = Math.round(ch * 0.8);
  const cards = (counts: number[]) => counts.flatMap((n, r) => Array.from({ length: n }, (_, k) => <Card key={`${r}.${k}`} resource={r} width={w} height={h} />));
  const eff = (seat: number) => (after?.key === key && s.evals[seat] ? after.evals[seat].win - s.evals[seat].win : null);
  return (
    <div className="ph-offer-slab">
      <div key={key} className="ph-offer cut8 arrive">
        <div className="side"><span className="lab">You get</span><div className="cards">{cards(t.slice(0, 5))}</div></div>
        <div className="side"><span className="lab">You give</span><div className="cards">{cards(t.slice(5, 10))}</div></div>
        {s.evalShown && (
          <div className="eff">
            {[s.human, from].map((seat) => {
              const d = eff(seat);
              return <span key={seat}><i style={{ background: SEAT_FILL[seat] }} />{d != null && <span className={`num ${d >= 0 ? "up" : "dn"}`}>{fmtDelta(d)}</span>}</span>;
            })}
          </div>
        )}
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        <button className="ph-btn cut8" disabled={!reject} onClick={() => reject && void act(reject)}>Decline</button>
        <button className="ph-btn go cut8" disabled={!accept} onClick={() => accept && void act(accept)}>Accept</button>
      </div>
    </div>
  );
}

const ZERO = [0, 0, 0, 0, 0];
/** packBundle gives each resource five bits (labels.ts); nineteen is the deck. */
const CAP = 19;

/** Your offer, built: one row of the five resources. A tap on a hand card gives it (it lifts, and its token
 *  reads −n); a tap on a token takes a given card back, or else asks for one more of it (+n, up to 3, then
 *  back to none). One row rather than two so it fits a short phone's slab at 44px a target. The bank or a
 *  port appears beside Offer only when the draft is exactly a trade the engine allows. */
function Builder() {
  const s = useApp();
  const v = s.view!;
  const { btnH } = useMetrics();
  const hand = v.players[s.human].hand;
  const { give, want } = s.offerDraft;
  const draft = (g: number[], w: number[]) => set({ offerDraft: { give: g, want: w } });
  const tapToken = (r: number) => {
    if (give[r] > 0) { draft(give.map((n, i) => (i === r ? n - 1 : n)), want); return; }
    const next = want[r] >= Math.min(3, CAP) ? 0 : want[r] + 1;
    draft(give, want.map((n, i) => (i === r ? next : n)));
  };
  const ok = s.legal.some((a) => a[0] === "OFFER_TRADE") && canOffer(give, want, hand, v.spent_offers);
  // The bank, only for exactly the trade the draft spells: k of one kind for one of another, at the engine's rate.
  const gives = give.flatMap((n, r) => (n > 0 ? [r] : []));
  const bank = gives.length === 1 ? bankFor(want, s.legal).find((a) => a[1] === gives[0] && a[2] === give[gives[0]]) : undefined;
  const close = () => set({ offering: false, offerDraft: { give: ZERO, want: ZERO } });
  return (
    <div className="ph-builder-slab">
      <div className="ph-builder cut8">
        <div className="toks">
          {ZERO.map((_, r) => {
            const n = give[r] ? -give[r] : want[r];
            return (
              <button key={r} className="ph-tokbtn" onClick={() => tapToken(r)}
                      aria-label={give[r] ? `Give one less ${RESOURCES[r].toLowerCase()}` : `Ask for ${want[r] >= 3 ? "none" : "one more"} ${RESOURCES[r].toLowerCase()}`}>
                <Token r={r} have={n !== 0 || hand[r] > 0} w={26} />
                {n !== 0 && <span className={`n num ${n < 0 ? "give" : "get"}`}>{n < 0 ? `−${-n}` : `+${n}`}</span>}
              </button>
            );
          })}
        </div>
        <span className="sum">{give.some(Boolean) && want.some(Boolean) ? `${bundleText(give)} for ${bundleText(want)}` : ""}</span>
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        <button className="ph-btn cut8" onClick={close}>Back</button>
        {bank && <button className="ph-btn cut8" onClick={() => void act(bank)}>{bank[2] === 4 ? "Bank" : "Port"} {bank[2]}:1</button>}
        <button className="ph-btn go cut8" disabled={!ok} onClick={() => void act(["OFFER_TRADE", packBundle(give), packBundle(want), -1])}>Offer</button>
      </div>
    </div>
  );
}

/** Your offer on the table: its cards, faint, while the answers come back on the chips; then a Trade for each
 *  seat that took it and Withdraw. The engine allows withdrawing only once every seat has answered. */
function OfferOut() {
  const s = useApp();
  const v = s.view!;
  const { cw, ch, btnH } = useMetrics();
  const t = v.current_trade;
  const confirms = s.legal.filter((a) => a[0] === "CONFIRM_TRADE");
  const cancel = s.legal.find((a) => a[0] === "CANCEL_TRADE");
  const w = Math.round(cw * 0.7), h = Math.round(ch * 0.7);
  const cards = (counts: number[]) => counts.flatMap((n, r) => Array.from({ length: n }, (_, k) => <Card key={`${r}.${k}`} resource={r} width={w} height={h} />));
  return (
    <div className="ph-offer-slab">
      <div className="ph-offer out cut8">
        <div className="side"><span className="lab">You give</span><div className="cards">{cards(t.slice(0, 5))}</div></div>
        <div className="side"><span className="lab">You get</span><div className="cards">{cards(t.slice(5, 10))}</div></div>
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        {confirms.map((a) => (
          <button key={a[1]} className="ph-btn go cut8" onClick={() => void act(a)}>
            <i className="ph-sw" style={{ background: SEAT_FILL[a[1]] }} />{confirms.length > 1 ? SEAT_NAMES[a[1]] : `Trade with ${SEAT_NAMES[a[1]]}`}
          </button>
        ))}
        <button className="ph-btn cut8" disabled={!cancel} onClick={() => cancel && void act(cancel)}>Withdraw</button>
      </div>
    </div>
  );
}

/** The slab's mode for the live position: `Hand` reads it too, since what the hand lifts and whether its
 *  stacks take taps depend on the phase (phone/drafts.ts). */
export function useSlabMode(): SlabMode {
  const s = useApp();
  const v = s.view!;
  const live = playing(s) && s.step == null;
  const mine = live && v.current_player === s.human && v.winner < 0;
  // Your own offer going round: the bots are on move, but the slab is still yours. A counter from a bot
  // names the bot in current_trade[10], so it is an offer to you, not this.
  const offerOut = live && v.is_resolving_trade && v.current_trade[10] === s.human && v.current_turn === s.human;
  return slabMode({ over: v.winner >= 0, mine, opening: v.initial_phase, prompt: v.prompt, legal: s.legal.map((a) => a[0]),
                    handoff: s.pendingHandoff != null, offerOut, builder: s.offering,
                    sheet: s.devSheet == null ? null : s.devSheet.dev == null ? "devs" : "pick" });
}

/** Every action of a position as a button: the fallback, and the list a Trade or a dev card opens. */
function Actions({ actions, onBack }: { actions: Canon[]; onBack?: () => void }) {
  const s = useApp();
  return (
    <div className="ph-list">
      {onBack && <button className="ph-act cut8 back" onClick={onBack}>‹ Back</button>}
      {actions.map((a, i) => (
        <button key={i} className="ph-act cut8" onClick={() => { set({ pending: null }); void act(a); }}>{label(a, s.map ?? undefined)}</button>
      ))}
    </div>
  );
}

/** The last few moves, newest on top, each with what it did to its own seat's chance (Eval on). */
function Moves() {
  const s = useApp();
  const rows: { i: number; seat: number; text: string; d: number | null }[] = [];
  for (let i = s.frames.length - 2; i >= 0 && rows.length < 3; i--) {
    const f = s.frames[i], row = rowAt(s.frames, i);
    if (!row || !f.action || !newsworthy(f.action) || !s.map) continue;
    const a = f.evals[f.seat]?.win, b = s.frames[i + 1].evals[f.seat]?.win;
    rows.push({ i, seat: f.seat, text: narrate(row, s.map, viewerNow(you(s), s.pendingHandoff)), d: a != null && b != null ? b - a : null });
  }
  return (
    <div className="ph-moves">
      {rows.map((r, k) => (
        <div key={r.i} className={`ph-move cut5${k ? "" : " new line"}`}>
          <i className="sw" style={{ background: SEAT_FILL[r.seat] }} />
          <span className="tx">{r.text}</span>
          {s.evalShown && r.d != null && Math.abs(r.d) >= 0.005 && <span className={`num dl ${r.d > 0 ? "up" : "dn"}`}>{fmtDelta(r.d)}</span>}
        </div>
      ))}
    </div>
  );
}

export default function Slab() {
  const s = useApp();
  const { tileH, btnH } = useMetrics();
  const v = s.view!;
  const mine = playing(s) && v.current_player === s.human && v.winner < 0 && s.step == null;
  const mode = useSlabMode();
  const of = (k: string) => s.legal.find((a) => a[0] === k);
  const H = tileH + 10 + btnH;

  const body = (() => {
    if (mine && s.pending) return <Actions actions={s.pending.actions} onBack={() => set({ pending: null })} />;
    switch (mode) {
      case "discard":
        return <DiscardSlab />;
      case "offer-in":
        return <OfferIn />;
      case "builder":
        return <Builder />;
      case "offer-out":
        return <OfferOut />;
      case "roll": {
        const roll = of("ROLL")!;
        return (
          <button className="ph-roll-slab cut" onClick={() => void act(roll)} aria-label="Roll the dice">
            <span className="dice"><Die n={4} size={54} /><Die n={2} size={54} /></span>
            <span className="d">Roll</span>
          </button>
        );
      }
      case "build": {
        const trades = s.legal.some((a) => a[0] === "OFFER_TRADE" || a[0] === "MARITIME_TRADE");
        const end = of("END_TURN");
        return (
          <div className="ph-build-slab">
            <BuildCards sunk={v.prompt === "MOVE_ROBBER"} />
            <div className="ph-row" style={{ height: btnH }}>
              <button className="ph-btn cut8" disabled={!trades} onClick={() => set({ offering: true, offerDraft: { give: ZERO, want: ZERO } })}>Trade</button>
              <button className="ph-btn go cut8" disabled={!end} onClick={() => end && void act(end)}>End turn</button>
            </div>
          </div>
        );
      }
      case "opening": {
        const h = held(s);
        const kind = h?.kind === "road" ? "road" : "settlement";
        return (
          <div className="ph-supply cut">
            <span className="now"><PieceIcon kind={kind} seat={s.human} size={64} /></span>
            <span className="next"><PieceIcon kind={kind === "road" ? "settlement" : "road"} seat={s.human} size={44} /></span>
          </div>
        );
      }
      case "bots":
        return (
          <div className="ph-bots">
            <Moves />
            {s.pendingHandoff != null && (
              <button className="ph-btn go cut8" style={{ height: btnH }} onClick={confirmHandoff}>
                {SEAT_NAMES[s.pendingHandoff]}: show hand
              </button>
            )}
          </div>
        );
      case "over":
        return (
          <div className="ph-over">
            <span className="d" style={{ color: SEAT_FILL[v.winner] }}>{SEAT_NAMES[v.winner]} won</span>
            <button className="ph-btn go cut8" style={{ height: btnH }} onClick={toLineup}>New game</button>
          </div>
        );
      default:
        return <Actions actions={s.legal} />;
    }
  })();

  // A tap that lands just after the slab changed under the finger was aimed at what used to be there
  // (a quick second tap in the fallback list would otherwise land on End turn): drop it. Keyboard activation
  // (detail 0) is aimed at the focused button, so it always goes through.
  const sig = `${mode}|${s.pending ? s.pending.actions.length : ""}|${s.legal.length}`;
  const changed = useRef({ sig, at: 0 });
  useLayoutEffect(() => { if (changed.current.sig !== sig) changed.current = { sig, at: performance.now() }; }, [sig]);
  const stale = (e: MouseEvent) => { if (e.detail > 0 && performance.now() - changed.current.at < SETTLE_MS) { e.stopPropagation(); e.preventDefault(); } };

  return <div className="ph-slab" style={{ height: H }} onClickCapture={stale}>{body}</div>;
}
