// The sandbox on a phone, driven by real touch (CDP touch events) in Playwright's cached headless shell, as
// phone_check.mjs does: set a board tile by tile, pick a seat, start, play the opening on the board's sockets, roll,
// build, a seven with its robber, a trade, undo, the log, a reload; at every step every button is at least 44px,
// nothing scrolls sideways and the board fits the width. Screenshots land in the given directory.
//
//   pnpm dev   (in another shell)
//   node web/tools/sandbox_phone.mjs [width] [height] [outDir]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const [W = 375, H = 667] = process.argv.slice(2, 4).map(Number);
const OUT = process.argv[4] ?? ".";
const URL_ = (process.env.PHONE_URL ?? "http://localhost:5173/") + "#/sandbox";
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
const pageErrors = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") pageErrors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300)); });
await cdp("Runtime.enable");
await cdp("Page.enable");
const shot = async (name) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, `sandbox-${W}x${H}-${name}.png`), Buffer.from(r.data, "base64")); };
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
const touch = (type, x, y) => cdp("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const tapAt = async (x, y) => { await touch("touchStart", x, y); await wait(40); await touch("touchEnd"); await wait(120); };
/** Tap the first element matching `sel` (and `text`, if given) that is enabled, by its centre. */
const tap = async (sel, text) => {
  const xy = await run(({ sel, text }) => {
    const el = [...document.querySelectorAll(sel)].find((e) => !e.disabled && (text == null || e.textContent.trim() === text || e.getAttribute("aria-label") === text));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, { sel, text });
  assert.ok(xy, `nothing to tap: ${sel} ${text ?? ""}`);
  await tapAt(xy[0], xy[1]);
};
const settle = () => run(async () => { for (let i = 0; i < 200; i++) { if (!document.querySelector(".sb-icon[aria-label=Undo]") || !document.querySelector(".sb-advice[aria-busy=true]")) break; await new Promise((r) => setTimeout(r, 50)); } await new Promise((r) => setTimeout(r, 150)); });
const session = () => run(() => JSON.parse(localStorage.getItem("sandbox.v1")));

const issues = new Set();
let checks = 0;
const check = async (where) => {
  checks++;
  const c = await run(() => {
    const small = [];
    for (const b of document.querySelectorAll(".sb button, .sb a")) {
      const r = b.getBoundingClientRect();
      if (r.width && r.height && (r.width < 44 || r.height < 44)) small.push(`${b.className || b.tagName} "${b.textContent.trim().slice(0, 12)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const a = document.querySelector(".sb-anchor")?.getBoundingClientRect();
    return { small, over: document.documentElement.scrollWidth > innerWidth, boardFits: !a || (a.left >= -0.5 && a.right <= innerWidth + 0.5 && a.width > 200) };
  });
  c.small.forEach((x) => issues.add(`${where}: small ${x}`));
  if (c.over) issues.add(`${where}: scrolls sideways`);
  if (!c.boardFits) issues.add(`${where}: board doesn't fit`);
};

await cdp("Page.navigate", { url: URL_ });
await wait(2500);
await run(() => localStorage.removeItem("sandbox.v1"));
await cdp("Page.reload");
await wait(2500);
await check("setup");
await shot("1-setup");

// ── the board: whatever piece is selected gets the first kind and number still left, as a person would tap them
for (let i = 0; i < 19; i++) {
  await tap(".sb-res");
  // the desert takes no number and moves straight on
  if (await run(() => [...document.querySelectorAll(".sb-nums .ph-btn")].some((b) => !b.disabled))) await tap(".sb-nums .ph-btn");
}
await check("tiles set");
await shot("2-tiles");
for (let i = 0; i < 9; i++) await tap(".sb-res");
await tap(".sb-you .sb-seatbtn", "You play second");
await check("board set");
await shot("3-board");
await tap(".sb-start");
await wait(3000);
await settle();
let s = await session();
assert.equal(s.started, true, "started");
assert.equal(s.you, 1);
await check("started");
await shot("4-opening");

// ── the opening: tap a socket on the board for each of the eight settlements and roads
const socket = () => run(() => {
  const el = document.querySelector(".carry [data-key]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
for (let i = 0; i < 16; i++) {
  const xy = await socket();
  assert.ok(xy, `a socket for placement ${i}`);
  await tapAt(xy[0], xy[1]);
  await wait(400);
  await settle();
}
s = await session();
assert.equal(s.log.length, 16, "the opening entered from the board");
await check("after opening");
await shot("5-roll");

// ── a turn: roll 8, end; seat 1 (you): roll 6, the advice is there, end
await tap(".sb-dice .ph-btn", "8"); await settle();
await check("rolled");
await shot("6-turn");
await tap(".sb-turn .ph-btn", "End turn"); await settle();
await tap(".sb-dice .ph-btn", "6"); await settle();
const tips = await run(async () => { for (let i = 0; i < 100 && !document.querySelector(".sb-tip .num"); i++) await new Promise((r) => setTimeout(r, 100)); return document.querySelectorAll(".sb-tip .num").length; });
assert.ok(tips > 0, "advice on your move");
await check("your turn");
await shot("7-advice");
// a trade from the sheet: give what you hold most of for one of something else from the next seat
await tap(".sb-turn .ph-btn", "Trade"); await wait(300);
await check("trade sheet");
await tap(".ph-sheet .sb-seatbtn");
await tap(".ph-sheet .sb-cards .card");
await shot("8-trade");
await tap(".ph-sheet .ph-btn", "Clear");
// close the sheet
await wait(500);
await run(() => document.querySelector(".ph-scrim").click());
await wait(200);
await tap(".sb-turn .ph-btn", "End turn"); await settle();

// ── rolls until a seat holds 8+, then a seven: discards (the cards each seat really holds, from the dev handle),
// then the robber and whom to rob
const title = () => run(() => document.querySelector(".ph-title").textContent);
for (let k = 0; k < 40; k++) {
  const most = await run(() => Math.max(...window.__sandbox.sim.view.players.map((p) => p.hand.reduce((a, b) => a + b, 0))));
  if (most >= 8) break;
  await tap(".sb-dice .ph-btn", String([6, 8, 5, 9, 10, 4][k % 6])); await settle();
  await tap(".sb-turn .ph-btn", "End turn"); await settle();
}
await tap(".sb-dice .ph-btn", "7"); await settle();
let discarded = 0;
for (let k = 0; k < 4 && /discards/.test(await title()); k++) {
  await check("discard");
  await shot("8b-discard");
  const hand = await run(() => { const v = window.__sandbox.sim.view; return v.players[v.current_player].hand; });
  const need = Number((await title()).match(/discards (\d+)/)[1]);
  for (let j = 0, r = 0; j < need; j++) {
    while (hand[r] === 0) r++;
    hand[r]--;
    const xy = await run((r) => { const c = document.querySelectorAll(".sb-col .sb-cards .card")[r].getBoundingClientRect(); return [c.x + c.width / 2, c.y + c.height / 2]; }, r);
    await tapAt(xy[0], xy[1]);
  }
  await tap(".sb-col .ph-btn.go"); await settle();
  discarded++;
}
assert.ok(discarded > 0, "someone discarded");
await check("robber");
await shot("9-robber");
const before = (await session()).log.length;
const xy = await socket();
await tapAt(xy[0], xy[1]); await wait(400);
// a victim chip, if the tile had one
const chip = await socket();
if (chip && /robber/.test(await title())) {
  await tapAt(chip[0], chip[1]);
  // the click a phone sends after the touch, on whatever is now under the finger
  await run((xy) => document.elementFromPoint(xy[0], xy[1])?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: xy[0], clientY: xy[1] })), chip);
  await wait(400);
}
if (await run(() => !!document.querySelector(".ph-sheet"))) {
  await check("steal sheet");
  await shot("9b-steal");
  // the card you took: one the victim holds (another is turned away, with the engine's reason)
  const victim = await run(() => { const t = document.querySelector(".ph-sheet .hd .d").textContent; return ["Red", "Blue", "Orange", "White"].findIndex((n) => t.startsWith(n)); });
  const r = await run((v) => window.__sandbox.sim.view.players[v].hand.findIndex((c) => c > 0), victim);
  const xy = await run((r) => { const c = document.querySelectorAll(".ph-sheet .card")[r].getBoundingClientRect(); return [c.x + c.width / 2, c.y + c.height / 2]; }, r);
  await tapAt(xy[0], xy[1]);
}
await settle();
if ((await session()).log.length <= before) { await shot("9x-robber-failed"); console.error(await title(), await run(() => document.querySelector(".ph-err")?.textContent)); }
assert.ok((await session()).log.length > before, "the robber moved");

// ── undo, the log, a roll fixed from it, a deleted entry, a file loaded, a reload
const n0 = (await session()).log.length;
await tap(".sb-icon[aria-label=Undo]"); await settle();
assert.ok((await session()).log.length < n0, "undo");
const openLog = async () => {
  await tap(".sb-icon[aria-label=Menu]"); await wait(300);
  await tap(".ph-sheet .ph-pickrow", await run(() => document.querySelector(".ph-sheet .ph-pickrow").textContent.trim()));
  await wait(300);
};
await openLog();
await check("log");
await shot("10-log");
const ss = await session();
const ri = ss.log.findIndex((e) => e.a[0] === "ROLL");
{
  const gs = [...new Set(ss.log.map((e) => e.g))];
  const row = gs.length - 1 - gs.indexOf(ss.log[ri].g);   // the log lists the latest first
  const xy = await run((k) => { const r = document.querySelectorAll(".sb-log .ph-pickrow")[k]; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, row);
  await tapAt(xy[0], xy[1]); await wait(300);
}
await check("entry");
await shot("10b-entry");
const was = ss.log[ri].o[0] + ss.log[ri].o[1];
const other = was === 6 ? "8" : "6";
await tap(".ph-sheet .sb-dice .ph-btn", other); await settle();
const fixedRoll = (await session()).log[ri].o;
assert.equal(fixedRoll[0] + fixedRoll[1], Number(other), "a roll fixed from the log");
await shot("10c-fixed");
const n2 = (await session()).log.length;
await openLog();
await tap(".sb-log .ph-pickrow"); await wait(300);
await tap(".ph-sheet .ph-pickrow.out"); await settle();
assert.ok((await session()).log.length < n2, "an entry deleted from the log");
const saved = path.join(OUT, "sandbox-saved.json");
writeFileSync(saved, JSON.stringify({ ...ss, log: ss.log.slice(0, 20) }));
await tap(".sb-icon[aria-label=Menu]"); await wait(300);
{
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: ".ph-sheet input[type=file]" });
  await cdp("DOM.setFileInputFiles", { nodeId, files: [saved] });
}
await wait(1500); await settle();
assert.equal((await session()).log.length, 20, "a session loaded from a file");
const n1 = (await session()).log.length;
const title1 = await title();
await cdp("Page.reload"); await wait(3000); await settle();
assert.equal((await session()).log.length, n1, "the session survives a reload");
assert.equal(await title(), title1, "and replays to the same position");
await check("reloaded");
await shot("11-reloaded");

proc.kill();
console.log(JSON.stringify({ size: `${W}x${H}`, checks, entries: n1, discarded, issues: [...issues], pageErrors }, null, 1));
if (issues.size || pageErrors.length) process.exit(1);
