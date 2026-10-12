// Usage: node web/tools/record_size.mjs <label> <games> <bot> <bot> <bot> <bot>   (after pnpm build:wasm)
// How big a full game record gets, raw and as a link: JSON, deflated JSON, and a compact binary
// (each action as its index in that step's legal list, plus one byte per random outcome), deflated.
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
const W = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = await import(W + "/src/engine/catan_engine.js");
await pkg.default({ module_or_path: readFileSync(W + "/src/engine/catan_engine_bg.wasm") });
const meta = JSON.parse(readFileSync(W + "/public/models/v89w.json", "utf8"));
const weights = new Uint8Array(readFileSync(W + "/public/models/v89w.bin"));
const [label, games, ...bots] = process.argv.slice(2);
const b64 = (buf) => Buffer.from(buf).toString("base64url").length;
const varint = (n, out) => { while (n >= 128) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); };
const rows = [];
for (let g = 0; g < +games; g++) {
  const e = new pkg.Engine(1000 + g, 4);
  if (bots.includes("vnet")) e.load_net(weights, meta.hidden);
  const idx = []; let maxLegal = 0;
  while (e.winner() < 0 && e.num_turns() < 1500) {
    const legal = JSON.parse(e.legal_actions()); maxLegal = Math.max(maxLegal, legal.length);
    const seat = e.current_player();
    const a = JSON.parse(e.decide(bots[seat], 2)).action;
    idx.push(legal.findIndex((x) => JSON.stringify(x) === JSON.stringify(a)));
    e.apply(JSON.stringify(a));
  }
  const rec = e.record(), r = JSON.parse(rec);
  const bin = []; varint(r.seed, bin);
  r.log.forEach(([a, o], i) => {
    varint(idx[i], bin);
    if (a[0] === "ROLL") bin.push((o[0] - 1) * 6 + (o[1] - 1));
    else if (a[0] === "MOVE_ROBBER" || a[0] === "BUY_DEVELOPMENT_CARD" || a[0] === "DISCARD_RESOURCE") bin.push(o[0] + 1);
  });
  rows.push({ steps: r.log.length, turns: e.num_turns(), json: rec.length, jsonLink: b64(deflateRawSync(Buffer.from(rec), { level: 9 })), bin: bin.length, binLink: b64(deflateRawSync(Buffer.from(bin), { level: 9 })), maxLegal, done: e.winner() >= 0 });
}
const q = (k, p) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
console.log(JSON.stringify({ label, games: rows.length, unfinished: rows.filter((r) => !r.done).length,
  ...Object.fromEntries(["steps", "turns", "json", "jsonLink", "bin", "binLink", "maxLegal"].map((k) => [k, { med: q(k, 0.5), p90: q(k, 0.9), max: q(k, 1) }])) }));
