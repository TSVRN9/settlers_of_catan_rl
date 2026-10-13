// The seat's tray: everything a person at the table holds or reaches for, in one cluster along
// the rim, centred under the board. Your hand is the middle of it, where the eye rests; the
// building cards sit to its left, where their cost can be read against it; the turn sits to its
// right — what is happening now, the trade, the dice and the end. It replaced a hand
// bottom-left and a column of buttons bottom-right, and then a strip that spread the same
// things across the whole width, both of which made every turn a trip across the screen.
//
// The opening has nothing to buy and no dice: the building cards give way to the draft order,
// the hand to the four pieces you place, until the second settlement pays out.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Canon, Frame, View } from "../engine";
import { act } from "../game";
import { offerAnswers } from "../coach";
import { RESOURCES, SEAT_NAMES, tradeText } from "../labels";
import { SEAT_FILL } from "../board/palette";
import Card from "../board/Card";
import { get, set, type State } from "../store";
import Build from "./Build";
import { DraftOrder, OpeningPieces } from "./Opening";
import { held, waiting } from "../waiting";
import { devChoices, devStep } from "../devpick";

const NARROW = "(max-width: 1240px)";
export const useNarrow = () => useSyncExternalStore(
  (cb) => { const m = matchMedia(NARROW); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
  () => matchMedia(NARROW).matches,
);

/** A die face. */
const FACE: [number, number][][] = [
  [], [[0, 0]], [[-1, -1], [1, 1]], [[-1, -1], [0, 0], [1, 1]], [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
];
export const Die = ({ n, size = 38, ink = "var(--color-pine)" }: { n: number; size?: number; ink?: string }) => (
  <svg width={size} height={size} viewBox="-1.6 -1.6 3.2 3.2" aria-hidden="true" style={{ display: "block" }}>
    <rect x="-1.5" y="-1.5" width="3" height="3" rx="0.42" fill="var(--color-paper)" />
    {(FACE[n] ?? []).map(([x, y], i) => <circle key={i} cx={x * 0.72} cy={y * 0.72} r="0.23" fill={ink} />)}
  </svg>
);

/** The last roll of the game up to frame `upTo` — the dice stay where they were thrown. */
export function lastRoll(frames: Frame[], upTo: number): [number, number] | null {
  const i = lastRollAt(frames, upTo);
  return i < 0 ? null : frames[i].outcome!;
}
function lastRollAt(frames: Frame[], upTo: number): number {
  for (let i = Math.min(upTo, frames.length) - 1; i >= 0; i--)
    if (frames[i].action?.[0] === "ROLL" && frames[i].outcome) return i;
  return -1;
}

/** The dice where they were thrown, and their total. A fresh live roll tumbles first — a few
 *  quick face swaps on a timer, then the throw lands; looking back, or under reduced motion,
 *  they are simply there. A seven is in brick. */
const TUMBLE = [[3, 5], [6, 2], [1, 4], [5, 6], [2, 3]];
export function Thrown({ frames, at, live }: { frames: Frame[]; at: number; live: boolean }) {
  const i = lastRollAt(frames, at);
  if (i < 0) return null;
  return <Tumble key={i} faces={frames[i].outcome!} fresh={live && i >= frames.length - 3} />;
}
function Tumble({ faces: [a, b], fresh }: { faces: [number, number]; fresh: boolean }) {
  const [k, setK] = useState(() => (!fresh || matchMedia("(prefers-reduced-motion: reduce)").matches ? TUMBLE.length : 0));
  useEffect(() => {
    if (k >= TUMBLE.length) return;
    const t = setTimeout(() => setK(k + 1), 80);
    return () => clearTimeout(t);
  }, [k]);
  const landed = k >= TUMBLE.length;
  const [x, y] = landed ? [a, b] : TUMBLE[k];
  const seven = a + b === 7;
  const ink = landed && seven ? "var(--color-brick)" : "var(--color-pine)";
  return (
    <span className="dice rest" aria-label={`Rolled ${a + b}`}>
      <span className={landed && fresh ? "die bump" : "die"} style={{ rotate: landed ? "0deg" : "-12deg" }}><Die n={x} size={32} ink={ink} /></span>
      <span className={landed && fresh ? "die bump" : "die"} style={{ rotate: landed ? "0deg" : "14deg" }}><Die n={y} size={32} ink={ink} /></span>
      <span className="d num total" style={{ opacity: landed ? 1 : 0, color: seven ? "var(--color-brick)" : "var(--color-pine)" }}>{a + b}</span>
    </span>
  );
}

/** Development cards in deck order, and the action that plays each. */
const PLAY = ["PLAY_KNIGHT_CARD", "PLAY_YEAR_OF_PLENTY", "PLAY_MONOPOLY", "PLAY_ROAD_BUILDING", null] as const;

/** The development cards you hold — only the kinds you hold, as a hand of them would be. A card
 *  lifts when its play is legal (which is the engine's word on bought-this-turn, one-a-turn and
 *  knight-before-the-roll). Year of Plenty and Monopoly open a row of resources over the card. */
function Devs({ devs, legal, gains, at, narrow }: { devs: number[]; legal: Canon[]; gains: number[]; at: number; narrow: boolean }) {
  const [picking, setPicking] = useState<{ dev: number; first: number | null } | null>(null);
  const plays = (dev: number) => legal.filter((a) => a[0] === PLAY[dev]);
  const w = narrow ? 50 : 58, h = narrow ? 68 : 78;

  const press = (dev: number) => {
    const acts = plays(dev);
    if (!acts.length) return;
    if (dev === 1 || dev === 2) setPicking(picking?.dev === dev ? null : { dev, first: null });
    else { setPicking(null); void act(acts[0]); }
  };
  const offered = (): number[] => (picking ? devChoices(picking.dev as 1 | 2, picking.first, legal) : []);
  const pick = (r: number) => {
    if (!picking) return;
    const step = devStep(picking.dev as 1 | 2, picking.first, r, legal);
    if ("first" in step) { setPicking({ dev: picking.dev, first: step.first }); return; }
    setPicking(null); void act(step.action);
  };

  const held = devs.map((n, i) => ({ n, i, gain: gains[i] || 0 })).filter((d) => d.n > 0 || d.gain < 0);
  if (!held.length) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, position: "relative" }}>
      {held.map(({ n, i, gain }) => {
        const live = plays(i).length > 0;
        const open = picking?.dev === i;
        return (
          <div key={i} style={{ position: "relative" }}>
            {open && (
              <div className="picker arrive" role="group" aria-label={i === 1 ? "Year of Plenty" : "Monopoly"}>
                {/* Year of Plenty takes two: two slots that fill as you pick. */}
                {i === 1 && (
                  <span className="pick-slots">
                    {picking?.first != null ? <Card resource={picking.first} width={34} height={46} /> : <span className="pick-slot" />}
                    <span className="pick-slot" />
                  </span>
                )}
                {offered().map((r) => (
                  <button key={r} className="pick" onClick={() => pick(r)} aria-label={`Take ${RESOURCES[r].toLowerCase()}`}>
                    <Card resource={r} width={44} height={60} />
                  </button>
                ))}
              </div>
            )}
            <button className={`devcard${live ? " live" : ""}${open ? " open" : ""}`} disabled={!live} onClick={() => press(i)}>
              <Card dev={i} count={n} width={w} height={h} delta={gain} deltaKey={at} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A trade put to you, drawn as the cards that would change hands. Keyed on the offer, so a
 *  haggled re-offer lands as a new one instead of its text changing under you. */
export function TradeOffer({ v, legal }: { v: View; legal: Canon[] }) {
  const t = v.current_trade;
  const from = t[10];
  const youGet = t.slice(0, 5), youGive = t.slice(5, 10);
  const of = (k: string) => legal.find((a) => a[0] === k);
  const accept = of("ACCEPT_TRADE"), reject = of("REJECT_TRADE");
  // Two rows, each led by who hands those cards over: what they give, what you would.
  const side = (seat: number, name: string, counts: number[]) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, width: 104, flex: "0 0 104px", whiteSpace: "nowrap", font: "600 12.5px var(--font-sans)" }}>
        <i style={{ width: 10, height: 10, flex: "0 0 10px", background: SEAT_FILL[seat] }} />{name}
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        {counts.map((n, r) => n > 0 && <Card key={r} resource={r} count={n} width={48} height={64} />)}
      </div>
    </div>
  );
  return (
    <div key={t.join(",")} className="cut arrive dock-r deal" aria-label={tradeText(t)}
         style={{ background: "var(--color-paper)", padding: "6px 15px 13px", pointerEvents: "auto", width: "100%" }}>
      {side(from, `${SEAT_NAMES[from]} gives`, youGet)}
      {side(v.current_player, "You give", youGive)}
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        {accept && <button className="act cut8 go armed" style={{ height: 34 }} onClick={() => void act(accept)}>Accept</button>}
        {reject && <button className="act cut8 armed" style={{ height: 34 }} onClick={() => void act(reject)}>Decline</button>}
        {legal.some((a) => a[0] === "OFFER_TRADE") && (
          <button className="act cut8 armed" style={{ height: 34 }} onClick={() => set({ offering: true })}>Counter</button>
        )}
      </div>
      {reject && (
        <button className="cap" style={{ background: "none", border: 0, cursor: "pointer", fontSize: 11.5, padding: 0, marginTop: 9 }}
                onClick={() => { set({ mutedSeat: from, mutedBy: get().human, mutedTurn: v.num_turns }); void act(reject); }}>
          Ignore {SEAT_NAMES[from]} this turn
        </button>
      )}
    </div>
  );
}

/** Your own offer, from the moment it goes round the table until you move on: the terms, each
 *  seat's answer as it comes, and — once it is back with you — a Trade beside each seat that
 *  took it, or the plain fact that nobody did. */
export function OfferOut({ out, v, legal }: { out: NonNullable<ReturnType<typeof offerAnswers>>; v: View; legal: Canon[] }) {
  const confirm = (seat: number) => legal.find((a) => a[0] === "CONFIRM_TRADE" && a[1] === seat);
  const cancel = legal.find((a) => a[0] === "CANCEL_TRADE");
  const me = v.current_turn;
  const nobody = !out.open && !out.answers.some((x) => x === "yes");
  const cards = (counts: number[]) => (
    <div style={{ display: "flex", gap: 4 }}>
      {counts.map((n, r) => n > 0 && <Card key={r} resource={r} count={n} width={40} height={54} />)}
    </div>
  );
  return (
    <div className="cut arrive dock-r deal" style={{ background: "var(--color-paper)", padding: "12px 15px 13px", pointerEvents: "auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 70, font: "600 12.5px var(--font-sans)" }}>You give</span>{cards(out.give)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <span style={{ width: 70, font: "600 12.5px var(--font-sans)" }}>You get</span>{cards(out.get)}
      </div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
        {v.players.map((_, seat) => {
          if (seat === me) return null;
          const a = out.answers[seat];
          const c = confirm(seat);
          return (
            <div key={seat} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30, fontSize: 12.5 }}>
              <i style={{ width: 10, height: 10, flex: "0 0 10px", background: SEAT_FILL[seat] }} />
              <span style={{ fontWeight: 600, width: 64 }}>{SEAT_NAMES[seat]}</span>
              <span className="cap" style={{ flex: 1 }}>
                {a === "yes" ? "takes it" : a === "no" ? "declines" : a === "counter" ? "counters" : out.open ? "…" : "—"}
              </span>
              {c && <button className="act cut8 go armed" style={{ height: 30, fontSize: 12.5 }} onClick={() => void act(c)}>Trade</button>}
            </div>
          );
        })}
      </div>
      {nobody && <div style={{ marginTop: 8, font: "600 12.5px var(--font-sans)" }}>Nobody took it.</div>}
      {cancel && <button className="act cut8 armed" style={{ height: 32, marginTop: 10 }} onClick={() => void act(cancel)}>Withdraw the offer</button>}
    </div>
  );
}

/** Over seven cards a seven costs you half of them, so the odds of one show then, over the hand. */
function Odds({ held: n }: { held: number }) {
  return (
    <div className="odds">
      <span className="d" style={{ fontSize: 15 }}>6<span style={{ color: "var(--color-moss)", fontSize: 11.5 }}> in 36</span></span>
      <span>a seven takes {Math.floor(n / 2)} of your {n} cards</span>
    </div>
  );
}

export default function Tray({ s, me, mine, over, at, gains, devGains }: {
  s: State; me: View["players"][number]; mine: boolean; over: boolean; at: number; gains: number[]; devGains: number[];
}) {
  const narrow = useNarrow();
  const v = s.view!;
  const of = (type: string) => s.legal.find((a) => a[0] === type);
  const legal = mine ? s.legal : [];
  const roll = mine ? of("ROLL") : undefined;
  const end = mine ? of("END_TURN") : undefined;
  const trades = mine && v.prompt !== "DECIDE_TRADE" && s.legal.some((a) => a[0] === "OFFER_TRADE" || a[0] === "MARITIME_TRADE");
  const cw = narrow ? 60 : 72, ch = narrow ? 82 : 98;
  const opening = v.initial_phase;
  const cards = me.hand.reduce((a, b) => a + b, 0);
  // The opening deals no cards until your second settlement, and five empty cards say nothing.
  const showHand = !opening || cards > 0;
  const w = s.step == null ? waiting(s) : null;

  return (
    <div className="tray">
      <div className="tray-l">
        {!over && (opening
          ? <DraftOrder v={v} you={s.human} />
          : <Build view={v} seat={s.human} legal={legal} carry={held(s) && !held(s)!.auto ? s.carry : null} />)}
      </div>

      <div className="tray-c">
        {cards > 7 && !over && <Odds held={cards} />}
        {opening && !over && <OpeningPieces v={v} seat={s.human} holding={mine && held(s) != null} />}
        {showHand && (
          <div className="hand">
            {me.hand.map((n, i) => (
              <span key={i} data-res={i} style={{ marginLeft: i ? -16 : 0 }}>
                <Card resource={i} count={n} width={cw} height={ch} rotate={(i - 2) * 4} dim={n === 0} delta={gains[i] || 0} deltaKey={at} />
              </span>
            ))}
          </div>
        )}
        {!opening && <Devs devs={me.devs} legal={legal} gains={devGains} at={at} narrow={narrow} />}
      </div>

      <div className="tray-r">
        {/* What the table is waiting on, by the controls that answer it. */}
        {!over && w && (
          <div key={w.text} className={`turn-status${w.seat === s.human ? " you" : ""}`}>
            <i style={{ background: SEAT_FILL[w.seat] }} />{w.text[0].toUpperCase() + w.text.slice(1)}
          </div>
        )}
        {/* Three fixed slots — trade, dice, end — each held open even when empty, so a control
            never slides into the place another one just was: a double-click on Roll used to land
            on End turn. Each control also ignores the pointer for a beat after it appears. The
            opening has none of the three. */}
        {!over && !opening && (
          <div className="turn-slots">
            <span className="slot-trade">
              {trades && <button className={`act cut8 armed${s.offering ? " on" : ""}`} style={{ height: 46 }} aria-pressed={s.offering}
                                 onClick={() => set({ offering: !s.offering })}>Trade</button>}
            </span>
            <span className="slot-dice">
              {/* Blank dice to throw; once thrown, they show what they rolled. */}
              {roll ? (
                <button className="act cut8 go dice armed" onClick={() => void act(roll)} aria-label="Roll the dice">
                  <Die n={0} size={28} /><Die n={0} size={28} />
                  <span>Roll</span>
                </button>
              ) : <Thrown frames={s.frames} at={at} live={s.step == null} />}
            </span>
            <span className="slot-end">
              {end && <button className="act cut8 go armed" style={{ height: 46 }} onClick={() => void act(end)}>End turn</button>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
