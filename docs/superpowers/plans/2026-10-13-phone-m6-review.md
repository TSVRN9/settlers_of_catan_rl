# Phone UI, Milestone 6: grades and the review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Your moves are graded like a chess review, Best to Blunder:
- **live**, beside the piece you set down;
- **in the review**, which a finished game opens. It shows:
  - the whole game's curve with the decisive moves lettered on it;
  - your grades counted;
  - every move a tap from the board at that moment, with the best move drawn faintly where it would have gone.

**Architecture:**
- **What a grade is.** It's the margin between the best root value and the played move's root value in the value-net search's ranked root (`rankedAt(step, "vnet")` on the review client, never on the live worker).
- **Thresholds.** The bands come from a measurement over about 200 bot games (`web/tools/grade_margins.mjs`), recorded in `docs/FINDINGS.md`.
- **`web/src/grade.ts`** holds the pure part (margin, band, which moves are graded) and is checked.
- **Storage.** `store.grades` maps a step to its grade. The live game fills it after each of a person's moves, off the game loop. The review fills it for the seat under review.
- **The review is a phone mode,** not a route: `store.review`, with `step` as its playhead. It keeps the board's size and the one bottom block, like watching.

**Tech Stack:** React 19, Vite, TypeScript, plain CSS. No engine change, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`. It covers "Analysis woven into play": Grades and The review. It also covers Milestone 6, a link to one move ("Watching bots and shared links"), and the pucks deferred from M5. Mockup: `web/design/phone/review.mjs` C–F.

## Global Constraints

- **Desktop stays the same.**
- **Grading is gated.** It's computed only with Eval on, only for a person's moves (live), and only off the game loop.
  - A grade shows beside the piece only if it's ready before the next move lands; otherwise it's kept for the review.
  - It never shows under a pass-and-play cover.
- **House rules:**
  - Labels only; the coach's line is the one sentence on the phone.
  - Targets ≥ 44px.
  - Nothing truncates at 375×667.
  - The board never moves during a game, and the review keeps the board's box.
  - One assert check per non-trivial module.
  - No `web/src` edits while `phone_check` runs.
- **Verification:**
  - `tsc -b`, the self-checks (`grade.ts` is new), smoke;
  - `phone_check` at 390×844, 375×667 and 360×780;
  - `pnpm build`.

## Review Focus

1. **A grade arriving after the next move.** Expected: no tag on the live board, and the grade is still in the review. Pinned in `grade.ts`'s check (`showLive`) and by the `gradeLive` probe.
2. **A played move missing from the ranked root** (an offer outside the search's three, a trade-policy answer). Expected: ungraded and not counted, never "Blunder" by default. Pinned in `grade.ts`'s check.
3. **The review of a game nobody was seated in** (watched, a cold link, pass and play). Expected: the bold seat and the graded seat are the winner by default, and a seat switch picks another. Pinned by the `reviewSeat` probe.
4. **A link to one move** (`#/r/<code>/<step>`). Expected: the review at that step, cold; a garbled step means the overview. Pinned by the `stepLink` probe.
5. **Leaving the review.** Expected: back to the result as it was, the board at the final position, and nothing live. Pinned by the `reviewBack` probe.

---

### Task 1: measure, then `grade.ts`

- **The measurement** (done by an agent): `web/tools/grade_margins.mjs`. It covers about 200 games of heuristic, jsrobot, random and vnet, the margin at every decision, `decide_full` timing, and per-category and per-bot percentiles. The results go into `docs/FINDINGS.md` as "Move grades: the margin scale".
- **`grade.ts`:**
  - `GRADES`, plus `BANDS` set from the measurement;
  - `margin(root, played): number | null`: null when the root has fewer than two entries, or the played move isn't in it;
  - `grade(m)`;
  - `graded(action, legalCount)`, which says which moves are graded (from the measurement's categories);
  - `showLive(step, framesLen)`;
  - `GRADE_INK`.
- **Self-check:** each band's edges; a missing move; a single-entry root; `showLive` only while the move's frame is the last closed one.

### Task 2: grades live

**Files:** `store.ts` (`grades`), `review.ts` (`gradeAt(step)`), `game.ts` (`act` queues a grade), `phone/Grade.tsx` (the tag on the board), `Phone.tsx`.

- A tag beside the piece for builds and the robber: the grade word in its ink, on open board to the right of the piece.
- It shows while the move's frame is the last closed one and no cover is up; otherwise nothing.
- Probe `gradeLive`: with Eval on, a person's build gets a grade in `store.grades` and a tag on screen before the next move.

### Task 3: the review

**Files:** `phone/Review.tsx`, `Curve.tsx` (pucks, the point of no return), `Result.tsx` (a Review button), `TopBar.tsx`, `game.ts`/`share.ts` (a step in links), `phone.css`.

- **The overview:**
  - the curve with the bold seat, lettered pucks from `deciding()`, W, and the point of no return dashed;
  - a tally row of the five grades;
  - the decisive moves as rows (letter, round, seat, icon, what, swing), each one opening that move.
- **At a move:**
  - the move row, with its grade;
  - for a graded move that wasn't Best, the best move's row, with "+N over yours" (N in win-chance points);
  - one coach line (`gap`/`evidence`);
  - the curve as the scrubber;
  - ‹ › and "Next key move".

  On the board: the position after the move, the move landing, and the best move as a ghost.
- **The seat:** you, or else the winner. With no single person seated, swatches in the top bar choose.
- **Share in the review** links to the step on screen: `#/r/<code>/<step>`.
- **Probes:** `review`, `reviewMove`, `reviewSeat`, `stepLink`, `reviewBack`.

### Task 4: docs and runs

- Docs: `UI-REWRITE.md` "Phones" M6, and the spec's Grades and Review rows.
