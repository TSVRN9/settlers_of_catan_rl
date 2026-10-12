// Plays a seated game on the phone layout in a headless Chromium, with real touch input (CDP touch events),
// and checks what a person would meet: looking back at a move on desktop and then narrowing the window
// does not strand the turn; a build card picks up from the keyboard and from a shaky tap; a cancelled
// touch drops the piece; a drag onto a spot builds; a drag let go among the spots but on none keeps the
// piece in hand without showing it snapped elsewhere; every button is at least 44px; the Roll slab rolls;
// the board's box never moves; nothing scrolls sideways; the game reaches its end. Screenshots land in
// the given directory.
//
//   pnpm dev   (in another shell)
//   node web/tools/phone_check.mjs [width] [height] [outDir]
//
// Uses Playwright's cached headless shell over the DevTools protocol (no Playwright dependency); a
// headless page is never "hidden", so the game's timers run at speed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const [W = 390, H = 844] = process.argv.slice(2, 4).map(Number);
const OUT = process.argv[4] ?? ".";
const URL_ = process.env.PHONE_URL ?? "http://localhost:5173/";
const cache = path.join(homedir(), ".cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell")).sort().pop();
const BIN = path.join(cache, shell, "chrome-headless-shell-linux64/chrome-headless-shell");
if (!existsSync(BIN)) throw new Error(`no headless shell at ${BIN}`);
mkdirSync(OUT, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(BIN, [`--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await wait(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (fn, arg) => {
  const r = await cdp("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, `${W}x${H}-${name}.png`), Buffer.from(r.data, "base64")); };


const size = (w, h, mobile) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
await cdp("Page.enable");
// Desktop first: deal, then look back at an earlier step, then narrow to the phone.
await size(1440, 900, false);
await cdp("Page.navigate", { url: URL_ });
await wait(3500);
await run(async () => {
  [...document.querySelectorAll("button")].find((b) => /Deal/.test(b.textContent)).click();
  await new Promise((r) => setTimeout(r, 2500));
  window.__app.set({ step: 0, crumbs: ["table", "game"] });
});
await size(W, H, true);
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
await wait(900);
const result = { stepCleared: await run(() => window.__app.get().step === null && !!document.querySelector(".ph")) };

// Play the seated person's moves with the heuristic bot until `until` holds, in the page.
const drive = (until) => run(async (src) => {
  const until = new Function("s", `return (${src})(s)`);
  for (let i = 0; i < 6000; i++) {
    const s = window.__app.get();
    if (until(s)) return true;
    if (s.view.winner >= 0) return false;
    if (s.view.current_player === s.human && s.status === "idle" && s.pendingHandoff == null && s.legal.length) {
      const d = await window.__app.live.decide("heuristic", 1); await window.__app.act(d.action);
    } else await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}, until.toString());
const touch = async (type, x, y) => cdp("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
const LIFT = 56;   // Phone.tsx passes liftPx 56 to Carry
const tap = (x, y) => cdp("Input.synthesizeTapGesture", { x, y, duration: 60 });
const state = () => run(() => { const s = window.__app.get(); return { carry: s.carry, roads: s.view.players[s.human].roads_available, steps: s.view.steps, snapped: !!document.querySelector(".carry .held-piece.snap") }; });
const putBack = () => run(() => window.__app.set({ carry: null }));

result.reachedBuild = await drive((s) => !s.view.initial_phase && s.view.prompt === "PLAY_TURN" && s.view.current_player === s.human && s.legal.some((a) => a[0] === "BUILD_ROAD") && !s.view.is_road_building);
try {
const card = await run(() => { const r = document.querySelectorAll(".ph-bcard")[0].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });

// Keyboard / assistive activation: a click with no pointer before it.
result.keyboard = await run(() => { const c = document.querySelectorAll(".ph-bcard")[0]; c.focus(); c.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); return window.__app.get().carry?.kind ?? null; });
await putBack();
// A shaky tap: 8px of travel is still a tap, and leaves the piece in hand.
await touch("touchStart", card[0], card[1]); await touch("touchMove", card[0] + 8, card[1] + 2); await touch("touchEnd");
await wait(300); result.shakyTap = (await state()).carry?.kind ?? null;
await putBack();
// A cancelled touch (a system gesture took it): the piece goes back, nothing stays mid-drag.
await touch("touchStart", card[0], card[1]); await touch("touchMove", card[0], card[1] - 120); await touch("touchCancel");
await wait(300); result.cancelled = (await state()).carry;
await putBack();

// A drag straight onto a spot.
{
  const spot = await run(async () => { const g = await import("/src/board/geometry.ts"); const a = window.__app.get().legal.find((x) => x[0] === "BUILD_ROAD"); return a[1]; });
  await touch("touchStart", card[0], card[1]); await touch("touchMove", card[0], card[1] - 40); await wait(200);
  const xy = await run(async (e) => { const g = await import("/src/board/geometry.ts"); const ctm = document.querySelector(".carry").getScreenCTM(); const [a, b] = g.EDGES[e].map((n) => { const [x, y] = g.nodeXY(n); const p = new DOMPoint(x, y).matrixTransform(ctm); return [p.x, p.y]; }); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }, spot);
  const b2 = (await state()).roads;
  await touch("touchMove", xy[0], xy[1] + LIFT); await wait(100); await touch("touchEnd"); await wait(1500);
  result.drag = { before: b2, after: (await state()).roads };
}


// Then, if a second road is affordable: a near miss, and a tap on the spot.
if (await run(() => window.__app.get().legal.some((a) => a[0] === "BUILD_ROAD"))) {
// Places for a road, and a near-miss point 32-44px off every legal edge, from the board's own geometry.
await touch("touchStart", card[0], card[1]); await touch("touchMove", card[0], card[1] - 40); await wait(200);
const geo = await run(async () => {
  const g = await import("/src/board/geometry.ts");
  const ctm = document.querySelector(".carry").getScreenCTM();
  const scr = (n) => { const [x, y] = g.nodeXY(n); const p = new DOMPoint(x, y).matrixTransform(ctm); return [p.x, p.y]; };
  const segs = window.__app.get().legal.filter((a) => a[0] === "BUILD_ROAD").map((a) => g.EDGES[a[1]].map(scr));
  const mid = segs.map(([[x1, y1], [x2, y2]]) => [(x1 + x2) / 2, (y1 + y2) / 2]);
  const segDist = ([px, py], [[x1, y1], [x2, y2]]) => { const k = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2))); return Math.hypot(x1 + k * (x2 - x1) - px, y1 + k * (y2 - y1) - py); };
  let miss = null;
  for (const rr of [36, 42, 48]) for (let k = 0; k < 24 && !miss; k++) {
    const p = [mid[0][0] + rr * Math.cos(k * Math.PI / 12), mid[0][1] + rr * Math.sin(k * Math.PI / 12)];
    const m = Math.min(...segs.map((sg) => segDist(p, sg)));
    if (m >= 32 && m <= 44) miss = p;
  }
  return { spot: mid[0], miss, n: segs.length };
});
const before = (await state()).roads;
await touch("touchMove", geo.miss[0], geo.miss[1] + LIFT); await wait(100); await touch("touchEnd"); await wait(400);
const afterMiss = await state();
result.nearMiss = { held: !!afterMiss.carry, built: afterMiss.roads !== before, snappedElsewhere: afterMiss.snapped };
// Then a tap on the spot places it there.
await tap(geo.spot[0], geo.spot[1]); await wait(1500);
const afterTap = await state();
result.tapPlaced = { before, after: afterTap.roads, carry: afterTap.carry };

}
} catch (e) { result.error = String(e).slice(0, 300); }

// The rest of the game: Roll through its slab once, the board's box, small buttons, sideways scroll.
const rest = await run(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, d = document;
  const boxes = new Map(), modes = new Set(), small = new Set();
  const box = (tag) => { const b = d.querySelector("#board-layer").getBoundingClientRect(); const k = [b.x, b.y, b.width, b.height].map(Math.round).join(","); if (!boxes.has(k)) boxes.set(k, tag); };
  const smallButtons = () => { for (const b of d.querySelectorAll(".ph button")) { const r = b.getBoundingClientRect(); if (r.width && r.height && (r.width < 44 || r.height < 44)) small.add(`${b.className || b.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`); } };
  let roll = null, overflowX = 0, tapThrough = null;
  for (let i = 0; i < 6000; i++) {
    const s = app.get();
    box(s.view.prompt);
    if (i % 20 === 0) smallButtons();
    if (d.documentElement.scrollWidth > innerWidth) overflowX++;
    if (s.view.winner >= 0) break;
    const mine = s.view.current_player === s.human && s.status === "idle" && s.pendingHandoff == null && s.legal.length;
    if (!mine) { await sleep(60); continue; }
    modes.add(d.querySelector(".ph-slab")?.firstElementChild?.className ?? "none");
    if (roll == null && s.legal.some((a) => a[0] === "ROLL")) { const b = s.view.steps; await sleep(600); d.querySelector(".ph-roll-slab").click();
      // A tap landing right after the slab turned from Roll to building must not reach End turn.
      for (let k = 0; k < 100 && !d.querySelector(".ph-build-slab"); k++) await sleep(10);
      const end = [...d.querySelectorAll(".ph-build-slab .ph-btn.go")].find((e) => !e.disabled);
      const at = app.get().view.steps;
      if (end) { end.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await sleep(300); tapThrough = app.get().view.steps !== at; }
      await sleep(1500); roll = app.get().view.steps > b; continue; }
    const dd = await app.live.decide("heuristic", 1); await app.act(dd.action);
  }
  const s = app.get();
  return { roll, tapThrough, overflowX, winner: s.view.winner, steps: s.view.steps, boxes: [...boxes].map(([k, v]) => `${v} ${k}`), modes: [...modes], small: [...small], overText: d.querySelector(".ph-over")?.innerText };
});
await shot("end");
console.log(JSON.stringify({ ...result, ...rest }, null, 1));
ws.close();
proc.kill();
