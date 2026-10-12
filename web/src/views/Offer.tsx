// Offering a trade, built rather than picked from a list — in a panel beside the board, not over
// it, since what you want is usually read off the board. The cards are the controls.
//
// The engine enumerates only its 20-bundle catalogue — one or two cards a side — which is
// why `legal` carries a couple of hundred OFFER_TRADE actions and why the old panel was a
// wall of them. But apply.rs validates offers free-form and never consults that catalogue,
// so an offer assembled here is applied as written: three-for-one, two-for-three, whatever
// the hand allows. The bots answer it normally; they simply never propose such offers
// themselves.
//
// Every rule apply.rs enforces is enforced on the controls instead — a `+` that would break
// one is disabled — so the Offer button can never raise an error. `canOffer` is the same
// predicate, kept in labels.ts where the self-check can reach it.
import { useState } from "react";
import type { Canon } from "../engine";
import { act } from "../game";
import Card from "../board/Card";
import { RESOURCES, SEAT_NAMES, bankFor, bundleText, canOffer, packBundle } from "../labels";
import { set, useApp } from "../store";
import { useNarrow } from "./Tray";

const ZERO = [0, 0, 0, 0, 0];
/** What a bundle can carry: `packBundle` gives each resource five bits and masks with 31
 *  (labels.ts), so an unbounded `want` silently wraps to nothing on the 32nd click. Nineteen is
 *  the deck, which is under that and is also the most of one resource anyone can be asked for. */
const CAP = 19;

export default function Offer() {
  const s = useApp();
  const v = s.view;
  // A counter starts from the offer it answers, turned round: what they asked of you is what
  // you would give, what they offered is what you want. You change it from there.
  const counter = v && v.prompt === "DECIDE_TRADE" && v.current_player === s.human ? v.current_trade : null;
  const [give, setGive] = useState<number[]>(() =>
    counter ? counter.slice(5, 10).map((n, r) => Math.min(n, v!.players[s.human].hand[r])) : ZERO);
  const [want, setWant] = useState<number[]>(() => (counter ? counter.slice(0, 5) : ZERO));
  const [busy, setBusy] = useState(false);
  const narrow = useNarrow();
  if (!v) return null;

  const hand = v.players[s.human].hand;
  const close = () => set({ offering: false });
  const bump = (side: "give" | "want", r: number, by: number) => {
    const [cur, put] = side === "give" ? [give, setGive] : [want, setWant];
    const next = cur.slice();
    next[r] = Math.max(0, next[r] + by);
    put(next);
  };

  // The rules, read off apply.rs: you cannot offer what you do not hold, and no resource
  // may sit on both sides of the same offer. Disabling the control says so without a toast.
  const canAdd = (side: "give" | "want", r: number) =>
    side === "give" ? give[r] < hand[r] && want[r] === 0 : give[r] === 0 && want[r] < CAP;

  const ok = s.legal.some((a) => a[0] === "OFFER_TRADE") && canOffer(give, want, hand, v.spent_offers);
  const spent = give.some(Boolean) && want.some(Boolean) && !ok
    && !give.some((c, i) => c > hand[i]) && !give.some((c, i) => c > 0 && want[i] > 0);

  // A landed offer closes the builder from `advance`; a refused one leaves it open with what was
  // staged still in it, because the only reason to refuse is that the position moved underneath.
  const offer = async () => {
    setBusy(true);
    if (!await act(["OFFER_TRADE", packBundle(give), packBundle(want), -1])) setBusy(false);
  };
  const toBank = async (a: Canon) => {
    setBusy(true);
    if (await act(a)) close(); else setBusy(false);
  };

  // The bank, for exactly one card of one kind: every resource you could pay for it with.
  const bankWays = bankFor(want, s.legal);

  // A card is the control: pressing it adds one. The less-one sits under it only once there is
  // one to take back, and the row keeps its height either way.
  const row = (side: "give" | "want", counts: number[]) => (
    <div style={{ display: "flex", gap: 6 }}>
      {counts.map((n, r) => (
        <div key={r} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <button className={`pick${n > 0 ? " in" : ""}`} disabled={busy || !canAdd(side, r)} onClick={() => bump(side, r, +1)}
                  aria-label={`One more ${RESOURCES[r].toLowerCase()}${side === "give" ? `, ${hand[r]} held` : ""}`}>
            <Card resource={r} count={n} width={narrow ? 40 : 48} height={narrow ? 54 : 64} dim={side === "give" ? hand[r] === 0 : false} />
          </button>
          <button className="less" aria-label={`One less ${RESOURCES[r].toLowerCase()}`}
                  style={{ visibility: n > 0 ? "visible" : "hidden" }} disabled={busy || n === 0}
                  onClick={() => bump(side, r, -1)}>−</button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="cut arrive dock-r deal trade-build" role="group" aria-label={counter ? `Counter ${SEAT_NAMES[counter[10]]}` : "Trade"}>
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <span className="d" style={{ fontSize: 17, flex: 1 }}>{counter ? `Counter ${SEAT_NAMES[counter[10]]}` : "Trade"}</span>
        <button className="cap" style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, padding: 0 }}
                disabled={busy} onClick={close}>Close</button>
      </div>

      <div className="cap" style={{ marginTop: 8, marginBottom: 5 }}>You give</div>
      {row("give", give)}
      <div className="cap" style={{ marginTop: 6, marginBottom: 5 }}>You get</div>
      {row("want", want)}

      {bankWays.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <span style={{ font: "600 12.5px var(--font-sans)", marginRight: 2 }}>From the bank for</span>
          {bankWays.map((a) => (
            <button key={a[1]} className="act cut8" style={{ height: 30, fontSize: 12.5, padding: "0 10px" }}
                    disabled={busy} onClick={() => void toBank(a)}>
              {a[2]} {RESOURCES[a[1]].toLowerCase()}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <span style={{ font: "600 12.5px var(--font-sans)", flex: 1, lineHeight: 1.35 }}>
          {give.some(Boolean) && want.some(Boolean) ? `${bundleText(give)} for ${bundleText(want)}` : ""}
          {spent && <span className="cap" style={{ display: "block", fontSize: 11.5, color: "var(--color-warn)" }}>already refused this turn</span>}
        </span>
        <button className="act go cut8" disabled={busy || !ok} onClick={() => void offer()}>Offer it</button>
      </div>
    </div>
  );
}
