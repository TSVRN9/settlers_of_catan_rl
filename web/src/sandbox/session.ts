// The sandbox's game: a board copied off a real table and the log of what happened at it, as entered. Pure data and
// pure functions, no React and no engine, so the Node check (tools/sandbox_check.mjs) runs them as they ship.
//
// The log is the truth and everything on screen is the engine replaying it (wasm `sandbox_resolve`, then
// `Engine.replay`), so undo is dropping the last entry and a correction is editing one. An outcome left null is one
// the person entering it couldn't see — a steal between two other seats, another seat's development card — and the
// replay types it.

export type Canon = [string, number, number, number];

/** One entry: an action, its outcome (null: not seen), for a monopoly what each seat handed over, and the group it
 *  was entered with (a trade is an offer, every seat's answer and the confirmation; a discard is one entry a card),
 *  which undo and delete take away together. */
export interface Entry { a: Canon; o: [number, number] | null; took?: number[]; g: number }

/** Tiles by engine tile id as [resource, number] (resource -1 the desert, null not set yet; number 0 none), ports by
 *  engine port id (-1 for 3:1, null not set). */
export interface Board { tiles: ([number, number] | null)[]; ports: (number | null)[] }

export interface Session { v: 1; seed: number; n: number; you: number; board: Board; started: boolean; log: Entry[] }

export const STORAGE_KEY = "sandbox.v1";

/** The BASE game's pieces (catan_engine base_topology.rs): what a board is checked against. */
export const TILE_COUNTS: Record<number, number> = { 0: 4, 1: 3, 2: 4, 3: 4, 4: 3, [-1]: 1 };
export const NUMBER_COUNTS: Record<number, number> = { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 };
export const PORT_COUNTS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, [-1]: 4 };

/** One dice pair per sum: only the sum is ever read (worker.ts SUM_PAIR). */
export const SUM_PAIR: Record<number, [number, number]> = {
  2: [1, 1], 3: [1, 2], 4: [1, 3], 5: [1, 4], 6: [1, 5], 7: [1, 6], 8: [2, 6], 9: [3, 6], 10: [4, 6], 11: [5, 6], 12: [6, 6],
};

export function blank(seed = Math.floor(Math.random() * 2 ** 31)): Session {
  return { v: 1, seed, n: 4, you: 0, board: { tiles: Array(19).fill(null), ports: Array(9).fill(null) }, started: false, log: [] };
}

/** How many of each piece are still to place. */
export function left(board: Board) {
  const tiles = { ...TILE_COUNTS }, numbers = { ...NUMBER_COUNTS }, ports = { ...PORT_COUNTS };
  for (const t of board.tiles) {
    if (!t) continue;
    tiles[t[0]]--;
    if (t[1] > 0) numbers[t[1]]--;
  }
  for (const p of board.ports) if (p != null) ports[p]--;
  return { tiles, numbers, ports };
}

/** Every tile and port set, each piece used exactly as often as the box has it, the desert alone without a number. */
export function boardComplete(board: Board) {
  if (board.tiles.some((t) => !t || (t[0] < 0) !== (t[1] === 0)) || board.ports.some((p) => p == null)) return false;
  const l = left(board);
  return [l.tiles, l.numbers, l.ports].every((c) => Object.values(c).every((x) => x === 0));
}

/** Set tile `id` to `resource` (keeping a number it already has, unless it became the desert). */
export function setTile(s: Session, id: number, resource: number): Session {
  const tiles = s.board.tiles.slice();
  const prev = tiles[id];
  tiles[id] = [resource, resource < 0 ? 0 : prev && prev[0] >= 0 ? prev[1] : 0];
  return { ...s, board: { ...s.board, tiles } };
}

export function setNumber(s: Session, id: number, number: number): Session {
  const t = s.board.tiles[id];
  if (!t || t[0] < 0) return s;
  const tiles = s.board.tiles.slice();
  tiles[id] = [t[0], number];
  return { ...s, board: { ...s.board, tiles } };
}

export function setPort(s: Session, id: number, resource: number): Session {
  const ports = s.board.ports.slice();
  ports[id] = resource;
  return { ...s, board: { ...s.board, ports } };
}

const nextGroup = (s: Session) => (s.log.length ? s.log[s.log.length - 1].g + 1 : 0);

/** Append entries entered together as one group. */
export function append(s: Session, entries: Omit<Entry, "g">[]): Session {
  const g = nextGroup(s);
  return { ...s, log: [...s.log, ...entries.map((e) => ({ ...e, g }))] };
}

/** Drop the last group. */
export function undo(s: Session): Session {
  if (!s.log.length) return s;
  const g = s.log[s.log.length - 1].g;
  return { ...s, log: s.log.filter((e) => e.g !== g) };
}

/** Drop group `g` from anywhere in the log; the replay then says whether what follows still holds. */
export function removeGroup(s: Session, g: number): Session {
  return { ...s, log: s.log.filter((e) => e.g !== g) };
}

/** Change the outcome of entry `i` (a roll's dice, a steal's card, a bought card; null for not seen). */
export function setOutcome(s: Session, i: number, o: [number, number] | null): Session {
  const log = s.log.slice();
  log[i] = { ...log[i], o };
  return { ...s, log };
}

/** What the engine's `sandbox_resolve` reads. */
export function wire(s: Session, hints: [number, number][] = []) {
  return JSON.stringify({
    board: s.board, n: s.n, seed: s.seed, hints,
    log: s.log.map((e) => (e.took ? [e.a, e.o, e.took] : [e.a, e.o])),
  });
}

const isInt = (x: unknown) => Number.isInteger(x);
const isCanon = (a: unknown) => Array.isArray(a) && a.length === 4 && typeof a[0] === "string" && a.slice(1).every(isInt);
const isPair = (o: unknown) => Array.isArray(o) && o.length === 2 && o.every(isInt);

/** A session from a file or storage, or null if it isn't one. The engine checks the rules; this checks the shape. */
export function parse(text: string): Session | null {
  let v: Partial<Session>;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || v.v !== 1 || !isInt(v.seed) || v.n !== 4 || !isInt(v.you) || v.you! < 0 || v.you! > 3 || typeof v.started !== "boolean") return null;
  const b = v.board;
  if (!b || !Array.isArray(b.tiles) || b.tiles.length !== 19 || !Array.isArray(b.ports) || b.ports.length !== 9) return null;
  if (!b.tiles.every((t) => t === null || (isPair(t) && t[0] >= -1 && t[0] <= 4 && t[1] >= 0 && t[1] <= 12))) return null;
  if (!b.ports.every((p) => p === null || (isInt(p) && p >= -1 && p <= 4))) return null;
  if (!Array.isArray(v.log) || !v.log.every((e) => e && isCanon(e.a) && (e.o === null || isPair(e.o)) && isInt(e.g)
      && (e.took === undefined || (Array.isArray(e.took) && e.took.length === 4 && e.took.every(isInt))))) return null;
  if (v.started && !boardComplete(b)) return null;
  return v as Session;
}

export const serialize = (s: Session) => JSON.stringify(s);

/** The maritime rate a seat gets for `res` from the ports it has built on: 2 on that resource's port, 3 on any 3:1. */
export function rateFor(seat: number, res: number, ports: { resource: number; nodes: number[] }[], owner: number[]) {
  let rate = 4;
  for (const p of ports) {
    if (!p.nodes.some((n) => owner[n] === seat)) continue;
    if (p.resource === res) rate = Math.min(rate, 2);
    else if (p.resource < 0) rate = Math.min(rate, 3);
  }
  return rate;
}

/** A domestic trade as the engine plays one: the offer, every other seat's answer in seat order (the partner's an
 *  accept), and the turn player's confirmation. */
export function tradeEntries(turn: number, partner: number, give: number[], get: number[], n = 4): Omit<Entry, "g">[] {
  const pack = (c: number[]) => c.reduce((acc, x, i) => acc + ((x & 31) << (5 * i)), 0);
  const out: Omit<Entry, "g">[] = [{ a: ["OFFER_TRADE", pack(give), pack(get), -1], o: null }];
  for (let s = 0; s < n; s++) if (s !== turn) out.push({ a: [s === partner ? "ACCEPT_TRADE" : "REJECT_TRADE", -1, -1, -1], o: null });
  out.push({ a: ["CONFIRM_TRADE", partner, -1, -1], o: null });
  return out;
}
