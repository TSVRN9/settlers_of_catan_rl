# Phone UI, Milestone 1: the shell and your turn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below 1000px wide the site becomes a playable phone app: the "around the table" layout, your turn
from roll to set-down with touch drag, readings behind the Eval and Hidden information switches, and a plain
fallback for every phase later milestones redesign, so a whole game can be played on a phone.

**Architecture:** `App.tsx` renders a new `phone/Phone.tsx` tree instead of the desktop stage when
`(max-width: 999px)` matches. The phone tree reuses the store, `game.ts`, both engine clients, `BoardLayer`
(parked on a phone `[data-anchor="table"]`), `Carry` (with three new touch props), `Fx`, `Thrown`, `COST`,
`PieceIcon`, `waiting`/`held`. What the slab under the hand shows is a pure function (`phone/slab.ts`) with an
assert self-check.

**Tech Stack:** React 19, Vite, Tailwind 4 (the site's CSS is plain CSS files), TypeScript, the Rust/wasm
engine. pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md` (sections "Layout", "Phases" rows Before the
roll / Roll lands / Main / Holding a piece / Set down / Another seat's turn, "Analysis woven into play" readings
and switches, "Architecture"). Mockups: `web/design/phone/play.mjs`, `small.mjs`, `builds.mjs`
(`node <file>.mjs` → `web/design/phone/out/`).

## Global Constraints

- Desktop (≥ 1000px) must not change. Every edit to a shared file is additive or behind a prop.
- No commits (house rule: commit only when the user asks). No new dependencies.
- UI copy labels, never narrates or captions; no strokes, outlines or halos on pieces; no placement confirm;
  sockets only while a piece is in hand (Carry already does this).
- One footprint: the slab under the hand is `84 + 10 + 50` px tall on a 390×844 phone in every phase; the board
  never resizes during a game. Nothing at rest covers a number or a name.
- Thumb zone: every control in the bottom block; tap targets ≥ 44px.
- `100dvh`, `env(safe-area-inset-*)`, no page scroll; inner panels scroll, nothing truncates.
- Small phones: below 700px tall, cards 44×60, build cards 70, buttons 46; below 375px wide, cards 46×63,
  build cards 80 (`small.mjs`).
- Sentences only from `coach.ts`/`labels.ts`.
- Holds are timers in `game.ts`; nothing waits on an animation.
- Non-trivial logic leaves one assert-based self-check runnable as `node --experimental-strip-types <file>`
  (pattern: `web/src/deciding.ts`, `web/src/readings.ts`).
- Verification each task: `cd web && pnpm exec tsc -b`; at the end also `node tools/smoke.mjs`, `pnpm build`.

## Review Focus

1. **A drag that ends just off a spot.** Expected: the piece stays in hand (near miss), not silently put back
   and not placed somewhere unintended. Pinned in Task 5's Chrome check.
2. **The board under a finger.** Expected: the held piece is visible above the finger, and snapping is
   generous enough for a fingertip (≥ 22px screen radius) on a 300px-wide board. Pinned in Task 5.
3. **A phase the phone has no design for yet** (discard, an incoming offer, Road Building, Year of Plenty,
   the robber's victims, a pass-and-play handoff). Expected: the game never strands you; the fallback slab
   lists every legal action. Pinned in Task 2's self-check (`fallback` for unknown prompts) and Task 7's check.
4. **Rotating or resizing across 1000px mid-game.** Expected: the game continues in the other layout with no
   lost state. Pinned in Task 1's check.
5. **375×667 and 360×780.** Expected: nothing overlaps or truncates; the hand fits beside the dev cards.
   Pinned in Task 8.

---

### Task 1: Mount the phone tree in place of "needs a wider window"

**Files:**
- Create: `web/src/phone/usePhone.ts`, `web/src/phone/Phone.tsx`, `web/src/phone/phone.css`
- Modify: `web/src/App.tsx` (return the phone tree early; delete the `.narrow` block at the end)
- Modify: `web/src/index.css:381-387` (delete the `.narrow` rules and the `@media (max-width: 999px)` block)

**Interfaces:**
- Produces: `usePhone(): boolean`; `default function Phone()`; CSS custom properties on `.ph`:
  `--cw --ch --tile-h --btn-h` (card, build-card and button metrics, stepped down by media queries).

- [ ] **Step 1: `usePhone.ts`**

```ts
// Whether the window is phone-sized: below the width the desktop table was designed down to.
import { useSyncExternalStore } from "react";

const PHONE = "(max-width: 999px)";
export const usePhone = () => useSyncExternalStore(
  (cb) => { const m = matchMedia(PHONE); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
  () => matchMedia(PHONE).matches,
);
```

- [ ] **Step 2: `Phone.tsx` skeleton** — a `.ph` column (top bar, chips row, board area with the anchor, seated
  block). `.ph` is the anchor's `offsetParent` and `#board-layer`'s containing block: **no element between them
  may be positioned**. In the lineup phase render the existing `<Lineup />` in a scrolling block under the board
  (Milestone 3 replaces it).

```tsx
// The phone: "around the table" (docs/superpowers/specs/2026-10-11-mobile-ui-design.md). Opponents across
// the top, the board, then you: your row, your hand and the slab whose job changes with the phase.
import BoardLayer from "../board/BoardLayer";
import Lineup from "../views/Lineup";
import { act } from "../game";
import { playing, set, useApp } from "../store";
import { held } from "../waiting";
import "./phone.css";

export default function Phone() {
  const s = useApp();
  const setup = s.phase === "lineup";
  const mine = !setup && playing(s) && s.view?.current_player === s.human && s.view.winner < 0 && s.step == null;
  const inHand = setup ? null : held(s);
  return (
    <div className="ph">
      {/* Task 3: <TopBar />, <Chips /> */}
      <div className="ph-board"><div data-anchor="table" className="ph-anchor" /></div>
      {s.map && s.view && (
        <BoardLayer view="table" dim={setup} map={s.map} gameView={s.view}
          carry={mine && inHand ? {
            map: s.map, view: s.view, legal: s.legal, seat: s.human, held: inHand, robTile: s.robTile,
            reveal: false, snapPx: 24, liftPx: 56, keepOnMiss: true,
            onPlace: (a) => void act(a), onRobTile: (t) => set({ robTile: t }),
            onDrop: () => set({ carry: null }),
            onClickCarry: () => set((cur) => (cur.carry ? { carry: { ...cur.carry, drag: false } } : {})),
          } : null}
          hidePieces={s.reveal} dealing={s.reveal} />
      )}
      {setup ? <div className="ph-setup"><Lineup /></div> : <div className="ph-seat">{/* Tasks 4-7 */}</div>}
    </div>
  );
}
```

(`snapPx`/`liftPx`/`keepOnMiss` are added to `CarryProps` in Task 5; until then leave them out.)

- [ ] **Step 3: `phone.css`** — layout and metrics. The board area is a size container; the anchor takes the
  largest box of the board's aspect (`VIEWBOX` 511.56 × 488.4) that fits.

```css
.ph { position: relative; height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      background: var(--color-chalk);
      --cw: 50px; --ch: 68px; --tile-h: 84px; --btn-h: 50px; --gut: 16px; }
@media (max-height: 699px) { .ph { --cw: 44px; --ch: 60px; --tile-h: 70px; --btn-h: 46px; } }
@media (max-width: 374px)  { .ph { --cw: 46px; --ch: 63px; --tile-h: 80px; } }
.ph-board { flex: 1; min-height: 0; container-type: size; display: flex; align-items: center; justify-content: center; }
.ph-anchor { width: min(100cqw, 100cqh * 1.04746); aspect-ratio: 511.56 / 488.4; }
.ph-seat, .ph-setup { flex: 0 0 auto; padding: 0 var(--gut) 10px; }
.ph-setup { max-height: 55dvh; overflow-y: auto; }
```

- [ ] **Step 4: `App.tsx`** — after the hooks (`useEffect`, `useApp`), `if (phone) return <><Phone /><div className="sr" role="status" aria-live="polite">{s.error ?? ""}</div></>;`
  with `const phone = usePhone();` declared before any early return (hooks order). Delete the
  `<div className="narrow">…</div>` block and its comment; delete the `.narrow` CSS and the media block that hid
  `.stage`.

- [ ] **Step 5: Check**

Run: `cd web && pnpm exec tsc -b` → no output.
Chrome (dev server on :5173): open `web/design/phone/frames.html` (create it: three iframes of
`http://localhost:5173/` at 390×844, 375×667, 360×780 side by side). Expected: the board fills the board area at
each size with the lineup below; at 1440 wide the desktop is unchanged. In a normal tab, start a game at a
narrow window width (`resize_window` to ~800 wide), then resize past 1000 and back: the game continues in each
layout with the same position and hand.

### Task 2: What the slab shows — a pure function with its check

**Files:**
- Create: `web/src/phone/slab.ts`

**Interfaces:**
- Produces: `type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over"`;
  `slabMode(x: SlabInput): SlabMode` with
  `interface SlabInput { over: boolean; mine: boolean; opening: boolean; prompt: string; legal: string[]; handoff: boolean }`
  (`legal` is the action-kind column, `s.legal.map(a => a[0])`).

- [ ] **Step 1: Write the module with its self-check first (the check fails to import until the function exists)**

```ts
// What the slab under your hand is for, from the position alone. Kept free of React and of the store so
// the check at the bottom runs outside Vite: node --experimental-strip-types web/src/phone/slab.ts
export type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over";
export interface SlabInput { over: boolean; mine: boolean; opening: boolean; prompt: string; legal: string[]; handoff: boolean }

/** The phases Milestone 1 designs, and a fallback that lists every legal action for the rest, so no
 *  position strands you on a phone before its own design lands (spec "Milestones"). */
export function slabMode(x: SlabInput): SlabMode {
  if (x.over) return "over";
  if (x.handoff || !x.mine) return "bots";
  if (x.opening) return "opening";                       // Carry holds the piece; the slab shows the supply
  if (x.prompt === "PLAY_TURN" && x.legal.includes("ROLL")) return "roll";
  if (x.prompt === "PLAY_TURN" && x.legal.includes("END_TURN")) return "build";
  if (x.prompt === "MOVE_ROBBER") return "build";        // Carry holds the robber; build cards sink
  return "fallback";
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("slab.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`slab self-check: ${m}`); };
  const base: SlabInput = { over: false, mine: true, opening: false, prompt: "PLAY_TURN", legal: [], handoff: false };
  assert(slabMode({ ...base, legal: ["ROLL", "PLAY_KNIGHT_CARD"] }) === "roll", "before the roll");
  assert(slabMode({ ...base, legal: ["END_TURN", "BUILD_ROAD"] }) === "build", "main phase");
  assert(slabMode({ ...base, mine: false }) === "bots", "someone else's turn");
  assert(slabMode({ ...base, handoff: true, legal: ["ROLL"] }) === "bots", "a handoff covers your controls");
  assert(slabMode({ ...base, opening: true, prompt: "BUILD_INITIAL_SETTLEMENT" }) === "opening", "opening");
  assert(slabMode({ ...base, prompt: "MOVE_ROBBER", legal: ["MOVE_ROBBER"] }) === "build", "robber in hand");
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"] }) === "fallback", "discard falls back");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE"] }) === "fallback", "offer falls back");
  assert(slabMode({ ...base, over: true, mine: false }) === "over", "game over");
  console.log("slab.ts self-check passed");
}
```

- [ ] **Step 2: Confirm the prompt names** against the engine before trusting the check:
  `grep -n '"PLAY_TURN"\|"MOVE_ROBBER"\|"DISCARD"\|"DECIDE_TRADE"\|BUILD_INITIAL' web/src/*.ts catan_engine/src/wasm.rs`.
  Fix the strings in both function and check if the engine's differ.

- [ ] **Step 3: Run** `node --experimental-strip-types web/src/phone/slab.ts` → `slab.ts self-check passed`.

### Task 3: Top bar, opponents' chips, and the Eval / Hidden information popover

**Files:**
- Create: `web/src/phone/TopBar.tsx`, `web/src/phone/Chips.tsx`
- Modify: `web/src/store.ts` (`evalShown`, persisted like `showHidden`), `web/src/phone/Phone.tsx`, `phone.css`

**Interfaces:**
- Consumes: `setShowHidden(on: boolean, remember?: boolean)` (game.ts), `hiddenLocked(s)`, `rememberedHidden()`
  (store.ts), `Thrown` (views/Tray.tsx), `roundOf` (labels.ts).
- Produces: `store.evalShown: boolean`; `setEvalShown(on: boolean)` exported from store.ts; chips carry
  `data-seat={seat}` (Fx flight targets).

- [ ] **Step 1: Store** — add `evalShown: boolean` to `State` (doc comment: "Readings on screen during play; off
  hides bars, percentages, swings and Suggest but `evaluateAll` still fills `frames`"), initial value
  `rememberedFlag("evalShown", true)`. Generalise `rememberedHidden` into
  `rememberedFlag(key: string, fallback: boolean)` and keep `rememberedHidden = () => rememberedFlag("showHidden", false)`.
  Add `export function setEvalShown(on: boolean) { try { localStorage.setItem("evalShown", on ? "1" : "0"); } catch { /* private window */ } set({ evalShown: on }); }`.

- [ ] **Step 2: `TopBar.tsx`** — 40px: back chevron (`toLineup` from game.ts), the title (`roundOf(s.frames, s.view)`,
  "Opening" while `s.view.initial_phase`), the last roll (`<Thrown frames={s.frames} at={s.frames.length - 1} live />`
  scaled to 24px dice via CSS), and an **Eval** control: a 44px button showing "Eval" with its on/off state that
  opens a small popover with two labelled switches, *Eval* and *Hidden information* (the second omitted while
  `hiddenLocked(s)`). Popover closes on outside tap or Esc.

- [ ] **Step 3: `Chips.tsx`** — one chip per other seat, clockwise from your left
  (`[1,2,3].map(k => (s.human + k) % n)`), each: swatch, name (`SEAT_NAMES`), VP (`v.players[i].vp`, display
  font), card count (sum of `hand` — public count), dev count, and with `evalShown` the win percentage
  (`fmtPct(s.evals[i]?.win)`) and a 4px bar. The seat on move (`turnSeat(v)` from Table.tsx, or
  `v.current_player`) lifts (white, shadow); others at opacity .55 while someone else is on move. A card-count
  increase since the previous frame shows as the count turning green for 1.4s (no "+3" — it would clip the chip).

- [ ] **Step 4: Check** — `pnpm exec tsc -b`; Chrome 390 frame: chips fit three across with no clipping at
  "Orange 5 … 18%"; toggling Eval hides bars and percentages; Hidden information swaps readings (compare
  `__app.get().evals` before/after) and is absent in a two-person lineup.

### Task 4: Your row and your hand

**Files:**
- Create: `web/src/phone/Hand.tsx`
- Modify: `web/src/phone/Phone.tsx`, `phone.css`

**Interfaces:**
- Consumes: `Card` (board/Card.tsx), `COST` (coach.ts: `COST[action]` is `number[5]`), `held(s)`, `s.carry`.
- Produces: `<YouRow />`, `<Hand />`; hand stacks carry `data-res={r}` (Fx targets).

- [ ] **Step 1: `YouRow`** — 24px: swatch, "You", VP, and with `evalShown` the bar and percentage. While a
  build card is held (`s.carry != null`), the row's opacity is 0 (the lifted cards rise into its space).

- [ ] **Step 2: `Hand`** — five stacks in resource order, each `var(--cw)` × `var(--ch)`, drawn at most four
  deep in 5px steps (`Math.min(n, 4)`), the count on the top card; a resource you hold none of keeps its slot as
  a dust card at .45. The row's height is fixed at `calc(var(--ch) + 15px)`. While a build card is held, the
  cards its `COST` spends lift 30px out of their stacks inside that lane (drop shadow), one faint card (.32) per
  card you lack, and each stack's count shows what you would keep. Dev cards sit right as a fanned pile
  (`Card dev={k}`, overlapping by 60%, ±4° rotation). A dev card is pressable when its `PLAY_*` action is in
  `s.legal`: Knight and Road Building act at once (Carry then holds the robber or the free road); Year of Plenty
  and Monopoly open the fallback list (Task 7) filtered to that action kind. Milestone 2 replaces this with
  dragging and the in-slab picker.

- [ ] **Step 3: Check** — `tsc -b`; Chrome 390: the gap from the You row to the stacks is the stack depth only;
  pressing City (Task 6) lifts 2 wheat + up to 3 ore and the counts stay readable under the lifted cards.

### Task 5: Carry on touch

**Files:**
- Modify: `web/src/board/Carry.tsx` (three optional props), `web/src/index.css` (`.carry.holding`)

**Interfaces:**
- Produces: `CarryProps.snapPx?: number` (minimum snap radius in screen px), `CarryProps.liftPx?: number` (the
  piece and its snapping point sit this many px above the pointer), `CarryProps.keepOnMiss?: boolean` (a drag
  ending near spots but on none keeps the piece in hand). All default to today's behaviour.

- [ ] **Step 1: Radius in screen px.** In `radius(sp)`, return `Math.max(units, (snapPx ?? 0) / k)` where `k` is
  the board's px-per-unit (`box.width / VIEWBOX.w`, already computed below — hoist it above `radius`).

- [ ] **Step 2: Lift.** Everywhere a pointer position becomes a board point (`at`, the drag-end `up`, `onClick`),
  subtract `liftPx ?? 0` from `clientY` first. The floating `afloat` piece uses the same lifted point.

- [ ] **Step 3: Near miss.** In the drag-end handler: `if (hit) place(hit); else if (keepOnMiss && amongSpots(p)) onClickCarry(); else onDrop();`.

- [ ] **Step 4: CSS.** `.carry.holding { touch-action: none; }` and the phone build cards (Task 6) also carry
  `touch-action: none`, so a drag does not scroll or zoom the page.

- [ ] **Step 5: Check** — `tsc -b`; desktop Chrome at 1440: drag a road and a settlement exactly as before
  (props absent). Phone frame (390): with a settlement held, the piece shows ~56px above the pointer; a drop
  within ~24px of a corner places it; a drop 40px off any corner but among them keeps it in hand; a drop on the
  sea puts it back.

### Task 6: Build cards with their costs

**Files:**
- Create: `web/src/phone/BuildCards.tsx`
- Modify: `web/src/phone/Phone.tsx`, `phone.css`

**Interfaces:**
- Consumes: `PieceIcon` (views/Build.tsx), `COST`, `RES_FILL`/`GLYPH_MINI` (board/palette.ts), `act`, `set`,
  `Carry`/`Building` types (store.ts).
- Produces: `<BuildCards sunk?: boolean />`.

- [ ] **Step 1: The cards.** Four cards in a row, each `var(--tile-h)` tall: piece icon (`PieceIcon`, seat
  colour), name (Road, Settlement, City, Dev card), and its cost as tokens — one per card of
  `COST[action]`, the resource colour with its glyph (`GLYPH_MINI`) when you hold it, a dust slot with the glyph
  at .35 when you lack it. "N left" in brick only when `≤ 2` (`roads_available` etc.). A card whose action is not
  in `s.legal` sinks (background `#e3e7de`, moss text); `sunk` sinks all four. The held card's slot shows an empty
  dust card.

- [ ] **Step 2: Pressing.** Same contract as `views/Build.tsx` `take`: `onPointerDown` (primary pointer only,
  `preventDefault`) sets `carry: { kind, drag: true, x0, y0 }` and `robTile: null`; pressing the held card again
  puts it back; the Dev card's `onClick` acts `BUY_DEVELOPMENT_CARD` directly. `touch-action: none` on each card.

- [ ] **Step 3: Check** — `tsc -b`; Chrome 390: City with 3 wheat 2 ore shows two solid wheat, two solid ore and
  one dust ore; Settlement shows "2 left" with two settlements remaining; dragging Road onto an edge builds it.

### Task 7: The slab — Roll, build + Trade/End, the move list, the fallback, game over

**Files:**
- Create: `web/src/phone/Slab.tsx`
- Modify: `web/src/phone/Phone.tsx` (mount `Slab` and `Fx`), `phone.css`

**Interfaces:**
- Consumes: `slabMode` (Task 2), `BuildCards` (Task 6), `Fx` (views/Fx.tsx), `rowAt` (review.ts), `narrate`
  (coach.ts), `label` (labels.ts), `act`, `set`, `delta` formatting via `fmtDelta` (labels.ts).
- Produces: `<Slab />`, always `calc(var(--tile-h) + 10px + var(--btn-h))` tall.

- [ ] **Step 1: Modes.**
  - `roll`: one pine slab the full height with two chalk dice and "Roll" (`act(ROLL)`); a Knight before the roll
    is played from the dev fan (Task 4).
  - `build`: `<BuildCards sunk={prompt === "MOVE_ROBBER"} />` above a row of **Trade** (opens the fallback list
    filtered to `OFFER_TRADE`/`MARITIME_TRADE`/`PLAY_*` in M1) and **End turn** (`act(END_TURN)`).
  - `bots`: the move list — the last three newsworthy frames since your last action, newest on top, each row the
    seat swatch and `narrate(rowAt(frames, i), map, you)` (two lines max), with the seat's swing
    (`fmtDelta(next.evals[seat].win - frame.evals[seat].win)`) when `evalShown`. Scrolls inside the slab.
  - `opening`: the supply — your settlement or road icon large (the one Carry holds), the next one faint.
  - `fallback`: every action in `s.legal`, one 44px button each, `label(a, s.map)`, scrolling inside the slab.
  - `over`: the winner (`SEAT_NAMES[v.winner]` + " won") in the display font and a **New game** button
    (`toLineup()`); Milestone 3 replaces this with the result screen.
  - The fallback list is also reachable from `build` mode's Trade button and from a dev card (Task 4), filtered
    by action kind: a `filter: string[] | null` in component state, cleared by Esc, by acting, or by the
    position changing.

- [ ] **Step 2: Fx.** Mount `<Fx frames={s.frames} at={s.frames.length - 1} map={s.map} you={you(s)} />` in
  `Phone`. Its targets already exist: `[data-tile]` (Board), `[data-seat]` (Chips), `[data-res]` (Hand).

- [ ] **Step 3: Handoff and discard.** `App.tsx` renders `<Discard />` and `<Handoff />` only in the desktop
  tree; in M1 the phone covers both through `fallback` (discard actions) and `bots` (a pending handoff shows the
  move list with a full-width **Show hand** button calling `confirmHandoff()` in place of the slab's buttons).

- [ ] **Step 4: Check** — `tsc -b`; `node --experimental-strip-types web/src/phone/slab.ts`; Chrome 390: play a
  whole game against three bots — opening placements via Carry, rolls with flights into chips and hand, builds,
  a 7 (discard through the fallback list, robber via Carry and its victim chips), an incoming offer through the
  fallback list, to game over. The board's box must not move between phases
  (`document.querySelector('#board-layer').getBoundingClientRect()` identical across them).

### Task 8: Small phones, desktop regression, docs

**Files:**
- Modify: `web/src/phone/phone.css` (as needed), `docs/UI-REWRITE.md` (Phones section), `web/design/mobile.mjs`
  (header comment)

- [ ] **Step 1: Small phones.** In the 375×667 and 360×780 frames, run Task 7's game to the first build. Fix any
  overlap, truncation or horizontal scroll (check `document.documentElement.scrollWidth <= innerWidth`).

- [ ] **Step 2: Desktop.** At 1440×900 start a game and play to the first build: identical to before (spine
  switch present, tray, ring).

- [ ] **Step 3: Gates.** `cd web && pnpm exec tsc -b && node tools/smoke.mjs && pnpm build`; all three self-checks:
  `node --experimental-strip-types src/deciding.ts`, `src/readings.ts`, `src/phone/slab.ts`.

- [ ] **Step 4: Docs.** In `docs/UI-REWRITE.md` "Phones (2026-09-09)", add a first paragraph:
  "Superseded 2026-10-12 by docs/superpowers/specs/2026-10-11-mobile-ui-design.md (mockups web/design/phone/);
  Milestone 1 built: …" with what shipped and what falls back. Add a one-line header comment to
  `web/design/mobile.mjs` saying it is superseded by `web/design/phone/`.
