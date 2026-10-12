# Phone UI, Milestone 3: lineup, opening, game over, Rematch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A game on the phone starts and ends on the phone's own screens:
- the phone's own lineup, with a picker sheet per seat;
- the opening draft order in the top bar;
- the result in place of your hand at game over, with Rematch;
- a watched game that shows no seat's private hand.

**Architecture:**
- **Lineup.** A new `phone/Lineup.tsx` replaces the desktop lineup that M1 put back into the phone's flow.
  - The seat edits (`setSeat` / `addSeat` / `removeSeat`, `humanFor`) and the deal-on-change effect (`useDealt`)
    move out of `views/Lineup.tsx` as exports. The desktop component calls them unchanged.
- **Game over.** The result (`phone/Result.tsx`) covers the seated block absolutely, with the hand kept in the DOM
  and hidden, so the board can't move.
  - Places come from a pure, checked `phone/standings.ts`. The words come from `labels.ts`.
- **Opening.** The draft order (`draft()` from `views/Opening.tsx`) is drawn as squares in the top bar.

**Tech Stack:** React 19, Vite, TypeScript, plain CSS (`phone/phone.css`). pnpm, uv. No engine change.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`. This plan covers:
- the "Phases" rows Opening and Game over;
- "Lineup";
- "Milestones" item 3.

Mockups: `web/design/phone/more.mjs` (H1 lineup, H2 picker, O1/O2 opening) and `review.mjs` (D, game over).

## Global Constraints

- **Desktop (≥ 1000px) must not change.** The functions moved out of `views/Lineup.tsx` keep their behaviour.
- **Commits.** Commit after each task. No attribution lines. No new dependencies.
- **House rules:**
  - UI copy labels, never narrates.
  - No strokes on pieces.
  - Every control sits in the bottom block, and every target is ≥ 44px.
  - Nothing truncates at 375×667.
- **No page reloads mid-run.** Never edit `web/src` or run `tsc -b`/`pnpm build` while `phone_check` runs.
- **Verification each task:** `cd web && pnpm exec tsc -b`. Pure modules run as
  `node --experimental-strip-types <file>`.

## Review Focus

1. **Watching with nobody seated.** `s.human` names a bot seat. Expected: no You row, no hand, a chip for every seat,
   and the move list in the slab. Pinned in Task 2's `watch` probe.
2. **Going back mid-game.** Expected: the phone lineup offers the game back at the same step, and Play then means a
   new game. Pinned in Task 5's `lineup` probe (`resumed.steps === before`).
3. **The result on a short phone.** Expected: header, curve, standings, VP cards and buttons all fit inside the fixed
   seated block at 375×667. Pinned in Task 5's `gameOver` probe (`scrollHeight <= clientHeight`).
4. **Rematch.** Expected: the same seed and lineup, a fresh game at step 0, and the board in the same box. Pinned in
   Task 5's `rematch` probe. The rematch is the next game the check plays, so its opening runs on real touch.
5. **Ties at the end.** Two seats on equal points share a place. Expected: "You tied for second", never two
   different places for equal points. Pinned in Task 1's `standings.ts` self-check.

---

### Task 1: Places at the end

**Files:**
- Create: `web/src/phone/standings.ts`
- Modify: `web/src/labels.ts` (`ORDINAL`, `placeText`), `web/src/views/Lineup.tsx` (import `ORDINAL`)

**Interfaces:**
- Produces:
  - `places(vps: number[], winner: number): number[]`
  - `placeText(place: number, tied: boolean): string`

- [ ] **Step 1: Write the self-check first.**

```ts
// web/src/phone/standings.ts
// Final places: the winner first whatever the points say, then by points; seats on equal points share a place.
export function places(vps: number[], winner: number): number[] {
  return vps.map((vp, i) => (i === winner ? 1 : 1 + vps.filter((w, j) => j !== i && (j === winner || w > vp)).length));
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("standings.ts")) {
  const eq = (a: number[], b: number[], m: string) => { if (a.join() !== b.join()) throw new Error(`standings self-check: ${m}: ${a}`); };
  eq(places([10, 8, 6, 5], 0), [1, 2, 3, 4], "plain order");
  eq(places([6, 10, 6, 3], 1), [2, 1, 2, 4], "a tie shares second; the next seat is fourth");
  eq(places([9, 10, 9, 9], 1), [2, 1, 2, 2], "a three-way tie");
  eq(places([10, 10], 1), [2, 1], "the winner is first on equal points");
}
```

- [ ] **Step 2: Run it.** Expected: it passes once `places` exists. Prove that the check bites by breaking `>` to `>=`
  once: it should then FAIL on "a tie shares second". Put `>` back.
  Run: `node --experimental-strip-types web/src/phone/standings.ts`.

- [ ] **Step 3: Add the words to `labels.ts`.**
  - Move `ORDINAL` there as an export, and have `views/Lineup.tsx` import it.
  - Add:

```ts
export function placeText(place: number, tied: boolean) { return `You ${tied ? "tied for" : "came"} ${ORDINAL[place - 1]}`; }
```

- [ ] **Step 4:** `pnpm exec tsc -b`. Then commit: "Phone M3: final places, ties shared".

### Task 2: Watching shows no private hand

**Files:** Modify `web/src/phone/Phone.tsx`, `web/src/phone/Chips.tsx`.

- [ ] **Step 1: The seated block.** Render `YouRow` and `Hand` only when `playing(s)`. The slab stays: with nobody
  seated, `slabMode` gives `bots` (the move list).
- [ ] **Step 2: Chips.** `seats` is every seat when `!playing(s)`:
  `playing(s) ? others : Array.from({ length: n }, (_, k) => k)`. The "off" rule compares against `you(s)`.
- [ ] **Step 3: Check.** In Chrome at 390×844, set an all-bot lineup with `__app` and `start()`. Expected:
  - four chips;
  - no `.ph-you` and no `.ph-hand`;
  - the slab is `ph-bots`;
  - no console error.

  The `watch` probe in Task 5 pins this.
- [ ] **Step 4:** `tsc -b`. Then commit: "Phone M3: a watched game shows every seat as a chip and no seat's hand".

### Task 3: The phone lineup

**Files:**
- Create: `web/src/phone/Lineup.tsx`
- Modify:
  - `web/src/views/Lineup.tsx` (export `humanFor`, `setSeat`, `addSeat`, `removeSeat`, `useDealt`)
  - `web/src/views/Picker.tsx` (`KINDS` and `sub` are already exported)
  - `web/src/phone/Phone.tsx`
  - `web/src/phone/phone.css`

**Interfaces:**
- Produces: the class names that Task 5's probes use:
  - `.ph-lineup`
  - `.ph-seatrow` (one per seat, `data-seat`)
  - `.ph-sheet`
  - `.ph-pickrow` (`data-kind`)
  - `.ph-play`
  - `.ph-resume`

- [ ] **Step 1: Shared seat edits.** In `views/Lineup.tsx`:
  - Lift `setSeat(i, kind)`, `addSeat()` and `removeSeat(i)` to module functions over `get()`/`set()`, with
    `humanFor` exported.
  - Lift the deal effect into `export function useDealt()`.
  - The desktop component calls these in place of its closures. Its behaviour is unchanged.
- [ ] **Step 2: `phone/Lineup.tsx`.** Top to bottom, after the board:
  - **One row per seat**, a button 52px tall: a colour bar, the occupant (`"You"` for the only person,
    `"Person"` when there are several, otherwise `BOT_SHORT`) over its `sub(b)`, and `›`.
  - **"Add a seat"**, a faint row, when `n < 4`.
  - **One row of buttons:** an Eval switch (`setEvalShown`), New board (a random seed), and Play, which is
    `start()`. Play reads "Watch" when nobody is seated and "New game" when a game is behind.
  - **When a game is behind** (`views/Lineup.tsx`'s `behind` test), a full-width go-button above that row:
    "Back to <round>", calling `resume()`.
  - **The sheet.** Tapping a seat opens a bottom sheet over a scrim:
    - a head with the seat's colour and name, and "wins vs 3 jSettlers" (the unit of the figures);
    - one row per `KINDS` entry with its name, `sub` and the measured rate (`Math.round(parseFloat(measured))%`);
    - the current occupant tinted;
    - "Take <seat> out" when `n > 2`.

    A row tap sets the seat and closes the sheet. A scrim tap closes it. The list scrolls inside the sheet
    (`max-height: 80dvh`). The current row takes focus when the sheet opens.
- [ ] **Step 3: `Phone.tsx` in setup.**
  - The wordmark "Catan RL" (44px) replaces the top bar.
  - The board is not dimmed.
  - `<PhoneLineup/>` replaces `.ph-setup` and its desktop-lineup CSS overrides.
- [ ] **Step 4: Check.** In Chrome at 390×844 and 375×667:
  - the lineup fits;
  - a seat opens its sheet, and a row changes the seat;
  - Play starts the game;
  - ‹ back and then "Back to …" resumes at the same step.

  `tsc -b`. Then commit: "Phone M3: the phone's own lineup and seat picker".

### Task 4: The opening in the top bar, the result at game over

**Files:**
- Create: `web/src/phone/Result.tsx`
- Modify: `web/src/phone/TopBar.tsx`, `web/src/phone/Slab.tsx`, `web/src/phone/Phone.tsx`, `web/src/phone/phone.css`

- [ ] **Step 1: The draft order** in the top bar's roll slot while `v.initial_phase`.
  - It has 2n squares in snake order: seat `i` for `i < n`, then `2n−1−i`. Seat 0 opens: `State::new` sets
    `current_player: 0`.
  - Placed squares are faded, the current one is larger, and there's a gap after the first n.
  - `role="img"`, with an aria-label as in `DraftOrder`.
- [ ] **Step 2: The supply's "next" piece.** It shows only if a piece follows the one you're placing:
  your settlements plus your roads, plus 1, is less than 4.
- [ ] **Step 3: `Result.tsx`.** It's absolute over `.ph-seat` (`position: relative`), on the chalk background. The
  You row, the hand and the slab stay laid out underneath at `visibility: hidden`, so the block keeps its height.
  - **Header.** "<who> won", in the winner's colour. With exactly one person seated who isn't the winner,
    `placeText`.
  - **The curve.** Every seat's `frames[i].evals[seat].win` as a polyline in an SVG with
    `preserveAspectRatio="none"`, `vector-effect: non-scaling-stroke` and `flex: 1`. Your line is bold, or the
    winner's when nobody is seated. The curve shows with Eval off too: the spec says the post-game curve is
    complete either way.
  - **Standings** by place. Each row has a swatch, the name, the VP cards face up (`Card dev={4}`, one per
    `devs[4]`) and `actual_vp`, with the winner's VP in its colour. On short phones the rows go into two columns.
  - **Buttons:** Lineup (`toLineup`) and Rematch (go, `start()`: same seed, same lineup).
  - The slab's `over` case renders nothing.
- [ ] **Step 4: Check.** Drive a game to its end in Chrome (`GAMES=1` `phone_check`, or `__app`). The result fits
  at all three sizes, and Rematch deals the same board at step 0. `tsc -b`. Then commit: "Phone M3: the draft order
  in the top bar, the result in place of the hand, Rematch".

### Task 5: Probes, runs, docs

**Files:** Modify `web/tools/phone_check.mjs`, `docs/UI-REWRITE.md`.

- [ ] **Step 1: Probes.**
  - `NEED` gains `opening`, `gameOver`, `rematch`, `lineup` and `watch`.
  - **`opening`**, the first time it's the person's turn in the opening and they hold a settlement:
    - `.ph-draft i` counts 2n, with one `.now`;
    - `.ph-supply` is present;
    - a raw-touch tap on a legal corner's screen point (via `geometry.nodeXY` and the `.carry` CTM) places the
      settlement.
  - **`gameOver`**, at the first winner, before the "all probes done" break:
    - `.ph-result` is present;
    - it has n standings rows;
    - the place line shows exactly when the person didn't win;
    - the curve is present;
    - `scrollHeight <= clientHeight`;
    - the board box is unchanged.

    Take a screenshot.
  - **`rematch`.** Tap Rematch with raw touch. Expected: the phase is `playing`, the seed is the same, and
    `steps < 3` within 4s. The rematch then *is* the next game: no `set({seed}); start()` on top of it.
  - **`lineup`**, after the loop:
    - tap ‹ back;
    - `.ph-lineup` shows "Back to …";
    - tap it, and the steps are unchanged;
    - tap ‹ back again, tap a bot seat's row, and `.ph-sheet` is present;
    - the sheet's `scrollHeight` is inside the viewport;
    - tap the `random` row, and the sheet closes with `lineup[i].kind === "random"`;
    - `small` stays empty.
  - **`watch`**: set an all-bot lineup through the sheet and tap Play, which reads Watch. Expected, after 4s:
    - phase `playing`;
    - n chips;
    - no `.ph-hand` and no `.ph-you`;
    - no error.
- [ ] **Step 2: Runs.** Run `phone_check` at 390×844, 375×667 and 360×780. Expected: exit 0, `small` [],
  `overflowX` 0, and one board box per size. Then a desktop pass at 1440 (CDP or Chrome):
  - change a seat in the Picker;
  - add a seat, then remove one;
  - Deal;
  - go back to the lineup mid-game;
  - "Back to the game" resumes at the same step.
- [ ] **Step 3: Docs.** Add an M3 paragraph to `docs/UI-REWRITE.md` "Phones". Then commit: "Phone M3: probes for
  the lineup, opening, result, Rematch and watching; docs".
