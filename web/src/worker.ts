/// <reference lib="webworker" />
// The wasm Engine lives here so search never blocks the UI. One engine per worker.
import init, { Engine } from "./engine/catan_engine.js";
import wasmUrl from "./engine/catan_engine_bg.wasm?url";
import type { Attribution, BotKind, BotSpec, Canon, Decision, Evaluation, Frame, GameRecord, MapView, Request, View } from "./engine";

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
    // Review's walk-forward: replays the record's own fixed actions once, capturing only
    // `view`/`evals` at each step (cheap forward passes) — never `decide()` or `attribution()`,
    // which are search/leave-one-out costs only ever worth paying for the step being looked
    // at, fetched lazily by Move/Game analysis via `replay` + `decide`/`attribution`.
    case "analyze": {
      epoch++;
      aborted = false;
      const rec = JSON.parse(req.record) as GameRecord;
      const e = await fresh(rec.seed, rec.n);
      const map = JSON.parse(e.map_json()) as MapView;
      const frames: Frame[] = [];
      let batch: Frame[] = [];
      let step = 0;
      const mine = epoch;
      for (const [action, outcome] of rec.log) {
        const v = view(e);
        const seat = v.current_player;
        const evals = evalAll(e);          // before applying — matches `f.view`'s own position
        e.apply(JSON.stringify(action));
        const f: Frame = { step, view: v, seat, action, outcome, decision: null, evals, attribution: null };
        frames.push(f);
        batch.push(f);
        step++;
        if (batch.length >= 8) {
          post(batch); batch = [];
          await new Promise((r) => setTimeout(r));
          if (aborted || epoch !== mine) throw new Error("stale");
        }
      }
      const v = view(e);
      const last: Frame = { step, view: v, seat: v.current_player, action: null, outcome: null, decision: null, evals: evalAll(e), attribution: null };
      frames.push(last);
      batch.push(last);
      post(batch);
      return { map, frames };
    }
  }
}

self.onmessage = async (ev: MessageEvent<Request & { id: number; epoch?: number }>) => {
  const { id, epoch: at, ...req } = ev.data;
  // `abort` jumps the queue: it is a control message, not a request.
  if ((req as Request).op === "abort") { aborted = true; self.postMessage({ id, ok: true, result: null }); return; }
  try {
    // `new`/`replay`/`analyze` bump the client's epoch before the request is even queued, so
    // the epoch it's stamped with is always one ahead of the worker's own (still pre-bump)
    // value — these three are exempt from the staleness check for that reason, not because
    // they can never be stale.
    const op = (req as Request).op;
    if (at !== undefined && at !== epoch && op !== "new" && op !== "replay" && op !== "analyze") {
      throw new Error("stale");
    }
    const result = await handle(req as Request, (frames) => self.postMessage({ id, progress: frames }));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};
