// The Coach: the same turn, argued with. A chat column templated from decide() and
// attribution() — there is no free text and nothing is persisted, because there is no LLM
// behind it, only the value net's own numbers said out loud.
import { useEffect, useState } from "react";
import type { Attribution, Canon } from "../engine";
import { act, advise, live } from "../game";
import { SEAT_NAMES, fmtPct, label, worstGroup } from "../labels";
import { push } from "../route";
import { openMoveAnalysis } from "../review";
import { get, set, useApp } from "../store";

interface Bubble { from: "assistant" | "user"; text: string }

const CHIPS: Record<string, (s: ReturnType<typeof useApp>) => string> = {
  "Who is closest to winning?": (s) => {
    const order = s.view!.players.map((_, i) => i).sort((a, b) => (s.evals[b]?.win ?? 0) - (s.evals[a]?.win ?? 0));
    const lead = order[0];
    return `${lead === s.human ? "You are" : `${SEAT_NAMES[lead]} is`}, at ${fmtPct(s.evals[lead]?.win)}.`;
  },
  "What if I keep the ore?": (s) => {
    const ore = s.view!.players[s.human].hand[4];
    return ore > 0 ? `You're holding ${ore} ore. The ranked list above already assumes you keep whatever a move doesn't spend.` : "You're not holding any ore right now.";
  },
  "Is a trade worth it?": (s) => {
    const offers = s.legal.filter((a) => a[0] === "OFFER_TRADE");
    return offers.length ? `There's ${offers.length} offer${offers.length === 1 ? "" : "s"} on the table worth a look — see the standing actions.` : "Nothing worth offering right now.";
  },
};

export default function Coach() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const [attr, setAttr] = useState<Attribution[] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [thread, setThread] = useState<Bubble[]>([]);

  const root = s.advice?.root.filter(([, val]) => val != null) ?? [];
  const ranked = [...root].sort((a, b) => (b[1] as number) - (a[1] as number));
  const top = ranked[0];

  useEffect(() => {
    setAttr(null);
    setDismissed(false);
    const at = get().view;
    void live.attribution(s.human).then((a) => { if (get().view === at) setAttr(a); }).catch(() => {});
    if (!get().advice) void advise();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  // Lit on the board: the move under discussion, on the live position (nothing hypothetical
  // has been applied — this is the persistent board's own view, just with a ring on it).
  useEffect(() => {
    if (!v || !top) { set({ boardOverride: null }); return; }
    set({ boardOverride: { view: v, highlight: top[0] as Canon } });
    return () => set({ boardOverride: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, top?.[0] ? (top[0] as Canon).join(":") : null]);

  if (!v || !map) return null;

  const me = v.players[s.human];
  const mine = v.current_player === s.human && v.winner < 0;
  const worst = worstGroup(attr);
  const last = s.log[s.log.length - 1];

  return (
    <>
      <div data-anchor="coach" />

      {/* the conversation */}
      <div style={{
        position: "absolute", left: 34, top: 26, bottom: 26, width: 498,
        display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 11,
      }}>
        <div className="cap">Earlier this turn</div>

        <div className="cut8" style={{ alignSelf: "flex-start", maxWidth: 404, background: "var(--color-paper)", padding: "11px 13px", fontSize: 14.5, lineHeight: 1.5 }}>
          {last
            ? <>{SEAT_NAMES[last.seat]} {label(last.action, map).toLowerCase()}{last.note ? ` — ${last.note}` : ""}.</>
            : <>Nothing played yet — you're at {fmtPct(s.evals[s.human]?.win)} to win.</>}
        </div>

        {!s.advice ? (
          <div className="cut8" style={{ alignSelf: "flex-start", maxWidth: 404, background: "var(--color-paper)", padding: "11px 13px", fontSize: 14.5 }}>
            Still working out the position…
          </div>
        ) : ranked.length === 0 ? (
          <div className="cut8" style={{ alignSelf: "flex-start", maxWidth: 404, background: "var(--color-paper)", padding: "11px 13px", fontSize: 14.5 }}>
            There's nothing to weigh — one move is forced.
          </div>
        ) : (
          <>
            <div className="cut8" style={{ alignSelf: "flex-start", maxWidth: 404, background: "var(--color-paper)", padding: "11px 13px", fontSize: 14.5, lineHeight: 1.5 }}>
              I'd {label(top[0] as Canon, map).toLowerCase()}.
              {ranked.length > 1 && (
                <div style={{ display: "flex", gap: 16, borderTop: "1px solid var(--color-dust)", marginTop: 9, paddingTop: 9 }}>
                  {ranked.slice(0, 3).map(([a, val], i) => (
                    <div key={label(a as Canon, map)}>
                      {i === 0 ? (
                        <button className="d num" style={{ fontSize: 19, background: "none", border: 0, padding: 0, cursor: "pointer" }}
                                title="See every move, ranked" onClick={() => openMoveAnalysis()}>
                          {fmtPct(val)}
                        </button>
                      ) : (
                        <div className="d num" style={{ fontSize: 19 }}>{fmtPct(val)}</div>
                      )}
                      <div className="cap" style={{ fontSize: 11 }}>{label(a as Canon, map)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!dismissed && (
              <div className="cut8" style={{ background: "var(--color-pine)", color: "var(--color-chalk)", padding: "14px 15px 15px" }}>
                <div style={{ fontSize: 15.5, lineHeight: 1.5 }}>
                  {worst ? (
                    <>
                      Your <b style={{ color: "var(--color-wheat)" }}>{worst.group}</b>{" "}
                      {worst.delta < 0 ? "is doing a lot of work here." : "is costing you right now."}
                      {" "}I'd <b style={{ color: "var(--color-wheat)" }}>{label(top[0] as Canon, map).toLowerCase()}</b> — it's lit on the board, worth {fmtPct(top[1])}.
                    </>
                  ) : (
                    <>The clearest move is to <b style={{ color: "var(--color-wheat)" }}>{label(top[0] as Canon, map).toLowerCase()}</b>.</>
                  )}
                </div>
                <div style={{ display: "flex", gap: 9, marginTop: 13 }}>
                  <button className="act cut8" style={{ height: 42, background: "var(--color-wheat)", color: "var(--color-pine)" }}
                          disabled={!mine} onClick={() => void act(top[0] as Canon)}>
                    Build it
                  </button>
                  <button className="act cut8" style={{ height: 42, background: "#243733", color: "var(--color-chalk)" }}
                          onClick={() => push("futures")}>
                    Show me the others
                  </button>
                  <button className="act cut8" style={{ height: 42, background: "#243733", color: "var(--color-chalk)" }}
                          onClick={() => setDismissed(true)}>
                    I'll play my own
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {thread.map((b, i) => (
          <div key={i} className="cut8" style={{
            alignSelf: b.from === "user" ? "flex-end" : "flex-start",
            maxWidth: b.from === "user" ? 340 : 404,
            background: b.from === "user" ? "#dfe5da" : "var(--color-paper)",
            padding: "10px 13px", fontSize: 14.5, lineHeight: 1.5,
          }}>
            {b.text}
          </div>
        ))}

        <div style={{ borderTop: "1px solid var(--color-dust)", paddingTop: 12 }}>
          <div className="cap" style={{ marginBottom: 8 }}>Ask about the position</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.keys(CHIPS).map((q) => (
              <button key={q} className="act cut8" style={{ height: 34, fontWeight: 400 }}
                      onClick={() => setThread((t) => [...t, { from: "user", text: q }, { from: "assistant", text: CHIPS[q](s) }])}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* the board illustrates whatever is being discussed — the persistent board itself,
          parked at the anchor below, ringed on the move under discussion by the effect
          above. Nothing else belongs on this side but the header naming what's lit. */}
      <div style={{ position: "absolute", right: 34, top: 26, width: 566, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="cap">Lit on the board: the move under discussion</span>
        <div style={{ display: "flex", gap: 8 }}>
          <span className="act cut8" style={{ height: 32, fontSize: 12.5, opacity: 0.6 }}>Hand: {me.hand.reduce((a, b) => a + b, 0)} cards</span>
          <button className="act cut8" style={{ height: 32, fontSize: 12.5 }} onClick={() => openMoveAnalysis()}>
            All {s.legal.length} moves
          </button>
        </div>
      </div>
    </>
  );
}
