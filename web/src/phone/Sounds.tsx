// The table's sounds and buzzes (spec "Sound and haptics"; sfx.ts): a step's cues play as the playhead moves forward
// onto it, by the same rule as the card flights (`coach.flies`), so a scrub or a jump is silent. Nothing plays in the
// review. The audio is unlocked by a tap, as browsers require, and brought back by any later one if the system took
// it away. In pass and play the cover rising is the next person's turn: it knocks for the whole table.
import { useEffect, useRef } from "react";
import { flies } from "../coach";
import { declinedFor } from "../game";
import { cuesFor, play, unlock, type CueAt } from "../sfx";
import { get, useApp } from "../store";

const KNOCK: CueAt = { cue: "turn", at: 0, buzz: [10, 60, 10] };

export default function Sounds({ you, cover }: { you: number; cover: number | null }) {
  const s = useApp();
  const at = s.view ? Math.max(0, Math.min(s.step ?? s.view.steps, s.frames.length - 1)) : 0;
  const last = useRef(at);
  useEffect(() => {
    if (!s.sound) return;
    const tap = () => unlock();
    addEventListener("pointerdown", tap, true);
    addEventListener("pointerup", tap, true);
    return () => { removeEventListener("pointerdown", tap, true); removeEventListener("pointerup", tap, true); };
  }, [s.sound]);
  useEffect(() => {
    const from = last.current;
    last.current = at;
    if (s.review || (!s.sound && !s.haptics) || !flies(s.frames, from, at)) return;
    const f = s.frames[at - 1], next = s.frames[at];
    if (!f || !next) return;
    const answered = you >= 0 && next.view.prompt === "DECIDE_TRADE" && next.view.current_player === you && declinedFor(get(), next.view, you);
    play(cuesFor(f, next.view, you, { answered }), { sound: s.sound, haptics: s.haptics });
  }, [at]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cover != null && !s.review) play([KNOCK], { sound: s.sound, haptics: s.haptics });
  }, [cover]);  // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
