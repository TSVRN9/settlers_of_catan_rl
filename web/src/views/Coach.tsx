// The coach's column: the same turn, argued with, beside the board. Every sentence is built
// from the position — what a corner pays, what a move spends, where the robber sits — by
// coach.ts. There is no LLM behind it and no free text; the questions themselves are
// generated from the ranked moves. The thread lives in the store, so closing and reopening
// the analysis keeps it for the turn. Older messages fade out at the top as new ones push
// them up.
import { useEffect, useState } from "react";
import type { Attribution, Canon } from "../engine";
import { act, advise, live } from "../game";
import { fmtPct } from "../labels";
import { RINGED, byKind, evidence, gap, lead, lean, narrate, newsworthy, questions, type Ctx } from "../coach";
import { push } from "../route";
import { openMoveAnalysis, rowAt } from "../review";
import { get, set, useApp, you } from "../store";

/** A move as one word, for the row of three readings. */
const KIND: Record<string, string> = {
  BUILD_CITY: "city", BUILD_SETTLEMENT: "settlement", BUILD_ROAD: "road", BUY_DEVELOPMENT_CARD: "dev card",
  END_TURN: "end the turn", ROLL: "roll", MOVE_ROBBER: "robber", PLAY_KNIGHT_CARD: "knight", PLAY_MONOPOLY: "monopoly",
  PLAY_YEAR_OF_PLENTY: "year of plenty", PLAY_ROAD_BUILDING: "road building", MARITIME_TRADE: "bank trade",
  OFFER_TRADE: "offer", ACCEPT_TRADE: "accept", REJECT_TRADE: "decline", CONFIRM_TRADE: "trade", CANCEL_TRADE: "cancel",
};
const kind = (a: Canon) => KIND[a[0]] ?? a[0].toLowerCase();

const bubble = { alignSelf: "flex-start", maxWidth: "100%", background: "var(--color-paper)", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5 } as const;

export default function Coach() {
  const s = useApp();
  const v = s.view;
  const map = s.map;
  const [attr, setAttr] = useState<Attribution[] | null>(null);

  const root = s.advice?.root.filter(([, val]) => val != null) ?? [];
  const ranked = [...root].sort((a, b) => (b[1] as number) - (a[1] as number)) as [Canon, number][];
  const top = ranked[0], second = ranked[1];
  const mine = !!v && v.current_player === s.human && v.winner < 0;

  useEffect(() => {
    setAttr(null);
    const at = get().view;
    void live.attribution(s.human).then((a) => { if (get().view === at) setAttr(a); }).catch(() => {});
    if (!get().advice) void advise();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  // Ringed on the board: the move under discussion, when it is a move about a place.
  // A roll or a card has nothing to ring, and the sentence below doesn't claim one.
  useEffect(() => {
    set({ mark: mine && top && RINGED.has(top[0][0]) ? top[0] : null });
    return () => set({ mark: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, top?.[0] ? top[0].join(":") : null]);

  if (!v || !map) return null;

  const me = you(s);
  const ctx: Ctx = { map, view: v, seat: s.human, you: me };
  const recent = s.frames.slice(0, -1).map((_, i) => rowAt(s.frames, i)).filter((r) => r && newsworthy(r.action)).slice(-2);
  const thread = s.coachThread?.step === v.steps ? s.coachThread.bubbles : [];
  const ask = (q: string, a: string) =>
    set({ coachThread: { step: v.steps, bubbles: [...thread, { from: "user", text: q }, { from: "assistant", text: a }] } });
  const asked = new Set(thread.filter((b) => b.from === "user").map((b) => b.text));
  const qs = top ? questions(ranked, ctx, s.evals.map((e) => e?.win ?? 0)).filter((x) => !asked.has(x.q)) : [];
  const read = lean(attr, ctx);
  const readings = byKind(ranked).slice(0, 3);

  return (
    <div className="thread" style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 9, height: "100%" }}>
      {recent.map((r, i) => (
        <div key={i} className="cut8 line" style={bubble}>{narrate(r!, map, me)}</div>
      ))}

      {!mine ? (
        <div className="cut8" style={bubble}>Waiting on the table.</div>
      ) : !s.advice ? (
        <div className="cut8" style={bubble}>Still working out the position…</div>
      ) : !top ? (
        <div className="cut8" style={bubble}>There is nothing to weigh — one move is forced.</div>
      ) : (
        <>
          <div className="cut8 arrive" style={bubble}>
            {read ?? `It reads ${fmtPct(top[1])}.`}
            {readings.length > 1 && (
              <div style={{ display: "flex", gap: 14, borderTop: "1px solid var(--color-dust)", marginTop: 8, paddingTop: 8 }}>
                {readings.map(([a, val], i) => (
                  <div key={a.join(":")}>
                    {i === 0 ? (
                      <button className="d num" style={{ fontSize: 17, background: "none", border: 0, padding: 0, cursor: "pointer" }}
                              title="Every move, ranked" onClick={() => openMoveAnalysis()}>
                        {fmtPct(val)}
                      </button>
                    ) : (
                      <div className="d num" style={{ fontSize: 17 }}>{fmtPct(val)}</div>
                    )}
                    <div className="cap" style={{ fontSize: 11 }}>{kind(a)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cut8 arrive dock-r" style={{ background: "var(--color-pine)", color: "var(--color-chalk)", padding: "12px 13px 13px" }}>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              I would <b style={{ color: "var(--color-wheat)" }}>{lead(top[0], ctx)}</b>
              {RINGED.has(top[0][0]) ? " — it is ringed on the board." : "."}
              {" "}{evidence(top[0], ctx)}{second ? ` ${gap(top[0], second[0], ctx)}` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap" }}>
              <button className="act cut8" style={{ height: 36, background: "var(--color-wheat)", color: "var(--color-pine)" }}
                      onClick={() => void act(top[0])}>
                Play it
              </button>
              <button className="act cut8" style={{ height: 36, background: "#243733", color: "var(--color-chalk)" }}
                      onClick={() => push("futures")}>
                Every legal move
              </button>
            </div>
          </div>
        </>
      )}

      {thread.map((b, i) => (
        <div key={i} className="cut8 arrive" style={{
          ...bubble,
          alignSelf: b.from === "user" ? "flex-end" : "flex-start",
          maxWidth: b.from === "user" ? "85%" : "100%",
          background: b.from === "user" ? "#dfe5da" : "var(--color-paper)",
        }}>
          {b.text}
        </div>
      ))}

      {qs.length > 0 && (
        <div style={{ borderTop: "1px solid var(--color-dust)", paddingTop: 12 }}>
          <div className="cap" style={{ marginBottom: 8, textAlign: "right" }}>Ask about the position</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {qs.map(({ q, a }) => (
              <button key={q} className="act cut8" style={{ height: "auto", minHeight: 32, padding: "6px 11px", fontSize: 12.5, fontWeight: 400, whiteSpace: "normal", textAlign: "left" }}
                      onClick={() => ask(q, a)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
