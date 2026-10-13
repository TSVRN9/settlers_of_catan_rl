// The table's sounds and buzzes (spec "Sound and haptics"; sfx.ts): a step's cues play as the playhead moves forward
// onto it, by the same rule as the card flights (`coach.flies`), so a scrub or a jump is silent. Nothing plays in the
// review. The audio is unlocked by the first tap, as browsers require.
import { useEffect, useRef } from "react";
import { flies } from "../coach";
import { cuesFor, play, unlock } from "../sfx";
import { useApp } from "../store";

export default function Sounds({ you }: { you: number }) {
  const s = useApp();
  const at = s.view ? Math.max(0, Math.min(s.step ?? s.view.steps, s.frames.length - 1)) : 0;
  const last = useRef(at);
  useEffect(() => {
    if (!s.sound) return;
    const first = () => unlock();
    addEventListener("pointerdown", first, { once: true, capture: true });
    return () => removeEventListener("pointerdown", first, { capture: true });
  }, [s.sound]);
  useEffect(() => {
    const from = last.current;
    last.current = at;
    if (s.review || (!s.sound && !s.haptics) || !flies(s.frames, from, at)) return;
    const f = s.frames[at - 1], next = s.frames[at];
    if (f && next) play(cuesFor(f, next.view, you), { sound: s.sound, haptics: s.haptics });
  }, [at]);  // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
