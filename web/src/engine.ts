// Types shared by the worker (owns the wasm Engine) and the UI, plus the request/response client.

export type Canon = [string, number, number, number];
export type BotKind = "random" | "heuristic" | "vnet" | "human";
export interface BotSpec { kind: BotKind; depth: number }

export interface PlayerView {
  hand: number[]; devs: number[]; played: number[]; vp: number; actual_vp: number;
  roads_available: number; settlements_available: number; cities_available: number;
  has_road: boolean; has_army: boolean; has_rolled: boolean; has_played_dev: boolean;
  longest_road_length: number; settlements: number[]; cities: number[]; roads: number[];
}
export interface View {
  n: number; players: PlayerView[]; bank: number[]; dev_deck: number;
  owner: number[]; is_city: boolean[]; road_owner: number[]; road_color: number; road_length: number; robber: number;
  current_player: number; current_turn: number; prompt: string; initial_phase: boolean; is_discarding: boolean;
  discard_counts: number[]; is_moving_knight: boolean; is_road_building: boolean; free_roads: number;
  num_turns: number; winner: number; steps: number;
  is_resolving_trade: boolean; current_trade: number[]; acceptees: boolean[]; spent_offers: number[][];
}
export interface MapView {
  tiles: { id: number; resource: number; number: number; nodes: number[] }[];
  ports: { id: number; resource: number; nodes: number[] }[];
  edges: [number, number][];
}
export interface Decision { bot: BotKind; action: Canon; value: number | null; root: [Canon, number | null][]; leaves: number; ms: number; trade?: boolean }
export interface Evaluation { win: number; vps: number[]; turns_left: number }
export interface Attribution { group: string; seat: number; delta: number }
export interface Frame {
  step: number; view: View; seat: number; action: Canon | null; outcome: [number, number] | null;
  decision: Decision | null; evals: Evaluation[]; attribution: Attribution[] | null;
}
export interface GameRecord { seed: number; n: number; log: [Canon, [number, number]][] }
/** Per-seat dice luck at one ROLL step: what the roll that happened was worth against the average
 *  over all eleven sums, weighted by their 36ths. Mean-zero per seat by construction, but a
 *  single one of these sits barely above the net's own noise — see `deciding.ts`. */
export interface LuckRoll { step: number; luck: number[] }

export type Request =
  | { op: "new"; seed: number; n: number }
  | { op: "apply"; action: Canon; steps?: number }
  | { op: "decide"; bot: BotKind; depth: number }
  | { op: "evaluateAll" }
  | { op: "attribution"; seat: number }
  | { op: "preview"; action: Canon }
  | { op: "run"; seed: number; bots: BotSpec[]; maxSteps: number }
  | { op: "record" }
  | { op: "replay"; record: string; steps: number }
  | { op: "luck"; record: string }
  | { op: "abort" };

export interface GameState { map: MapView; view: View; legal: Canon[] }
export interface RunResult { map: MapView; frames: Frame[]; record: GameRecord }

type Msg = { id: number } & ({ ok: true; result: unknown } | { ok: false; error: string } | { progress: Frame[] });

/** Promise client over the worker: one wasm Engine per client, one client per worker.
 *
 *  Three things it does that the previous version did not, each fixing something real:
 *
 *  - **It serialises.** `new` awaits a wasm boot and two fetches, so a request posted
 *    straight after `newGame` used to be handled first and throw "no game".
 *  - **It stamps an epoch.** Anything in flight when a new game starts is answered with
 *    "stale" rather than against the wrong engine, which is what the callers' hand-rolled
 *    generation counters and re-entry refs were for.
 *  - **It can abort.** `run` is a long loop in the worker; without this, leaving a replay
 *    left it grinding and posting to nobody.
 *
 *  There is deliberately no module-level instance. The live game and any review of it hold
 *  their own client, because the worker frees its engine on every `new` — one shared client
 *  is how Play and Watch used to destroy each other. */
export class EngineClient {
  private worker: Worker | null = null;
  private next = 1;
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: Frame[]) => void }>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if ("progress" in m) { p.onProgress?.(m.progress); return; }
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "worker error"));
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }

  private post<T>(req: Request, onProgress?: (f: Frame[]) => void): Promise<T> {
    const w = this.ensure();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage({ id, epoch: this.epoch, ...req });
    });
  }

  /** Every request waits for the one before it. A rejection does not poison the chain. */
  private call<T>(req: Request, onProgress?: (f: Frame[]) => void): Promise<T> {
    const run = this.tail.then(() => this.post<T>(req, onProgress));
    this.tail = run.catch(() => undefined);
    return run;
  }

  newGame(seed: number, n = 4) { this.epoch++; return this.call<GameState>({ op: "new", seed, n }); }
  /** `steps` pins the action to the position it was chosen at. The worker rejects it as "stale"
   *  if the engine has moved on — the only check that can see the round-trip, since the store's
   *  view is not replaced until this resolves. */
  apply(action: Canon, steps?: number) { return this.call<{ outcome: [number, number]; view: View; legal: Canon[] }>({ op: "apply", action, steps }); }
  decide(bot: BotKind, depth: number) { return this.call<Decision>({ op: "decide", bot, depth }); }
  evaluateAll() { return this.call<Evaluation[]>({ op: "evaluateAll" }); }
  attribution(seat: number) { return this.call<Attribution[]>({ op: "attribution", seat }); }
  /** The view after `action`, without touching the live game — for showing several hypotheticals at once. */
  preview(action: Canon) { return this.call<View>({ op: "preview", action }); }
  /** The live game's log, so a review client can replay it without touching this engine. */
  record() { return this.call<string>({ op: "record" }); }
  /** Rebuild a game from a record at a given step. Reloads the net: Engine::replay does not. */
  replay(record: string, steps: number) { this.epoch++; return this.call<GameState>({ op: "replay", record, steps }); }
  /** Dice luck across a whole recorded game: eleven counterfactual replays at every ROLL step,
   *  about 0.8 s. Review-only — never ask the live client for this. */
  luck(record: string) { return this.call<LuckRoll[]>({ op: "luck", record }); }
  run(seed: number, bots: BotSpec[], onProgress: (f: Frame[]) => void, maxSteps = 3000) {
    this.epoch++;
    return this.call<RunResult>({ op: "run", seed, bots, maxSteps }, onProgress);
  }
  /** Out of band, ahead of the queue: `run` is polling for exactly this. */
  abort() { if (this.worker) return this.post<null>({ op: "abort" }); return Promise.resolve(null); }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.tail = Promise.resolve();
  }
}

/** A rejected request from a game that no longer exists. Callers ignore these. */
export const isStale = (e: unknown) => e instanceof Error && e.message === "stale";
