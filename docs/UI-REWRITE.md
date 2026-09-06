# Plan: rewriting the web UI (2026-09-04)

The design is settled and published as a canvas — six views, one board, one line of chrome.
`web/src` implements none of it. This is what the new front end is, in what order it gets
built, and what has to be true for each step to count as done.

The visual spec is the canvas, not this document:
https://claude.ai/code/artifact/dd5dfb20-2e25-44a1-8924-65cda26a1da1
Its generators are in `web/design/` (`board.mjs` is the board's single definition), and
`web/design/README.md` records the decisions the board encodes.

## Where the current app stands

1,050 lines under `web/src`, and the shape of it fights every part of the design.

| | today | why it has to go |
| --- | --- | --- |
| navigation | four hash tabs, `App.tsx:35-38` renders exactly one page | switching a tab unmounts the page **and destroys the game** |
| state | `useState` inside `Play`/`Watch` | there is nowhere for a game to live that outlives a view |
| engine | one module-global `EngineClient`, `engine.ts:98` | `worker.ts:25` frees the wasm engine on every `new`, so Play and Watch destroy each other |
| styling | Tailwind stone/amber, `dark:` on everything, `"Inter"` declared and never loaded | none of the design's palette, type or geometry |
| board | `Board.tsx`, sea rect, outlined pieces, brown ports | the design has no outlines, no sea, no island edge |

Four bugs worth naming before they are inherited, because each is a fixed cost in the
rewrite rather than a thing to guard:

- **`decide` straight after `newGame` throws "no game" today.** `new` awaits a wasm boot and
  two fetches; nothing serialises the queue, so the next request is handled first.
- **`run` cannot be aborted.** Its `while` in `worker.ts:70-91` contains no `await`, so the
  worker never yields to `onmessage`. Navigating away leaves it grinding up to 3,000 steps
  and posting to a dead handler.
- **The drive loop can deadlock.** `Play.tsx:52` and `:57` bail on a generation change
  *without clearing `inflight`*, and nothing else clears it but `start()`.
- **`busy` is status, ellipsis and error at once** (`Play.tsx:24`) **and** gates `myTurn`
  (`:111`), so one caught error disables the human's whole action surface until a new game.

## The architecture, in one paragraph

One board element that is never unmounted, one store outside React, two workers. A view
change moves the board; a time change moves the pieces; a hypothetical divides the board
into six and brings one back. Nothing else is allowed to move the board, which is what makes
the motion legible.

### Modules

Kept as they are: `main.tsx`, `labels.ts` (every string, `actionKey`, `label`, the bundle
pack/unpack, `outcomeText`, `tradeText`, `fmtPct`), `data/topology.json`, `vite.config.ts`
(`worker: {format:"es"}` is already right for two workers), the Pages workflow.

| new / rewritten | job |
| --- | --- |
| `src/index.css` | `@theme` tokens + the bespoke CSS lifted from `board.mjs`'s `BASE` and `SPINE_CSS`. Hand-rolled, not `@apply` |
| `src/store.ts` | one immutable snapshot, `useSyncExternalStore`, no dependency |
| `src/route.ts` | one regex, the crumb stack, `popstate` |
| `src/waiting.ts` | `waiting(state)` and `heat(decision)` — the two derivations that were missing or duplicated |
| `src/game.ts` | the drive loop and the live `EngineClient` |
| `src/keys.ts` | one global key handler |
| `src/Spine.tsx` | crumbs, the step, what is waiting. The only permanent chrome |
| `src/board/Board.tsx` | `board.mjs`'s drawing, driven by live `MapView`/`View` |
| `src/board/BoardLayer.tsx` | the single instance, and its flight between views |
| `src/board/geometry.ts` | derived from `map.*.nodes`, never from `topology` array order |
| `src/views/Table.tsx` | M1. Console, Coach, Futures, Move, Game follow |

Deleted in M0: `pages/{Play,Watch,Results,About}.tsx`, `analysis/*`, `ui/*` (git history
keeps `WinProbTimeline`'s scaling and `Attribution`'s bipolar bar for M3 to crib), and nine
of eleven runtime dependencies — every `@zag-js/*` and `@tailwindcss/typography`. If a modal
is needed later, `<dialog>` + `showModal()` is native.

### State

```ts
let state: State = initial;                       // one object, replaced wholesale
export const getSnapshot = () => state;           // referentially stable, or React loops
export const useApp = () => useSyncExternalStore(subscribe, getSnapshot);
```

No selector layer: `getSnapshot` must be cached or React throws *"The result of getSnapshot
should be cached"* and re-renders forever. Four seats and one board is not a render cost
worth a subscription graph. `map`, `view` and `legal` live in a module, so `App.tsx` swapping
which *view* renders cannot take the game with it — the board element is a sibling of the
view slot, mounted once, with no `key` and no branch above it.

**`waiting()` is derived, never pushed**, from `current_player`, `prompt`, `is_discarding`,
`is_resolving_trade` and `winner` — all of them, because a seven arrives as `is_discarding`
and a knight as `is_moving_knight` rather than as a distinct prompt. That is the whole
mechanism by which an interrupt reaches you three crumbs deep in analysis: the spine reads
the same snapshot everything else does. It also *has* to be derived rather than keyed off the
route, because Console and Coach have no route at all.

### Workers

`EngineClient` is already a class; only its export is a singleton. So two instances — `live`,
and `review` built lazily on first entry to a review view — plus four small changes:

1. **A queue.** `this.tail = this.tail.then(...)` in `call()`. Fixes the live "no game" bug
   and makes a stray `newGame` during a `run` impossible.
2. **An epoch** on every request, rejected locally and in the worker as `"stale"`. Replaces
   `Play.tsx`'s `gen` counter *and* its `inflight` ref, and makes StrictMode harmless.
3. **`abort`**, posted outside the queue, plus the yield that lets it land:
   ```ts
   if (batch.length >= 8) { post(batch); batch = [];
     await new Promise(r => setTimeout(r));        // one macrotask per 8 frames
     if (aborted) break; }
   ```
   `SharedArrayBuffer` + `Atomics.wait` is the textbook answer and is unavailable on Pages,
   which serves no COOP/COEP headers.
4. **`record`**, so an interactive game can be handed to the review worker. Today the record
   is only reachable as a field of `run`'s result.

**`Engine::replay` returns an engine with no value net.** `catan_engine/src/wasm.rs:74` calls
`Engine::new`, which sets `net: None`; `tools/smoke.mjs` replays and compares `view()` but
never evaluates, so nothing catches it. Every replay must `load_net` and assert `has_net()`
immediately, and the smoke test gains that assertion. Review then walks the record forward
**once**, emitting frames in batches of 8 exactly as `run` does, and scrubbing reads the
cached array — replaying per scrub is O(n²) and the `evaluate_all()` per step is the real
cost anyway.

Each worker holds its own copy of the 1.6 MB net. Same fetch, cached; two resident copies.
That is the price of never freeing the live engine, and it is why review is lazy.

### The board

`board.mjs`'s drawing, transcribed, with three substitutions: the hard-coded turn-31 `TILES`
become `map.tiles`, the hard-coded `PIECES` become `view.owner` / `is_city` / `road_owner`,
and every colour literal becomes `var(--color-…)` so the dark palette is later a `@theme`
override rather than a second component. Kept exactly: no stroke, outline or halo on any
piece; the plinth as the only shadow; `TOKEN = {r:16.5, font:14, base:4.2, pipCy:10.2,
pipR:1.15, pipGap:3.2}`; glyphs at 13%; roads at 5.4 with round caps so a chain fuses; the
squared lattice taper; no island outline; the port badge filled like a tile.

The number token keeps the individual-property trick — the group carries
`transform="translate(cx,cy)"` and the animation touches the `scale` *property*, which
applies first and so pops about the tile's own centre. In React that is
`style={{ scale: ... }}`; folding it into the transform attribute breaks it.

`VIEWBOX` is the design's literal `-236.72 -244.2 511.56 488.4`, not the padded box
`geometry.ts` computes today, because every measured width maps onto it exactly
(574/511.56 = 548/488.4 = 1.1220).

**Geometry is derived, which retires a whole bug class.** `Board.tsx:57` and `:93` index
`topology.tiles[t.id]` and `topology.ports[p.id]`, assuming the Rust `map_json()` array order
matches the Python dump's — undocumented, unvalidated, and already broken once (commit
`27ea5c4`). But `map_json()` carries `nodes` per tile and per port, and node ids *are* the
engine's, so tile centres and port docks come from `map.tiles[i].nodes` /
`map.ports[i].nodes` through `topology.node_xy` and the order stops mattering.

### The flight

The board's position per view is **FLIP against per-view CSS anchors**, not custom properties
driven from JS. Each view renders an empty anchor positioned by ordinary responsive CSS:

```css
.stage { container-type: size; }                  /* the box under the 28px spine */
[data-anchor] { position:absolute; transform:translate(-50%,-50%); aspect-ratio:511.56/488.4; }
[data-anchor="table"] { left:45.694%; top:51.835%; width:min(39.861cqw, 65.826cqh); }
[data-anchor="move"]  { left:24.306%; top:55.631%; width:min(43.611cqw, 72.018cqh); }
```

The `min(cqw, cqh)` pair is what makes it responsive: at exactly 1440×872 — the artboard less
the spine — both terms equal the measured width and the artboard is reproduced to the pixel;
at any other aspect the board shrinks to fit instead of distorting. `BoardLayer` measures
both rects in `useLayoutEffect`, parks the board on the new anchor with no transition, then
animates a single `transform` back from the old rect. Layout does the responsive arithmetic;
the animation is pure compositor work; and `prefers-reduced-motion` is an early `return`, so
the reduced path is *less* code rather than a second one — the board still changes size, it
just arrives there.

Ratios come from `web/design/measured.json`, whose `cy` values include the spine. Note Move
analysis is **628 wide, larger than Table's 574**, so nothing may clamp the board at the
Table size; and `ViewFutures` has **seven** rects, the six 207px candidates plus a 180px
comparison thumbnail at (126, 221).

### Routing

One regex, `#/g/<seed>[/futures | /step/<n>[/move]]`, and **the crumb stack is the truth
while the hash is a projection** — Console and Coach have no route, so a pure derivation
could not reproduce a two-level path from a hash alone. Every navigation — Esc and a crumb included — sets
the stack and pushes a history entry carrying it; browser-back lands on an entry and `popstate`
re-seeds the stack from it. (Navigating *by* `history.go(-n)` trusted the browser's depth to
mirror the stack, which a deep link on a cold load or a step scrubbed inside a review broke: the
"Step 118" crumb landed on the entry's stale step.) Scrubbing inside a review view
`replaceState`s the current entry, so the address bar names the step on screen. A review link
survives a reload because a step is a fact about a record. `#/g/<seed>` on reload does **not** resume or restart: it shows the
lineup with that seed already filled in, because a seed reproduces the map and not the play,
and starting a different game under the same address would be a lie about what the link
means.

Space is "show every legal move" in a play view and play/pause in a review view — they never
coexist, and the spine says which you are in. Guard it against `document.activeElement`
matching a button, or it double-fires against the board's own keyable targets.

## What is built (2026-09-05)

**M0 through M4 are done** — the rewrite covers everything in this document. `pnpm dev` deals
a game with the reveal, you build by touching the board, the bots drive themselves, and a loud
interrupt now opens the actual UI it names rather than just saying what's wrong. The game ends
with standings, a mini curve, and the moments that decided it. Console, Coach and Futures are
all reachable and playable, not just Table. Game analysis and Move analysis are reachable from
the spine's turn number, Table's ending, Coach's recommendation, and Console's ranked list —
the live engine is never touched by either. Two or more human seats is a real hotseat: a
handoff screen covers each hand between turns.

The log is **not** on the Table, and the M1 check that asked for it there was wrong: the
design puts the log in ViewConsole. It arrives with M2, which is why `store.log` has been
filling up with nothing reading it.

Three things the build taught that the plan did not know:

1. **The coach's search was swallowing clicks.** The drive loop held its lock across the
   advisory `decide("vnet", 2)` — a depth-2 search over every legal move, seconds long at
   the opening — and `act()` bailed while the lock was held, so a human's clicks vanished
   with no feedback. The advice now runs *after* the lock is released, in `advise()`.
2. **The crumb stack rides in `history.state`, not just the URL.** Console and Coach project
   onto their game's own address, so `Table > Console > Coach` and `Table > Coach` share a
   hash; deriving the stack from the URL on `popstate` landed Esc on Table instead of
   Console. `pushState` carries the stack, and the hash is the fallback for a cold load.
3. **The geometry invariants hold to 2e-5, not exactly.** `topology.json` stores node
   coordinates rounded to four decimals (`0.866`, not √3/2), so the smoke test's port
   assertions use a 1e-3 tolerance. At S=44 the error is 0.001px.

Also built, and not in the plan: a panel on the Table listing any legal action the board and
the action column do not cover — a trade to answer, cards to discard, a card to play, whom to
rob, which trade to offer. Without it a position can be reached that is simply unplayable,
which a full game hits within ten turns.

### What finishing M1 turned up

An audit against the design and the engine found more than the first pass admitted:

- **A `while` loop in the spine froze the tab.** `while (s.crumbs.length > 1) pop()` read a
  render-time snapshot while `history.back()` is asynchronous, so the condition never
  changed. It fired on every loud state — a seven, a trade, the robber, the win — from every
  view but the Table. Navigation is now one `history.go(-n)` and never a loop.
- **Some positions could not be played.** The panel truncated at twelve actions, and the
  engine emits dev-card plays first: one Year of Plenty can emit fifteen combinations, which
  pushed Monopoly, Knight, Road Building and every maritime trade out of reach. It scrolls
  now, and nothing is cut.
- **You could not choose whom to rob.** A tile carries one `MOVE_ROBBER` per victim and the
  board fired the first. A tile with several victims now asks.
- **Every trade offer but one was unreachable**, and the button named that one arbitrary
  offer rather than saying "Offer a trade".
- **`DECIDE_ACCEPTEES` was mislabelled.** It shares `is_resolving_trade` with `DECIDE_TRADE`,
  but on that prompt the offerer in `current_trade[10]` is *you* — the spine was telling you
  that you had offered yourself a trade.
- **StrictMode installed every listener twice**, so in dev Escape popped two crumbs and the
  1–4 seat keys turned themselves off again. Both installers return their uninstall now.
- **The bot pacing ignored a zero.** `parseFloat(v) || 350` treats `0ms` as absent, so the
  pacing could not be turned off — which is how a whole game gets watched in a minute.

And two things the design had that the implementation did not: the four readings belong on a
**ring around the board**, not in a rail down the left (that rail was mine; the dense version
of it belongs to Console in M2), and the hand is **one fanned card per resource carrying its
count**, not one card per card held.

A lineup with nobody in it is now legal, which is what watching is. It is not the Broadcast
view — the Table simply plays itself and says who is thinking rather than "your turn".

### M2 notes

Console and Coach matched the plan closely: the log finally has a reader, the action bar
copies Table's cost-pip pattern at Console's own size, and Coach's bubbles are templated
strings from `decide()`/`attribution()` — no free text, nothing persisted. Two things the
build resolved that the plan left open:

- **Futures needed one new engine method.** `decide()`'s `root` is values only, no board
  state, so showing several genuinely different hypothetical boards at once required
  `Engine::preview(action)` (`catan_engine/src/wasm.rs`): clone `self.state`, apply the action
  to the clone, return its `view()`. Non-mutating, queued through the same `EngineClient` as
  everything else, no epoch bump. `tools/smoke.mjs` asserts it doesn't touch the live engine
  and does change the result.
- **Slot 0 is a sixth candidate, not the live position — the artboard is the spec, and it
  disagreed with this document's own prose.** The first build read "the real board flies to
  slot 0" as "slot 0 shows the current position," which produced an uncaptioned board reading
  as a rendering bug next to five labeled candidates. `web/design/canvas/ViewFutures.dc.html`
  has no such thing: it is a plain 3×2 grid of six hypothetical candidates (the top-ranked one
  ringed), plus a *separate* 180px thumbnail in the left aside captioned "You, right now" for
  the current position. The fix keeps "one board element never unmounted" intact without
  fighting the artboard: the persistent board still parks at `[data-anchor="futures"]` (which
  is exactly the grid's top-left cell), but now shows that cell's own top-ranked candidate via
  a new store field, `boardOverride`, rather than the live view — `App.tsx` reads
  `s.boardOverride?.view ?? s.view` for whatever `BoardLayer` renders. The other five cells are
  plain clones, as before. The dice-branch panel and "show the other eight" stay cut, per the
  plan's own list.
- `Board.tsx`'s `highlight` prop, previously only compared against a target already in
  `legal`, now draws an unconditional ring/line/outline at the action's node, edge or tile —
  needed for Futures' clones, where `legal` is empty, and reusable as-is for M3's move ladder.
- **Console and Coach had their own artboard gaps**, found the same way — a fresh read of
  `ViewConsole.dc.html`/`ViewCoach.dc.html` against the shipped components, after the Futures
  miss made clear the artboard has to be the actual check, not this document's paraphrase of
  it. Console gained a per-seat pip bar and hidden-VP marker on the seat rail, a hexagonal
  shield in place of the flat colour swatch, "Offer a trade"/"Bank trade" in the action bar,
  and a "why it is not close" line plus an "All N moves" door into Move analysis below the
  ranked list. Coach's right column turned out to be just the board with a two-button header
  ("Hand: N cards", "All N moves") — the seat-mini-stats-and-hand panel the first pass built
  there doesn't exist in the design — and its "earlier this turn" bubble now narrates the most
  recent `store.log` row instead of repeating a static win%/VP line Console already shows.

### M4 notes

Interrupts turned out mostly already wired: Table's generic `pending`/`rest` panel already
surfaced trades and the robber's multi-victim choice correctly the moment you were back at the
Table, which is what the spine's loud pill already did (`toRoot()`, untouched). The one real
gap was discarding on a seven — one card at a time through that same generic panel — which is
now `Discard.tsx`: pick cards up to the count, "Discard these N" fires them in one batch, "Let
the net choose" loops `decide('vnet', 2)` the same way a bot's own discard already does, no new
engine surface.

- **A modal has to render after the board in DOM order, not nested inside a view.** The first
  `Discard` pass lived inside `Table.tsx`'s own return, same as everything else there — but
  `BoardLayer` is a *later* sibling in `App.tsx`, so the board painted on top of the modal
  instead of behind it. Fixed by rendering `Discard` (like `Handoff`) directly from `App.tsx`,
  after the board. The lesson generalises: anything meant to sit in front of the persistent
  board belongs at the App level, keyed off `waiting()`/store state, never inside whichever
  view happens to be current.
- **Hotseat needed one new field, not a new identity system.** `store.human` already meant
  "the seat the readings are written from" — for hotseat it just becomes dynamic. `game.ts`'s
  `pump()` already had the exact spot that detects "a human seat, not forced" and returns
  control; hotseat only had to check there whether that seat differs from `human` and, if so,
  hold in `pendingHandoff` until `confirmHandoff()` moves `human` to it. Every existing
  `s.human`-keyed read (hand, coach, attribution, "you") was already hotseat-correct with zero
  changes. Verified live: handoffs fire in both directions between two human seats, never for
  a bot, and a single-human game never sets `pendingHandoff` at all.
- **The ending's curve and "moments" list cost nothing new.** `topSwings(frames, seat, n)` was
  pulled out of `Game.tsx`'s own inline computation into `review.ts` so the ending screen could
  call the same function; the curve is a smaller copy of the same polyline loop. The artboard's
  "how you played" stats row (moves matched the net, total cost) was cut — it needs an on-demand
  `decide()` at every one of the human's past turns, real search cost for a once-per-game
  screen, and it's backed by the weakest-authority artboard in the canvas.
- **Loose end, not chased:** the spine's loud pill occasionally still read "move the robber"
  a beat after the robber had already been moved (by a bot, later in the same batch of frames).
  Play was never actually blocked when this happened — rolling, trading and discarding all
  worked normally regardless of what the pill said — so it reads as `waiting()` lagging the
  view by one render rather than a stuck engine state. Not reproduced deliberately; worth a
  look if it recurs with a tighter repro.

### Cards were flat rectangles, in every view, since M1

Every hand rendering (Table, Console, Futures, Coach's inert strip, and Discard once M4 built
it) drew a resource card as a flat `RES_FILL`/`C[r]` fill with a count — no session note
attributes this to the design canvas, and it isn't: `ViewTable.dc.html` draws a card as a
**paper background**, a colored bottom border naming the resource, and a 32×32 glyph icon at
.85 opacity — the same `GLYPH_MINI` shapes the board's own tiles and port badges already use
(`Board.tsx`'s port-badge rendering is the exact recipe: `translate(cx,cy) scale(k)
translate(dx,dy)` on the glyph's own markup). The glyph data was already sitting unused in
`palette.ts`. Fixed once, in a new `board/Card.tsx` every hand-rendering call site now shares,
rather than five call sites each drawing their own colored box — the actual bug was that
nobody had checked the flat-rectangle placeholder against the artboard since it was first
written.

## The laws (2026-09-05)

The rewrite built the structure and stopped; this pass made every screen obey one philosophy.
It is recorded here because it is the check every later change is held to, before the artboard
and before this document's own prose.

**The table is a place. Everything you see is either the game or evidence about the game.**

1. **Nothing appears or vanishes; things arrive and leave.** The board travels (`--t-board`,
   420ms). A panel arrives beside it from the edge it docks to and leaves the same way
   (`--t-panel`, 260ms). A piece lands on its own centre. A reading drifts to its new value.
   A control answers a press (`--t-feel`, 120ms). One easing. Reduced motion is the same
   layout with the travel removed — one `@media` block in `index.css`, never a second path.
2. **One thing moves at a time, and each thing has one way of moving.** A view change moves
   the board and nothing on it; a move changes the pieces and nothing about the rect; a
   hypothetical divides the board.
3. **The furniture knows who is sitting there.** A person gets a hand, an action column and a
   coach; a table with nobody at it gets a transport (play/pause, step, pace) and a commentary.
   The lineup's chips look different for a person and a bot. "You" is written only when there
   is a you (`labels.who` / `whom`, from `store.you(s)`, which is -1 in a watched game).
4. **Every sentence cites its evidence.** `coach.ts` is the only place a sentence about the
   game is built: corners by their tiles ("the 8 wood · 3 ore corner"), moves by what they pay
   ("eleven ways in thirty-six"), gaps by their kind ("production, not risk"). No id — a node,
   an edge, an attribution group's name — reaches the screen. `label()` in `labels.ts` names
   corners and edges the same way.
5. **The interface narrates; it does not instruct.** The Table's instruction line shows until
   this person has built once, then the same place carries the commentary.

### How the motion is built

- **Navigation is a View Transition.** `store.transition(fn)` wraps `document.startViewTransition`;
  `route.push`, `route.sync`, `game.start` and `game.toLineup` go through it. The callback runs
  on the *next frame*, so anything reading the store afterwards awaits the returned promise
  (`start()` does; getting this wrong left the game parked in the lineup phase).
- **The board's travel is the browser's.** `#board-layer` carries `view-transition-name: board`;
  its group animates over `--t-board`. The hand-written FLIP in `BoardLayer` was deleted:
  two animation systems cannot share one element, because a CSS transform on the real DOM is
  invisible under the transition's pseudo-tree. `BoardLayer.park()` only positions now.
- **Panels dock.** `Dock.tsx` gives a panel a unique `view-transition-name` (`view-panel`) and a
  `view-transition-class` of `dock-l/r/t/b`; `index.css` slides old and new snapshots 26px (14px
  for top/bottom) in and out of that edge. The same classes carry `@starting-style` rules, so a
  panel that appears because state changed within a view arrives the same way.
- **Dimming lives on the named element.** An ancestor's opacity is not captured in a snapshot,
  so the lineup's half-strength board is `#board-layer`'s own opacity (`dim` prop), not a wrapper's.
- **Pieces, robber, readings.** `.pc` on every piece lands with a `scale` keyframe (a city's key
  differs from a settlement's so an upgrade re-mounts); the robber is positioned by the
  `translate` property and transitions; `Ring.tsx` places labels by `translate` and transitions
  the arcs' `stroke-dasharray`, and slides a label a few degrees along its arc when a port
  badge is under it.
- **Screenshots and hidden documents skip transitions.** A transition started while the page is
  not rendering rejects `finished` with `InvalidStateError`; the DOM update still lands, and
  `transition()` swallows that rejection.

### The stands

A lineup with nobody in it is a watched game: `store.paused`, `store.pace` (`slow`, `normal`,
`fast` = 1200/350/0ms) and `pump(once)` are the transport; Space and → drive them from
`keys.ts`. `App.tsx` lights legal targets only when `playing(s)`, so a bot's seat never shows
corners to click. The lineup allows two to four seats; `newGame(seed, n)` takes the count and
everything else indexes by seat.

### Analysis

The whole-game curve is drawn in step × percent units with `preserveAspectRatio="none"`, and
pointer x is mapped through `getScreenCTM()`, so the click zone is exactly the curve (before,
the SVG was letterboxed inside a wider element and the scrub used the element's width). The
turning points on its axis are laid out in rows (`Game.tsx` `lanes()`): markers stack when two
steps are adjacent, the six biggest moments get a caption, and a caption that would need a
third row is dropped rather than drawn over another. `review.ts` reads frames without the
engine: `events()` (first cities, sevens, longest road and largest army changing hands,
monopolies, the win), `turns()`, `rowAt()`. Attribution's `seat` is relative to the evaluated
seat (`valuenet.rs`); `coach.groupText` maps it back.

### The polish pass (2026-09-05, later the same day)

- **The frames are the game's own.** `store.frames` holds every position as it is played
  (`game.advance` closes the last frame with its action and appends the new one with its
  evals), so the ending's curve, the stands' seek bar and both analysis views read one array
  the instant they need it. The second worker's `analyze` walk is gone; `review.ts` is now only
  the per-step ladder and attribution, repositioning its engine with `replay` on a record
  re-fetched once per new live step.
- **The header.** `App.tsx`'s `Head`: the screen's title top-left (`‹ Coach`; on the Table the
  turn) and the way back one page. One element on every screen (`view-transition-name: head`),
  so a navigation crossfades its word while the panels dock. On the Table it goes back to the
  lineup, where the game waits behind the panel: "Back to the game — turn N" resumes it
  (`game.resume`) and Deal reads "Deal a new game". The spine keeps the path; its "turn N" door
  shows in every play view.
- **The analysis column.** Seated, the ring and the coach's line are folded against the right
  edge behind one tall press (`.fold`, "open analysis"); `store.analysis` (default off) also
  gates `advise()`, so a person's turn runs no depth-2 search until asked. The ring is above the
  board (`z-index: 1` on `[data-ring]` — the lattice runs past the viewbox and used to cover the
  readings) and arrives with a `@starting-style` scale.
- **The stands' seek bar.** `views/Strip.tsx` (shared with Move analysis) under the board;
  `game.seek()` holds the game and sets `step`, the Table owns `boardOverride` while looking
  back, and the ring, commentary and header read that frame. Play means live. `←`/`→` seek.

### Touch-ups (2026-09-05, evening)

- **Two screens cut.** Console is gone; the Coach screen is gone too — its column (`views/
  Coach.tsx`) docks beside the board on the Table when the analysis is open. Four views remain:
  Table, Every legal move, The whole game, One decision.
- **Zones, not surfaces.** The analysis fold (`.fold`) is bare text at the right edge; hovering
  leans it toward the board. Every sentence that told the reader how to use a control was
  deleted. The ring (`<Ring off>`) is always mounted and draws in/out (`.off` + `@starting-style`
  on the arcs' dasharray).
- **Staged moves.** A board click never plays: `store.staged` holds the move, the board shows it
  as a ghost (`Board` `ghost` prop; hovering a target previews the same way through
  `store.hover`), and a card asks "Play it / Cancel"; Esc lets go. Labelled buttons (Roll, End
  turn, Buy a card, the coach's Play it) play at once. Futures stage the same way.
- **A watched game is a playback.** `game.watch()` streams `live.run()` frames into
  `store.frames`; `show(i)` puts the playhead on a frame (`view`/`evals` are that frame's), a
  timer walks it at `pace`, and the ending is announced only when the playhead reaches the last
  frame of a finished run. `review.record()` builds the record from the frames, so analysis never
  waits on the busy live worker. The seated game still runs `pump()`.
- **Legible change.** Marks (`.mark`) draw under the pieces; a hypothetical's new piece
  (`since` prop → `.pc.new`) lands late and large; a roll rises out of the board's centre as two
  dice and the total (`.roll`); a card count bumps and its change floats off the card
  (`Card` `delta`); the hand carries a development-card row. The futures grid is three columns
  of ~330px boards; the live board parks in the aside as "the board as it stands". The Move
  ladder is one list with the heuristic's rank beside the net's reading (heuristic scores are
  not percentages, so they are never shown as one).
- **Timeline.** The game strip sits above the board in both modes (turn ticks, lettered event
  markers); seated it looks back (`step`), in the stands it is the playhead.

### The apply pin (2026-09-06)

Live games threw `Error: you do not hold what you offer` on repeat and stalled the drive loop.
It never reproduced headlessly — 8/8 generated games completed clean through the same engine —
because the worker's `run` loop never touches `advance()`.

Two obvious explanations are **refuted**; do not re-derive them:

- **Not a double-apply.** `OFFER_TRADE` moves no cards (`apply.rs:33-41` sets
  `is_resolving_trade`, writes `current_trade` and flips the prompt; cards move only in
  `ConfirmTrade`, `apply.rs:75-81`). A second apply hits the *prompt* guard at `apply.rs:22` and
  returns a different string. StrictMode is on, but no `useEffect` anywhere calls
  `act`/`advance`/`pump`/`live.apply`.
- **Not stale `spent_offers`.** That is the next guard, `apply.rs:31`, and its own string.
- **Not the coach or the futures grid.** `search_actions()` strips `OfferTrade` from every root
  (`actions.rs:133-137`) and `decide` returns `root: []` when the trade policy fires
  (`wasm.rs:206`), so neither can emit an offer.

The real defect: **every guard in the app was written against `store.view`, which lags the engine
by a worker round-trip, and nothing re-validated at apply time.** `advance()` set
`status: "applying"` that no play view read (`store.ts:44-47` records dropping that gate on
purpose), and the store `view` is not replaced until the round-trip resolves — so two actions
chosen from one position both passed every check the UI could make.

`OFFER_TRADE` was the canary, not the disease. It is one of the few actions `apply.rs` validates;
its siblings fail *silently* — the builds check nothing and drive a hand negative, `EndTurn` has
no `has_rolled` check, `Roll` re-pays the whole table, and a duplicate `Reject` answers for the
next responder.

**The fix is one line in the worker.** `apply` carries the `steps` it was chosen at and the engine
refuses anything else — `Engine::steps()` was already on the wasm surface (`wasm.rs:117`), so no
Rust change. The rejection reuses `"stale"`, which every caller already swallows. `advance` now
returns whether the action landed, because silence is right for a bot's superseded decision and
wrong for something a person just did: the offer builder stays open on a refusal instead of
closing as though it had gone through, and the discard loop stops instead of discarding blind.
`act` moved its `void pump()` into a `finally` — returning before it is how one rejected click
used to kill the table, since `pump`'s own catch abandons the loop with a bot on move.

**The trigger was probably HMR, and that is fixed separately.** Nothing in `web/src` had an
`import.meta.hot` handler and `EngineClient.terminate()` was defined and never called, so Fast
Refresh re-evaluating `game.ts` left a second client, worker, engine and `pumping` flag driving
one store, with the old loop still mid-`wait(900)`. `game.ts` and `review.ts` now dispose their
workers. Dev-only, which is why it never showed headlessly or under `pnpm preview`.

## Milestones

### M0 — groundwork

| step | check |
| --- | --- |
| amputate: delete `pages/`, `analysis/`, `ui/`, nine deps, the Tailwind classes on `<body>` | `pnpm build` passes, `dist` shrinks, `pnpm ls @zag-js/tabs` finds nothing |
| tokens and the bespoke CSS; Chivo + Syne self-hosted via `@fontsource` (a Google Fonts link is a render-blocking third party on Pages) | no six-digit hex anywhere in `src/**/*.tsx` |
| worker: queue, epoch, `abort`, `record`, the yield | `newGame(1)` then `decide('vnet',2)` back to back resolves instead of throwing; a `run` stops within ~8 steps of `abort()` |
| `store.ts`, `route.ts`, `waiting.ts` | React logs no "getSnapshot should be cached" warning |
| geometry derived from `map.*.nodes`; smoke gains the invariants | `node tools/smoke.mjs` asserts each port's two nodes are 1 unit apart and equidistant from the derived centre, 19 distinct tile centres, and `replay → load_net → evaluate_all().length === 4` |
| `Board.tsx` ported | side by side with the canvas at 574px: tokens, pips, glyphs, nine ports, taper, no outlines |
| spine, `BoardLayer`, the flight, two anchor-only views | `document.querySelector('#board-layer svg')` is the *same node* after Table → Console → Esc, and its rect is 574×548 centred at (658,480) at 1440×900 |

### M1 — the Table, playable

| step | check |
| --- | --- |
| the drive loop in `game.ts`; `busy` splits into `status` and `error` | mash "new game" mid-bot-turn ten times: no "no game", no stuck spinner, no orphaned loop |
| the Table layout — five corner-docked panels at the artboard's own insets, plus the anchor | reads as `ViewTable` at 1440×900; nothing overlaps or clips at 1280×800 and 1920×1080 |
| play by touching the board; the dock; the coach line; the seat rail; the log | a full game to a winner without opening a menu — **and** the dock dims what you cannot pay, the coach line equals `decide('vnet',2)`'s top value, and the fourth seat is `#b9bfb2`, never white |
| keys and Esc | Table → Console → Coach → Esc lands on **Console**; browser back does the same |
| the ending | `grep -rn "New game" src/` returns exactly one file |

No artboard below 1024px exists. M1 shows a plain "this needs a wider window" card rather
than inventing a layout the design has not decided.

### M2 — Console, Coach, Futures

| step | check |
| --- | --- |
| `Engine::preview(action)`, non-mutating | `node tools/smoke.mjs` asserts the live engine is unchanged after a call and the returned view differs |
| Console: seat cards, log, action bar, always-open ranked list | reachable from Table ("The turn, counted"); a full turn's actions appear in the log newest-first; the action bar dims what you cannot pay using the same cost table as Table |
| Coach: templated bubbles from `decide()`/`attribution()`, suggestion chips | the "why" bubble names the attribution group of largest magnitude; "Build it" applies the same action as Table's own buttons; "Show me the others" lands on Futures |
| Futures: six candidates in a 3×2 grid — the persistent board at the top-left cell via `boardOverride`, five plain clones from `preview()` — plus a separate current-position thumbnail | all six candidate boards render genuinely different piece states, the top-ranked one ringed; clicking a card commits its action; clicking the board itself does nothing (`legal` is empty for this view) |
| Esc from all three | Table → Console → Esc, Table → Coach → Esc, Table → Futures → Esc all land on Table |

### M3 — review, on the second worker

| step | check |
| --- | --- |
| `analyze(record)` on a new, lazily-built `review` `EngineClient` — walks the record forward once with plain `apply()`, never `decide()`/`attribution()` per step | `node tools/smoke.mjs` walks a record the same way directly against the wasm module and asserts it reproduces the live game's final view |
| `review.ts`: `ensureReview()` (idempotent per game), `openGameAnalysis()`/`openMoveAnalysis(step?)`, `rankedAt`/`attributionAt` (fetched and cached per viewed step, never precomputed for the whole game), autoplay | opening Game or Move analysis twice in the same game does not re-walk the record; scrubbing back to an already-visited step in Move analysis does not re-search |
| Game analysis: the win-probability curve (one polyline per seat), scrub-by-click, swing markers, attribution bars that light tiles on the board on hover, "where the game turned" | the curve shows four distinct lines; clicking a point moves the board (via `boardOverride`) to that step; hovering an attribution row rings the seat's own producing tiles; a swing entry opens Move analysis at that step |
| Move analysis: the ranked ladder at one step, a value-net/both-at-once tab, the ◇ marker where the heuristic disagrees, steps either side | the ladder matches a fresh `decide('vnet',2)` at that step; the rank-1 row's target is ringed on the board; the step strip jumps correctly |
| Doors in from the spine's turn number, Table's ending, Coach's recommendation percentage, Console's "All N moves" | each reaches the expected view at the expected step; Esc from Move lands back on whichever view (Coach, Console, or Game analysis) opened it, at the step it was opened from |

`boardOverride` (`{ view, highlight?, litTiles? }`), added for Futures' own M2 fix above, turned
out to be exactly the mechanism Game and Move analysis needed too — one channel the persistent
board reads instead of the live view, written by whichever view currently owns it and cleared
on unmount. Attribution's seven groups (`hand`, `production`, `buildings`, `roads`, `pieces`,
`devs`, `score`, plus global `robber`/`bank`) are structural, not per-resource, so "light the
board on hover" maps `production`/`buildings` to the seat's own settled tiles, `roads` to its
road tiles, and `robber` to the robbed tile — the other groups have no board location and
light nothing, which is a correct answer, not a gap.

### M4 — interrupts, handoff, lineup, ending

| step | check |
| --- | --- |
| `Discard.tsx`: pick cards up to the count, "Discard these N" fires them as a batch, "Let the net choose" | discarding leaves the right hand behind and the right seat's turn resumes; the modal renders in front of the board, not behind it |
| Hotseat: `store.pendingHandoff`, `game.ts`'s `pump()` holds there instead of moving `human`, `confirmHandoff()` | a handoff appears only between two different human seats, never for a bot; a single-human game never sets `pendingHandoff` |
| `Handoff.tsx`, and the stage's blur wrapper in `App.tsx` | board and hand are blurred and unclickable until the tap; `keys.ts` ignores every key while it is up |
| Lineup: more than one seat can already be `"human"` | the caption says so; nothing else changed |
| The ending: a mini win-probability curve and "three moments that decided it" from `topSwings`, opening Move analysis | the curve renders once `ensureReview()` resolves; a moment's click lands on the right step |

`waiting()` already reached every view; this milestone made the loud states actionable rather
than just legible — pressing "a seven" in the spine pops back to the Table with the discard
already open. Added no architecture beyond `pendingHandoff` and the boardOverride-adjacent
render-order fix above, which is why it was the one milestone the plan itself flagged as safe
to reorder.

## What gets cut if it runs long, in order

1. **Animation before architecture.** Ship M1 on the reduced-motion path only; the board
   changes size instantly. That path has to exist anyway, and it removes the flight's risk
   from M1 entirely.
2. The `?` door overlay and the 1–4 seat jump — discoverability polish on a UI with seven
   visible doors.
3. The decode reveal. Ornament.
4. The Table's seven-odds panel and the rotated hand fan; a plain resource row says the same.
5. The coach line on the Table — Coach is a whole view, and the line is a preview of it.

Not cuttable at any size: the store, the two-worker split, the epoch guard, and the derived
geometry. Everything after M1 stands on those four, and retrofitting any of them means
touching every file written since.

## Loose ends this inherits

`Results` and `About` are not views around a board; they stay as two plain routes outside the
shell. `Results` imports its 153 KB `benchmark.json` statically today, so a visitor who only
plays still downloads it — that becomes a lazy import. Its headline prose hardcodes "55.2%
against three AlphaBeta" while the table renders live from the JSON; the newer 58.3% is a
different condition (trading AlphaBeta, 300 games), so check `docs/FINDINGS.md` before
touching it.
