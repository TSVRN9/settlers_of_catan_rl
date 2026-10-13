// Usage: node web/tools/grade_margins.mjs <out.jsonl> <firstSeed> <games>   (after pnpm build:wasm)
// Grade margins: at each decision, margin = best root value - played move's value in decide_full("vnet",2).
// Lineups rotate [heuristic, jsrobot, random, vnet] by game index. Writes one JSONL row per decision, plus a
// {game:...} row per game with the winner and seat kinds.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const W = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = await import(W + "/src/engine/catan_engine.js");
await pkg.default({ module_or_path: readFileSync(W + "/src/engine/catan_engine_bg.wasm") });
const meta = JSON.parse(readFileSync(W + "/public/models/v89w.json", "utf8"));
const weights = new Uint8Array(readFileSync(W + "/public/models/v89w.bin"));
const [out, first, games] = process.argv.slice(2);
const KINDS = ["heuristic", "jsrobot", "random", "vnet"];
const cat = (t, init) =>
  init && (t === "BUILD_SETTLEMENT" || t === "BUILD_ROAD") ? "opening"
  : t.startsWith("BUILD_") ? "build" : t === "MOVE_ROBBER" ? "robber" : t === "DISCARD_RESOURCE" ? "discard"
  : t === "BUY_DEVELOPMENT_CARD" || t.startsWith("PLAY_") ? "dev" : t === "MARITIME_TRADE" ? "maritime"
  : t === "OFFER_TRADE" ? "offer" : /^(ACCEPT|REJECT|CONFIRM|CANCEL)_TRADE$/.test(t) ? "answer"
  : t === "ROLL" ? "roll" : t === "END_TURN" ? "end" : "other:" + t;
writeFileSync(out, "");
for (let g = +first; g < +first + +games; g++) {
  const e = new pkg.Engine(g, 4); e.load_net(weights, meta.hidden);
  const bots = [0, 1, 2, 3].map((s) => KINDS[(s + g) % 4]);
  let step = 0, rows = [];
  while (e.winner() < 0 && e.num_turns() < 1500) {
    const legal = JSON.parse(e.legal_actions()), seat = e.current_player();
    const a = JSON.parse(e.decide(bots[seat], 2)).action;
    if (legal.length > 1) {
      const init = !!JSON.parse(e.view()).initial_phase;
      const t0 = performance.now(), full = JSON.parse(e.decide_full("vnet", 2)), ms = performance.now() - t0;
      // Only valued root entries count, as in web/src/grade.ts margin().
      const ranked = full.root.filter(([, v]) => v != null && Number.isFinite(v));
      const k = JSON.stringify(a), hit = ranked.find(([x]) => JSON.stringify(x) === k);
      const best = Math.max(...ranked.map(([, v]) => v));
      rows.push(JSON.stringify({ g, step, seat, bot: bots[seat], cat: cat(a[0], init), init, margin: hit ? best - hit[1] : null, ms, n: full.root.length }));
    }
    e.apply(JSON.stringify(a)); step++;
  }
  rows.push(JSON.stringify({ game: g, winner: e.winner(), bots, done: e.winner() >= 0 }));
  appendFileSync(out, rows.join("\n") + "\n");
}
