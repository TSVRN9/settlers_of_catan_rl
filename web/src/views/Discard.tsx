// A seven's discard, made real: today's engine takes it one card at a time
// (`DISCARD_RESOURCE`), but choosing which four of nine to lose is one decision, not four —
// so this picks all of them before it plays any of them. Rendered by Table.tsx over its own
// other panels; the board itself stays visible and untouched behind it (its legal actions
// during a discard are all `DISCARD_RESOURCE`, so nothing on it is clickable anyway).
import { useState } from "react";
import { act, live } from "../game";
import Card from "../board/Card";
import { useApp } from "../store";

export default function Discard() {
  const s = useApp();
  const v = s.view;
  if (!v) return null;
  const need = v.discard_counts[s.human];
  const cards = v.players[s.human].hand.flatMap((n, r) => Array.from({ length: n }, () => r));
  const [selected, setSelected] = useState<Set<number>>(() => new Set(cards.map((_, i) => i).slice(0, need)));
  const [busy, setBusy] = useState(false);

  const toggle = (i: number) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(i)) next.delete(i);
    else if (next.size < need) next.add(i);
    return next;
  });

  const discard = async () => {
    setBusy(true);
    const counts = [0, 0, 0, 0, 0];
    for (const i of selected) counts[cards[i]]++;
    // One card per action, so the position moves under this loop; `act` refusing one means the
    // rest were chosen against a hand that no longer exists. Stop rather than discard blind.
    outer: for (let r = 0; r < 5; r++)
      for (let k = 0; k < counts[r]; k++) if (!await act(["DISCARD_RESOURCE", r, -1, -1])) break outer;
    setBusy(false);
  };

  const letNetChoose = async () => {
    setBusy(true);
    for (let k = 0; k < need; k++) {
      const d = await live.decide("vnet", 2);
      if (!await act(d.action)) break;
    }
    setBusy(false);
  };

  const cardW = 64, cardH = 86, gap = 7;
  const modalW = Math.max(400, cards.length * (cardW + gap) - gap + 44);

  return (
    <div className="modal arrive">
      <div className="cut arrive dock-t" style={{ width: modalW, background: "var(--color-paper)", padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span className="d" style={{ fontSize: 20 }}>Choose {need} to lose</span>
          <span className="num cap" style={{ marginLeft: "auto", fontSize: 12 }}>{selected.size} of {need} chosen</span>
        </div>
        <div style={{ display: "flex", gap, marginTop: 14 }}>
          {cards.map((r, i) => (
            <Card key={i} resource={r} width={cardW} height={cardH}
                  selected={selected.has(i)} disabled={busy} onClick={() => toggle(i)} />
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 14 }}>
          <button className="act go cut8" disabled={busy || selected.size !== need} onClick={() => void discard()}>
            Discard these {need}
          </button>
          <button className="act cut8" disabled={busy} onClick={() => void letNetChoose()}>Let the net choose</button>
        </div>
      </div>
    </div>
  );
}
