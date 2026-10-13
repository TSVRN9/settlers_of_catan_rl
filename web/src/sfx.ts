// The table's sounds and buzzes (spec "Sound and haptics"): one cue per event, synthesised with Web Audio (no assets),
// and `navigator.vibrate` where it exists (Android Chrome; iOS Safari has none, so nothing depends on it).
//
// `cuesFor` is the pure part: what one step of the game sounds like, for whom. Bots' moves play only their set-down,
// quieter; everything else answers something that happened to you. Self-check:
//   node --experimental-strip-types web/src/sfx.ts
import type { Canon } from "./engine";

export type Cue = "dice" | "land" | "card" | "road" | "set" | "city" | "snap" | "robber" | "offer" | "accepted" | "refused" | "turn" | "win" | "loss";
export interface CueAt { cue: Cue; at: number; quiet?: boolean; res?: number; buzz?: number | number[] }

/** Just enough of a frame and its view to hear a step. */
export interface StepView {
  players: { hand: number[] }[]; current_turn: number; current_player: number; prompt: string; winner: number; current_trade: number[];
  initial_phase?: boolean;
}
export interface StepFrame { seat: number; action: Canon | null; outcome: [number, number] | null; view: StepView }

/** A production is a run, not a roar. */
export const MAX_FLICKS = 6;
/** When the dice land, and when a card lands in your hand: the card flights' own beats (views/Fx.tsx) — a flight
 *  starts at 760ms after a roll (420 after a steal, 380 off the opening's second settlement) and reaches its seat
 *  about 740ms later. */
const LAND_AT = 500, FLIGHT = 740, FLICK_GAP = 70;
const ARRIVES: Record<string, number> = { ROLL: 760 + FLIGHT, MOVE_ROBBER: 420 + FLIGHT, BUILD_SETTLEMENT: 380 + FLIGHT };

const BUZZ = { snap: 8, set: 18, land: [12, 40, 12], robber: 35, turn: [10, 60, 10], offer: 15 };

/** The cues of the step from `f` (closed: its action and outcome) to `next`, for viewer `you` (−1: a spectator,
 *  who hears only the public half and no cards arriving in anyone's hand). */
export function cuesFor(f: StepFrame, next: StepView, you: number, opts: { answered?: boolean } = {}): CueAt[] {
  const a = f.action;
  if (!a) return [];
  const out: CueAt[] = [];
  const mine = you >= 0 && f.seat === you;
  const k = a[0];
  if (k === "ROLL" && mine) {
    out.push({ cue: "dice", at: 0 }, { cue: "land", at: LAND_AT, buzz: BUZZ.land });
  } else if (k === "BUILD_ROAD" || k === "BUILD_SETTLEMENT" || k === "BUILD_CITY") {
    out.push({ cue: k === "BUILD_ROAD" ? "road" : k === "BUILD_CITY" ? "city" : "set", at: 0, quiet: !mine, ...(mine ? { buzz: BUZZ.set } : {}) });
  } else if (k === "MOVE_ROBBER" && mine) {
    out.push({ cue: "robber", at: 0, buzz: BUZZ.robber });
  } else if (k === "ACCEPT_TRADE" && !mine && you >= 0 && f.view.current_trade[10] === you) {
    out.push({ cue: "accepted", at: 0 });
  } else if (k === "REJECT_TRADE" && !mine && you >= 0 && f.view.current_trade[10] === you && next.prompt === "PLAY_TURN") {
    out.push({ cue: "refused", at: 0 });                 // once, as your offer dies with nobody taking it
  }
  // An offer reaching you: whenever the decision comes round to you (a table offer asks the seats in turn), unless the
  // game answered it for you (you can't afford it, or you muted its bot: `pump`'s autoDecline), when it never reaches you.
  if (you >= 0 && !mine && !opts.answered && next.prompt === "DECIDE_TRADE" && next.current_player === you
      && !(f.view.prompt === "DECIDE_TRADE" && f.view.current_player === you)) out.push({ cue: "offer", at: 0, buzz: BUZZ.offer });
  // Cards arriving in your hand, one flick each, pitched by resource: off the tiles after a roll, at once otherwise.
  if (you >= 0) {
    const was = f.view.players[you]?.hand ?? [], now = next.players[you]?.hand ?? [];
    const flown = k === "ROLL" || k === "MOVE_ROBBER" || (k === "BUILD_SETTLEMENT" && f.view.initial_phase);
    const start = flown ? ARRIVES[k] : 0;
    // A steal's card isn't named by its pitch: a phone's speaker is heard by everyone at the table.
    const named = k !== "MOVE_ROBBER";
    let n = 0;
    for (let r = 0; r < 5 && n < MAX_FLICKS; r++)
      for (let c = 0; c < (now[r] ?? 0) - (was[r] ?? 0) && n < MAX_FLICKS; c++) out.push({ cue: "card", at: start + FLICK_GAP * n++, ...(named ? { res: r } : {}) });
  }
  if (you >= 0 && next.winner < 0 && next.current_turn === you && f.view.current_turn !== you) out.push({ cue: "turn", at: 0, buzz: BUZZ.turn });
  if (next.winner >= 0 && f.view.winner < 0) out.push({ cue: you < 0 || next.winner === you ? "win" : "loss", at: 300 });
  return out;
}

/** The snap tick, from the piece in hand finding a spot (board/Carry.tsx `onSnap`). */
export const SNAP: CueAt = { cue: "snap", at: 0, buzz: BUZZ.snap };

// ── the synth ─────────────────────────────────────────────────────────────────────────
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
/** What has played, newest last (a probe reads it; it costs nothing). */
export const played: { cue: Cue; t: number }[] = [];
export const buzzed: (number | number[])[] = [];
/** Every cue ever played: `played` keeps only the last 200. */
export const heard = { count: 0 };

/** The context is made on a tap (browsers start one suspended otherwise) and only once sound is on. */
export function unlock() {
  if (typeof AudioContext === "undefined") return;
  // A context the system took away (iOS after a lock or a call: "interrupted") or one made before the page could
  // start audio ("suspended") comes back on the next tap.
  if (ctx) { if (ctx.state !== "running") ctx.resume().catch(() => {}); return; }
  try { ctx = new AudioContext(); } catch { return; }
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  const b = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noise = b;
}
export const unlocked = () => ctx != null;

function tone(t: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const c = ctx!, o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function hiss(t: number, dur: number, freq: number, gain: number, q = 1.2) {
  const c = ctx!, src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
  src.buffer = noise;
  bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}

/** Wood, brick, sheep, wheat, ore: a card's flick rises with its resource. */
const PITCH = [520, 587, 659, 740, 831];

const SYNTH: Record<Cue, (t: number, v: number, res?: number) => void> = {
  dice: (t, v) => { for (let i = 0; i < 6; i++) hiss(t + i * 0.055 + Math.random() * 0.03, 0.035, 2600 + Math.random() * 900, 0.35 * v, 4); },
  land: (t, v) => { tone(t, 150, 85, 0.13, 0.5 * v); hiss(t, 0.03, 1800, 0.25 * v, 3); },
  card: (t, v, r = 0) => { hiss(t, 0.04, 3200, 0.18 * v, 2); tone(t + 0.01, PITCH[r] ?? 600, (PITCH[r] ?? 600) * 1.06, 0.07, 0.12 * v, "triangle"); },
  road: (t, v) => tone(t, 260, 170, 0.09, 0.35 * v),
  set: (t, v) => { tone(t, 190, 105, 0.14, 0.5 * v); hiss(t, 0.025, 900, 0.15 * v); },
  city: (t, v) => { tone(t, 130, 68, 0.22, 0.6 * v); hiss(t, 0.04, 600, 0.22 * v); },
  snap: (t, v) => tone(t, 1900, 1700, 0.014, 0.08 * v, "square"),
  robber: (t, v) => { tone(t, 85, 48, 0.24, 0.7 * v); hiss(t, 0.06, 300, 0.25 * v, 0.8); },
  offer: (t, v) => { tone(t, 660, 660, 0.12, 0.16 * v); tone(t + 0.13, 880, 880, 0.14, 0.16 * v); },
  accepted: (t, v) => { tone(t, 523, 523, 0.1, 0.18 * v, "triangle"); tone(t + 0.1, 784, 784, 0.14, 0.18 * v, "triangle"); },
  refused: (t, v) => { tone(t, 659, 659, 0.1, 0.14 * v, "triangle"); tone(t + 0.1, 440, 440, 0.14, 0.14 * v, "triangle"); },
  turn: (t, v) => { tone(t, 230, 160, 0.07, 0.45 * v, "triangle"); hiss(t, 0.02, 1500, 0.2 * v, 3); },
  win: (t, v) => [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.09, f, f, 0.16, 0.2 * v, "triangle")),
  loss: (t, v) => tone(t, 196, 180, 0.45, 0.25 * v),
};

/** Play cues as they fall due, if sound (and haptics) are on. Never throws: a phone with its audio taken by
 *  something else simply stays quiet. */
export function play(cues: CueAt[], opts: { sound: boolean; haptics: boolean }) {
  for (const c of cues) {
    if (opts.haptics && c.buzz != null && typeof navigator !== "undefined" && navigator.vibrate) {
      const fire = () => {
        try { navigator.vibrate(c.buzz!); buzzed.push(c.buzz!); if (buzzed.length > 200) buzzed.splice(0, buzzed.length - 200); } catch { /* not allowed yet */ }
      };
      if (c.at) setTimeout(fire, c.at); else fire();
    }
    // Only into a running context: nodes started on a stopped clock would all sound at once when it resumed.
    if (!opts.sound || !ctx || ctx.state !== "running" || !noise) continue;
    try {
      SYNTH[c.cue](ctx.currentTime + c.at / 1000, c.quiet ? 0.4 : 1, c.res);
      played.push({ cue: c.cue, t: Date.now() + c.at });
      heard.count++;
      if (played.length > 200) played.splice(0, played.length - 200);
    } catch { /* a closed or interrupted context */ }
  }
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("sfx.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`sfx self-check: ${m}`); };
  const hand = (...h: number[]) => ({ hand: h.length ? h : [0, 0, 0, 0, 0] });
  const view = (o: Partial<StepView> = {}): StepView => ({ players: [hand(0, 0, 0, 0, 0), hand(0, 0, 0, 0, 0)], current_turn: 0, current_player: 0, prompt: "PLAY_TURN",
    winner: -1, current_trade: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1], ...o });
  const F = (seat: number, a: string, v = view(), x = -1): StepFrame => ({ seat, action: [a, x, -1, -1], outcome: null, view: v });
  const cues = (c: CueAt[]) => c.map((x) => x.cue).join();
  // Your roll: dice, the landing (buzz), then a flick per card you got, after the landing; capped.
  const big = view({ players: [hand(3, 2, 2, 1, 0), hand(0, 0, 0, 0, 0)] });
  const roll = cuesFor(F(0, "ROLL"), big, 0);
  assert(cues(roll) === "dice,land," + Array(MAX_FLICKS).fill("card").join(), `your roll: ${cues(roll)}`);
  assert(roll[1].buzz && roll.filter((c) => c.cue === "card").every((c) => c.at >= LAND_AT), "landing buzzes; cards after it");
  assert(roll.filter((c) => c.cue === "card").map((c) => c.res).join() === "0,0,0,1,1,2", "pitched by resource, in order");
  // A bot's roll: no dice for you, only the cards that reach your hand.
  assert(cues(cuesFor(F(1, "ROLL"), view({ players: [hand(1, 0, 0, 0, 0), hand(0, 0, 0, 0, 0)], current_turn: 1 }), 0)) === "card", "a bot's roll");
  // Watching, or under a cover: nobody's cards are heard.
  assert(cues(cuesFor(F(0, "ROLL"), big, -1)) === "", "a spectator hears no hands and no dice");
  // Set-downs: yours buzzes; a bot's is quiet; a road is its own, lighter cue.
  const set = cuesFor(F(0, "BUILD_SETTLEMENT"), view(), 0)[0];
  assert(set.cue === "set" && !set.quiet && set.buzz === 18, "your settlement");
  const bot = cuesFor(F(1, "BUILD_CITY", view({ current_turn: 1 })), view({ current_turn: 1 }), 0)[0];
  assert(bot.cue === "city" && bot.quiet && bot.buzz == null, "a bot's city");
  assert(cuesFor(F(0, "BUILD_ROAD"), view(), 0)[0].cue === "road", "a road");
  // Offers: one to you; answers to yours; nothing for an offer between others.
  assert(cues(cuesFor(F(1, "OFFER_TRADE", view({ current_turn: 1 })), view({ current_turn: 1, prompt: "DECIDE_TRADE", current_player: 0 }), 0)) === "offer", "an offer to you");
  const yours = view({ current_trade: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0] });
  assert(cues(cuesFor(F(1, "ACCEPT_TRADE", yours), yours, 0)) === "accepted", "a seat takes your offer");
  assert(cues(cuesFor(F(1, "ACCEPT_TRADE", view()), view(), 0)) === "", "an answer to someone else's offer");
  // The turn coming to you knocks; the game ending is a win or a loss, once.
  assert(cues(cuesFor(F(1, "END_TURN", view({ current_turn: 1 })), view({ current_turn: 0 }), 0)) === "turn", "your turn");
  assert(cues(cuesFor(F(1, "BUILD_CITY", view({ current_turn: 1 })), view({ current_turn: 1, winner: 1 }), 0)) === "city,loss", "a loss");
  assert(cues(cuesFor(F(0, "BUILD_CITY"), view({ winner: 0 }), 0)) === "city,win", "a win");
  assert(cues(cuesFor(F(1, "BUILD_CITY"), view({ winner: 1 }), -1)).endsWith("win"), "watching, an ending is a win");
  assert(cues(cuesFor(F(0, "ROBBER_X"), view(), 0)) === "" && cuesFor({ ...F(0, "ROLL"), action: null }, view(), 0).length === 0, "nothing else");
  // An offer reaches you whenever the decision comes round to you, not only when you're asked first; one answered for
  // you (you can't afford it, or you muted its bot) never reaches you, so it makes no sound.
  const asking = (cp: number) => view({ current_turn: 3, prompt: "DECIDE_TRADE", current_player: cp, players: [hand(), hand(), hand(), hand()].map(() => hand(0, 0, 0, 0, 0)) });
  assert(cues(cuesFor(F(1, "REJECT_TRADE", asking(1)), asking(2), 2)) === "offer", "an offer reaching the second responder");
  assert(cues(cuesFor(F(1, "REJECT_TRADE", asking(1)), asking(2), 2, { answered: true })) === "", "an offer answered for you");
  // A steal's flick doesn't name the card: a phone's speaker is heard by the whole table.
  const stole = cuesFor(F(0, "MOVE_ROBBER"), view({ players: [hand(0, 0, 0, 0, 1), hand(0, 0, 0, 0, 0)] }), 0).find((c) => c.cue === "card");
  assert(stole && stole.res == null, "a steal is unpitched");
  // Each card flicks as it lands in your hand, after its flight.
  assert(roll.filter((c) => c.cue === "card")[0].at >= 1400, "a production's card lands after its flight");
  // Your offer: a rising pair per seat that takes it; a falling pair once, when it dies with nobody taking it.
  const dead = view({ current_trade: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], current_player: 0, prompt: "PLAY_TURN" });
  assert(cues(cuesFor(F(1, "REJECT_TRADE", yours), view({ ...yours, prompt: "DECIDE_TRADE", current_player: 2 }), 0)) === "", "a refusal while others are still asked");
  assert(cues(cuesFor(F(1, "REJECT_TRADE", yours), dead, 0)) === "refused", "the offer dies");
  console.log("sfx self-check ok");
}
