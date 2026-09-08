// The seat chip and the list it unfolds into. In the panel's flow, not an overlay: the panel is
// clipped (`.cut`), so nothing positioned outside it would show, and a list in flow needs no
// positioning at all. Each row is two sibling buttons — the option, and the info chip that
// asks the lineup for the card on that bot — never one inside the other.
import { useEffect, useRef } from "react";
import type { BotKind, BotSpec } from "../engine";
import { BOT_INFO, BOT_SHORT, SEAT_NAMES } from "../labels";
import { SEAT_FILL } from "../board/palette";

export const KINDS: BotKind[] = ["human", "vnet", "heuristic", "jsrobot", "jsdroid", "drrl", "uct", "buct", "vpi", "random"];
const DEPTH = new Set<BotKind>(["heuristic", "vnet", "drrl"]);
export const sub = (b: BotSpec) => BOT_INFO[b.kind].sub + (DEPTH.has(b.kind) ? ` · depth ${b.depth}` : "");

interface Props {
  seat: number; spec: BotSpec; open: boolean; info: BotKind | null;
  onOpen: (open: boolean) => void; onPick: (k: BotKind) => void;
  /** The row the card belongs beside, or null to close it. */
  onInfo: (k: BotKind | null, row: HTMLElement | null) => void;
}

export default function Picker({ seat, spec, open, info, onOpen, onPick, onInfo }: Props) {
  const chip = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const person = spec.kind === "human";
  const close = () => { onInfo(null, null); onOpen(false); chip.current?.focus(); };
  const options = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (info) onInfo(null, null); else if (open) close(); else return;
      e.preventDefault(); e.stopPropagation();       // keys.ts would pop a page
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const os = options();
    const at = os.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? Math.min(os.length - 1, at + 1) : Math.max(0, at - 1);
    os[to]?.focus();
    e.preventDefault();
  };
  const toggle = () => (open ? close() : onOpen(true));
  // Opening lands the focus on the current choice, once the list is in the tree.
  useEffect(() => { if (open) options()[KINDS.indexOf(spec.kind)]?.focus(); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ flex: 1, minWidth: 0 }} onKeyDown={onKey}>
      <button ref={chip} className="cut8 chip" aria-haspopup="listbox" aria-expanded={open} aria-label={`${SEAT_NAMES[seat]} is`}
              onClick={toggle}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "var(--color-chalk)", padding: "9px 11px",
                       border: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}>
        <span style={{ width: 12, height: 12, flex: "0 0 12px", background: SEAT_FILL[seat] }} />
        <span style={{ flex: 1, font: `${person ? 600 : 500} 13.5px var(--font-sans)` }}>{person ? SEAT_NAMES[seat] : BOT_SHORT[spec.kind]}</span>
        <span className="cap" style={{ fontSize: 12 }}>{sub(spec)}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true"
             style={{ flex: "0 0 9px", rotate: open ? "180deg" : "0deg", transition: "rotate var(--t-feel) var(--ease)" }}>
          <path d="M0 0 L4.5 5 L9 0" fill="none" stroke="var(--color-moss)" strokeWidth="1.5" />
        </svg>
      </button>
      {/* Always mounted, opened by a class, so it can leave the way it arrived. */}
      <div className={`unfold${open ? " open" : ""}`} inert={!open}>
        <div ref={list} role="listbox" aria-label={`${SEAT_NAMES[seat]} could be`} style={{ padding: "4px 0 2px 22px" }}>
          {KINDS.map((k) => {
            const on = k === spec.kind;
            return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button role="option" aria-selected={on} tabIndex={open ? 0 : -1} className="chip"
                        onClick={() => { onPick(k); close(); }}
                        style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8, padding: "6px 8px", border: 0, background: "none",
                                 font: `${on ? 700 : 500} 13px var(--font-sans)`, color: "inherit", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ flex: 1 }}>{k === "human" ? "A person" : BOT_SHORT[k]}</span>
                  <span className="cap" style={{ fontSize: 11 }}>{BOT_INFO[k].sub}</span>
                </button>
                {k !== "human" && (
                  <button className="cut8 chip cap" tabIndex={open ? 0 : -1} aria-label={`About ${BOT_SHORT[k]}`} aria-pressed={info === k}
                          onClick={(e) => onInfo(info === k ? null : k, e.currentTarget.parentElement)}
                          style={{ width: 20, height: 20, padding: 0, border: 0, cursor: "pointer", fontSize: 11, fontStyle: "italic",
                                   background: info === k ? "var(--color-pine)" : "var(--color-chalk)", color: info === k ? "var(--color-chalk)" : "inherit" }}>
                    i
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
