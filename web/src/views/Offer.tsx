// Offering a trade, built rather than picked from a list.
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
import { act } from "../game";
import Card from "../board/Card";
import { RESOURCES, bundleText, canOffer, packBundle } from "../labels";
import { set, useApp } from "../store";

const ZERO = [0, 0, 0, 0, 0];
/** What a bundle can carry: `packBundle` gives each resource five bits and masks with 31
 *  (labels.ts), so an unbounded `want` silently wraps to nothing on the 32nd click. Nineteen is
 *  the deck, which is under that and is also the most of one resource anyone can be asked for. */
const CAP = 19;

export default function Offer() {
  const s = useApp();
  const v = s.view;
  const [give, setGive] = useState<number[]>(ZERO);
  const [want, setWant] = useState<number[]>(ZERO);
  const [busy, setBusy] = useState(false);
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

  const ok = canOffer(give, want, hand, v.spent_offers);
  const spent = give.some(Boolean) && want.some(Boolean) && !ok
    && !give.some((c, i) => c > hand[i]) && !give.some((c, i) => c > 0 && want[i] > 0);

  // A landed offer closes the builder from `advance`; a refused one leaves it open with what was
  // staged still in it, because the only reason to refuse is that the position moved underneath.
  const offer = async () => {
    setBusy(true);
    if (!await act(["OFFER_TRADE", packBundle(give), packBundle(want), -1])) setBusy(false);
  };

  const row = (side: "give" | "want", counts: number[]) => (
    <div style={{ display: "flex", gap: 10 }}>
      {counts.map((n, r) => (
        <div key={r} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
          <Card resource={r} count={n} width={62} height={84} dim={n === 0} />
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button className="act cut8" aria-label={`One less ${RESOURCES[r].toLowerCase()}`}
                    style={{ height: 24, width: 24, padding: 0, fontSize: 14 }}
                    disabled={busy || n === 0} onClick={() => bump(side, r, -1)}>−</button>
            <button className="act cut8" aria-label={`One more ${RESOURCES[r].toLowerCase()}`}
                    style={{ height: 24, width: 24, padding: 0, fontSize: 14 }}
                    disabled={busy || !canAdd(side, r)} onClick={() => bump(side, r, +1)}>+</button>
          </div>
          {side === "give" && <span className="cap" style={{ fontSize: 11 }}>{hand[r]} held</span>}
        </div>
      ))}
    </div>
  );

  return (
    <div className="modal arrive">
      <div className="cut arrive dock-t" style={{ background: "var(--color-paper)", padding: "20px 22px" }}>
        <div className="d" style={{ fontSize: 20 }}>Offer a trade</div>

        <div style={{ display: "flex", gap: 26, marginTop: 16, alignItems: "flex-start" }}>
          <div>
            <div className="cap" style={{ marginBottom: 8 }}>You give</div>
            {row("give", give)}
          </div>
          <div>
            <div className="cap" style={{ marginBottom: 8 }}>You want</div>
            {row("want", want)}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <span style={{ font: "600 13.5px var(--font-sans)", flex: 1 }}>
            {give.some(Boolean) || want.some(Boolean)
              ? `${bundleText(give)} for ${bundleText(want)}`
              : "Nothing offered yet."}
            {spent && <span className="cap" style={{ marginLeft: 8, color: "var(--color-warn)" }}>already refused this turn</span>}
          </span>
          <button className="act go cut8" disabled={busy || !ok} onClick={() => void offer()}>Offer it</button>
          <button className="act cut8" disabled={busy} onClick={close}>Back</button>
        </div>
      </div>
    </div>
  );
}
