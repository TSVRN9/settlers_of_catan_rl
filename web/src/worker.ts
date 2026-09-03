/// <reference lib="webworker" />
// The wasm Engine lives here so search never blocks the UI. One engine per worker.
import init, { Engine } from "./engine/catan_engine.js";
import wasmUrl from "./engine/catan_engine_bg.wasm?url";
import type { Attribution, BotKind, BotSpec, Canon, Decision, Evaluation, Frame, MapView, Request, View } from "./engine";

let ready: Promise<{ weights: Uint8Array; hidden: number }> | null = null;
let engine: Engine | null = null;

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
    case "run": {
      const e = await fresh(req.seed, req.bots.length);
      const map = JSON.parse(e.map_json()) as MapView;
      const frames: Frame[] = [];
      let batch: Frame[] = [];
      let step = 0;
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
        if (batch.length >= 8) { post(batch); batch = []; }
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

self.onmessage = async (ev: MessageEvent<Request & { id: number }>) => {
  const { id, ...req } = ev.data;
  try {
    const result = await handle(req as Request, (frames) => self.postMessage({ id, progress: frames }));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};
