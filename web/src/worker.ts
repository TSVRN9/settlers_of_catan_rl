/// <reference lib="webworker" />
// The wasm Engine lives here so search never blocks the UI. One engine per worker.
import init, { Engine } from "./engine/catan_engine.js";
import wasmUrl from "./engine/catan_engine_bg.wasm?url";
import type { Attribution, BotKind, BotSpec, Canon, Decision, Evaluation, Frame, GameRecord, LuckRoll, MapView, Request, View } from "./engine";

let ready: Promise<{ weights: Uint8Array; hidden: number }> | null = null;
let engine: Engine | null = null;
// Bumped by every `new`/`replay`. A request stamped with an older epoch belongs to a game
// that no longer exists, so it is rejected rather than answered against the wrong engine.
let epoch = 0;
// `run` polls this at its batch boundary. Set out of band, ahead of the queue.
let aborted = false;

function boot() {
  if (!ready) {
    ready = (async () => {
      await init({ module_or_path: wasmUrl });
      const base = import.meta.env.BASE_URL;
      const meta = await (await fetch(`${base}models/v40.json`)).json();
      const weights = new Uint8Array(await (await fetch(`${base}models/v40.bin`)).arrayBuffer());
      return { weights, hidden: meta.hidden as number };
    })();
  }
  return ready;
}

async function fresh(seed: number, n: number) {
  const { weights, hidden } = await boot();
  engine?.free();
  engine = new Engine(seed >>> 0, n);
  engine.load_net(weights, hidden);
  return engine;
}

/** Engine.replay() returns a fresh Engine, and Engine::new sets net: None — a replayed
 *  engine cannot evaluate or run the value-net bot until the net is loaded back into it.
 *  See catan_engine/src/wasm.rs:74. */
async function replayed(record: string, steps: number) {
  const { weights, hidden } = await boot();
  engine?.free();
  engine = Engine.replay(record, steps);
  engine.load_net(weights, hidden);
  if (!engine.has_net()) throw new Error("replay lost the net");
  return engine;
}

// The eleven dice sums and their 36ths. Only the sum is ever read (`apply.rs` computes
// `dice.0 + dice.1` and the individual dice appear nowhere else), so one representative pair
// per sum is exact rather than a simplification — the 21 ordered pairs would be redundant.
const SUM_36: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const SUM_PAIR: Record<number, [number, number]> = {
  2: [1, 1], 3: [1, 2], 4: [1, 3], 5: [1, 4], 6: [1, 5], 7: [1, 6],
  8: [2, 6], 9: [3, 6], 10: [4, 6], 11: [5, 6], 12: [6, 6],
};

function need() {
  if (!engine) throw new Error("no game: call new first");
  return engine;
}

const view = (e: Engine) => JSON.parse(e.view()) as View;
const legal = (e: Engine) => JSON.parse(e.legal_actions()) as Canon[];
const evalAll = (e: Engine) => JSON.parse(e.evaluate_all()) as Evaluation[];

function decide(e: Engine, bot: BotKind, depth: number): Decision {
  if (bot === "human") throw new Error("a human seat has no bot");
  const t0 = performance.now();
  const d = JSON.parse(e.decide(bot, depth));
  return { bot, action: d.action, value: d.value, root: d.root, leaves: d.leaves, ms: performance.now() - t0, trade: !!d.trade };
}

async function handle(req: Request, post: (frames: Frame[]) => void): Promise<unknown> {
  switch (req.op) {
    case "new": {
      epoch++;
      aborted = false;
      const e = await fresh(req.seed, req.n);
      return { map: JSON.parse(e.map_json()) as MapView, view: view(e), legal: legal(e) };
    }
    case "apply": {
      const e = need();
      // An action is only legal at the position it was chosen at, and the store's view lags this
      // engine by a round-trip — so two actions chosen from one position both pass every check the
      // UI can make. Here is the only place the two can be compared. `steps` is already on the
      // wasm surface (wasm.rs:117), so this costs nothing and needs no engine change.
      if (req.steps !== undefined && e.steps() !== req.steps) throw new Error("stale");
      const outcome = JSON.parse(e.apply(JSON.stringify(req.action)));
      return { outcome, view: view(e), legal: legal(e) };
    }
    case "decide":
      return decide(need(), req.bot, req.depth);
    case "evaluateAll":
      return evalAll(need());
    case "attribution":
      return JSON.parse(need().attribution(req.seat)) as Attribution[];
    case "preview":
      return JSON.parse(need().preview(JSON.stringify(req.action))) as View;
    case "record":
      return need().record();
    case "replay": {
      epoch++;
      aborted = false;
      const e = await replayed(req.record, req.steps);
      return { map: JSON.parse(e.map_json()) as MapView, view: view(e), legal: legal(e) };
    }
    case "luck": {
      // Dice luck, by counterfactual: replay the record with each of the eleven sums forced in
      // place of the one that happened, and compare what happened to the weighted average.
      // `Engine::replay` forces recorded outcomes (wasm.rs:82), so this needs no Rust change.
      //
      // Deliberately does not touch the module-level `engine`, does not bump `epoch`, and does
      // not go through `replayed()`: the review client holds a position for the ladder and the
      // attribution panel, and clobbering it here would silently invalidate review.ts's cache.
      const { weights, hidden } = await boot();
      const rec = JSON.parse(req.record) as GameRecord;
      const out: LuckRoll[] = [];
      let since = 0;
      for (let i = 0; i < rec.log.length; i++) {
        if (rec.log[i][0][0] !== "ROLL") continue;
        const actual = rec.log[i][1][0] + rec.log[i][1][1];
        const expected = new Array<number>(rec.n).fill(0);
        let realized: number[] | null = null;
        for (const key of Object.keys(SUM_36)) {
          const sum = Number(key);
          const log = [...rec.log.slice(0, i), [rec.log[i][0], SUM_PAIR[sum]]];
          const alt = Engine.replay(JSON.stringify({ seed: rec.seed, n: rec.n, log }), -1);
          alt.load_net(weights, hidden);
          const wins = (JSON.parse(alt.evaluate_all()) as Evaluation[]).map((v) => v.win);
          // Mandatory, not hygiene: wasm-bindgen objects are not promptly collected and every
          // replayed engine holds its own 1.6 MB copy of the net. Without this the pass dies
          // with "RuntimeError: unreachable" a couple of games in, and slows 6× before it does.
          alt.free();
          for (let s = 0; s < rec.n; s++) expected[s] += (SUM_36[sum] / 36) * wins[s];
          if (sum === actual) realized = wins;
        }
        // The realized sum is always one of the eleven, but a malformed record should not throw.
        if (realized) out.push({ step: i, luck: realized.map((w, s) => w - expected[s]) });
        if (++since >= 8) {
          since = 0;
          await new Promise((r) => setTimeout(r));   // same reason as `run`: let `abort` land
          // Only `abort` stops this, and it throws rather than breaking: a partial series is a
          // wrong answer, not a short one. An epoch change must NOT stop it — scrubbing the
          // review replays, and this pass is about the record, not the current position.
          if (aborted) throw new Error("stale");
        }
      }
      return out;
    }
    case "run": {
      epoch++;
      aborted = false;
      const e = await fresh(req.seed, req.bots.length);
      const map = JSON.parse(e.map_json()) as MapView;
      const frames: Frame[] = [];
      let batch: Frame[] = [];
      let step = 0;
      const mine = epoch;
      while (e.winner() < 0 && step < req.maxSteps) {
        const v = view(e);
        const seat = v.current_player;
        const acts = legal(e);
        const bot = req.bots[seat];
        const forced = acts.length === 1;
        const decision = forced ? { bot: bot.kind, action: acts[0], value: null, root: [], leaves: 0, ms: 0 } as Decision : decide(e, bot.kind, bot.depth);
        const evals = evalAll(e);
        const attribution = forced ? null : (JSON.parse(e.attribution(seat)) as Attribution[]);
        const outcome = JSON.parse(e.apply(JSON.stringify(decision.action))) as [number, number];
        const f: Frame = { step, view: v, seat, action: decision.action, outcome, decision, evals, attribution };
        frames.push(f);
        batch.push(f);
        step++;
        if (batch.length >= 8) {
          post(batch); batch = [];
          // The loop has no other await, so without this the worker never returns to its
          // own message queue and `abort` can never be heard. One macrotask per 8 frames
          // is nothing against a depth-2 search. (SharedArrayBuffer + Atomics.wait is the
          // textbook answer and needs COOP/COEP headers, which GitHub Pages does not send.)
          await new Promise((r) => setTimeout(r));
          if (aborted || epoch !== mine) break;
        }
      }
      const v = view(e);
      const last: Frame = { step, view: v, seat: v.current_player, action: null, outcome: null, decision: null, evals: evalAll(e), attribution: null };
      frames.push(last);
      batch.push(last);
      post(batch);
      return { map, frames, record: JSON.parse(e.record()) };
    }
  }
}

self.onmessage = async (ev: MessageEvent<Request & { id: number; epoch?: number }>) => {
  const { id, epoch: at, ...req } = ev.data;
  // `abort` jumps the queue: it is a control message, not a request.
  if ((req as Request).op === "abort") { aborted = true; self.postMessage({ id, ok: true, result: null }); return; }
  try {
    // `new`/`replay`/`run` bump the client's epoch before the request is even queued, so the
    // epoch it's stamped with is always one ahead of the worker's own (still pre-bump) value —
    // the three are exempt from the staleness check for that reason, not because they can
    // never be stale. (`run` was missing here and every watched game was refused as stale.)
    const op = (req as Request).op;
    // `luck` joins the three exemptions for a different reason: it holds no engine state at
    // all, building and freeing its own throwaway engines from the record it is handed, so it
    // is correct whatever the live engine is doing. Without this it is refused as stale
    // whenever a `replay` is queued behind it — which the Game view does on the same mount.
    if (at !== undefined && at !== epoch && op !== "new" && op !== "replay" && op !== "run" && op !== "luck") {
      throw new Error("stale");
    }
    const result = await handle(req as Request, (frames) => self.postMessage({ id, progress: frames }));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};
