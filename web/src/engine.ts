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

export type Request =
  | { op: "new"; seed: number; n: number }
  | { op: "apply"; action: Canon }
  | { op: "decide"; bot: BotKind; depth: number }
  | { op: "evaluateAll" }
  | { op: "attribution"; seat: number }
  | { op: "run"; seed: number; bots: BotSpec[]; maxSteps: number };

export interface GameState { map: MapView; view: View; legal: Canon[] }
export interface RunResult { map: MapView; frames: Frame[]; record: GameRecord }

type Msg = { id: number } & ({ ok: true; result: unknown } | { ok: false; error: string } | { progress: Frame[] });

/** Promise client over the worker; one in-flight game per worker. The worker is created lazily and
 * recreated after terminate(), so React StrictMode's mount/unmount/mount cycle cannot strand it. */
export class EngineClient {
  private worker: Worker | null = null;
  private next = 1;
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
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      console.error("engine worker failed", e.message ?? e);
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error(`engine worker failed: ${e.message ?? "see console"}`)); }
    };
    this.worker = w;
    return w;
  }

  private call<T>(req: Request, onProgress?: (f: Frame[]) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.ensure().postMessage({ id, ...req });
    });
  }

  newGame(seed: number, n = 4) { return this.call<GameState>({ op: "new", seed, n }); }
  apply(action: Canon) { return this.call<{ outcome: [number, number]; view: View; legal: Canon[] }>({ op: "apply", action }); }
  decide(bot: BotKind, depth: number) { return this.call<Decision>({ op: "decide", bot, depth }); }
  evaluateAll() { return this.call<Evaluation[]>({ op: "evaluateAll" }); }
  attribution(seat: number) { return this.call<Attribution[]>({ op: "attribution", seat }); }
  run(seed: number, bots: BotSpec[], onProgress: (f: Frame[]) => void, maxSteps = 3000) {
    return this.call<RunResult>({ op: "run", seed, bots, maxSteps }, onProgress);
  }
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("engine client terminated")); }
  }
}

/** One worker for the whole app; pages share it (only one game is live at a time). */
export const engine = new EngineClient();
