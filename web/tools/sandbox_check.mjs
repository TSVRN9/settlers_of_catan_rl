// Runnable check for the sandbox (src/sandbox): a game played by random seats on a board entered tile by tile, logged
// as one seat would see it at the table (other seats' steals between each other and their bought cards unseen), must
// replay to the real position on everything that seat can know, through undo, a deleted entry, a corrected roll and a
// save/load round trip; a mistyped entry is caught at its own index; the readings and the advice come back.
// `node tools/sandbox_check.mjs` after `pnpm build:wasm` (Node 22.18+: it imports session.ts as it ships).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import * as S from "../src/sandbox/session.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = await import(path.join(here, "../src/engine/catan_engine.js"));
await pkg.default({ module_or_path: readFileSync(path.join(here, "../src/engine/catan_engine_bg.wasm")) });
const meta = JSON.parse(readFileSync(path.join(here, "../public/models/v89w.json"), "utf8"));
const weights = new Uint8Array(readFileSync(path.join(here, "../public/models/v89w.bin")));

/** session -> {view, fault, engine}, the way the worker does it. */
function replay(s, hints = []) {
  const r = JSON.parse(pkg.sandbox_resolve(S.wire(s, hints)));
  const e = pkg.Engine.replay(JSON.stringify({ seed: s.seed, n: s.n, board: s.board, log: r.log }), -1);
  return { view: JSON.parse(e.view()), fault: r.fault, engine: e, resolved: r.log.map(([, o]) => o) };
}

// ── the board, entered tile by tile off a "real" one (any number placement: two tokens swapped from the spiral)
const real = JSON.parse(new pkg.Engine(1234, 4).map_json());
const land = real.tiles.filter((t) => t.resource >= 0);
[land[0].number, land[7].number] = [land[7].number, land[0].number];
let s = S.blank(77);
assert.equal(S.boardComplete(s.board), false);
for (const t of real.tiles) {
  s = S.setTile(s, t.id, t.resource);
  if (t.resource >= 0) s = S.setNumber(s, t.id, t.number);
}
assert.equal(S.boardComplete(s.board), false, "ports still to set");
for (const p of real.ports) s = S.setPort(s, p.id, p.resource);
assert.ok(S.boardComplete(s.board), "a full BASE board");
const counts = S.left(s.board);
assert.ok(Object.values(counts.tiles).every((x) => x === 0) && Object.values(counts.numbers).every((x) => x === 0));
s = { ...s, you: 1, started: true };
{
  const bad = S.setTile(s, land[0].id, -1);       // two deserts
  assert.equal(S.boardComplete(bad.board), false);
  assert.throws(() => pkg.sandbox_resolve(S.wire(bad)), /tiles must be/);
}
const truth = pkg.Engine.replay(JSON.stringify({ seed: s.seed, n: 4, board: s.board, log: [] }), -1);
{
  const m = JSON.parse(truth.map_json());
  assert.deepEqual(m.tiles.map((t) => [t.resource, t.number]), real.tiles.map((t) => [t.resource, t.number]), "the board as entered");
  const v = JSON.parse(truth.view());
  assert.equal(m.tiles[v.robber].resource, -1, "the robber starts on the desert");
}

// ── play: random seats, the log as seat `you` sees it
let rng = 5;
const rand = (n) => { rng = (rng * 1103515245 + 12345) % 2 ** 31; return rng % n; };
const you = s.you;
let hidden = 0, traded = false, fixed = 0;
const publicOf = (v) => ({
  owner: v.owner, road_owner: v.road_owner, bank: v.bank, robber: v.robber, prompt: v.prompt, current: v.current_player,
  counts: v.players.map((p) => [p.hand.reduce((a, b) => a + b, 0), p.devs.reduce((a, b) => a + b, 0), p.vp, p.played.join()]),
  mine: [v.players[you].hand, v.players[you].devs],
});
for (let step = 0; step < 900 && truth.winner() < 0; step++) {
  const v = JSON.parse(truth.view());
  const p = v.current_player;
  const legal = JSON.parse(truth.legal_actions()).filter((a) => a[0] !== "OFFER_TRADE");
  // one domestic trade, entered as the sandbox enters it
  if (!traded && v.prompt === "PLAY_TURN" && v.players[p].has_rolled && !v.is_road_building) {
    const q = [0, 1, 2, 3].find((x) => x !== p && v.players[x].hand.some((c) => c > 0));
    const g = v.players[p].hand.findIndex((c) => c > 0);
    const w = q == null ? -1 : v.players[q].hand.findIndex((c, r) => c > 0 && r !== g);
    if (q != null && g >= 0 && w >= 0) {
      const give = [0, 0, 0, 0, 0], get = [0, 0, 0, 0, 0];
      give[g] = 1; get[w] = 1;
      const entries = S.tradeEntries(p, q, give, get);
      for (const e of entries) truth.apply(JSON.stringify(e.a));
      s = S.append(s, entries);
      traded = true;
      continue;
    }
  }
  const a = legal[rand(legal.length)];
  const took = a[0] === "PLAY_MONOPOLY" ? v.players.map((pl, i) => (i === p ? 0 : pl.hand[a[1]])) : undefined;
  const o = JSON.parse(truth.apply(JSON.stringify(a)));
  const seen = a[0] === "BUY_DEVELOPMENT_CARD" ? p === you : a[0] === "MOVE_ROBBER" && a[2] >= 0 ? p === you || a[2] === you : true;
  if (!seen) hidden++;
  s = S.append(s, [{ a, o: seen ? o : null, ...(took ? { took } : {}) }]);
  if (step % 60 === 59) {
    const r = replay(s);
    assert.equal(r.fault, null, `step ${step}: ${JSON.stringify(r.fault)}`);
    assert.deepEqual(publicOf(r.view), publicOf(JSON.parse(truth.view())), `step ${step}`);
    r.engine.free();
  }
}
assert.ok(hidden > 5, `hidden entries (${hidden})`);
assert.ok(traded, "a trade was entered");
let r = replay(s);
assert.equal(r.fault, null);
assert.deepEqual(publicOf(r.view), publicOf(JSON.parse(truth.view())));
// hints: the outcomes handed back replay the same position
{
  const again = replay(s, r.resolved);
  assert.deepEqual(again.view, r.view);
  again.engine.free();
}

// ── undo drops the last group; a deleted roll makes what followed not fit, and putting it back mends it
{
  const before = S.undo(s);
  assert.equal(before.log.length < s.log.length, true);
  const g = s.log[s.log.length - 1].g;
  assert.ok(before.log.every((e) => e.g !== g));
  const u = replay(before);
  assert.equal(u.fault, null);
  assert.equal(u.view.steps, before.log.length);
  u.engine.free();
  const rollAt = s.log.findIndex((e, i) => i > 40 && e.a[0] === "ROLL");
  const cut = S.removeGroup(s, s.log[rollAt].g);
  const c = replay(cut);
  assert.notEqual(c.fault, null, "a log missing a roll doesn't fit");
  assert.equal(c.fault.at, rollAt, "and says where");
  c.engine.free();
  // a corrected roll: same sum, other dice, is the same game
  const o = s.log[rollAt].o, sum = o[0] + o[1];
  const re = S.setOutcome(s, rollAt, S.SUM_PAIR[sum]);
  const rr = replay(re);
  assert.equal(rr.fault, null);
  assert.deepEqual(publicOf(rr.view), publicOf(r.view));
  rr.engine.free();
  fixed++;
}

// ── a mistyped entry is caught at its own index
{
  const v = r.view;
  const bad = S.append(s, [{ a: ["BUILD_CITY", v.owner.findIndex((o) => o < 0), -1, -1], o: null }]);
  const b = replay(bad);
  assert.equal(b.fault?.at, s.log.length);
  b.engine.free();
}

// ── save / load
{
  const text = S.serialize(s);
  const back = S.parse(text);
  assert.deepEqual(back, s);
  assert.equal(S.parse("{"), null);
  assert.equal(S.parse(JSON.stringify({ ...s, board: { ...s.board, tiles: s.board.tiles.slice(1) } })), null);
  assert.equal(S.parse(JSON.stringify({ ...s, log: [{ a: ["ROLL"], o: null, g: 0 }] })), null);
  const l = replay(back);
  assert.deepEqual(l.view, r.view, "a loaded session replays to the same position");
  l.engine.free();
}

// ── the readings and the advice
{
  const e = r.engine;
  e.load_net(weights, meta.hidden);
  const pub = JSON.parse(e.evaluate_all_public(you, 16));
  assert.equal(pub.length, 4);
  assert.ok(pub.every((x) => x.win >= 0 && x.win <= 1));
  // a position with `you` on move: walk the real game's log back to one
  let at = s.log.length;
  while (at > 0) {
    const t = replay({ ...s, log: s.log.slice(0, at) });
    if (t.view.current_player === you && t.view.prompt === "PLAY_TURN" && t.view.winner < 0) {
      t.engine.load_net(weights, meta.hidden);
      const d = JSON.parse(t.engine.decide_full("vnet", 2));
      assert.ok(d.root.length >= 1, "advice ranks the moves");
      const placements = JSON.parse(t.engine.placements());
      assert.ok(Array.isArray(placements));
      t.engine.free();
      break;
    }
    t.engine.free();
    at--;
  }
  assert.ok(at > 0, "found a position on your move");
}
// rate from ports
assert.equal(S.rateFor(0, 1, [{ resource: 1, nodes: [3, 4] }, { resource: -1, nodes: [7, 8] }], Array(54).fill(-1).map((_, i) => (i === 8 ? 0 : -1))), 3);
r.engine.free();
truth.free();
console.log(`sandbox: ${s.log.length} entries (${hidden} unseen), trade, undo, delete, corrected roll (${fixed}), mistyped entry, save/load, readings, advice: ok`);
// the page draws the board from topology.json before the engine exists: its tile and port ids must be the engine's
{
  const topo = JSON.parse(readFileSync(path.join(here, "../src/data/topology.json"), "utf8"));
  const m = JSON.parse(new pkg.Engine(1, 4).map_json());
  assert.deepEqual(topo.tiles.map((t) => t.nodes), m.tiles.map((t) => t.nodes));
  assert.deepEqual(topo.ports.map((p) => p.nodes), m.ports.map((p) => p.nodes));
}
