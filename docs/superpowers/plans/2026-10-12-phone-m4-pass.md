# Phone UI, Milestone 4: pass and play — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two or more people share one phone with no hand ever shown to the wrong person:
- the cover drops in the next person's colour as soon as the phone has to change hands;
- the board replays the moves since that person last acted;
- a discard or an offer that needs someone else passes the phone for just that answer, and then hands it back;
- the table re-seats for whoever holds the phone.

**Architecture:**
- **In transit.** The phone keeps `holder` in the store: the person who last tapped Show hand, or null while the
  phone is in transit.
  - A pure `phone/pass.ts` decides whether a cover is up, for whom, and in which mode (`replay` or `answer`), from
    the view, the people seated and `holder`.
  - Once a cover rises, `holder` goes null, so every later person decision, the seated seat's own included, comes
    through a cover until Show hand.
  - `pump` is unchanged, except that the auto-decline of an offer nobody can afford now applies to every person seat.
- **The replay** is the look-back `step` the store already has, used as a playhead. The phone's readers of live
  state follow it:
  - the board's view;
  - the chips;
  - the top bar;
  - `Fx`;
  - `seen()`.

  `Fx` animates only forward steps. Bots keep playing under the replay, and their moves join it.

**Tech Stack:** React 19, Vite, TypeScript, plain CSS (`phone/phone.css`). pnpm. No engine change.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`. This plan covers "Pass and play" (the cover, the
replay, mid-turn answers, public only) and "Milestones" item 4. Mockup: `web/design/phone/handoff.mjs`.

## Global Constraints

- **Desktop behaviour stays the same.** There are two exceptions, both bug fixes, each ledgered:
  - an unaffordable offer to any person is declined without a handoff;
  - `Fx` doesn't animate a backward seek.
- **Commits.** Commit after each task. No attribution lines. No new dependencies.
- **House rules:**
  - Labels only.
  - Targets ≥ 44px.
  - The board never moves.
  - Nothing truncates at 375×667.
  - Sentences come from `labels.ts`/`coach.ts`.
- **Public only.** Under a cover, the narration and the flights are a spectator's (viewer −1).
- **No page reloads mid-run.** No `web/src` edits or builds while `phone_check` runs.
- **Verification:** `pnpm exec tsc -b`, the self-checks, `phone_check` at 390×844, 375×667 and 360×780, smoke, and
  `pnpm build`.

## Review Focus

1. **A cover's seat turns out to be the seated person again.** For example, A ends their turn, B's cover is up, and
   a bot's 7 makes A discard. Expected: a cover in A's colour and no hand until Show hand. Pinned in `pass.ts`'s
   check, and by `phone_check`'s invariant on every iteration: from a person's END_TURN until Show hand, no visible
   `.ph-hand`/`.ph-you` and no decision slab.
2. **The replay racing the live game.** Bots add frames while the replay runs. Expected: the replay walks to the
   live end, then `step` returns to null. A row tap or ↺ never animates backwards. Pinned by the `replay`/`jump`
   probes.
3. **Covered input.** An auto-held opening settlement or robber is under the cover. Expected: a board tap does
   nothing, and the slab's buttons are inert. Pinned by the `cover` probe: a tap on a legal corner while covered
   places nothing.
4. **The snake opening.** Expected: the cover names the person who really places next, using the second round's
   reverse order. Pinned in `pass.ts`'s check.
5. **An offer nobody can take, to a person who isn't seated.** Expected: it's declined without passing the phone.
   Pinned in Task 2 by a store-level check in `phone_check`: no answer cover for an unaffordable offer.

---

### Task 1: `pass.ts`, who the phone goes to

**Files:** Create `web/src/phone/pass.ts`. Modify `web/src/labels.ts` (`coverHead`).

**Interfaces (produced):**

```ts
export interface PassView { n: number; current_player: number; current_turn: number; initial_phase: boolean; winner: number;
                            owner: number[]; road_owner: number[] }
/** The next person to decide: the player on move if a person, else the turn's seat if a person (the turn comes back to
 *  them), else the first person in the turns still to come (the snake in the opening). -1 if none. */
export function nextPerson(v: PassView, person: boolean[]): number
export type Cover = { seat: number; mode: "replay" | "answer" } | null
/** Whether the phone is covered and for whom. Only with two or more people; never once the game is over. */
export function coverFor(v: PassView, person: boolean[], holder: number | null): Cover
/** The frames the cover replays for `seat`: every closed frame after the last one it acted in. */
export function sinceActed(frames: { seat: number; action: unknown }[], seat: number): number[]
```

- **`coverFor`:**
  - `seat = nextPerson(...)`.
  - It returns null when there are fewer than 2 people, the game is over, `seat < 0`, or `seat === holder`.
  - The mode is `answer` when `v.current_player === seat && v.current_turn !== seat`. Otherwise it's `replay`.
- **Self-check, before any implementation:**
  - in transit, the seated seat's own discard is covered;
  - with A holding, A's own turn isn't covered;
  - a bot on move in A's turn means no cover;
  - B after a bot is a `replay` cover;
  - a discard by B in A's turn is an `answer` cover;
  - one person never gets a cover;
  - the snake's second round predicts its reverse order;
  - `sinceActed` handles both "never acted" and "acted at frame k".
- **`labels.coverHead(v, seat)`:** "Discard N" while `v.prompt === "DISCARD"`, "Offer from <seat>" while
  `DECIDE_TRADE`, and "" otherwise.

### Task 2: the playhead and its readers; the shared fixes

**Files:**
- `web/src/store.ts`: `holder: number | null`, reset by `deal()`; `shown(s)` returns `{ view, evals }` at
  `step ?? live`.
- `web/src/phone/usePhone.ts`: `seen` slices to `step ?? view.steps`.
- `web/src/phone/{Phone,Chips,TopBar}.tsx`.
- `web/src/views/Fx.tsx`: forward only.
- `web/src/game.ts`: the auto-decline covers every person seat. The mute stays the seated seat's.

What changes:
- `BoardLayer gameView`, Chips' view and evals, TopBar's title and roll, `Fx at`, and `seen` all follow `step`.
- `Fx` keeps the last `at` it animated and skips any `at` at or below it.

### Task 3: the cover

**Files:** Create `web/src/phone/Cover.tsx`. Modify `Phone.tsx`, `Hand.tsx` (the You row's name), `Slab.tsx` (drop the
old "show hand" button), and `phone.css`.

- **The cover itself.** It's absolute over `.ph-seat`, like the result, in `SEAT_FILL[seat]`. The ink is chalk on
  Red and Blue, and pine on Orange and White. It carries `data-seat={seat}`, so flights to that seat land on it.
  It holds:
  - the seat's name (display 34px) and `coverHead`;
  - in replay mode with more than one row, the strip: one segment per row, the passed ones full;
  - the rows: icon, seat swatch, the narration (viewer −1), and the swing with Eval on. The playing row is lit, and
    the rows scroll inside the cover;
  - ↺ (54px; replay mode with more than one row) and Show hand (go).
- **The replay** runs while a replay cover is up for a seat. On cover start, the steps are the newsworthy indices
  `r` from `sinceActed`, and `step = rows[0]`. Then:
  - every 1000ms, `step` moves to the next row's `index + 1`;
  - when the next row would be past the live end, `step` is null;
  - frames that arrive later extend the rows;
  - a row tap sets `step = index` and replays from there; ↺ goes back to the first row;
  - in answer mode there's no replay: rows are the current turn's newsworthy moves.
- **Show hand.** If `pendingHandoff === seat`, it calls `confirmHandoff()`. It then sets `human: seat`,
  `holder: seat`, `step: null`.
- **Phone wiring:**
  - `covered`: hide the You row and the hand; make the slab inert; turn off `carry`; seat the chips for the cover
    seat; the viewer is −1.
  - An effect sets `holder: null` once a cover is up.
  - On game start with 2 or more people, `holder` is null, so the first person gets a cover too.
  - The You row reads `SEAT_NAMES[human]` with more than one person seated.

### Task 4: probes, runs, docs

- **`phone_check` gets a pass-and-play phase after the lineup/watch probes.**
  - **Setup:** two people (seats 1 and 2) and two bots, through `__app`, then `start`. The person's moves use the
    existing policy. A cover is answered by probes, then by Show hand.
  - **The invariant, every iteration:**
    - from a person's END_TURN (or the game's start) until a Show hand tap, `.ph-hand` and `.ph-you` are not visible;
    - the slab under the cover is `inert`;
    - `phone.leak` counts violations and must be 0.
  - **Probes (NEED):**
    - **`cover`**: the cover is up within 300ms of an END_TURN, with `data-seat` the next person; the chips don't
      include that seat; a tap on a legal corner or a build card under it changes nothing.
    - **`replay`**: `step` advances at least twice and then returns to null.
    - **`jump`**: a row tap sets `step` to that row's index.
    - **`restart`**: ↺ sets `step` to the first row's index.
    - **`showHand`**: `human` and `holder` are the seat, and the You row shows `SEAT_NAMES[seat]`.
    - **`answer`**: an answer cover with a non-empty head.
    - **`handBack`**: the next cover after an answer is in the turn player's colour.
    - **`coverFits`**: the cover's `scrollHeight <= clientHeight`, or its rows scroll inside.
  - **Length:** up to 2 pass-and-play games until all probes have run.
- **Desktop hotseat at 1440:**
  - two people;
  - the `Handoff` gate appears for the second person, and "I am <seat>" proceeds;
  - the game reaches the next person's decision;
  - no page errors.
- **Docs:** `docs/UI-REWRITE.md` "Phones" M4, and the spec's Pass and play row.
