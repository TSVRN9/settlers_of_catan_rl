// A game as a link: the engine's compact record (catan_engine/src/compact.rs) with the lineup in its seats section,
// deflated and base64url-encoded into the address's fragment, which never reaches a server. The engine owns the
// steps; this file owns the seats section and the text of the link. Self-check:
//   node --experimental-strip-types web/src/share.ts
import type { BotKind, BotSpec } from "./engine";

/** Occupants by id, part of the link format: append only. */
export const KINDS: readonly BotKind[] = ["human", "random", "heuristic", "vnet", "drrl", "jsrobot", "jsdroid", "uct", "buct", "vpi"];
/** No real game inflates past this (the longest measured is ~2 KB of steps). */
export const MAX_BYTES = 64 * 1024;
const VERSION = 1, SEATS = 1;

const varint = (x: number, out: number[]) => { while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x = Math.floor(x / 128); } out.push(x); };

/** The seats section: per seat its occupant's id, its search depth and a settings string (empty: none yet). */
export function seatsSection(lineup: BotSpec[]): Uint8Array {
  const body: number[] = [];
  for (const b of lineup) body.push(Math.max(0, KINDS.indexOf(b.kind)), b.depth & 0xff, 0);
  const out = [SEATS];
  varint(body.length, out);
  return Uint8Array.from([...out, ...body]);
}

/** What a link says before its steps are replayed: the seed, the seat count and, if it carries them, the seats. A
 *  section it doesn't know is skipped; a malformed header throws. */
export function readHeader(b: Uint8Array): { seed: number; n: number; seats: BotSpec[] | null } {
  let at = 0;
  const byte = () => { if (at >= b.length) throw new Error("the link ends early"); return b[at++]; };
  const num = () => { let x = 0, m = 1; for (let k = 0; k < 5; k++) { const v = byte(); x += (v & 0x7f) * m; if (v < 0x80) return x; m *= 128; } throw new Error("a number is too long"); };
  if (byte() !== VERSION) throw new Error("another version");
  const seed = num(), n = byte();
  let seats: BotSpec[] | null = null;
  for (let tag = byte(); tag !== 0; tag = byte()) {
    const len = num(), end = at + len;
    if (end > b.length) throw new Error("a section runs past the end");
    if (tag === SEATS) {
      const out: BotSpec[] = [];
      while (at < end) {
        const kind = KINDS[byte()], depth = byte();
        const settings = num();                        // the settings string, unused so far (`at += num()` would
        at += settings;                                // read `at` before num() moves it)
        if (!kind) { out.length = 0; break; }
        out.push({ kind, depth });
      }
      seats = out.length === n ? out : null;
    }
    at = end;
  }
  return { seed, n, seats };
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, cap: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { await reader.cancel(); throw new Error("the link is too big"); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The record's bytes as the text after `#/r/`. */
export async function toCode(bytes: Uint8Array): Promise<string> {
  const z = await pipe(bytes, new CompressionStream("deflate-raw"), Infinity);
  let s = "";
  for (const x of z) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The text after `#/r/` back as the record's bytes. Anything that isn't one throws. */
export async function fromCode(code: string): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("not a link");
  const s = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  return pipe(Uint8Array.from(s, (c) => c.charCodeAt(0)), new DecompressionStream("deflate-raw"), MAX_BYTES);
}

/** The code in an address, if it is a link to a game. */
export const linkCode = (hash: string) => /^#\/r\/([A-Za-z0-9_-]+)/.exec(hash)?.[1] ?? null;

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1]?.endsWith("share.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`share self-check: ${m}`); };
  const lineup: BotSpec[] = [{ kind: "vnet", depth: 2 }, { kind: "human", depth: 2 }, { kind: "jsrobot", depth: 1 }, { kind: "vpi", depth: 3 }];
  // A header the engine would write: version, seed 300 (two varint bytes), four seats, an unknown section, the seats.
  const head = Uint8Array.from([1, 0xac, 0x02, 4, 9, 2, 7, 7, ...seatsSection(lineup), 0, 5, 1, 3]);
  const h = readHeader(head);
  assert(h.seed === 300 && h.n === 4, `seed and seats: ${JSON.stringify(h)}`);
  assert(JSON.stringify(h.seats) === JSON.stringify(lineup), `the seats round-trip past an unknown section: ${JSON.stringify(h.seats)}`);
  assert(readHeader(Uint8Array.from([1, 5, 3, 0])).seats === null, "no seats section: unnamed seats");
  assert(readHeader(Uint8Array.from([1, 5, 2, 1, 3, 99, 2, 0, 0])).seats === null, "an unknown occupant: unnamed seats");
  let threw = 0;
  for (const bad of [[2, 5, 4, 0], [1, 5, 4, 1, 40, 0], [1], [1, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]]) {
    try { readHeader(Uint8Array.from(bad)); } catch { threw++; }
  }
  assert(threw === 4, "a malformed header throws");
  const code = await toCode(head);
  assert(/^[A-Za-z0-9_-]+$/.test(code), "a code is fragment-safe");
  assert((await fromCode(code)).join() === head.join(), "the code round-trips");
  assert(linkCode(`#/r/${code}`) === code && linkCode("#/g/12") === null, "a link's code");
  // A garbled code may still inflate (deflate has no checksum): the header, then the engine's decoder, refuse it.
  for (const bad of ["", "not a code!", "AAAA"]) {
    let ok = false;
    try { readHeader(await fromCode(bad)); } catch { ok = true; }
    assert(ok, `garbage throws: ${bad}`);
  }
  // A bomb: a code that inflates past the cap throws instead of filling memory.
  const big = await toCode(new Uint8Array(MAX_BYTES + 1));
  let capped = false;
  try { await fromCode(big); } catch { capped = true; }
  assert(capped, "the inflated size is capped");
  console.log("share self-check ok");
}
