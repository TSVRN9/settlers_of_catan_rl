# Phone UI, Milestone 7: sound and haptics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The table sounds and, where the phone can, buzzes. Each cue answers one event:
- dice, then the landing;
- a card flick for each card arriving in your hand;
- set-downs;
- a snap tick;
- the robber;
- offers;
- your turn;
- a win or a loss.

Bots' moves play only their set-down, quieter.

**Architecture:**
- **`web/src/sfx.ts`.** Its pure part is `cuesFor(frame, next, you)`, which maps one step to timed cues (checked). The rest is a small Web Audio synth (oscillators and a noise buffer; no assets, no dependency), unlocked on the first tap, plus `navigator.vibrate`.
- **`phone/Sounds.tsx`** plays a step when the playhead moves forward to it, under the same rule as the card flights (`coach.flies`). It plays nothing in the review.
- **The snap tick** comes from `Carry`, through a new optional `onSnap`.
- **Switches.** `store.sound` and `store.haptics` are per viewer (`localStorage`), and both switches are on the lineup. Haptics shows only where `navigator.vibrate` exists.

**Tech Stack:** TypeScript, Web Audio. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-ui-design.md`, "Sound and haptics" and Milestone 7.

## Global Constraints

- **Desktop stays the same.** `onSnap` is optional.
- **Haptics,** exactly as the spec gives them:
  - snap: 8ms;
  - set-down: 18ms;
  - dice landing: [12, 40, 12];
  - robber: 35ms;
  - your turn: [10, 60, 10];
  - offer: 15ms.
- **Private cues are yours only.** Card flicks follow the viewer's own hand. Under a pass-and-play cover the viewer is a spectator, so no card flicks play there.
- **Reduced motion keeps sound and haptics** (spec).
- **House rules:**
  - Labels only.
  - Targets ≥ 44px.
  - Nothing truncates at 375×667.
  - One assert check (`sfx.ts`).
- **Verification:** `tsc -b`, the self-checks, smoke, `phone_check` at the three sizes, and `pnpm build`.

## Review Focus

1. **A big production.** Expected: a run of card flicks capped at six, not a roar. Pinned in `sfx.ts`'s check.
2. **Pass and play.** Expected: cards gained by the seat under the cover make no flick. Pinned in the check (viewer −1).
3. **A scrub, a jump or the review.** Expected: no burst of cues. Pinned by `flies` (already checked) and the review exclusion; the `soundJump` probe.
4. **Sound off.** Expected: nothing plays and no AudioContext is created. Pinned by the `soundOff` probe.
5. **Autoplay policy.** Expected: nothing throws before the first tap. The context is created on the first `pointerdown`, and `phone_check` fails on any page error.

---

### Task 1: `sfx.ts` (cues, synth, vibrate) and the switches

- `cuesFor` with its self-check:
  - your roll: dice, the landing at 500ms, then flicks from 760ms;
  - a bot's roll: only your flicks;
  - your build: the set-down plus a vibration, the road lighter;
  - a bot's build: the set-down, quiet;
  - an offer to you: offer;
  - an answer to your offer: accepted or refused;
  - the turn coming to you;
  - a win or a loss;
  - the flick cap;
  - viewer −1.
- `store.sound`/`haptics` and their setters; the lineup switches.

### Task 2: playing it

- `phone/Sounds.tsx` in `Phone`. `Carry`'s `onSnap` gives the snap tick.
- Probes:
  - `sound`: the cues logged in a seated game include dice, landing, a set-down, a card and your turn;
  - `haptics`: the patterns, with a stubbed `vibrate`;
  - `soundOff`: no cues, no context;
  - `soundJump`: a cover row jump plays nothing;
  - `switches`: on the lineup.
- Docs: `UI-REWRITE.md` M7, and the spec row.
