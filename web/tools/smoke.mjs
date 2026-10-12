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

const meta = JSON.parse(readFileSync(path.join(here, "../public/models/v89w.json"), "utf8"));
const weights = readFileSync(path.join(here, "../public/models/v89w.bin"));

const seed = 42;
const eng = new pkg.Engine(seed, 4);
eng.load_net(new Uint8Array(weights), meta.hidden);
assert.equal(eng.has_net(), true);
const map = JSON.parse(eng.map_json());
assert.equal(map.tiles.length, 19);
assert.equal(map.ports.length, 9);

// preview() must not mutate the live engine, and must actually apply the action to the
// returned view — otherwise the futures view would show six copies of the same board.
{
  const before = eng.view();
  const legal = JSON.parse(eng.legal_actions());
  const a = legal.find((x) => x[0] === "BUILD_ROAD" || x[0] === "BUILD_SETTLEMENT") ?? legal[0];
  const previewed = JSON.parse(eng.preview(JSON.stringify(a)));
  const beforeView = JSON.parse(before);
  assert.equal(eng.view(), before, "preview must not touch the live engine");
  assert.ok(
    JSON.stringify(previewed.owner) !== JSON.stringify(beforeView.owner) ||
    JSON.stringify(previewed.road_owner) !== JSON.stringify(beforeView.road_owner),
    "preview reflects the hypothetical move",
  );
}

const bots = ["vnet", "heuristic", "random", "heuristic"];
let sawAccept = false, sawDiscard = false;
let steps = 0, tVnet = 0, nVnet = 0, maxLeaves = 0, tPublic = 0;
while (eng.winner() < 0 && eng.num_turns() < 1000) {
  const seat = eng.current_player();
  const legal = JSON.parse(eng.legal_actions());
  assert.ok(legal.length > 0, "legal actions");
  // The phone's read-only helpers (wasm accepted_readings / suggest_discards) must not touch the live game.
  const v = JSON.parse(eng.view());
  if (v.prompt === "DECIDE_TRADE" && !sawAccept && [5, 6, 7, 8, 9].every((i, r) => v.players[seat].hand[r] >= v.current_trade[i])) {
    const before = eng.view();
    const r = JSON.parse(eng.accepted_readings(seat, 4));
    assert.ok(r.pub.length === 4 && r.full.length === 4, "readings after accepting, both kinds");
    assert.equal(eng.view(), before, "accepted_readings must not touch the live engine");
    sawAccept = true;
  }
  if (v.prompt === "DISCARD" && !sawDiscard) {
    const before = eng.view();
    const picks = JSON.parse(eng.suggest_discards("vnet", 1));
    assert.equal(picks.length, v.discard_counts[seat], "one pick per card owed");
    assert.ok(picks.every((a) => a[0] === "DISCARD_RESOURCE"), "picks are discards");
    assert.equal(eng.view(), before, "suggest_discards must not touch the live engine");
    sawDiscard = true;
  }
  const t0 = performance.now();
  const d = JSON.parse(eng.decide(bots[seat], 2));
  if (bots[seat] === "vnet" && legal.length > 1) { tVnet += performance.now() - t0; nVnet++; maxLeaves = Math.max(maxLeaves, d.leaves); }
  assert.ok(legal.some((a) => JSON.stringify(a) === JSON.stringify(d.action)), `bot picked an illegal action ${JSON.stringify(d.action)}`);
  eng.apply(JSON.stringify(d.action));
  steps++;
}
const view = JSON.parse(eng.view());
assert.ok(view.winner >= 0, "game reached a winner");
assert.ok(sawDiscard, "the smoke game had a discard to suggest");
const evals = JSON.parse(eng.evaluate_all());
assert.equal(evals.length, 4);
const attr = JSON.parse(eng.attribution(0));
assert.ok(Array.isArray(attr));

const record = eng.record();
const again = pkg.Engine.replay(record, -1);
assert.equal(again.view(), eng.view(), "replay reproduces the final view");
const half = pkg.Engine.replay(record, Math.floor(steps / 2));
assert.equal(half.steps(), Math.floor(steps / 2));

// Engine::replay goes through Engine::new, which sets net: None — a replayed engine cannot
// evaluate or run the value-net bot until the net is put back. The review worker depends on
// this, and comparing views alone would never have caught it.
assert.equal(half.has_net(), false, "replay is expected to come back without the net");
half.load_net(new Uint8Array(weights), meta.hidden);
assert.equal(half.has_net(), true);
assert.equal(JSON.parse(half.evaluate_all()).length, 4, "a reloaded replay evaluates");

// Public win chances (public.rs): evaluate_all's shape; the viewer's own seat is its exact reading; the same position
// reads the same in the live game's replay and in a second replay (the deals are seeded from the game, not the call).
{
  const spec = JSON.parse(half.evaluate_all_public(-1, 4));
  assert.equal(spec.length, 4);
  for (const r of spec) assert.ok(r.win >= 0 && r.win <= 1 && r.vps.length === 4 && Number.isFinite(r.turns_left), "public reading shape");
  for (let v = 0; v < 4; v++) {
    const pub = JSON.parse(half.evaluate_all_public(v, 4));
    assert.deepEqual(pub[v], JSON.parse(half.evaluate(v)), `viewer ${v} reads its own seat exactly`);
  }
  const other = pkg.Engine.replay(record, Math.floor(steps / 2));
  other.load_net(new Uint8Array(weights), meta.hidden);
  assert.equal(other.evaluate_all_public(1, 4), half.evaluate_all_public(1, 4), "same position, same public reading");
  assert.equal(eng.evaluate_all_public(-1, 4), eng.evaluate_all(), "a finished game reads as evaluate_all");
}

// The site keeps every step's view as the game is played (store.frames) and repositions its
// review engine with `Engine.replay(record, step)` for the ladder and attribution at one step.
// This walks the record forward with `apply()` and checks it lands on the live game's own final
// view — the argument that a frame at step i and a replay to step i are the same position.
{
  const rec = JSON.parse(record);
  const e2 = new pkg.Engine(rec.seed >>> 0, rec.n);
  e2.load_net(new Uint8Array(weights), meta.hidden);
  let frameCount = 0;
  for (const [action] of rec.log) {
    JSON.parse(e2.evaluate_all());   // a frame carries the evals of the position before its action
    // the live game (outcomes drawn) and its review (outcomes forced, so a different deck order and RNG) agree
    if (frameCount === Math.floor(steps / 2)) assert.equal(e2.evaluate_all_public(1, 4), half.evaluate_all_public(1, 4), "live and review read the same");
    const t0 = performance.now();
    JSON.parse(e2.evaluate_all_public(-1, 4));
    tPublic += performance.now() - t0;
    e2.apply(JSON.stringify(action));
    frameCount++;
  }
  assert.equal(frameCount, rec.log.length, "one frame per recorded action");
  assert.equal(frameCount, steps, "the walk covers every step the live game took");
  assert.equal(e2.view(), eng.view(), "walking the record forward reproduces the live game's final view");
}

// Board geometry is derived from the map's own node ids rather than from the order of the
// arrays in topology.json — the assumption that those two orders agree is undocumented and
// broke once. These are the invariants that derivation relies on.
const topo = JSON.parse(readFileSync(path.join(here, "../src/data/topology.json"), "utf8"));
const xy = topo.node_xy;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// topology.json stores node coordinates rounded to four decimals (0.866, not sqrt(3)/2),
// so the invariants hold to about 2e-5 rather than exactly. At S=44 that is 0.001px.
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-3, `${what}: ${a} vs ${b}`);
for (const p of map.ports) {
  const [a, b] = p.nodes.map((n) => xy[n]);
  near(dist(a, b), 1, `port ${p.id} dock nodes are one radius apart`);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), h = (Math.sqrt(3) / 2) * len;
  const c1 = [mx - (dy / len) * h, my + (dx / len) * h];
  const c2 = [mx + (dy / len) * h, my - (dx / len) * h];
  const c = Math.hypot(...c1) > Math.hypot(...c2) ? c1 : c2;
  near(dist(c, a), 1, `port ${p.id} centre to its first dock`);
  near(dist(c, b), 1, `port ${p.id} centre to its second dock`);
  // Both apexes of that triangle are equidistant from the two docks, so the two assertions
  // above pass for either one. This is the one that says we took the seaward apex.
  near(dist(c, topo.ports.find((q) => q.id === p.id).center), 0, `port ${p.id} centre is the seaward apex`);
}
const centres = new Set(map.tiles.map((t) => {
  const c = t.nodes.reduce((acc, n) => [acc[0] + xy[n][0], acc[1] + xy[n][1]], [0, 0]);
  return `${(c[0] / t.nodes.length).toFixed(4)},${(c[1] / t.nodes.length).toFixed(4)}`;
}));
assert.equal(centres.size, map.tiles.length, "every tile derives a distinct centre");
// The lineup allows two to four seats; the engine deals and plays any of them to a winner.
for (const n of [2, 3]) {
  const e = new pkg.Engine(seed + n, n);
  e.load_net(new Uint8Array(weights), meta.hidden);
  assert.equal(JSON.parse(e.view()).players.length, n, `${n} seats dealt`);
  assert.equal(JSON.parse(e.evaluate_all()).length, n, `${n} evaluations`);
  const kinds = ["vnet", "heuristic", "random"].slice(0, n);
  let k = 0;
  while (e.winner() < 0 && k < 4000) {
    const d = JSON.parse(e.decide(kinds[e.current_player()], 2));
    e.apply(JSON.stringify(d.action));
    k++;
  }
  assert.ok(e.winner() >= 0, `${n}-seat game reaches a winner`);
  assert.equal(JSON.parse(e.attribution(0)).length > 0, true, `${n}-seat attribution`);
}

// The site's net bot stops offering once two offers were refused in a turn (wasm.rs VNET_OFFER_CAP): a table that
// refuses everything, as a person often does, sees at most two offers a turn from it.
let capOffers = 0;
{
  const e = new pkg.Engine(seed + 7, 4);
  e.load_net(new Uint8Array(weights), meta.hidden);
  const perTurn = new Map();
  while (e.winner() < 0 && e.num_turns() < 1000) {
    const seat = e.current_player();
    const legal = JSON.parse(e.legal_actions());
    const reject = legal.find((a) => a[0] === "REJECT_TRADE");
    const a = seat !== 0 && reject ? reject : JSON.parse(e.decide(seat === 0 ? "vnet" : "heuristic", 2)).action;
    if (seat === 0 && a[0] === "OFFER_TRADE") perTurn.set(e.num_turns(), (perTurn.get(e.num_turns()) ?? 0) + 1);
    e.apply(JSON.stringify(a));
  }
  capOffers = [...perTurn.values()].reduce((x, y) => x + y, 0);
  assert.ok(capOffers > 0, "the net bot offered at least once, so the cap was exercised");
  assert.ok(Math.max(...perTurn.values()) <= 2, `at most two refused offers a turn, got ${Math.max(...perTurn.values())}`);
}

console.log(`smoke ok: accepted_readings ${sawAccept ? "checked" : "not reached"} + suggest_discards + geometry + replay-net + 2/3-seat games + offer cap (${capOffers} refused offers) checked; seed ${seed}, ${steps} steps, ${view.num_turns} turns, winner seat ${view.winner}, ` +
  `vnet ${nVnet} decisions avg ${(tVnet / Math.max(nVnet, 1)).toFixed(1)} ms (max leaves ${maxLeaves}), ` +
  `evaluate_all_public(-1, 4) avg ${(tPublic / steps).toFixed(2)} ms`);
