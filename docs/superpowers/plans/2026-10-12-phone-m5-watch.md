# Phone UI, Milestone 5: watching and shared links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A watched game on a phone has its own screen, and any finished game can be sent as a link that opens cold on another phone:
- **The watch screen:** the newest move, the curve as a scrubber, a transport, and the seats as standings.
- **The cold open:** the result first, then Watch from the start.

**Architecture:**
- **The link format is Rust's** (`catan_engine/src/compact.rs`, no serde):
  - version 1;
  - a varint seed and the seat count;
  - TLV sections, ending with tag 0;
  - per step, the action's index in that step's `playable_actions()`, or an escape for an offer outside the list, plus one byte where the action has a random outcome.
- **The browser** only builds the seats section, and deflate-raws and base64urls the bytes (`web/src/share.ts`).
- **A decoded game is a recording.** The worker's `film` op rebuilds every frame (views and spectator readings) by applying the decoded log with its outcomes forced.
  - The store marks it `film`, and `playing()` is false for it, so no person seat comes to life.
  - The playhead walks the frames it already has, with no `run` and no `pump`.
- **Watching keeps a high-water mark, `seenTo`.** The curve is drawn up to it; after the playhead it's faint, and "Live" returns to it.
- **The bottom block keeps one height.** The watch block and the result share it, so the board doesn't move when a watched game ends.

**Tech Stack:**
- Rust (`cargo test --no-default-features --features wasm`), wasm-bindgen.
- React 19, Vite, TypeScript, plain CSS (`phone/phone.css`).
- `CompressionStream("deflate-raw")`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`. It covers "Watching bots and shared links", "Open questions" (the link format) and Milestone 5. Mockup: `web/design/phone/review.mjs` A, B and C.

## Global Constraints

- **Desktop stays the same,** except for one addition: a `#/r/` link opens there as a watched game held at its end.
- **Engine edits:**
  - Rebuild with `uv run maturin develop --release -m catan_engine/Cargo.toml`.
  - Run `uv run python test_env.py` (the replay oracle).
  - Build the site with `cd web && pnpm build`.
- **House rules:**
  - Labels only.
  - Targets ≥ 44px.
  - The board never moves during a game, including when a watched game ends.
  - Nothing truncates at 375×667.
  - One assert check per non-trivial module.
  - No `web/src` edits while `phone_check` runs.
- **Spectators see public information only.**
  - While watching, the points are `players[i].vp`, not `actual_vp`.
  - A link's person seats are never seated.
- **The decoder is a trust boundary.** Bad bytes give `Err` and a lineup with a line saying the link is broken, never a panic or a page error. Caps: 64 KB inflated, 5,000 steps.
- **Verification:**
  - `cargo test`, `test_env.py`, `pnpm exec tsc -b`;
  - the self-checks (`share.ts` is new; `coach.ts` adds one);
  - `phone_check` at 390×844, 375×667 and 360×780;
  - smoke, `pnpm build`, and a desktop check of a cold link.

## Review Focus

1. **A link to a game with people in it.** Expected: it opens as a playback. There's no hand, no slab, no cover, and `pump` never runs. Pinned by a `phone_check` probe on a two-person game's link; `leak` stays 0.
2. **A garbled or truncated link.** Expected: the lineup and one line saying so; no page error. Pinned by Rust tests (truncation, a bad index, a bad outcome) and a `phone_check` probe with a garbled code.
3. **The legal-action order changes under the format.** Expected: a test fails, which forces a version bump. Pinned by a golden test: a fixed seeded game's encoding has a fixed hash.
4. **Scrubbing back, then Live.** Expected:
   - the curve is faint after the playhead, up to where play had reached, and never to the worker's lookahead;
   - Live returns there and plays on.

   Pinned by the `scrub` and `live` probes, which compare against `seenTo` and `frames.length`.
5. **A watched game ending.** Expected: the result takes the watch block's place, and the board box doesn't move. Pinned by the `watchEnd` probe, which compares the board rect before and after.

---

### Task 0: M4 leftovers

- **`toLineup` resets `holder` to null.** Back to the game in pass and play then raises a cover, rather than showing the last holder's hand to whoever holds the phone.
  - Probe `resumeCover`: in the pass-and-play phase, after Show hand, tap ‹, then Back to the game. The cover is up.
- **A cover row tapped ahead of the playhead flew the move before it.**
  - `coach.flies(frames, from, to)` decides whether `Fx` flies `frames[to-1]` after a jump from `from`. It does only when no newsworthy frame lies strictly between them, so the replay's beat (which steps over unlisted moves) still flies its move and a jump over listed moves flies nothing.
  - `Fx` uses it.
  - Assert in `coach.ts`'s check: a single step flies; a beat over unlisted moves flies; a jump over a listed move doesn't.

### Task 1: the compact format in Rust

**Files:** Create `catan_engine/src/compact.rs`. Modify `lib.rs` and `wasm.rs`.

**The format:**
- **Header:** `VERSION = 1`, varint seed, `n` byte, then sections `(tag, varint len, payload)*`, then `0`.
- **Steps, until the bytes end:**
  - `varint idx`. If `idx == legal.len()`, it's an escape: `give[5]`, `get[5]` bytes, an `OfferTrade` only.
  - An outcome byte follows for:
    - `Roll`: `(d1-1)*6 + d2-1`;
    - `BuyDev`: the card;
    - `MoveRobber`: the stolen resource + 1, or 0 for none.
  - `Discard` carries its resource in the action, so it gets no byte.

**Interfaces:**
- `pub fn new_state(seed: u32, n: usize, layout: &Layout) -> State`. `Engine::new` uses it, so the two can't drift.
- `pub fn encode(seed: u32, n: usize, sections: &[u8], log: &[(Action, Outcome)], layout: &Layout) -> Result<Vec<u8>, String>`
- `pub fn decode(bytes: &[u8], layout: &Layout) -> Result<(u32, usize, Vec<(Action, Outcome)>), String>`
- In `decode`, every step goes through `state.apply(...)?`, and the outcome logged is what `apply` returns.

**wasm exports:**
- `record_to_compact(record_json, sections) -> Vec<u8>`
- `compact_to_record(bytes) -> String`, the same JSON as `record()`.
- `Engine::apply_with(action, a, b)`, which applies with a forced outcome.

**Tests:**
- A round trip on 6 seeded random-legal games. One includes a 3-for-1 offer outside the legal list.
- Unknown section tags are skipped.
- Truncation, an index past the list, and an outcome for a card not in the deck each give `Err`.
- Golden: the hash of a fixed game's bytes.

### Task 2: links in the browser

**Files:**
- Create `web/src/share.ts`.
- Modify `worker.ts`, `engine.ts`, `game.ts`, `store.ts`, `App.tsx`.

**`share.ts`:**
- `KINDS`, frozen: `human random heuristic vnet drrl jsrobot jsdroid uct buct vpi`.
- `seatsSection(lineup)`: tag 1, per seat a kind id, the depth and an empty settings string.
- `readHeader(bytes)` returns `{ seed, n, seats: BotSpec[] | null }`. It skips unknown tags.
- `toCode(bytes)` and `fromCode(code)` do deflate-raw and base64url, and throw past 64 KB.
- Self-check: the seats round trip, an unknown tag skipped, the code round trip, and garbage throwing.

**The worker:**
- `compact {record, sections}` is stateless and exempt from the epoch.
- `film {bytes}`:
  - decode, check that the step count is ≤ 5,000;
  - for each step, a frame with the view, `seat`, the action, the outcome, the spectator's `readings(e, -1)`, and `decision`/`attribution` null;
  - then the last frame.
  - It bumps the epoch, like `run`.

**`game.ts`:**
- `shareLink()` returns `location.origin + pathname + "#/r/" + code`, built from `review.record()` on the review client.
- `openShared(code)`:
  - stops watching;
  - films on the live client;
  - sets `lineup` from the seats (all `vnet` depth 2 when the link has none) and `film: true`;
  - sets `seed`, `map`, `frames`, `seenTo = last`, and `show(last)`, which gives `phase: "over"` when finished and held otherwise.
  - On error, it goes to `toLineup()` with `error: "This link is broken."`.
- `replayFilm()` (Watch from the start): `show(0)`, unpaused, `startTimer()`.
- `seenTo`:
  - `show()` raises it;
  - `deal()` and `watch()` reset it;
  - `live()` shows `seenTo` and unpauses.

**`store.ts`:**
- `film: boolean`, reset by `deal()`.
- `playing = !s.film && lineup[human] is human`.
- At load, `phase` is `"over"` when the hash is `#/r/…`, so the lineup never mounts and deals.

**`App.tsx`:** on mount, and on `hashchange` to `#/r/`, call `openShared`.

### Task 3: the watch screen

**Files:**
- Create `web/src/phone/Watch.tsx` and `web/src/phone/Curve.tsx`.
- Modify `Phone.tsx`, `Result.tsx`, `phone.css`.

**`Curve`** (shared with `Result`):
- An SVG with `viewBox 0 0 last 1` and `preserveAspectRatio="none"`.
- One polyline per seat:
  - with Eval on, the seat's `evals[seat].win`;
  - with Eval off, `vp/10` (public `vp`).
- Lines are solid up to `at` and at 0.3 opacity from `at` to `upto`. A playhead line runs at `at`.
- With `onSeek`, a pointer drag maps x to a step in `[0, upto]`; `touch-action: none`.

**`Watch`** (no person seated, `.ph-watch`):
- the newest move row (`moveRow` over `seen(s)`);
- `Curve` with `at = playhead` and `upto = seenTo`;
- the transport:
  - ‹ step (`seek(at-1)`);
  - play/pause (56 wide, go);
  - › step (`hold(); stepOnce()`);
  - at the right, "Live" when `at < seenTo`, else the pace ("Slow", "Normal", "Fast"), cycling on tap;
- standings: one row per seat in seat order, with swatch, name, kind (`BOT_SHORT`, "Person" for a person), `pct(win)` with Eval on, and the public VP.

**`Phone.tsx`:**
- watching means no chips;
- the bottom is `.ph-watch` at a fixed height (`--watch-h`, small-phone step-down);
- the result covers it when over.

**`Result`:**
- **Watched or film:** the head is "Red won" and the round; the curve (always the win curve); the standings sorted by place with the kind; and Lineup, Share, Watch.
- **Played:** Lineup, Share, Rematch.
- **Share:** `navigator.share({url})` if present, else `clipboard.writeText`. The label reads "Copied" for 1.5s on success.

### Task 4: probes, desktop, docs

**`phone_check`:**
- **`watchUI`:** a watched game shows `.ph-watch` with standings, curve and transport, and no `.ph-chips`.
- **`scrub`:** a drag on the curve holds the playhead at the dragged step, ≤ `seenTo`.
- **`live`:** Live returns to `seenTo`, unpaused.
- **`watchEnd`:** the board rect is the same before and after the result.
- **`share`:** the result's link opened in a fresh page shows the cold result with the same winner and VP, and `film`.
- **`filmPeople`:** a two-person game's link opens with no hand and no cover; `leak` is 0.
- **`badLink`:** a garbled code lands on the lineup with the error line, and there's no page error.
- **`resumeCover`:** from Task 0.

**Desktop:** a cold `#/r/` link at 1440 shows the stands at the end with no page errors.

**Docs:** `UI-REWRITE.md` "Phones" M5, and the spec's notes on Watching and on the link format as built.
