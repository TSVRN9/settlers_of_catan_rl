# Phone UI, Milestone 2: everything else in a turn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every phase of a turn gets its own phone design, so the fallback list of legal actions is reached in
normal play by nothing:
- the robber and whom to rob;
- the discard on a 7;
- an incoming offer, including a bot's counter;
- your own offer, with the bank and ports and the answers coming back;
- development cards;
- a bot turn's move list, with a tap on the board to hurry the bots.

**Architecture:**
- The slab's mode stays a pure function (`phone/slab.ts`), with new modes: `discard`, `offer-in`,
  `offer-out`, `builder`, `devs` and `pick`.
- Selection state that both the hand and the slab read lives in the store:
  - `offerDraft` (give and want) and `discardPick` (the resources in the slots), so a tap on a hand card feeds
    the slab and the slab's choice lifts cards in the hand;
  - `devSheet` (the pile spread, or a Year of Plenty / Monopoly pick), cleared by `advance` like `pending`.
- Logic shared with the desktop moves into pure, checked functions:
  - `devpick.ts`, the Year of Plenty / Monopoly choice;
  - `game.discardAll`, the one-card-at-a-time discard loop.
- Two read-only wasm exports supply the analysis:
  - `accepted_readings`: what accepting an offer does to every seat;
  - `suggest_discards`: the engine's whole discard, without applying it.

**Tech Stack:** React 19, Vite, TypeScript, plain CSS (`phone/phone.css`), Rust → wasm (wasm-pack). pnpm, uv.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`. This plan covers:
- the "Phases" rows: Robber, Discard on a 7, Incoming offer, Your offer, Dev cards, Another seat's turn;
- "Analysis woven into play": an offer's effect, Suggest;
- "Milestones" item 2.

Mockups: `web/design/phone/off.mjs` (bot turn, offer, discard, steal) and `more.mjs` (your offer, answers,
Knight, Year of Plenty). Milestone 1's plan (`2026-10-12-phone-m1-shell.md`) is what this builds on.

## Global Constraints

- **Desktop (≥ 1000px) must not change.** Shared files change additively; the desktop's Year of Plenty /
  Monopoly picker and discard loop move into shared functions with identical behaviour.
- **Commits.** Commit after each task (the user, 2026-10-12: "commit on will"). No attribution lines. No new
  dependencies.
- **House rules:**
  - UI copy labels, never narrates or captions.
  - No strokes, outlines or halos on pieces.
  - No placement confirm.
  - Sockets only while a piece is in hand.
- **One footprint.** The slab is `tileH + 10 + btnH` tall in every mode; the board never resizes. Nothing at
  rest covers a number or a name.
- **Thumb zone.** Every control sits in the bottom block. Tap targets are ≥ 44px; `phone_check`'s `small` list
  must stay empty.
- **Eval off** hides every reading: the offer's effect, Suggest, swings.
- **Readings respect "Hidden information"** (`showHidden`): `pub` by default, `full` with the switch.
- **Sentences** come only from `coach.ts` / `labels.ts`.
- **Self-checks.** Non-trivial logic leaves one assert-based self-check, runnable as
  `node --experimental-strip-types <file>`.
- **Don't reload the page mid-run.** Never run `pnpm build`, `tsc -b` or edit a non-component module while
  `phone_check` runs: Vite reloads the page.
- **Verification each task:** `cd web && pnpm exec tsc -b`. Engine tasks also run `cargo test` and
  `node tools/smoke.mjs`.

## Review Focus

1. **A selection outliving its moment.** For example, Trade is open and a bank trade lands, or a discard pick is
   half made and the commit loop is running. Expected: the builder closes on any landed action. Discard taps
   are refused once the slots are full or while the loop runs. A hand card never lifts for a phase that's
   over. Pinned in Task 3's store self-check, `drafts.ts`.
2. **A bot counter-offer to you, mid-offer.** `DECIDE_TRADE` with you as the turn player: accepting executes at
   once. Expected: it shows as an incoming offer, and Accept trades. Pinned in Task 2's `slab.ts` check.
3. **Offer answered by nobody.** The engine resets to `PLAY_TURN` by itself, and `CANCEL_TRADE` is never legal.
   Expected: the slab returns to building, with no Withdraw button stranded. Pinned in `slab.ts`: `offer-out`
   only while `is_resolving_trade`.
4. **The dev pile with one card bought this turn.** It isn't playable. Expected: the sheet shows it sunk, not
   pressable, and nothing errors. Pinned in Task 7's `phone_check` probe (it records each card's `disabled`).
5. **A probe that never ran.** Stochastic games skip phases (M1's `nearMiss` came back `null`). Expected: the
   check fails when any probe is unexercised. Pinned in Task 9: `phone_check` exits non-zero and lists the
   missing probes.

---

### Task 1: Engine — what accepting does, and the engine's whole discard

**Files:**
- Modify: `catan_engine/src/apply.rs`: new `State::accepted`, plus a test in its `tests` module.
- Modify: `catan_engine/src/wasm.rs`: the `accepted_readings` and `suggest_discards` exports.
- Modify: `web/src/worker.ts`, `web/src/engine.ts`: ops `acceptedReadings`, `suggestDiscards`.
- Modify: `web/tools/smoke.mjs`: two assertions.

**Interfaces:**
- Produces:
  - `EngineClient.acceptedReadings(viewer: number): Promise<Readings>`
  - `EngineClient.suggestDiscards(bot: BotKind, depth: number): Promise<Canon[]>`

- [ ] **Step 1: Write the failing Rust test** (append inside `mod tests` in `apply.rs`)

```rust
    /// `accepted` is the position after the seat on move takes the offer in front of it: the cards change
    /// hands exactly as `current_trade` says, the trade is logged (so public readings stay consistent),
    /// and the live state is untouched.
    #[test]
    fn accepted_swaps_the_offer() {
        let layout: Layout = serde_json::from_str(include_str!("base_layout.json")).unwrap();
        let mut found = 0;
        for seed in 0..40u64 {
            let map = Arc::new(Map::generate(seed, &layout));
            let mut s = State::new(map, 4, seed, 10);
            let mut steps = 0;
            while s.winner() < 0 && steps < 3000 {
                if s.prompt == Prompt::DecideTrade && s.can_accept_offer(s.current_player) {
                    let me = s.current_player;
                    let them = s.current_trade[10] as usize;
                    let before = s.clone();
                    let after = s.accepted().unwrap();
                    assert_eq!(s.players[me].hand, before.players[me].hand, "live state untouched");
                    for r in 0..5 {
                        let (give, get) = (s.current_trade[r], s.current_trade[5 + r]);
                        assert_eq!(after.players[me].hand[r], s.players[me].hand[r] + give - get);
                        assert_eq!(after.players[them].hand[r], s.players[them].hand[r] + get - give);
                    }
                    assert!(!after.is_resolving_trade && after.prompt == Prompt::PlayTurn);
                    assert!(after.events.len() > s.events.len(), "the trade is logged");
                    found += 1;
                }
                let a = s.trade_action(&Eval::Heuristic).or_else(|| s.decide_heuristic(1)).unwrap_or(s.playable_actions()[0]);
                s.apply(a, None).unwrap();
                steps += 1;
            }
            if found >= 5 { break; }
        }
        assert!(found >= 5, "only {found} acceptable offers seen");
    }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd catan_engine && cargo test --no-default-features --features wasm accepted_swaps_the_offer`
Expected: compile error, `no method named accepted`.

- [ ] **Step 3: Implement `State::accepted`** (in `impl State` in `apply.rs`, after `apply`)

```rust
    /// The position after the seat on move accepts the offer in front of it, played through the engine's own
    /// rules: the accept, the other seats declining, and the offerer confirming with this seat. A counter to the
    /// turn player trades on the accept itself. For "what accepting does" (wasm `accepted_readings`).
    pub fn accepted(&self) -> Result<State, String> {
        if self.prompt != Prompt::DecideTrade { return Err("no offer to answer".into()); }
        let me = self.current_player;
        let mut s = self.clone();
        s.apply(Action::AcceptTrade, None)?;
        while s.prompt == Prompt::DecideTrade { s.apply(Action::RejectTrade, None)?; }
        if s.prompt == Prompt::DecideAcceptees { s.apply(Action::ConfirmTrade { partner: me as u8 }, None)?; }
        Ok(s)
    }
```

Check `ConfirmTrade`'s field type against `actions.rs` and match it (`partner: me as u8` or `as usize`).
`State::new`'s argument list and `can_accept_offer` visibility are as in the existing test. Make
`can_accept_offer` `pub(crate)` if it's private.

- [ ] **Step 4: Run the test**

Run: `cd catan_engine && cargo test --no-default-features --features wasm accepted_swaps_the_offer`
Expected: `test ... ok`.

- [ ] **Step 5: The wasm exports** (in `wasm.rs`'s `#[wasm_bindgen] impl Engine`, next to `evaluate_all_public`)

```rust
    /// Both readings of the position after the seat on move accepts the offer in front of it
    /// (`State::accepted`): {pub, full}, `pub` from `viewer`'s public information as `evaluate_all_public`.
    pub fn accepted_readings(&self, viewer: i32, k: u32) -> Result<String, JsValue> {
        let net = self.net.as_ref().ok_or_else(|| err("load_net() first"))?;
        let s = self.state.accepted().map_err(err)?;
        let v = if viewer < 0 { None } else { Some(viewer as usize) };
        let (pubr, _) = s.public_evals(net, &layout(), v, k as usize, self.seed as u64 ^ 0x9B1C_5EA7_0000_0001);
        let full: Vec<Value> = (0..self.n).map(|p| reading_json(s.reading(net, &layout(), p))).collect();
        Ok(json!({"pub": pubr.into_iter().map(reading_json).collect::<Vec<_>>(), "full": full}).to_string())
    }

    /// The whole discard `bot` would make for the seat on move, one card per action, without applying it.
    pub fn suggest_discards(&mut self, bot: &str, depth: u32) -> Result<String, JsValue> {
        let seat = self.state.current_player;
        let mut shadow = Engine { state: self.state.clone(), seed: self.seed, n: self.n, log: vec![], net: self.net.clone(),
                                  bot_rng: self.bot_rng, drrl: vec![], jsettlers: vec![] };
        let mut out = vec![];
        while shadow.state.prompt == Prompt::Discard && shadow.state.current_player == seat && out.len() < 20 {
            let d: Value = serde_json::from_str(&shadow.decide(bot, depth)?).map_err(err)?;
            let a = d["action"].clone();
            shadow.apply(&a.to_string())?;
            out.push(a);
        }
        Ok(Value::Array(out).to_string())
    }
```

Match the real names when writing it:
- `Prompt::Discard`: grep `enum Prompt`.
- `self.apply(&str)`'s signature: it returns the outcome JSON.
- `preview`'s shadow-construction fields: copy that literal.

- [ ] **Step 6: Worker and client**

`web/src/engine.ts`:
- Add `| { op: "acceptedReadings"; viewer: number } | { op: "suggestDiscards"; bot: BotKind; depth: number }` to
  `Request`.
- Add to `EngineClient`:

```ts
  /** Both readings after the seat on move accepts the offer in front of it (wasm `accepted_readings`). */
  acceptedReadings(viewer: number) { return this.call<Readings>({ op: "acceptedReadings", viewer }); }
  /** The bot's whole discard for the seat on move, not applied. */
  suggestDiscards(bot: BotKind, depth: number) { return this.call<Canon[]>({ op: "suggestDiscards", bot, depth }); }
```

`web/src/worker.ts`, in `handle`:

```ts
    case "acceptedReadings":
      return JSON.parse(need().accepted_readings(req.viewer, PUBLIC_K)) as Readings;
    case "suggestDiscards":
      return JSON.parse(need().suggest_discards(req.bot, req.depth)) as Canon[];
```

- [ ] **Step 7: Smoke assertions, written before the build** (`web/tools/smoke.mjs`, inside the game loop, which
  already plays a full game. Add these where the loop has the engine `eng` at each step, before its apply.)

```js
  if (v.prompt === "DECIDE_TRADE" && !sawAccept) {
    const me = v.current_player, them = v.current_trade[10];
    const hand = v.players[me].hand;
    if ([5, 6, 7, 8, 9].every((i, r) => hand[r] >= v.current_trade[i])) {
      const r = JSON.parse(eng.accepted_readings(me, 4));
      assert.equal(r.pub.length, 4); assert.equal(r.full.length, 4);
      assert.equal(eng.view(), JSON.stringify(v) === eng.view() ? eng.view() : eng.view(), "live engine untouched");
      sawAccept = true;
    }
  }
  if (v.prompt === "DISCARD" && !sawDiscard) {
    const before = eng.view();
    const picks = JSON.parse(eng.suggest_discards("vnet", 1));
    assert.equal(picks.length, v.discard_counts[v.current_player], "one pick per card owed");
    assert.ok(picks.every((a) => a[0] === "DISCARD_RESOURCE"));
    assert.equal(eng.view(), before, "suggest_discards must not touch the live engine");
    sawDiscard = true;
  }
```

Replace the placeholder "live engine untouched" line with `const before = eng.view();` before the call and
`assert.equal(eng.view(), before)` after, as in the discard block. After the loop:
`assert.ok(sawDiscard, "the smoke game had a discard")`. If the smoke game has no `DECIDE_TRADE` with an
affordable answer, `sawAccept` is reported in the `smoke ok` line, not asserted; the Rust test owns
correctness.

Read `smoke.mjs`'s loop first and use its variable names. Check the prompt names with
`grep -n '"DISCARD\|DECIDE_TRADE' catan_engine/src/wasm.rs`.

- [ ] **Step 8: Build and run**

Run:
```
cd catan_engine && cargo test --no-default-features --features wasm
cd ../web && pnpm build > /tmp/b.log 2>&1; tail -3 /tmp/b.log && node tools/smoke.mjs && pnpm exec tsc -b
```
Expected: all Rust tests pass, the build succeeds, the smoke line prints `ok`, and tsc is clean.

- [ ] **Step 9: Commit**

```bash
git add catan_engine/src/apply.rs catan_engine/src/wasm.rs web/src/worker.ts web/src/engine.ts web/tools/smoke.mjs web/src/engine
git commit -m "Engine: readings after accepting an offer, and the engine's whole discard (read-only wasm exports)"
```

(`web/src/engine/` is the wasm-pack output. Commit it only if it's tracked: `git ls-files web/src/engine | head -1`.)

---

### Task 2: What the slab shows — new modes, the dev pick, and the discard loop

**Files:**
- Modify: `web/src/phone/slab.ts`: new modes and inputs, and its self-check.
- Create: `web/src/devpick.ts`, the Year of Plenty / Monopoly choice with a self-check.
- Modify: `web/src/views/Tray.tsx`: `Devs` uses `devpick.ts`, with identical behaviour.
- Modify: `web/src/game.ts`: `discardAll(counts)`. Modify `web/src/views/Discard.tsx` to call it.

**Interfaces:**
- Produces:
  - `type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over" | "discard" | "offer-in" | "offer-out" | "builder" | "devs" | "pick"`
  - `SlabInput` gains `offerOut: boolean`, `builder: boolean`, `sheet: "devs" | "pick" | null`
  - `devChoices(dev: 1 | 2, first: number | null, legal: Canon[]): number[]`
  - `devStep(dev: 1 | 2, first: number | null, r: number, legal: Canon[]): { first: number } | { action: Canon }`
  - `discardAll(counts: number[]): Promise<boolean>`

- [ ] **Step 1: Failing checks.** Replace the two "falls back" asserts in `slab.ts` and add:

```ts
  const none = { offerOut: false, builder: false, sheet: null } as const;
  // (spread `none` into `base`)
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"] }) === "discard", "discard");
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE"] }) === "offer-in", "an offer to you");
  // A bot's counter to your offer comes to you as the turn player: still an offer to answer.
  assert(slabMode({ ...base, prompt: "DECIDE_TRADE", legal: ["ACCEPT_TRADE", "REJECT_TRADE", "OFFER_TRADE"] }) === "offer-in", "a counter");
  // Your offer going round: the bots are on move, but the slab is still yours.
  assert(slabMode({ ...base, mine: false, offerOut: true, prompt: "DECIDE_TRADE" }) === "offer-out", "your offer, bots answering");
  assert(slabMode({ ...base, offerOut: true, prompt: "DECIDE_ACCEPTEES", legal: ["CONFIRM_TRADE", "CANCEL_TRADE"] }) === "offer-out", "answers back");
  assert(slabMode({ ...base, legal: ["END_TURN", "OFFER_TRADE"], builder: true }) === "builder", "the builder");
  assert(slabMode({ ...base, legal: ["END_TURN"], sheet: "devs" }) === "devs", "the dev sheet");
  assert(slabMode({ ...base, legal: ["ROLL", "PLAY_KNIGHT_CARD"], sheet: "devs" }) === "devs", "dev sheet before the roll");
  assert(slabMode({ ...base, legal: ["END_TURN", "PLAY_YEAR_OF_PLENTY"], sheet: "pick" }) === "pick", "a pick");
  // A selection never outlives its phase: the builder or the sheet open when the turn has moved on means nothing.
  assert(slabMode({ ...base, mine: false, builder: true, sheet: "devs" }) === "bots", "stale selections ignored");
  assert(slabMode({ ...base, prompt: "DISCARD", legal: ["DISCARD_RESOURCE"], builder: true }) === "discard", "discard beats a stale builder");
```

`devpick.ts`:

```ts
// Year of Plenty and Monopoly as a choice of resources, read off the card's own legal actions: shared by the
// desktop tray's picker and the phone's pick slab. Free of React; check: node --experimental-strip-types web/src/devpick.ts
import type { Canon } from "./engine";

const KIND = { 1: "PLAY_YEAR_OF_PLENTY", 2: "PLAY_MONOPOLY" } as const;

/** The resources the open card can still take. Year of Plenty lists a pair once, in either order, so the
 *  first pick may be either slot; one-card plays (a bank with one kind left) have a[2] < 0. */
export function devChoices(dev: 1 | 2, first: number | null, legal: Canon[]): number[] {
  const acts = legal.filter((a) => a[0] === KIND[dev]);
  if (dev === 2) return [...new Set(acts.map((a) => a[1]))].sort();
  if (first == null) return [...new Set(acts.flatMap((a) => (a[2] >= 0 ? [a[1], a[2]] : [a[1]])))].sort();
  return [...new Set(acts.filter((a) => (a[1] === first && a[2] >= 0) || a[2] === first).map((a) => (a[1] === first ? a[2] : a[1])))].sort();
}

/** One tap on resource `r`: the action it completes, or the first of Year of Plenty's two picks. */
export function devStep(dev: 1 | 2, first: number | null, r: number, legal: Canon[]): { first: number } | { action: Canon } {
  const acts = legal.filter((a) => a[0] === KIND[dev]);
  if (dev === 2) return { action: acts.find((a) => a[1] === r)! };
  if (first == null) {
    const pair = acts.some((a) => (a[1] === r && a[2] >= 0) || a[2] === r);
    return pair ? { first: r } : { action: acts.find((a) => a[1] === r)! };
  }
  return { action: acts.find((a) => (a[1] === first && a[2] === r) || (a[1] === r && a[2] === first))! };
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("devpick.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`devpick self-check: ${m}`); };
  const yop: Canon[] = [["PLAY_YEAR_OF_PLENTY", 0, 0, -1], ["PLAY_YEAR_OF_PLENTY", 0, 3, -1], ["PLAY_YEAR_OF_PLENTY", 3, 4, -1]];
  assert(JSON.stringify(devChoices(1, null, yop)) === "[0,3,4]", "first pick: every resource in a pair");
  assert(JSON.stringify(devChoices(1, 3, yop)) === "[0,4]", "second pick after wheat: its partners, either order");
  assert("first" in devStep(1, null, 3, yop), "a resource with partners waits for the second");
  assert(JSON.stringify((devStep(1, 3, 0, yop) as { action: Canon }).action) === JSON.stringify(yop[1]), "pair found in either order");
  const one: Canon[] = [["PLAY_YEAR_OF_PLENTY", 2, -1, -1]];
  assert(JSON.stringify((devStep(1, null, 2, one) as { action: Canon }).action) === JSON.stringify(one[0]), "a one-card play commits at once");
  const mono: Canon[] = [0, 1, 2, 3, 4].map((r) => ["MONOPOLY" && "PLAY_MONOPOLY", r, -1, -1] as Canon);
  assert(devChoices(2, null, mono).length === 5 && (devStep(2, null, 4, mono) as { action: Canon }).action[1] === 4, "monopoly");
  console.log("devpick.ts self-check passed");
}
```

(Write the `mono` line plainly as `["PLAY_MONOPOLY", r, -1, -1]`.)

- [ ] **Step 2: Run both and watch them fail**

Run: `cd web && node --experimental-strip-types src/phone/slab.ts; node --experimental-strip-types src/devpick.ts`
Expected: `slab.ts` throws on "discard" (or a TS strip error on the new fields). `devpick.ts` is new, so its RED
is that it doesn't exist yet. Write the check block first with stub functions returning `[]` /
`{ first: -1 }`, and see it throw.

- [ ] **Step 3: Implement `slabMode`**

```ts
export type SlabMode = "opening" | "roll" | "build" | "bots" | "fallback" | "over" | "discard" | "offer-in" | "offer-out" | "builder" | "devs" | "pick";
export interface SlabInput {
  over: boolean; mine: boolean; opening: boolean; prompt: string; legal: string[]; handoff: boolean;
  /** Your own offer is on the table (`is_resolving_trade`, you made it, it's your turn): the slab stays yours while the bots answer. */
  offerOut: boolean;
  /** The offer builder is open (`store.offering`). */
  builder: boolean;
  /** The dev pile is spread (`devs`) or a Year of Plenty / Monopoly is choosing (`pick`) — `store.devSheet`. */
  sheet: "devs" | "pick" | null;
}

export function slabMode(x: SlabInput): SlabMode {
  if (x.over) return "over";
  if (x.handoff) return "bots";
  if (x.offerOut) return "offer-out";
  if (!x.mine) return "bots";
  if (x.opening) return "opening";
  if (x.prompt === "DISCARD") return "discard";
  if (x.prompt === "DECIDE_TRADE") return "offer-in";
  if (x.sheet === "pick" && x.legal.some((k) => k === "PLAY_YEAR_OF_PLENTY" || k === "PLAY_MONOPOLY")) return "pick";
  if (x.sheet === "devs" && x.prompt === "PLAY_TURN") return "devs";
  if (x.builder && x.prompt === "PLAY_TURN" && x.legal.includes("END_TURN")) return "builder";
  if (x.prompt === "PLAY_TURN" && x.legal.includes("ROLL")) return "roll";
  if (x.prompt === "PLAY_TURN" && x.legal.includes("END_TURN")) return "build";
  if (x.prompt === "MOVE_ROBBER") return "build";
  return "fallback";
}
```

`offerOut` is computed in `Slab.tsx` (Task 3) as
`v.is_resolving_trade && v.current_trade[10] === s.human && v.current_turn === s.human`. A counter from a bot sets
`current_trade[10]` to the bot, so a counter is `offer-in`, not `offer-out`.

- [ ] **Step 4: Implement `devpick.ts`** (the code above) **and switch `Tray.tsx`'s `Devs` to it**:

```ts
  const offered = (): number[] => (picking ? devChoices(picking.dev as 1 | 2, picking.first, legal) : []);
  const pick = (r: number) => {
    if (!picking) return;
    const step = devStep(picking.dev as 1 | 2, picking.first, r, legal);
    if ("first" in step) { setPicking({ dev: picking.dev, first: step.first }); return; }
    setPicking(null); void act(step.action);
  };
```

- [ ] **Step 5: `discardAll` in `game.ts`**, moved from `Discard.tsx`:

```ts
/** A discard chosen whole and played one card per action (the engine's `DISCARD_RESOURCE`). One refused
 *  means the rest were chosen against a hand that no longer exists: stop rather than discard blind. */
export async function discardAll(counts: number[]): Promise<boolean> {
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < counts[r]; k++) if (!await act(["DISCARD_RESOURCE", r, -1, -1])) return false;
  return true;
}
```

In `Discard.tsx`, `discard()` becomes: `setBusy(true); const counts = [0,0,0,0,0]; for (const i of selected)
counts[cards[i]]++; await discardAll(counts); setBusy(false);`.

- [ ] **Step 6: Run the checks**

Run: `cd web && node --experimental-strip-types src/phone/slab.ts && node --experimental-strip-types src/devpick.ts && pnpm exec tsc -b`
Expected: both print `self-check passed`. `tsc` will error in `Slab.tsx` on the missing `SlabInput` fields;
pass `offerOut: false, builder: false, sheet: null` there for now. Task 3 wires the real values.

- [ ] **Step 7: Commit**

```bash
git add web/src/phone/slab.ts web/src/devpick.ts web/src/views/Tray.tsx web/src/game.ts web/src/views/Discard.tsx web/src/phone/Slab.tsx
git commit -m "Phone M2: slab modes for the rest of a turn; dev pick and discard loop shared with the desktop"
```

---

### Task 3: Selection state, the hand as a control, hurry, and the probe harness

**Files:**
- Modify: `web/src/store.ts`: `offerDraft`, `discardPick`, `devSheet`, `hurry`.
- Create: `web/src/phone/drafts.ts`: pure lift/tap rules, with a self-check.
- Modify: `web/src/game.ts`:
  - `advance` clears `devSheet`, and clears `offerDraft` with `offering`;
  - `beat` honours `hurry`;
  - `pump` clears `hurry` at a person's decision.
- Modify: `web/src/phone/Hand.tsx`: one lift source; hand stacks tap in builder/discard modes.
- Modify: `web/src/phone/Phone.tsx`: a board tap hurries the bots.
- Modify: `web/src/phone/Slab.tsx`: compute and pass the real `SlabInput`.
- Modify: `web/tools/phone_check.mjs`:
  - a steered policy (hoard to provoke discards, buy dev cards);
  - a probe registry that fails on unexercised probes;
  - board taps to hurry.

**Interfaces:**
- Consumes: `slabMode`, `SlabInput` (Task 2).
- Produces:
  - store: `offerDraft: { give: number[]; want: number[] }`
  - store: `discardPick: number[]` (one resource index per filled slot)
  - store: `devSheet: { dev: 1 | 2 | null; first: number | null } | null` (`dev: null` = the pile spread)
  - store: `hurry: boolean`
  - `drafts.ts`:
    - `lifted(x: LiftInput): number[]`
    - `inSlots(pick: number[]): number[]`
    - `canPick(pick: number[], need: number, hand: number[], r: number): boolean`
  - `phone_check.mjs`:
    - `probe(name, fn)`
    - final `missing` list; exit code 1 if non-empty

- [ ] **Step 1: Failing check** (`web/src/phone/drafts.ts`, check block first, stubs returning `[]` / `false`)

```ts
// What the hand lifts and what a tap on it does, for every phase that reads cards off the hand: a build card
// held (its cost), the offer builder (what you give), an offer to you (what it asks of you), a discard (the
// cards already in the slots leave their stacks). Pure; check: node --experimental-strip-types web/src/phone/drafts.ts
export interface LiftInput { mode: string; cost: number[] | null; give: number[]; asked: number[] | null }

/** Cards to lift out of each stack, per resource. Only the phase's own source counts, so a draft left over
 *  from a phase that's over never lifts anything. */
export function lifted(x: LiftInput): number[] {
  if (x.cost) return x.cost;
  if (x.mode === "builder") return x.give;
  if (x.mode === "offer-in" && x.asked) return x.asked;
  return [0, 0, 0, 0, 0];
}
/** The discard slots as per-resource counts. */
export const inSlots = (pick: number[]) => [0, 1, 2, 3, 4].map((r) => pick.filter((p) => p === r).length);
/** A tap on resource `r` may fill a slot: a slot is free and you still hold one not already in a slot. */
export const canPick = (pick: number[], need: number, hand: number[], r: number) => pick.length < need && inSlots(pick)[r] < hand[r];

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("drafts.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`drafts self-check: ${m}`); };
  const z = [0, 0, 0, 0, 0];
  assert(lifted({ mode: "build", cost: [1, 1, 0, 0, 0], give: [2, 0, 0, 0, 0], asked: null })[0] === 1, "a held build card wins");
  assert(lifted({ mode: "builder", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 2, "builder lifts the give side");
  assert(lifted({ mode: "build", cost: null, give: [2, 0, 0, 0, 0], asked: null })[0] === 0, "a stale draft lifts nothing");
  assert(lifted({ mode: "offer-in", cost: null, give: z, asked: [0, 0, 0, 2, 0] })[3] === 2, "an offer lifts what it asks");
  assert(canPick([], 2, [1, 0, 0, 0, 0], 0) && !canPick([0], 2, [1, 0, 0, 0, 0], 0), "never more than you hold");
  assert(!canPick([0, 1], 2, [3, 3, 0, 0, 0], 0), "full slots take nothing");
  assert(inSlots([3, 0, 3])[3] === 2, "slot counts");
  console.log("drafts.ts self-check passed");
}
```

- [ ] **Step 2: Run it.** `node --experimental-strip-types web/src/phone/drafts.ts`. Expected: throws on
  "a held build card wins".
- [ ] **Step 3: Implement** (the bodies above). **Run.** Expected: `drafts.ts self-check passed`.

- [ ] **Step 4: Store and game.** In `store.ts`, add to `State` with doc comments, and to `initial`:
  - `offerDraft: { give: [0,0,0,0,0], want: [0,0,0,0,0] }`
  - `discardPick: []`
  - `devSheet: null`
  - `hurry: false`

In `game.ts`:
- `advance`'s first `set` adds `devSheet: null`.
- The landed `set` becomes
  `set({ view: res.view, legal: res.legal, last: action, offering: false, offerDraft: { give: [0,0,0,0,0], want: [0,0,0,0,0] } })`.
- `discardPick` is NOT cleared by `advance`; `discardAll`'s caller clears it in a `finally`.
- `deal()` and `toLineup()`'s resets add `offerDraft` / `discardPick: []` / `devSheet: null` / `hurry: false`.
- `beat`:

```ts
  const ms = SEATED_MS[prev] ?? 900;
  // A tap on the board hurries the bots until the seated person is asked something (phone, spec "Another seat's turn").
  if (s.hurry) return Math.min(120, ms);
```

- `pump`, at the human return: `if (seat !== s.human) set({ pendingHandoff: seat }); set({ hurry: false }); return;`

- [ ] **Step 5: Hand.** In `Hand.tsx`:
  - Replace `spending(s)` with `const up = lifted({ mode, cost: spending(s), give: s.offerDraft.give, asked })`.
    - `mode` comes from a `useSlabMode()` hook exported from `Slab.tsx`, which computes the `SlabInput` once for
      both components.
    - `asked = v.prompt === "DECIDE_TRADE" ? v.current_trade.slice(5, 10) : null`.
  - Subtract `inSlots(s.discardPick)` from each stack when `mode === "discard"`.
  - Make each stack a `<button className="ph-stack">` when `mode` is `builder` or `discard`, with `onClick`:
    - **builder:** `give[r] < hand[r] && want[r] === 0` → `give[r]++`. Same rule as desktop `canAdd`.
    - **discard:** `canPick(...)` → push `r`.

  `YouRow`'s fade uses `spending(s)` (held build card only), unchanged. `useSlabMode()` in `Slab.tsx`:

```ts
export function useSlabMode(): SlabMode {
  const s = useApp();
  const v = s.view!;
  const mine = playing(s) && v.current_player === s.human && v.winner < 0 && s.step == null;
  const offerOut = playing(s) && v.is_resolving_trade && v.current_trade[10] === s.human && v.current_turn === s.human && s.step == null;
  return slabMode({ over: v.winner >= 0, mine, opening: v.initial_phase, prompt: v.prompt, legal: s.legal.map((a) => a[0]),
                    handoff: s.pendingHandoff != null, offerOut, builder: s.offering,
                    sheet: s.devSheet == null ? null : s.devSheet.dev == null ? "devs" : "pick" });
}
```

  The `View` type needs `is_resolving_trade` and `current_trade`. Check `engine.ts` `View` and add them if
  missing; `wasm.rs` `view()` already serializes them (`grep is_resolving_trade catan_engine/src/wasm.rs`).

- [ ] **Step 6: Hurry.** In `Phone.tsx`, wrap the board band:
  `<div className="ph-board" onClick={() => { if (!mine && playing(s) && !s.hurry) set({ hurry: true }); }}>`.
  Taps while a piece is held go to Carry's own layer, which stops propagation. Verify in Step 8.

- [ ] **Step 7: Probe harness in `phone_check.mjs`.**
  - Add `const probes = {}; const probe = (name, v) => { probes[name] = v; };` and a list `NEED` of every probe
    name this milestone adds:
    `["discard", "offerIn", "builder", "offerOut", "devSheet", "pick", "robberVictim", "hurry", "moveIcons"]`.
  - At the end: `missing = NEED.filter((k) => probes[k] == null)`. Print `{ ...result, probes, missing }`;
    `process.exitCode = missing.length ? 1 : 0`.
  - **The steered policy** (in the rest-of-game loop, replacing `app.live.decide("heuristic", 1)` for the person):
    - prefer `BUY_DEVELOPMENT_CARD` when legal;
    - never build while holding fewer than 9 cards, so 7s cost a discard: when the heuristic picks a
      `BUILD_*` and the hand has fewer than 9 cards, play `END_TURN` instead if legal;
    - otherwise the heuristic's pick.
  - **Hurry:** on a bot's turn, once per turn, `Input.synthesizeTapGesture` on an empty corner of `.ph-board`
    (top-left 6px inside), then `probe("hurry", app.get().hurry === true)`.
  - **Several games:** wrap the rest-of-game loop in up to 3 games (`app.set` a new seed and call
    `__app.start()`; add `start` to the dev handle in `main.tsx`) until `missing` is empty.

- [ ] **Step 8: Run.** With `pnpm dev` up:
  `node web/tools/phone_check.mjs 390 844 <scratch>` (in the background; read the tail).
  Expected: M1 fields as before (`roll`, `overflowX: 0`, `small: []`), `probes.hurry === true`, and `missing`
  listing the other probes. Those are added by Tasks 4–8; their absence now is the RED.

- [ ] **Step 9: Commit**

```bash
git add web/src/store.ts web/src/game.ts web/src/main.tsx web/src/phone/drafts.ts web/src/phone/Hand.tsx web/src/phone/Phone.tsx web/src/phone/Slab.tsx web/tools/phone_check.mjs
git commit -m "Phone M2: selection state the hand and slab share, tap the board to hurry, probe harness"
```

---

### Task 4: Discard on a 7

**Files:**
- Modify: `web/src/phone/Slab.tsx`: a `Discard` mode component. `web/src/phone/phone.css`.
- Modify: `web/tools/phone_check.mjs`: the `discard` probe.

**Interfaces:**
- Consumes:
  - `discardAll`, `canPick`, `inSlots` (Tasks 2–3);
  - `live.suggestDiscards` (Task 1);
  - store `discardPick`.

Behaviour (spec row "Discard on a 7", mockup `off.mjs` C):
- **The zone:** a pale panel, `tileH` tall, holding "Discard" (the `d` font) and N slots. A filled slot shows the
  resource `Card` at hand size; an empty one is a dust slot.
- **Tapping a hand stack** fills the next slot (Task 3). **Tapping a filled slot** returns it (removes that
  index from `discardPick`).
- **When the last slot fills by tap**, it commits: `discardAll(inSlots(pick))`, then `set({ discardPick: [] })` in
  `finally`. Ruling: the spec's "the last slot commits".
- **The button row (Eval on): Suggest.**
  - It fills every slot with `live.suggestDiscards("vnet", 2)` (the resources, `a[1]`), and doesn't commit.
  - With the slots full, the button reads "Discard" and commits.
  - Ruling: Suggest filling the last slot doesn't commit by itself. The person sees the engine's pick first;
    the spec says Suggest *fills*.
- **Eval off:** no Suggest, and the slots take the whole slab (`tileH + 10 + btnH`).
- **Too many slots:** if N > 5, the slots wrap into two rows of half-height cards. Nothing scrolls sideways.

Mode component:

```tsx
function DiscardSlab({ H }: { H: number }) {
  const s = useApp();
  const v = s.view!;
  const { cw, ch, tileH, btnH } = useMetrics();
  const need = v.discard_counts[s.human];
  const pick = s.discardPick;
  const [busy, setBusy] = useState(false);
  const commit = async (p: number[]) => { setBusy(true); try { await discardAll(inSlots(p)); } finally { set({ discardPick: [] }); setBusy(false); } };
  // The last tap commits (spec "Discard on a 7"); Suggest only fills, so the engine's pick is seen first.
  useEffect(() => { if (pick.length === need && need > 0 && !busy && s.discardBy === "tap") void commit(pick); }, [pick.length]);
  ...
}
```

Instead of a `discardBy` store field, give the tap path its own call: `Hand`'s discard tap calls
`pickDiscard(r)`, exported from `Slab.tsx`. It pushes `r`, and if that filled the last slot it calls
`commit(next)` (module-level `commitDiscard`). No effect needed. Suggest calls `set({ discardPick: picks })` only.

Card size in the slots: `min(cw, (zoneWidth - label) / need - 6)`. For N > 5, use two rows at `ch / 2 + 6`. Use
`Card resource={r} width={w} height={h}`.

- [ ] **Step 1: The probe first** (`phone_check.mjs`, in the loop, before the policy acts):

```js
    if (s.view.prompt === "DISCARD" && s.view.current_player === s.human && probes.discard == null) {
      const need = s.view.discard_counts[s.human];
      const before = s.view.players[s.human].hand.reduce((a, b) => a + b, 0);
      for (let k = 0; k < need; k++) {
        const r = s.view.players[s.human].hand.findIndex((n, i) => n - app.get().discardPick.filter((p) => p === i).length > 0);
        d.querySelector(`.ph-stack[data-res="${r}"]`).click(); await sleep(150);
      }
      for (let k = 0; k < 40 && app.get().view.prompt === "DISCARD" && app.get().view.current_player === s.human; k++) await sleep(100);
      const after = app.get().view.players[s.human].hand.reduce((a, b) => a + b, 0);
      probe("discard", { need, lost: before - after, slab: d.querySelector(".ph-discard") != null });
      continue;
    }
```

Pass condition (checked when printing): `probes.discard.lost === probes.discard.need`. The steered policy makes
discards near-certain within 3 games; if `missing` still lists it, raise the hoard threshold to 10.

- [ ] **Step 2: Run, and see `missing` include `discard`** (or the probe throws on the missing `.ph-stack` button).
- [ ] **Step 3: Implement** `DiscardSlab`, `pickDiscard`, `commitDiscard`, and the CSS:

```css
.ph-discard { background: #e3e7de; display: flex; align-items: center; gap: 6px; padding: 0 12px; flex-wrap: wrap; align-content: center; }
.ph-discard .d { font-size: 19px; margin-right: auto; }
.ph-slot { border: 0; padding: 0; background: var(--color-dust); opacity: .6; min-width: 44px; min-height: 44px; }
.ph-slot.full { background: none; opacity: 1; cursor: pointer; }
```

  In `Slab`'s switch: `case "discard": return <DiscardSlab />;`
- [ ] **Step 4: Run the check.** Expected: `probes.discard` with `lost === need` and `slab: true`.
- [ ] **Step 5: Commit** — `git commit -am "Phone M2: discard on a 7 — tap cards into the slots, Suggest fills them"`

---

### Task 5: An offer to you

**Files:**
- Modify: `web/src/phone/Slab.tsx`: the `OfferIn` mode. `phone.css`.
- Modify: `web/tools/phone_check.mjs`: the `offerIn` probe.

Behaviour (spec row "Incoming offer", mockup `off.mjs` B):
- **The zone** is white, `tileH` tall.
- **"You get"**, with the offerer's cards (`current_trade[0..5]`): the offerer's `give` side is what you get.
- **"You give"**, with `current_trade[5..10]`, as `Card`s at `0.8·cw`.
- **With Eval on, the effect:** two rows, each a seat swatch and `fmtDelta(after - now)`, for you and the
  offerer.
  - `after` comes from `live.acceptedReadings(viewer(s))`, picking `.pub` or `.full` by `s.showHidden`.
  - `now` is `s.evals`.
  - Fetch it in an effect keyed on `current_trade.join(",")`; show nothing until it lands.
- **Buttons:** Decline and Accept (`go`).
- **The cards it asks for** lift in the hand (Task 3, `asked`).
- **The panel is keyed on the trade,** so a haggled re-offer lands as new. Add the `arrive` class.
- Ruling: Counter and "Ignore this seat" are desktop only in M2. The spec's phone table lists Decline / Accept.
  Cost: no counter-offers from a phone.

```tsx
function OfferIn() {
  const s = useApp(); const v = s.view!; const t = v.current_trade; const from = t[10];
  const { cw, ch, btnH } = useMetrics();
  const [after, setAfter] = useState<Evaluation[] | null>(null);
  useEffect(() => {
    if (!s.evalShown) return;
    let live_ = true;
    void live.acceptedReadings(viewer(s)).then((r) => { if (live_) setAfter(s.showHidden ? r.full : r.pub); }).catch(() => {});
    return () => { live_ = false; };
  }, [t.join(","), s.evalShown, s.showHidden]);
  const accept = s.legal.find((a) => a[0] === "ACCEPT_TRADE"), reject = s.legal.find((a) => a[0] === "REJECT_TRADE");
  const cards = (counts: number[]) => counts.flatMap((n, r) => Array.from({ length: n }, (_, k) => <Card key={`${r}${k}`} resource={r} width={Math.round(cw * .8)} height={Math.round(ch * .8)} />));
  const eff = (seat: number) => after && s.evals[seat] ? after[seat].win - s.evals[seat].win : null;
  return (
    <div className="ph-offer-slab">
      <div key={t.join(",")} className="ph-offer cut8 arrive">
        <div className="side"><span className="lab">You get</span><div className="cards">{cards(t.slice(0, 5))}</div></div>
        <div className="side"><span className="lab">You give</span><div className="cards">{cards(t.slice(5, 10))}</div></div>
        {s.evalShown && <div className="eff">{[s.human, from].map((seat) => { const d = eff(seat); return (
          <span key={seat}><i style={{ background: SEAT_FILL[seat] }} />{d == null ? "" : <span className={`num ${d >= 0 ? "up" : "dn"}`}>{fmtDelta(d)}</span>}</span>); })}</div>}
      </div>
      <div className="ph-row" style={{ height: btnH }}>
        <button className="ph-btn cut8" disabled={!reject} onClick={() => reject && void act(reject)}>Decline</button>
        <button className="ph-btn go cut8" disabled={!accept} onClick={() => accept && void act(accept)}>Accept</button>
      </div>
    </div>
  );
}
```

`viewer` is `store.viewer`, already used by `game.ts`. `live` is the game's `EngineClient`, exported from
`game.ts`.

- [ ] **Step 1: The probe** (before the policy acts, whenever the person faces `DECIDE_TRADE`):
  - Read `.ph-offer` (exists) and `.ph-offer .eff span` count (2, with Eval on; wait up to 1.5s).
  - Click Accept if the hand covers the ask, otherwise Decline.
  - `probe("offerIn", { slab, eff, answered: <prompt moved on> })`.
- [ ] **Step 2: Run, see `offerIn` missing or thrown.**
- [ ] **Step 3: Implement** `OfferIn` and the CSS:

```css
.ph-offer-slab { display: flex; flex-direction: column; gap: 10px; }
.ph-offer { flex: 1; min-height: 0; background: #fff; box-shadow: 0 8px 18px rgba(18,33,31,.14); display: flex; align-items: center; gap: 14px; padding: 6px 12px; }
.ph-offer .side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ph-offer .lab { font: 600 11.5px var(--font-sans); color: var(--color-moss); }
.ph-offer .cards { display: flex; gap: 4px; }
.ph-offer .eff { margin-left: auto; display: grid; gap: 6px; }
.ph-offer .eff > span { display: flex; align-items: center; gap: 8px; }
.ph-offer .eff i { width: 9px; height: 9px; }
.ph-offer .up { color: #2e7d4f; font: 700 13px var(--font-sans); } .ph-offer .dn { color: #a5452b; font: 700 13px var(--font-sans); }
```

  Cards overflowing the zone (a 3-for-2): `.cards` overlap with negative margins (`margin-left: -18px` after the
  first card) instead of wrapping.
- [ ] **Step 4: Run the check.** Expected: `probes.offerIn = { slab: true, eff: 2, answered: true }`.
  - If no bot offered to the person in 3 games, `missing` keeps it. Then add to the steered policy: a person who
    holds 5+ of one resource and none of another keeps that hand; bots offer for exactly such surpluses.
  - Report it if it still never happens. Don't fake it: that is a finding about the bots (the offer cap,
    `no-offer-spam`).
- [ ] **Step 5: Commit** — `git commit -am "Phone M2: an offer to you — the cards, what accepting does, Decline / Accept"`

---

### Task 6: Your offer — builder, bank and ports, answers

**Files:**
- Modify: `web/src/phone/Slab.tsx`:
  - the `Builder` and `OfferOut` modes;
  - the build slab's Trade button opens the builder.
- Modify: `web/src/phone/Chips.tsx`: answer badges.
- Modify: `phone.css` and `web/tools/phone_check.mjs` (`builder`, `offerOut` probes).

**Interfaces:**
- Consumes:
  - `canOffer`, `bankFor`, `packBundle` (`labels.ts`);
  - `offerAnswers` (`coach.ts`);
  - store `offerDraft`, `offering`.

Behaviour (spec row "Your offer", mockups `more.mjs` T1/T2):
- **Opening it:** Trade in the build slab is enabled when `OFFER_TRADE` or `MARITIME_TRADE` is legal, and sets
  `offering: true`.
- **The zone:** white, `tileH` tall, with two rows, Give and Get, of five resource tokens. Each token is the
  build card's `Token` look at 30×36, carrying a count badge when non-zero.
  - Hand taps add to Give (Task 3).
  - **Tapping a Give token** takes one back.
  - **Tapping a Get token** cycles 0→1→2→3→0, capped by `CAP` and blocked while that resource is on Give.
  - Ruling: one gesture per token, no ± buttons; the 44px rule leaves no room for separate minus targets.
    Cost: asking for 3 takes three taps, and going back from 3 to 1 takes a wrap.
- **The button row:**
  - **Back:** `offering: false`, draft cleared.
  - **The bank button**, only when the draft is exactly a legal maritime trade. Give is k of one resource
    (k ≥ 2), Get is 1 of one resource, and `bankFor(want, s.legal)` has an action with `a[1] === giveRes &&
    a[2] === k`. It reads "Bank k:1" (k = 4) or "Port k:1".
  - **Offer** (`go`), disabled unless `canOffer(give, want, hand, v.spent_offers) &&` `OFFER_TRADE` is legal.
  - A draft that matches a legal maritime trade at a better rate than given (say, 4 wood with a 2:1 wood port)
    shows the port's rate. The bank's rate is the engine's.
  - Ruling: the bank button appears only for the exact rate held. Cost: you must put down exactly k cards.
- **Answers (`offer-out`):** the zone shows the offer faint (give/get cards). Under each chip hangs an answer
  badge, from `offerAnswers(s.frames, s.frames.length - 1, s.human)`:
  - **Accepts:** green.
  - **No:** dust.
  - **"···":** waiting.

  The badges sit in a strip absolutely positioned under `.ph-chips`, on open board, never over a chip's
  numbers.
- **Trading:**
  - The button row holds one "Trade with <Name>" per accepting seat that has a legal `CONFIRM_TRADE` (thumb
    zone), plus "Withdraw" (`CANCEL_TRADE`, when legal).
  - Tapping an accepting chip confirms too.
  - Ruling: the per-seat buttons satisfy the thumb zone; the spec's chip tap is kept as a second way.
  - Ruling: Withdraw shows only when `CANCEL_TRADE` is legal (`DECIDE_ACCEPTEES`). The engine has no withdraw
    while the bots are still answering.
  - With more than two acceptors, the buttons share the row (`flex: 1`, names shortened to the seat colour
    swatch plus name).

- [ ] **Step 1: Probes.** In the main phase, once per game while `probes.builder == null`:
  1. Click Trade (`.ph-build-slab .ph-btn:not(.go)`).
  2. Click the hand stack with the most cards, once (or twice if the person holds 4+).
  3. Click the Get token of a resource the person holds 0 of.
  4. Record `{ open: .ph-builder exists, lifted: count of .ph-card.lifted, offer: Offer button enabled }`, then
     click Offer.
  5. `probe("builder", …)`.
  6. Then wait (≤ 20s) while `offer-out` shows; record the `.ph-answers .badge` count. At `DECIDE_ACCEPTEES`,
     click the first "Trade with" if any, else Withdraw.
  7. `probe("offerOut", { badges, ended: back to PLAY_TURN, traded })`.
  8. Separately, when a draft of exactly 4 of one resource fits (`hand[r] >= 4`), probe the bank button's
     presence: `probes.builder.bank = true|false`. Not required.
- [ ] **Step 2: Run, see them missing.**
- [ ] **Step 3: Implement** `Builder`, `OfferOut`, the chip badge strip, the Trade-button wiring and the CSS:

```css
.ph-builder { flex: 1; min-height: 0; background: #fff; box-shadow: 0 8px 18px rgba(18,33,31,.14); display: flex; flex-direction: column; justify-content: space-around; padding: 4px 10px; }
.ph-builder .row { display: flex; align-items: center; gap: 8px; }
.ph-builder .lab { font: 600 11.5px var(--font-sans); color: var(--color-moss); width: 34px; }
.ph-tokbtn { position: relative; border: 0; padding: 0; background: none; min-width: 44px; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; }
.ph-tokbtn .n { position: absolute; right: 0; top: -4px; background: var(--color-pine); color: var(--color-chalk); font: 700 10.5px var(--font-sans); padding: 1px 4px; }
.ph-answers { position: absolute; left: var(--gut); right: var(--gut); top: 100%; display: flex; gap: 8px; pointer-events: none; z-index: 4; margin-top: 4px; }
.ph-answers > span { flex: 1; display: flex; justify-content: center; }
.ph-answers .badge { pointer-events: auto; height: 24px; padding: 0 9px; display: inline-flex; align-items: center; font: 700 12px var(--font-sans); }
.ph-answers .yes { background: #2e7d4f; color: #fff; } .ph-answers .no { background: var(--color-dust); color: var(--color-moss); } .ph-answers .wait { background: var(--color-paper); color: var(--color-moss); }
```

  Token rows: 5 tokens × 44px + label 34px + gaps ≈ 290px fits 358px (390 − 2·16). At 360 wide (328px of room),
  set the label width to 30px and the gap to 4px under `(max-width: 374px)`.
- [ ] **Step 4: Run the check.** Expected:
  - `probes.builder = { open: true, lifted: ≥1, offer: true }`;
  - `probes.offerOut = { badges: 3, ended: true }`;
  - `small: []`.
- [ ] **Step 5: Commit** — `git commit -am "Phone M2: your offer — give/get builder, bank and port rates, answers on the chips"`

---

### Task 7: Development cards

**Files:**
- Modify: `web/src/phone/Hand.tsx`: tapping the pile opens the sheet.
- Modify: `web/src/phone/Slab.tsx`: the `DevSheet` and `Pick` modes.
- Modify: `phone.css` and `phone_check.mjs` (`devSheet`, `pick` probes).

**Interfaces:**
- Consumes: `devChoices`, `devStep` (Task 2); store `devSheet`.

Behaviour (spec row "Dev cards", mockup `more.mjs` D1/D2):
- **Tapping the pile** sets `devSheet: { dev: null, first: null }`. It is enabled whenever you hold any dev card on
  your turn, so you can look at your cards. A playable card lifts the pile (as now).
- **The `devs` mode:**
  - The slab shows each held kind as a full-size `Card dev={k} count={n}` (`cw × ch`). Playable ones (a legal
    `PLAY_*`) are raised and pressable; the others are sunk (opacity 0.45) and disabled. VP cards are sunk.
  - **The button row:** Back (`devSheet: null`).
  - **Knight** → `act(PLAY_KNIGHT_CARD)`. The robber is then in hand (Carry, `held` auto); you tap or drag it on the
    board.
  - **Road Building** → `act(PLAY_ROAD_BUILDING)`; the roads are in hand.
  - **Year of Plenty / Monopoly** → `devSheet: { dev, first: null }`.
  - Ruling: the Knight is played by a tap that puts the robber in your hand, not dragged out of the fan. The
    robber exists only after the play's round trip, so a drag would have to survive an async apply. Cost: one
    tap more than the spec's gesture.
  - Ruling: the pile spreads into the slab instead of each fanned card being a target. The 8px fan step is
    under 44px (M1's fix). Cost: one extra tap to play.
- **The `pick` mode:**
  - The card takes the zone: its `Card dev` at 30×42, its name (`DEV_CARDS[dev]`) and, for Year of Plenty, two
    slots (the first fills with the first pick).
  - Under them, the five resources from `devChoices` as `Card`s at `cw`, at least 44 wide.
  - A tap calls `devStep`: `{first}` → `set({ devSheet: { dev, first } })`; `{action}` → `act(action)`
    (`advance` clears the sheet).
  - **Button row:** Back (to the `devs` sheet).

- [ ] **Step 1: Probes.**
  - When the person holds a dev card on their turn after rolling, while `probes.devSheet == null`:
    1. Tap `.ph-devs`.
    2. Record `{ cards: .ph-devsheet .ph-devcard count, playable: count not disabled }`.
    3. If Year of Plenty or Monopoly is playable, tap it and record the `.ph-pick .ph-res` count, then tap
       resources until the prompt moves on: `probe("pick", { choices, played: hand changed })`.
    4. Else, if a Knight is playable, tap it, then `probe("robberVictim", …)` through Task 8's robber probe.
    5. Else tap Back.
  - The steered policy buys dev cards, so a Year of Plenty or Monopoly comes up within 3 games with good odds
    (2 + 2 of 25 cards).
  - If `pick` stays missing, the check may set up a pick for this probe only: a seat holding YoP is not
    constructible from the UI. Instead, accept `pick` exercised by Monopoly or YoP across up to 5 games, and
    raise the game cap for this probe.
- [ ] **Step 2: Run, see them missing.**
- [ ] **Step 3: Implement** `DevSheet`, `Pick`, the pile's `onClick`, and the CSS:

```css
.ph-devsheet { display: flex; align-items: flex-end; justify-content: center; gap: 8px; }
.ph-devcard { border: 0; padding: 0; background: none; transition: translate var(--t-feel) var(--ease), opacity var(--t-feel) var(--ease); }
.ph-devcard:not(:disabled) { translate: 0 -8px; cursor: pointer; }
.ph-devcard:disabled { opacity: .45; }
.ph-pick { flex: 1; min-height: 0; background: #fff; box-shadow: 0 8px 18px rgba(18,33,31,.14); display: flex; flex-direction: column; gap: 8px; padding: 8px 12px; }
.ph-pick .head { display: flex; align-items: center; gap: 10px; }
.ph-pick .res { display: flex; gap: 6px; justify-content: space-between; }
.ph-res { border: 0; padding: 0; background: none; min-width: 44px; display: flex; justify-content: center; }
```

  The `pick` zone needs `tileH + 10 + btnH` minus the Back row. With `tileH` 84 that is 84 for the head (42) and
  the resources (`ch × 0.6`). Use `Card` at `round(cw × 0.9) × round(ch × 0.6)` so it fits. On short phones,
  check the 360×780 and 375×667 screenshots.
- [ ] **Step 4: Run the check.** Expected:
  - `probes.devSheet = { cards: ≥1, playable: ≥0 }`;
  - `probes.pick = { choices: 5 or fewer, played: true }`;
  - `small: []`.
- [ ] **Step 5: Commit** — `git commit -am "Phone M2: development cards — the pile spreads into the slab; Year of Plenty and Monopoly pick in it"`

---

### Task 8: The robber on touch, and the bot turn's move list

**Files:**
- Modify: `web/src/phone/Slab.tsx`: `Moves` shows the rows since your last move, scrolling, each with an icon.
- Modify: `web/tools/phone_check.mjs`: `robberVictim` and `moveIcons` probes.
- Possibly modify: `web/src/board/Carry.tsx`, only if the robber probe finds a defect. Keep it phone-only
  behind a prop.

Behaviour:
- **Robber** (spec row "Robber"): Carry already holds the robber (`held` auto), sinks the build cards
  (`sunk`), and, on a tile with several victims, shows victim chips (`VictimChip`, the seat's colour plus its
  card count) and steals at once from a lone victim. The phone needs:
  1. **Tapping a tile** places it. Touch tap-to-place is M1's `tapAt`, and `snapPx: 24` reaches a tile.
  2. **Tapping a victim chip** robs that seat. The chip is 22×18 board units, about 20px. `snapPx: 24` gives a
     48px catch radius, which meets 44px.
  3. **Trade and End turn faint** while the robber is in hand. They're already disabled: `END_TURN` isn't legal
     at `MOVE_ROBBER`.
  4. **Placement on a screenshot:** a victim chip must not rest on a number token. `CHIP_LIFT` puts it 20 units
     above the building. Check it on a 390 screenshot of the victim choice. If it covers a token, ledger it and
     move the chip to the building's open side. That decision is local to `Carry` and shared with the desktop,
     which is acceptable if it's identical there.
- **Move list** (spec row "Another seat's turn"):
  - The rows are every newsworthy move since the seated person's last move (cap 24), newest on top, in a
    container that scrolls inside the slab (`.ph-moves` already has `overflow-y: auto`).
  - Each row: the seat swatch, an icon, the narration and the swing (Eval on). The icon:
    - `PieceIcon` (size 18) for `BUILD_ROAD`/`BUILD_SETTLEMENT`/`BUILD_CITY`, in the seat's colour;
    - two `Die` at 14 for `ROLL`;
    - a face-down dev card (the `Card dev={-1}`-style back, or a 12×16 pine block, the same mark the chips use)
      for `BUY_DEVELOPMENT_CARD`;
    - nothing otherwise, keeping the 24px column.

- [ ] **Step 1: Probes.**
  - **`robberVictim`:** when the person faces `MOVE_ROBBER` (their own 7, or a Knight from Task 7):
    1. Find a tile with ≥ 2 victims in `s.legal` (`MOVE_ROBBER` actions grouped by `a[1]` with `a[2] >= 0`), or
       any legal tile.
    2. Tap its centre, mapping board units to screen with `#board-layer`'s rect and the board viewBox, the way
       the near-miss probe does.
    3. With 2+ victims: wait for `s.robTile`, then tap the first victim chip's screen position (its building's
       node, `CHIP_LIFT` up).
    4. `probe("robberVictim", { victims, moved: view.robber === tile, stolen: <the steal frame's seat> })`.
  - **`moveIcons`:** during a bot turn, the count of `.ph-move .ic svg` is at least 1.
- [ ] **Step 2: Run, see them missing.**
- [ ] **Step 3: Implement** the `Moves` changes. Fix Carry only if the probe shows a defect.
- [ ] **Step 4: Run the check.** Expected:
  - `probes.robberVictim.moved === true`;
  - with victims ≥ 2, a steal happened;
  - `moveIcons ≥ 1`.

  Screenshot the victim choice at 390 (`shot("victims")`) and look at it.
- [ ] **Step 5: Commit** — `git commit -am "Phone M2: robber and victims on touch; the bot turn's move list since your last move"`

---

### Task 9: All sizes, desktop regression, docs

**Files:**
- Modify: `docs/UI-REWRITE.md`: a Milestone 2 summary under the phone section, with the rulings.
- Modify: `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`: only the "Open questions" discard line, if the
  Suggest ruling changes it.

- [ ] **Step 1:** Run `phone_check` at 390×844, 375×667 and 360×780, one after another, in the background.
  Expected at each:
  - `missing: []`;
  - `small: []`;
  - `overflowX: 0`;
  - one board box per prompt;
  - `winner >= 0`;
  - the M1 probes as before (`keyboard`, `shakyTap`, `drag`, `roll`, `tapThrough: false`).

  Look at the screenshots of each new slab at 375×667: nothing truncated, nothing overlapping a number.
- [ ] **Step 2: Desktop.** At 1440 wide in the headless shell:
  - deal a game and drive it through a discard and a Year of Plenty with the desktop's own panels, using
    `__app.act` for the rest;
  - assert no console errors, and that the desktop tray's Year of Plenty picker still takes two resources (the
    `devpick.ts` refactor).

  `pnpm exec tsc -b`, `node tools/smoke.mjs`, the self-checks (`slab.ts`, `devpick.ts`, `drafts.ts`,
  `readings.ts`, `deciding.ts`) and `pnpm build` all pass.
- [ ] **Step 3: Docs.** In `docs/UI-REWRITE.md`'s phone section, add "Milestone 2 (2026-10-12)":
  - what shipped;
  - every ruling from the ledger, one line each;
  - the two wasm exports;
  - `phone_check`'s probe registry.
- [ ] **Step 4: Commit** — `git commit -am "Phone M2: verified at three sizes; docs"`

---

## Self-review notes

- **Spec coverage:**
  - Robber (Task 8), Discard (Task 4), Incoming offer (Task 5), Your offer (Task 6), Dev cards (Task 7),
    another seat's turn plus hurry (Tasks 3 and 8).
  - Offer effect and Suggest: Tasks 1, 4 and 5.
  - Eval off hides the effect and Suggest: Tasks 4 and 5.
- **Not in M2, by the spec's milestones:** pass and play's mid-turn answer covers (M4), grades (M6), sound (M7).
- **Rulings to ledger as they're made:**
  - Suggest doesn't commit;
  - no Counter or Ignore on the phone;
  - per-seat Trade buttons as well as the chip tap;
  - Withdraw only at `DECIDE_ACCEPTEES`;
  - Get tokens cycle;
  - the bank button only at the exact rate;
  - the pile spreads into the slab;
  - the Knight is a tap;
  - discard is tap only (the spec says "drag or tap"; dragging cards into slots is deferred).
