// Runnable check for the wasm engine: play a full heuristic-vs-vnet game in Node, then prove the
// record replays to the identical position. `node web/tools/smoke.mjs` after `pnpm build:wasm`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = await import(path.join(here, "../src/engine/catan_engine.js"));
const wasm = readFileSync(path.join(here, "../src/engine/catan_engine_bg.wasm"));
await pkg.default({ module_or_path: wasm });

const meta = JSON.parse(readFileSync(path.join(here, "../public/models/v40.json"), "utf8"));
const weights = readFileSync(path.join(here, "../public/models/v40.bin"));

const seed = 42;
const eng = new pkg.Engine(seed, 4);
eng.load_net(new Uint8Array(weights), meta.hidden);
assert.equal(eng.has_net(), true);
const map = JSON.parse(eng.map_json());
assert.equal(map.tiles.length, 19);
assert.equal(map.ports.length, 9);

const bots = ["vnet", "heuristic", "random", "heuristic"];
let steps = 0, tVnet = 0, nVnet = 0, maxLeaves = 0;
while (eng.winner() < 0 && eng.num_turns() < 1000) {
  const seat = eng.current_player();
  const legal = JSON.parse(eng.legal_actions());
  assert.ok(legal.length > 0, "legal actions");
  const t0 = performance.now();
  const d = JSON.parse(eng.decide(bots[seat], 2));
  if (bots[seat] === "vnet" && legal.length > 1) { tVnet += performance.now() - t0; nVnet++; maxLeaves = Math.max(maxLeaves, d.leaves); }
  assert.ok(legal.some((a) => JSON.stringify(a) === JSON.stringify(d.action)), `bot picked an illegal action ${JSON.stringify(d.action)}`);
  eng.apply(JSON.stringify(d.action));
  steps++;
}
const view = JSON.parse(eng.view());
assert.ok(view.winner >= 0, "game reached a winner");
const evals = JSON.parse(eng.evaluate_all());
assert.equal(evals.length, 4);
const attr = JSON.parse(eng.attribution(0));
assert.ok(Array.isArray(attr));

const record = eng.record();
const again = pkg.Engine.replay(record, -1);
assert.equal(again.view(), eng.view(), "replay reproduces the final view");
const half = pkg.Engine.replay(record, Math.floor(steps / 2));
assert.equal(half.steps(), Math.floor(steps / 2));
console.log(`smoke ok: seed ${seed}, ${steps} steps, ${view.num_turns} turns, winner seat ${view.winner}, ` +
  `vnet ${nVnet} decisions avg ${(tVnet / Math.max(nVnet, 1)).toFixed(1)} ms (max leaves ${maxLeaves})`);
