// What a move does to the cards, shown moving: a roll's cards come off the tiles that paid them
// into each seat (into your own hand cards for you), the robber's card goes from the robbed seat
// to the thief, and a bought development card leaves the bank face down.
//
// Decoration only. Nothing waits on it — the drive loop's holds are timers in game.ts, because a
// background tab never runs an animation frame and a loop that waited on one would stall there.
// Each flight is a throwaway element animated with the Web Animations API on a fixed overlay,
// between the boxes of things already on screen ([data-tile], [data-seat], [data-res]).
import { useLayoutEffect, useRef } from "react";
import type { Frame, MapView } from "../engine";
import { flies, production } from "../coach";
import { RES_FILL } from "../board/palette";

const EASE = "cubic-bezier(.2, .7, .2, 1)";
/** The dice land first; the tiles answer; then the cards travel. */
const TILES_AT = 520, CARDS_AT = 760;

const centre = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width || r.height ? [r.left + r.width / 2, r.top + r.height / 2] as const : null;
};

export default function Fx({ frames, at, map, you }: { frames: Frame[]; at: number; map: MapView; you: number }) {
  const layer = useRef<HTMLDivElement>(null);
  // Keyed on the step alone: a watched game's frames grow in batches while the playhead is
  // behind them, and that is not a move.
  const latest = useRef({ frames, map, you });
  latest.current = { frames, map, you };

  // Only a step forward is a move: seeking back (a replay restarting, the stands' scrubber) shows a position, it
  // doesn't play the move before it again; and a jump forward past listed moves (a tapped row) shows one too.
  const last = useRef(at);
  useLayoutEffect(() => {
    const from = last.current;
    last.current = at;
    const { frames, map, you } = latest.current;
    if (!flies(frames, from, at)) return;
    const root = layer.current;
    const f = frames[at - 1], cur = frames[at];
    if (!root || !f || !cur || !f.action || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seatEl = (seat: number, r: number | null) =>
      (seat === you && r != null ? document.querySelector(`[data-res="${r}"]`) : null) ?? document.querySelector(`[data-seat="${seat}"]`);

    const fly = (from: readonly [number, number] | null, to: readonly [number, number] | null, colour: string | null, delay: number) => {
      if (!from || !to) return;
      const el = document.createElement("i");
      el.className = "fly";
      if (colour) el.style.borderBottomColor = colour; else el.classList.add("back");
      root.appendChild(el);
      const [x0, y0] = from, [x1, y1] = to;
      const a = el.animate([
        { transform: `translate(${x0}px, ${y0}px) scale(.5)`, opacity: 0 },
        { transform: `translate(${x0}px, ${y0 - 22}px) scale(1)`, opacity: 1, offset: 0.22 },
        { transform: `translate(${x1}px, ${y1}px) scale(.85)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${x1}px, ${y1}px) scale(.6)`, opacity: 0 },
      ], { duration: 820, delay, easing: EASE, fill: "both" });
      a.onfinish = () => el.remove();
    };

    const [kind] = f.action;
    if (kind === "ROLL" && f.outcome && f.outcome[0] + f.outcome[1] !== 7) {
      const paid = production(map, f.view, cur.view, f.outcome[0] + f.outcome[1]);
      for (const t of new Set(paid.map((p) => p.tile))) {
        for (const el of document.querySelectorAll(`#board-layer [data-tile="${t}"]`))
          el.animate([{ scale: 1 }, { scale: 1.07 }, { scale: 1 }], { duration: 560, delay: TILES_AT, easing: EASE });
      }
      paid.forEach((p, i) => fly(centre(document.querySelector(`#board-layer [data-tile="${p.tile}"]`)),
                                 centre(seatEl(p.seat, p.resource)), RES_FILL[p.resource], CARDS_AT + i * 70));
    } else if (kind === "BUILD_SETTLEMENT" && f.view.initial_phase) {
      // The opening's second settlement pays one card per tile it touches: off those tiles.
      const node = f.action[1], seat = f.seat;
      const gained = cur.view.players[seat].hand.map((c, r) => c - f.view.players[seat].hand[r]);
      let i = 0;
      for (const t of map.tiles) {
        if (!t.nodes.includes(node) || t.resource < 0 || gained[t.resource] <= 0) continue;
        gained[t.resource]--;
        fly(centre(document.querySelector(`#board-layer [data-tile="${t.id}"]`)), centre(seatEl(seat, t.resource)), RES_FILL[t.resource], 380 + i++ * 90);
      }
    } else if (kind === "MOVE_ROBBER" && f.action[2] >= 0) {
      const thief = f.seat, victim = f.action[2];
      // Which card it was is yours to see only if it was your card or your theft.
      const r = [thief, victim].includes(you)
        ? cur.view.players[you].hand.findIndex((n, i) => n !== f.view.players[you].hand[i]) : -1;
      fly(centre(seatEl(victim, r >= 0 ? r : null)), centre(seatEl(thief, r >= 0 ? r : null)), r >= 0 ? RES_FILL[r] : null, 420);
    } else if (kind === "BUY_DEVELOPMENT_CARD" && f.seat !== you) {
      fly(centre(document.querySelector("#board-layer svg")), centre(seatEl(f.seat, null)), null, 120);
    }
    // No cleanup: a flight still landing when the next move arrives finishes on its own.
  }, [at]);

  return <div ref={layer} className="fx" aria-hidden="true" />;
}
