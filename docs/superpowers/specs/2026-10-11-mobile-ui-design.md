# Phone UI: design spec (2026-10-11)

A phone layout and play flow for the site, designed from scratch. Below 1000px wide the site
today shows "The board needs a wider window" (`App.tsx:129-138`, `index.css:370`); this spec
replaces that branch with its own component tree on the same engine, store and game loop.

Mockups: `web/design/phone/*.mjs`; `node <file>.mjs` writes pages to `web/design/phone/out/`
(gitignored). The screens referred to below are `play.mjs` (one round), `handoff.mjs`,
`review.mjs` (watching, shared links, game over, review), `more.mjs` (lineup, opening, your
offer, dev cards), `small.mjs` (small phones) and `builds.mjs` (build-card options).

## What the user asked for

Said: a high-quality phone UI, from scratch; gameplay and analysis that feel intuitive, dynamic
and engaging. Analysis woven into play rather than a separate mode. In scope: you against bots,
pass and play, watching bots, opening shared links. Keep the site's look and evolve it. The feel:
a tactile tabletop, a chess app's review, fast and snappy, sound and haptics. During review:
build costs must be legible ("more clear the resources it takes to build"); evaluation must be
switchable off; overlapping elements are fine but must stay visually clear; the gap between the
You row and the hand was too big; pass and play must *replay* the moves since your last turn,
not summarise them.

Assumed (not said): portrait only; one phone, no network play; desktop untouched; tablets
between 700 and 999px wide get the phone layout scaled up, not a third layout.

Success: every phase of a game is playable one-handed on a 390×844 phone and still fits
375×667 and 360×780 with nothing truncated; no screen needs a caption to be understood; a
person can play a full game against bots, pass and play with a friend, watch a bot game, and
open a shared game cold.

## Rules this design holds to

- The five laws (`docs/UI-REWRITE.md` "The laws"): things arrive and leave; one thing moves at a
  time; the furniture fits who is sitting; every sentence cites its evidence and comes from
  `coach.ts`/`labels.ts`; the interface narrates rather than instructs.
- House rules: labels, not captions; no strokes, outlines or halos on pieces; no confirm step
  for placements; legal targets appear only while a piece is in hand and carry information at
  rest (sized by pips), never "light every target"; affordances match behaviour.
- New here:
  - **One footprint.** The block under the hand is the same height in every phase (84 + 10 + 50
    px on a 390×844 phone) and changes job with the phase. The board never moves or resizes
    during a game.
  - **Nothing at rest covers a number or a name.** Moving things (flying cards, tumbling dice)
    may cross anything but never stop on top of it. Lifted cards stay in the hand's own lane;
    the last roll lives in the top bar, not on the board; tags sit on open board beside their
    piece, clear of tokens and ports.
  - **Thumb zone.** Every control is in the bottom block; targets are at least 44px.

## Layout ("around the table")

Top to bottom, in a `100dvh` column with safe-area insets and no page scroll:

1. **Top bar (40px):** back, the phase or round ("Round 9", "Opening", "Orange rolled 7"), the
   last roll as two small dice, the Eval switch.
2. **Opponents (≈64px):** one chip per other seat, clockwise from your left: colour, name, VP,
   card count, dev-card count, win chance and bar. The seat on move lifts (white, shadow); the
   others step back (opacity). A production gain turns the card count green and updates it.
3. **Board:** takes all remaining height, never smaller than its width allows.
4. **Seated block (≈281px):**
   - **You row (24px):** your colour, "You" (or the seat's name in pass and play), VP, win
     chance and bar. It fades out while you hold a build card and returns with the new value.
   - **Hand:** one stack per resource in fixed order (an empty resource keeps its slot as dust),
     stacks drawn at most four deep (5px steps) with the count on the top card; dev cards as a
     fanned pile at the right. Reserved height is the deepest stack only.
   - **Slab (84 + 10 + 50):** the phase's own content; see Phases.

Small phones step down (`small.mjs`): below 700px tall, cards 44×60, build cards 70 tall,
buttons 46, chip padding 6 (375×667 → board 300 wide); below 375px wide, cards 46×63, build
cards 80 (360×780 → board 352). Panels that can grow (move lists, the picker) scroll inside
themselves; nothing truncates.

## Phases

| Phase | Slab | Notes |
|---|---|---|
| Opening (snake draft) | Supply: the one piece you place next, the road after it faint | No build cards, trade or dice. Draft order in the top bar, the current pick larger. Holding the settlement shows every legal corner as a dot sized by pips. |
| Before the roll | One slab: the dice and "Roll" | Knight stays playable from the fan. |
| Roll lands | Build cards rise after production | Dice tumble mid-board, settle into the top bar; then the producing tiles rise with the pieces they feed while the rest of the board sinks; then cards fly to each seat (your hand, opponents' chips). One thing at a time. |
| Main | Build cards + Trade / End turn | Build cards: Road, Settlement, City, Dev card; each shows its piece, name and cost as resource tokens (colour + glyph). A token you hold is solid, one you lack is a dust slot. Unaffordable cards sink. "N left" only when ≤2. |
| Holding a piece | The held card's slot is empty | Pressing a build card lifts the cards it spends into the hand's lane (a faint card per one you lack), the You row yields, the piece floats above the finger, legal spots appear sized by pips, the nearest within reach catches it. Let go on a spot to build, elsewhere to put it all back. |
| Set down | Build cards | The piece lands; every bar moves with the changed stretch faint for a beat; your grade appears beside the piece (Eval on). |
| Robber | Build cards sunk, Trade / End faint | The robber is dragged like a piece. On a tile with two neighbours their pieces rise with hand-size badges; tap one. One neighbour: it steals at once. |
| Discard on a 7 | "Discard" + N slots | Drag or tap cards into the slots; drag one back to undo; the last slot commits. Suggest (Eval on) fills the slots with the engine's pick. |
| Incoming offer | The offer: You get / You give as cards, what accepting does to each side (Eval on); Ignore <seat> / Decline / Counter / Accept (Counter and Ignore kept from the desktop, user 2026-10-12) | The cards it asks for lift in your hand. Counter opens your offer builder on the offer turned round. |
| Your offer | Give / Get: two rows of the five resource tokens with counts | Tapping hand cards gives them (they lift), tapping a resource asks for one. Bank k:1 and port buttons appear only when that exact maritime trade is legal (`bankFor`). Answers hang under each chip as they arrive; tap an accepting seat to trade; Withdraw. |
| Dev cards | Knight: dragged out of the fan, it becomes the robber. Year of Plenty / Monopoly: the card takes the slab with the five resources as the choice. | Tap works for cards with no target. |
| Another seat's turn | The move list: newest on top, each row seat, piece, what, and that seat's swing (Eval on) | The acting chip lifts; each row lands as its piece lands. Tap the board to hurry the bots. |
| Game over | The result: winner, your place, the game's curve with your line bold, final VP (VP cards face up); Rematch / Review | Built (M3) with Lineup in Review's place until Milestone 6; the curve shows with Eval off too. |

## Pass and play

The table re-seats for whoever holds the phone: they sit at the bottom, the others clockwise.
The board does not rotate. The seated row carries the seat's name, not "You".

- **The cover.** When a person's turn passes to anyone else and another person is next to act,
  the next person's colour drops over the seated block at once, before the phone leaves the
  hands of the person who just played. The cover holds their name, a per-move strip (one
  segment per move, like a stories bar), the moves since they last held the phone, ↺ and
  "Show hand".
- **The replay.** Under the cover the board replays every move since that person last acted,
  about a second a move, through the same decoration as live play (dice, production flights,
  pieces landing, bars moving). The row playing is lit. Bots keep playing while the phone is
  passed (`pump` only stops at a person), so their moves join the replay as they happen. ↺
  replays from the start; tapping a row jumps to just before that move; "Show hand" ends the
  replay at the present and lifts the cover.
- **Mid-turn answers.** A discard, an offer or a steal that needs another person passes the
  phone for just that answer, under a cover saying why ("Discard 5", the roll), with nothing to
  replay; then a cover in the turn player's colour hands it back.
- **Built (M4).** The cover rows are 44px buttons that scroll inside the cover, not 32px rows. The replay steps
  from listed move to listed move. With two people, the first person to act also gets a cover at the game's start.
- **Public only.** The replay never shows what the incoming person couldn't have seen: steals
  between two other seats fly face down, dev-card buys stay face down, `revealAll` is never
  used.

## Watching bots and shared links

- **Watching** (no person seated): no hand, so the seats move to the bottom as a standings list
  (colour, name, bot kind, win chance, VP). Above it: the newest move, the curve, and a transport
  (step back, play/pause, step forward, speed or "Live"). The curve is the scrubber: drag to seek
  (`game.seek`); after the playhead it is faint.
- **A shared link, cold:** the result first ("Red won", the round), the curve, the final
  standings with the lineup, then Watch (from the start) and Review. A link to one move opens
  the review at that move. Unfinished games open in Watch at the end.
- **Built (M5).**
  - The cold open keeps the top bar rather than the mockup's wordmark row, so its footprint is the same as watching.
  - Lineup stands in Review's place until Milestone 6.
  - Every result has Share. It puts the link in the address bar, then opens the share sheet or copies it.
  - The pace reads Slow, Normal or Fast; the paces aren't multiples of each other.
  - The lettered pucks on the curve and links to one move come with the review (Milestone 6).

## Analysis woven into play

**Readings.** Each seat's win chance (bars, percentages), each move's swing, an offer's effect
on both sides, Suggest on a discard, and your grades.

**The Eval switch** (top bar; default on, remembered per viewer in `localStorage`) hides every
reading during play. It is not `store.analysis`: `evaluateAll` still runs and fills `frames`,
so the post-game curve and review are complete with Eval off. With Eval off: chips show seat,
VP, cards and dev cards; the move list has no swings; the offer has no effect line; there is no
Suggest; grades are not computed. While watching with Eval off, the curve draws each seat's VP
instead of its chance.

**Hidden information.** `evaluate(seat)` encodes the state from that seat's perspective,
including its own hand, dev cards and actual VP (`encode.rs:122-133`), so shown to anyone else
an opponent's bar moves when they draw a VP card. The desktop ring has the same property today.
Decided (2026-10-12): readings are computed from public information by default, on phone and
desktop. The viewer's own chance is already public-correct; every other seat's chance is the
average over K deals of the hidden cards consistent with what the viewer can know (the
`jsettler/view.rs` hand views replayed from `State.events`; unseen dev cards dealt from the
unplayed deck). The viewer is the one seated person; when watching, or when two people share
the phone, a spectator who sees no private cards, so neither person's hand colours the other's
readings. A
**Hidden information** switch shows today's full-information readings instead. On the phone it
sits with Eval: the top bar's Eval control opens a small popover with two switches, Eval and
Hidden information. On desktop it sits at the right end of the spine, the one permanent line of chrome. In pass and play the Hidden
switch is unavailable during play (it would show one person the other's hand) and available in
the review. `frames` keep both readings so the switch is instant in the review. Built on desktop 2026-10-12: K=16 deals, 0.62 ms a
position in wasm; the public reading costs +0.0006 Brier against the eventual winner (not
significant) and an opponent's VP draw no longer moves its bar (`docs/FINDINGS.md`, 2026-10-12).
"What the net is leaning on" (`attribution`) reads the mover's own hand too, so for anyone
else's move it shows only with the switch on.

**Grades.** A grade judges the choice, not the outcome. It is the margin between the best move's
value and the played move's value in the ranked root from `rankedAt(step, "vnet")` (the
`review` worker: `replay` then `decide(full)`), computed after the move and off the game loop.
It is shown beside the piece if it is ready before the next move lands, and otherwise dropped
from the live board (kept for the review). Swings stay a separate reading: a swing is what
happened, a grade is how good the choice was (`deciding.ts` makes the same distinction).
The words (Best, Good, Inaccuracy, Mistake, Blunder) and their thresholds are not fixed here:
they are measured first over a few hundred games' worth of margins, the way `FLOOR` was, and
recorded in `docs/FINDINGS.md`. The search sees the full state, so a grade can reward a move
whose merit depended on hidden cards; the review says what was best, not what was knowable.

**The review.** A smaller board on top; the curve with your line bold, the decisive moves as
lettered pucks (`deciding()`), the winning move as W, and the point of no return as a dashed
line (`pointOfNoReturn`); your grades counted; the decisive moves as rows, each a tap from the
board at that moment. **At a graded move:** the played move lifted on the board, the best move
as a faint piece tagged "Best", rows for both with the margin, one coach line under them
(`gap()`/`evidence()` from `coach.ts`, the only sentence on the phone), step controls and
"Next key move".

## Sound and haptics

- **Sound:** Web Audio, synthesised (no assets, no dependency), unlocked on the first tap. Each
  cue answers one event: dice rattle then a landing knock; a card flick per card arriving in
  your hand, pitched by resource and capped so a big production is a run, not a roar; a set-down
  thunk (road lighter than city); a snap tick; the robber's thud; an offer arriving (two soft
  notes), accepted (rising pair), refused (falling pair); your turn (a knock); a win (a short
  rising run), a loss (one low note). Bot turns play the set-down only, quieter.
- **Haptics:** `navigator.vibrate` where it exists (Android Chrome); iOS Safari has none, so
  nothing depends on it. Snap 8ms, set down 18ms, dice land [12, 40, 12], robber 35ms, your
  turn [10, 60, 10], offer 15ms.
- The Sound and Haptics switches live on the lineup screen. Reduced motion removes flights and
  tumbles; sounds and haptics stay.

## Lineup

The wordmark; the board, with "New board" (built in the bottom row beside Play: the board takes no pointer); one row per seat (colour bar, occupant, its
`BOT_INFO` sub), each opening a picker sheet that lists every occupant with its sub and measured
win rate against three stock jSettlers (the bot cards' `measured` figures); the Eval switch;
Play. Pass and play is implied by a second person seat. With no person seated, Play becomes
Watch.

## Architecture

- **Mount point.** A `phone/` component tree mounted where `App.tsx` renders the narrow branch,
  chosen by viewport width (< 1000px). Desktop is untouched.
- **Shared:** the store, `game.ts` (pump, beats, watch, seek, handoff), both engine clients and
  workers, `review.ts`, `deciding.ts`, `coach.ts`, `labels.ts`, `waiting.ts`, `board/Board.tsx`,
  `board/Carry.tsx`, `views/Fx.tsx`, `Opening.draft`, `canOffer`/`bankFor`, the Tray's dev-card
  logic. The phone tree replaces only layout and input.
- **Gaps to close for touch:**
  - `.carry` needs `touch-action: none` (only `.bcard` has it).
  - `SNAP` is in board units; on a phone the snap radius must be in screen pixels, the held
    piece floats offset above the finger, and a near miss keeps the piece in hand.
  - `BoardLayer` needs a phone `[data-anchor]`.
  - `Fx` flight endpoints need the phone's `[data-seat]`/`[data-res]` targets (chips, hand,
    cover).
- **New state:** `evalShown`, `showHidden`, `sound`, `haptics` (per viewer, `localStorage`); the cover's
  replay position (a playhead over `frames`, through the existing look-back `step`).
- **New modules:** `phone/` views (Shell, Chips, Hand, Slab and its modes, Cover, Standings,
  Curve, Review, Lineup); `grade.ts` (margin → grade, thresholds from the measurement);
  `sfx.ts` (synth and vibrate). The slab's mode is a pure function of (phase, prompt, seat,
  holding) so it can be checked without a browser.
- **Checks** (house rule: one `assert`-based check per non-trivial module): slab mode per phase;
  the pass-and-play replay range (frames since a seat last acted); `grade.ts` bins. `tsc -b`,
  `tools/smoke.mjs` and `pnpm build` stay green.

## Milestones (each ships on its own)

1. **Shell and your turn:** layout, chips, hand, build cards with costs, Roll, production
   flights, Carry on touch, set down; Eval and Hidden information switches on public-information
   readings.
2. **Everything else in a turn:** robber and victims, discard, incoming offers, your offer with
   bank and ports, dev cards, bot turns' move list.
3. **Opening and lineup**, game over, Rematch.
4. **Pass and play:** cover, replay, mid-turn answers, re-seating.
5. **Watching and shared links:** standings, curve scrubber, transport, cold open.
6. **Grades and the review:** the margin measurement and thresholds first, then grades live and
   the review screens.
7. **Sound and haptics.**

Each milestone is verified in Chrome at 390×844, 375×667 and 360×780 (device emulation) by
playing the phases it adds, plus a check on a real phone by the user.

## What this supersedes

`docs/UI-REWRITE.md` "Phones (2026-09-09)" (four tabs, staging) and the artboards in
`web/design/mobile.mjs` predate the play-feel pass and are replaced by this spec. Once it is
approved, that section gets a pointer here and the old artboards are marked superseded.

## Open questions

- Discard commits on the last slot with no confirm, in line with placements. If that proves too
  final, it is the one place a confirm would go.
- "Play from here" (take a seat in a watched or shared game at the playhead) is out of scope.
- Shared links (measured 2026-10-12, `web/tools/record_size.mjs`, 52 bot games): a record is
  the seed plus every action and its random outcome; the seed alone does not reproduce the
  outcomes. Games run 414-429 steps at the median (max 715). The record's JSON is 14-25 KB;
  deflated and base64url-encoded it is 1.3-2.0 KB, which fits in a `#` fragment (never sent to
  the server). A compact form (each action as its index in that step's legal list, one byte per
  dice roll, steal, draw or discard) is 525-860 bytes, 380-600 characters as a link. Links
  use the compact form (decided 2026-10-12). Format, version 1, then deflate-raw and base64url
  into `#/r/<code>`:
  - header: a version byte, varint seed, seat count; then optional sections, each a tag byte,
    a varint length and its payload, ended by tag 0. A decoder skips tags it does not know, so
    sections can be added without a version bump. Defined now, both optional:
    - **seats** (tag 1): per seat, its occupant (a `BotKind` id, person included), its search
      depth, and a short settings string for bot parameters (empty for none);
    - **models** (tag 2): a table of model ids (e.g. `v89w`) and, per seat, an index into it
      (0 = the site's default for that bot).
    Without them the game still replays; the seats show as unnamed and model-dependent readings
    use the site's defaults;
  - per step: varint index of the action in that step's `legal_actions()` order, then one byte
    for a random outcome where the action has one (dice as (d1−1)·6 + (d2−1); robber steal,
    dev-card draw and discard as the type + 1, 0 for none). The plan confirms the full set of
    actions that carry outcomes from `apply.rs`.
  - Encoder and decoder live in Rust beside `record()`/`replay()` (wasm exports
    `record_compact()` → bytes and `Engine::replay_compact(bytes, steps)`), decoding in one pass
    with `state.apply(action, Some(outcome))`; the browser only deflates and base64url-encodes
    (`CompressionStream`). The legal-action order is part of the format, so a change to it bumps
    the version byte. One Rust test round-trips games through it against `record()`.
  - A person who trades a lot makes longer games than these bots; unmeasured.
  - Built (M5, `catan_engine/src/compact.rs`, `web/src/share.ts`):
    - A discard carries no outcome byte, since its resource is in the action. A robber move always carries one,
      0 for no steal.
    - An offer outside the legal list (a person's 3-for-1) is written as the list's length followed by its 10 counts.
    - The wasm exports are `record_to_compact`, `compact_to_record` (the same JSON as `record()`) and
      `Engine::apply_with`, rather than `replay_compact`: every consumer takes the JSON record.
