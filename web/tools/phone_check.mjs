// Plays a seated game on the phone layout in a headless Chromium, with real touch input (CDP touch events),
// and checks what a person would meet: looking back at a move on desktop and then narrowing the window
// does not strand the turn; a build card picks up from the keyboard and from a shaky tap; a cancelled
// touch drops the piece; a drag onto a spot builds; a drag let go among the spots but on none keeps the
// piece in hand without showing it snapped elsewhere; every button is at least 44px; the Roll slab rolls;
// the board's box never moves; nothing scrolls sideways; the game reaches its end; Milestone 2's phases of a
// turn and Milestone 3's opening on touch, result, Rematch, lineup (resume, the seat sheet) and a watched game
// each run once; Milestone 4's pass and play; Milestone 5's watching (scrub, Live, the ending in the same block) and
// shared links (opened cold, with people in them, garbled); no uncaught page error. Screenshots land in the given directory.
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
const pageErrors = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") pageErrors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300)); });
await cdp("Runtime.enable");
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
// A tap as raw touch events: CDP's synthesizeTapGesture never fires `click` in the headless shell (not even on a
// plain button), so a check built on it misses every onClick a real phone would run.
const tap = async (x, y) => { await touch("touchStart", x, y); await wait(40); await touch("touchEnd"); };
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

// The rest of the game, driven from here so a probe can use real touch: Roll through its slab once, the board's
// box, small buttons, sideways scroll, and Milestone 2's probes, each run the first time its phase comes up.
// The person's moves follow a steered heuristic (buy development cards; hold cards until 9 so a seven costs a
// discard) so the phases come up; up to GAMES games are played until every probe in NEED has run.
const failed_extra = [];
const NEED = ["hurry", "discard", "offerIn", "builder", "offerOut", "devSheet", "pick", "robberVictim", "moveIcons", "counterIgnore",
              "opening", "gameOver", "rematch", "lineup", "watch",
              "cover", "coverFast", "coveredInput", "replay", "jump", "showHand", "answer", "handBack", "resumeCover",
              "scrub", "live", "watchEnd", "share", "filmPeople", "badLink",
              "gradeLive", "review", "reviewSeat", "reviewMove", "reviewBack", "stepLink", "reviewPlayed", "reviewPass",
              "sound", "haptics", "soundJump", "soundOff"];
const GAMES = Number(process.env.GAMES ?? 3);
const probes = {};
const probe = (k, v) => { if (probes[k] == null) probes[k] = v; };
const S = () => run(() => {
  const s = window.__app.get(), v = s.view;
  return { prompt: v.prompt, cur: v.current_player, human: s.human, status: s.status, winner: v.winner, steps: v.steps, opening: v.initial_phase,
           handoff: s.pendingHandoff, hurry: s.hurry, legal: s.legal, hand: v.players[s.human].hand, devs: v.players[s.human].devs,
           robber: v.robber, robTile: s.robTile, discard: v.discard_counts[s.human], trade: v.current_trade, resolving: v.is_resolving_trade };
});
const click = (sel) => run((q) => { const e = document.querySelector(q); if (!e || e.disabled) return false; e.click(); return true; }, sel);
const rect = (sel) => run((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }, sel);
const sleep = wait;
// The person's move when no probe takes it.
const policy = () => run(async () => {
  const app = window.__app, s = app.get(), v = s.view;
  const buy = s.legal.find((a) => a[0] === "BUY_DEVELOPMENT_CARD");
  let a = buy ?? (await app.live.decide("heuristic", 1)).action;
  const cards = v.players[s.human].hand.reduce((x, y) => x + y, 0);
  const end = s.legal.find((x) => x[0] === "END_TURN");
  if (!v.initial_phase && /^BUILD_/.test(a[0]) && cards < 9 && end && !v.is_road_building) a = end;
  await app.act(a);
});

const boxes = new Map(), modes = new Set(), small = new Set();
let roll = null, overflowX = 0, tapThrough = null, games = 0, winner = -1, hurriedTurn = -1;
const checks = () => run(() => {
  const d = document, small = [];
  for (const b of d.querySelectorAll(".ph button")) { const r = b.getBoundingClientRect(); if (r.width && r.height && (r.width < 44 || r.height < 44)) small.push(`${b.className || b.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`); }
  const b = d.querySelector("#board-layer").getBoundingClientRect();
  return { small, box: [b.x, b.y, b.width, b.height].map(Math.round).join(","), over: d.documentElement.scrollWidth > innerWidth, mode: d.querySelector(".ph-slab")?.firstElementChild?.className ?? "none" };
});
try {
for (let i = 0; i < 40000; i++) {
  const s = await S();
  if (i % 10 === 0) { const c = await checks(); if (!boxes.has(c.box)) boxes.set(c.box, s.prompt); c.small.forEach((x) => small.add(x)); if (c.over) overflowX++; }
  if (s.winner >= 0) {
    games++; winner = s.winner;
    // Milestone 3: the first ending is looked at, then Rematch is tapped and the rematch is the next game.
    if (probes.gameOver == null) {
      await sleep(1500);
      const c = await checks();
      const x = await run(() => {
        const e = document.querySelector(".ph-result"), s = window.__app.get();
        if (!e) return null;
        return { rows: e.querySelectorAll(".row").length, n: s.view.n, place: !!e.querySelector(".pl"), personWon: s.view.winner === s.human,
                 curve: !!e.querySelector(".curve"), fits: e.scrollHeight <= e.clientHeight + 1 };
      });
      await shot("over");
      probe("gameOver", { ...x, box: boxes.has(c.box), ok: !!x && x.rows === x.n && x.place === !x.personWon && x.curve && x.fits && boxes.has(c.box) });
      // Milestone 7: a whole game at your seat is heard: dice and their landing, set-downs, cards into your hand, your
      // turn; and felt, where the phone can: the landing, a set-down, your turn.
      const heard = await run(async () => { const m = await import("/src/sfx.ts"); return { cues: [...new Set(m.played.map((p) => p.cue))], buzz: m.buzzed.map((b) => JSON.stringify(b)) }; });
      probe("sound", { cues: heard.cues, ok: ["dice", "land", "card", "turn"].every((c) => heard.cues.includes(c)) && heard.cues.some((c) => ["set", "road", "city"].includes(c)) });
      probe("haptics", { buzz: [...new Set(heard.buzz)], ok: ["[12,40,12]", "[10,60,10]"].every((b) => heard.buzz.includes(b)) && (heard.buzz.includes("18") || heard.buzz.includes("8")) });
      // Milestone 6: the review of a game you played: your seat, your moves graded, and back to the result.
      const tv = await rect(".ph-toreview");
      if (tv) {
        await tap(tv[0] + tv[2] / 2, tv[1] + tv[3] / 2); await sleep(1500);
        for (let k = 0; k < 40 && (await run(() => Object.values(window.__app.get().grades).filter((g) => g.seat === window.__app.get().human).length)) < 10; k++) await sleep(500);
        const pr = await run(() => { const s = window.__app.get(); return { review: s.review, seat: s.reviewSeat, human: s.human, mine: Object.values(s.grades).filter((g) => g.seat === s.human).length,
          others: Object.values(s.grades).filter((g) => g.seat !== s.human).length, seatBtn: !!document.querySelector(".ph-seatpick") }; });
        await shot("review-played");
        (await checks()).small.forEach((q) => small.add(q));
        const back = await rect(".ph-back"); await tap(back[0] + back[2] / 2, back[1] + back[3] / 2); await sleep(700);
        const res = await run(() => !window.__app.get().review && !!document.querySelector(".ph-result"));
        probe("reviewPlayed", { ...pr, res, ok: pr.review && pr.seat === pr.human && pr.mine >= 10 && pr.others === 0 && !pr.seatBtn && res });
      }
      const seed = await run(() => window.__app.get().seed);
      const r = await rect(".ph-rematch");
      let y = null;
      if (r) {
        await tap(r[0] + r[2] / 2, r[1] + r[3] / 2);
        for (let k = 0; k < 40; k++) {
          await sleep(100);
          y = await run((seed) => { const s = window.__app.get(); return { phase: s.phase, steps: s.view.steps, same: s.seed === seed, winner: s.view.winner }; }, seed);
          if (y.phase === "playing" && y.winner < 0 && y.steps < 3) break;
        }
      }
      probe("rematch", { ...y, ok: !!y && y.phase === "playing" && y.same && y.winner < 0 && y.steps < 3 });
      if (games >= GAMES) break;
      continue;
    }
    const missing = NEED.filter((k) => probes[k] == null && !["lineup", "watch"].includes(k));
    if (!missing.length || games >= GAMES) break;
    await run(async (seed) => { window.__app.set({ seed }); await window.__app.start(); }, 1000 + games * 7919);
    await sleep(2500);
    continue;
  }
  const mine = s.cur === s.human && s.status === "idle" && s.handoff == null && s.legal.length;
  if (!mine) {
    // A bot's turn: tap the board to hurry it, once per turn (and that is the hurry probe).
    if (s.cur !== s.human && !s.hurry && hurriedTurn !== s.steps && s.handoff == null) {
      hurriedTurn = s.steps;
      const r = await rect(".ph-board");
      if (r) { await tap(r[0] + 6, r[1] + 6); await sleep(60); if ((await S()).hurry) probe("hurry", true); }
    }
    if (probes.moveIcons == null && s.cur !== s.human && !s.opening) {
      const n = await run(() => document.querySelectorAll(".ph-move .ic svg").length);
      if (n > 0) { probe("moveIcons", { icons: n, ok: true }); await shot("moves"); }
    }
    await sleep(40); continue;
  }
  modes.add((await checks()).mode);
  // The opening on touch: the draft order is in the top bar, the supply holds the piece, and a tap on a legal
  // corner puts the settlement there.
  if (s.opening && probes.opening == null && s.legal.some((a) => a[0] === "BUILD_SETTLEMENT")) {
    await sleep(600);
    const d = await run(() => ({ cells: document.querySelectorAll(".ph-draft i").length, now: document.querySelectorAll(".ph-draft i.now").length,
                                 supply: !!document.querySelector(".ph-supply"), n: window.__app.get().view.n }));
    const xy = await run(async () => {
      const g = await import("/src/board/geometry.ts"), s = window.__app.get();
      const a = s.legal.find((x) => x[0] === "BUILD_SETTLEMENT");
      const p = new DOMPoint(...g.nodeXY(a[1])).matrixTransform(document.querySelector(".carry").getScreenCTM());
      return { at: [p.x, p.y], node: a[1] };
    });
    await shot("opening");
    await tap(...xy.at);
    const mineAt = () => run((n) => { const s = window.__app.get(); return s.view.owner[n] === s.human; }, xy.node);
    for (let k = 0; k < 30 && !(await mineAt()); k++) await sleep(100);
    const placed = await mineAt();
    probe("opening", { ...d, placed, ok: d.cells === 2 * d.n && d.now === 1 && d.supply && placed });
    continue;
  }
  if (roll == null && s.legal.some((a) => a[0] === "ROLL")) {
    await sleep(600);
    const b = s.steps;
    await click(".ph-roll-slab");
    // A tap landing right after the slab turned from Roll to building must not reach End turn.
    tapThrough = await run(async () => {
      const d = document, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), app = window.__app;
      for (let k = 0; k < 100 && !d.querySelector(".ph-build-slab"); k++) await sleep(10);
      const end = [...d.querySelectorAll(".ph-build-slab .ph-btn.go")].find((e) => !e.disabled);
      if (!end) return null;
      const at = app.get().view.steps;
      end.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await sleep(300);
      return app.get().view.steps !== at;
    });
    await sleep(1500); roll = (await S()).steps > b; continue;
  }
  // Discard on a 7: Suggest fills the slots, a tap on a filled slot takes one back, and a tap on the hand
  // fills the last slot, which commits.
  if (s.prompt === "DISCARD" && probes.discard == null) {
    const need = s.discard, before = s.hand.reduce((a, b) => a + b, 0);
    const center = async (sel) => { const r = await rect(sel); return r && [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
    const pick = () => run(() => window.__app.get().discardPick.length);
    await sleep(600);   // a human beat: the slab drops taps for 400ms after it changes
    const sug = await center(".ph-discard-slab .ph-btn");
    if (sug) await tap(...sug);
    let suggested = 0;
    for (let k = 0; k < 40 && (suggested = await pick()) < need; k++) await sleep(100);
    await shot("discard");
    const slot = await center(".ph-slot.full");
    if (slot) await tap(...slot);
    await sleep(150);
    const tookBack = suggested - (await pick());
    const r = await run(() => { const s = window.__app.get(), h = s.view.players[s.human].hand; return h.findIndex((n, i) => n - s.discardPick.filter((p) => p === i).length > 0); });
    const st = await center(`.ph-stack[data-res="${r}"]`);
    if (st) await tap(...st);
    for (let k = 0; k < 60 && (await S()).prompt === "DISCARD" && (await S()).cur === s.human; k++) await sleep(100);
    const after = (await S()).hand.reduce((a, b) => a + b, 0);
    probe("discard", { need, suggested, tookBack, lost: before - after, ok: before - after === need && suggested === need && tookBack === 1 });
    continue;
  }
  const center = async (sel) => { const r = await rect(sel); return r && [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
  const tapSel = async (sel) => { const c = await center(sel); if (c) await tap(...c); return !!c; };
  // A later offer: Counter opens the builder on it turned round, Back returns to the offer, Ignore declines it
  // and mutes that seat for its turn.
  if (s.prompt === "DECIDE_TRADE" && probes.offerIn != null && probes.counterIgnore == null && s.legal.some((a) => a[0] === "OFFER_TRADE")) {
    await sleep(600);
    const from = s.trade[10];
    const btn = (label) => run((l) => { const b = [...document.querySelectorAll(".ph-answer .ph-btn")].find((x) => x.textContent.startsWith(l)); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, label);
    const c = await btn("Counter");
    if (c) await tap(...c);
    await sleep(300);
    const draft = await run(() => window.__app.get().offerDraft);
    const turned = draft.want.every((n, r) => n === s.trade[r]) && draft.give.every((n, r) => n === Math.min(s.trade[5 + r], s.hand[r]));
    const builder = !!(await rect(".ph-builder"));
    await shot("counter");
    await tapSel(".ph-builder-slab .ph-btn:not(.go)"); await sleep(600);
    const back = !!(await rect(".ph-offer"));
    const ig = await btn("Ignore");
    if (ig) await tap(...ig);
    await sleep(800);
    const muted = await run(() => window.__app.get().mutedSeat);
    const answered = (await S()).steps > s.steps;
    probe("counterIgnore", { counter: !!c, builder, turned, back, muted: muted === from, answered, ok: !!c && builder && turned && back && muted === from && answered });
    continue;
  }
  // An offer to you: the cards, what accepting does (Eval on), then Accept.
  if (s.prompt === "DECIDE_TRADE" && probes.offerIn == null) {
    await sleep(600);
    const slab = !!(await rect(".ph-offer"));
    let eff = 0;
    for (let k = 0; k < 30 && (eff = await run(() => document.querySelectorAll(".ph-offer .eff .num").length)) < 2; k++) await sleep(100);
    const lifted = await run(() => document.querySelectorAll(".ph-card.lifted").length);
    await shot("offer-in");
    const accept = await run(() => !document.querySelector(".ph-offer-slab .ph-btn.go")?.disabled);
    await tapSel(accept ? ".ph-offer-slab .ph-btn.go" : ".ph-offer-slab .ph-btn:not(.go)");
    await sleep(800);
    const answered = (await S()).steps > s.steps;
    probe("offerIn", { slab, eff, lifted, accepted: accept, answered, ok: slab && eff === 2 && lifted > 0 && answered });
    continue;
  }
  // Your offer: Trade opens the builder, a hand card gives, a token asks, Offer sends it; the answers come back
  // under the chips; then trade with a taker, or withdraw.
  if (probes.builder == null && s.prompt === "PLAY_TURN" && !s.opening && s.legal.some((a) => a[0] === "OFFER_TRADE")
      && s.hand.some((n) => n > 0) && s.hand.some((n) => n === 0) && !s.legal.some((a) => a[0] === "ROLL")) {
    await sleep(600);
    await tapSel(".ph-build-slab .ph-row .ph-btn:not(.go)");
    await sleep(300);
    const open = !!(await rect(".ph-builder"));
    const most = s.hand.indexOf(Math.max(...s.hand)), none = s.hand.indexOf(0);
    await tapSel(`.ph-stack[data-res="${most}"]`); await sleep(150);
    const toks = await run(() => [...document.querySelectorAll(".ph-tokbtn")].map((b) => { const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
    if (toks[none]) await tap(...toks[none]);
    await sleep(150);
    const draft = await run(() => window.__app.get().offerDraft);
    const lifted = await run(() => document.querySelectorAll(".ph-card.lifted").length);
    const enabled = await run(() => !document.querySelector(".ph-builder-slab .ph-btn.go")?.disabled);
    await shot("builder");
    await tapSel(".ph-builder-slab .ph-btn.go");
    probe("builder", { open, draft, lifted, enabled, ok: open && draft.give[most] === 1 && draft.want[none] === 1 && lifted === 1 && enabled });
    let sawOut = false, badges = 0, traded = false, withdrew = false;
    for (let k = 0; k < 200; k++) {
      const x = await S();
      const out = await run(() => ({ out: !!document.querySelector(".ph-offer.out"), badges: document.querySelectorAll(".ph-answers .badge").length,
                                     take: !!document.querySelector(".ph-offer-slab .ph-btn.go"), cancel: !document.querySelector(".ph-offer-slab .ph-btn:not(.go)")?.disabled }));
      if (out.out && !sawOut) await shot("offer-out");
      sawOut ||= out.out; badges = Math.max(badges, out.badges);
      if (x.prompt === "DECIDE_ACCEPTEES" && x.cur === s.human) {
        await sleep(600);
        if (out.take) { traded = await tapSel(".ph-offer-slab .ph-btn.go"); } else if (out.cancel) { withdrew = await tapSel(".ph-offer-slab .ph-btn:not(.go)"); }
        await sleep(800);
      }
      if (!x.resolving && x.prompt === "PLAY_TURN" && k > 2) break;
      await sleep(100);
    }
    const ended = !(await S()).resolving;
    probe("offerOut", { sawOut, badges, traded, withdrew, ended, ok: sawOut && badges === 3 && ended });
    continue;
  }
  // Development cards: the pile spreads into the slab; a Year of Plenty or Monopoly picks there.
  const playable = (k) => s.legal.some((a) => a[0] === k);
  const yopOrMono = playable("PLAY_YEAR_OF_PLENTY") || playable("PLAY_MONOPOLY");
  // Road Building: played from the sheet, its free roads in hand, the build slab sunk (not the fallback list).
  if (s.prompt === "PLAY_TURN" && playable("PLAY_ROAD_BUILDING") && probes.roadBuilding == null) {
    await sleep(600);
    await tapSel(".ph-devs"); await sleep(600);   // past the slab's 400ms tap guard
    const i = await run(() => { const st = window.__app.get(); return st.view.players[st.human].devs.slice(0, 3).filter((n) => n > 0).length; });
    const at = await run((i) => { const b = document.querySelectorAll(".ph-devcard")[i]; if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, i);
    if (at) await tap(...at);
    await sleep(900);
    const x = await run(() => ({ rb: window.__app.get().view.is_road_building, slab: document.querySelector(".ph-slab")?.firstElementChild?.className ?? "" }));
    await shot("road-building");
    probe("roadBuilding", { ...x, ok: x.rb && x.slab.startsWith("ph-build-slab") });
    continue;
  }
  if (s.prompt === "PLAY_TURN" && s.devs.some((n) => n > 0) && !s.resolving && (probes.devSheet == null || (yopOrMono && probes.pick == null))) {
    await sleep(600);
    await tapSel(".ph-devs"); await sleep(600);
    const cards = await run(() => [...document.querySelectorAll(".ph-devcard")].map((b) => !b.disabled));
    probe("devSheet", { cards: cards.length, playable: cards.filter(Boolean).length, ok: cards.length > 0 });
    await shot("devs");
    if (yopOrMono && probes.pick == null) {
      const kind = playable("PLAY_YEAR_OF_PLENTY") ? 1 : 2;
      const before = s.hand.reduce((a, b) => a + b, 0);
      // The sheet lists held kinds in deck order; tap the one for this kind.
      const i = await run((k) => { const held = window.__app.get().view.players[window.__app.get().human].devs; return held.slice(0, k).filter((n) => n > 0).length; }, kind);
      const at = await run((i) => { const b = document.querySelectorAll(".ph-devcard")[i]; if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, i);
      if (at) await tap(...at);
      await sleep(400);
      const choices = await run(() => document.querySelectorAll(".ph-pick .ph-res").length);
      await shot("pick");
      for (let k = 0; k < 2 && (await S()).steps === s.steps; k++) { await tapSel(".ph-pick .ph-res"); await sleep(500); }
      await sleep(600);
      const x = await S();
      probe("pick", { kind, choices, played: x.steps > s.steps, ok: choices > 0 && x.steps > s.steps && (kind === 2 || x.hand.reduce((a, b) => a + b, 0) === before + 2) });
    } else {
      await tapSel(".ph-devsheet-slab .ph-btn");
      await sleep(300);
    }
    continue;
  }
  // The robber in hand: tap a tile (one with two or more seats to rob when there is one), then a victim's chip.
  if (s.prompt === "MOVE_ROBBER" && probes.robberVictim == null) {
    await sleep(600);
    const plan = await run(async () => {
      const g = await import("/src/board/geometry.ts");
      const app = window.__app, st = app.get(), map = st.map, v = st.view;
      const by = new Map();
      for (const a of st.legal) if (a[0] === "MOVE_ROBBER") by.set(a[1], [...(by.get(a[1]) ?? []), a[2]]);
      const tiles = [...by.entries()].sort((a, b) => b[1].filter((x) => x >= 0).length - a[1].filter((x) => x >= 0).length);
      const [tile, victims] = tiles[0];
      const ctm = document.querySelector(".carry").getScreenCTM();
      const scr = ([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(ctm); return [p.x, p.y]; };
      const t = map.tiles[tile];   // MOVE_ROBBER names the tile by its index (Board.tsx reads map.tiles[a[1]])
      const xy = t.nodes.map((n) => g.nodeXY(n));
      const c = scr([xy.reduce((a, p) => a + p[0], 0) / xy.length, xy.reduce((a, p) => a + p[1], 0) / xy.length]);
      const vs = victims.filter((x) => x >= 0);
      const node = vs.length > 1 ? t.nodes.find((n) => v.owner[n] === vs[0]) : null;
      return { tile, victims: vs, centre: c, chip: node != null ? scr([g.nodeXY(node)[0], g.nodeXY(node)[1] - 20]) : null };
    });
    await tap(...plan.centre); await sleep(700);
    const asked = (await S()).robTile;
    if (plan.chip && asked != null) { await shot("victims"); await tap(...plan.chip); }
    for (let k = 0; k < 30 && (await S()).prompt === "MOVE_ROBBER"; k++) await sleep(100);
    const x = await S();
    probe("robberVictim", { tile: plan.tile, victims: plan.victims.length, asked, moved: x.robber === plan.tile, ok: x.robber === plan.tile && (plan.victims.length < 2 || asked === plan.tile) });
    continue;
  }
  await policy();
  // Milestone 6: a person's piece set down gets its grade beside it, before anything else moves.
  if (probes.gradeLive == null) {
    const mine = await run(() => { const s = window.__app.get(), f = s.frames[s.frames.length - 2];
      return f && f.seat === s.human && /^(BUILD_|MOVE_ROBBER)/.test(f.action?.[0] ?? "") && s.evalShown ? s.frames.length - 2 : null; });
    if (mine != null) {
      let tag = null;
      for (let k = 0; k < 40 && tag == null; k++) {
        await sleep(100);
        tag = await run((i) => (window.__app.get().frames.length - 2 !== i ? "moved" : document.querySelector(".ph-gradetag")?.textContent ?? null), mine);
        if (tag && tag !== "moved") {
          const tr = await rect(".ph-gradetag");
          if (!(tr && tr[0] >= 0 && tr[0] + tr[2] <= W + 0.5)) failed_extra.push("gradeTagOffScreen");
        }
      }
      const g = await run((i) => window.__app.get().grades[i]?.grade ?? null, mine);
      if (tag && tag !== "moved") { await shot("gradetag"); probe("gradeLive", { step: mine, tag, g, ok: tag === g }); }
    }
  }
}
} catch (e) { result.error = (result.error ? result.error + " | " : "") + String(e).slice(0, 300); }
await shot("end");

// Milestone 3's lineup: back to it, a new game, back again and resume at the same step; a seat changed through its
// sheet; then nobody seated, and Play watches.
try {
  const tapQ = async (q) => {
    const r = await run((q) => { const e = document.querySelector(q); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, q);
    if (!r) return false;
    await tap(...r); await sleep(800); return true;
  };
  const L = () => run(() => {
    const s = window.__app.get(), sh = document.querySelector(".ph-sheet")?.getBoundingClientRect();
    return { phase: s.phase, steps: s.view?.steps, kinds: s.lineup.map((b) => b.kind), sheet: !!sh, sheetIn: !sh || sh.bottom <= innerHeight + 1,
             resume: !!document.querySelector(".ph-resume"), chips: document.querySelectorAll(".ph-chip").length, n: s.lineup.length,
             rows: document.querySelectorAll(".ph-standings .row").length, curve: !!document.querySelector(".ph-curve"), transport: document.querySelectorAll(".ph-transport button").length,
             hand: !!document.querySelector(".ph-hand, .ph-you") };
  });
  await tapQ(".ph-back");
  (await checks()).small.forEach((x) => small.add(x));
  await shot("lineup");
  await tapQ(".ph-play"); await sleep(4000);
  await tapQ(".ph-back");
  const behind = await L();
  await tapQ(".ph-resume"); await sleep(300);
  const resumed = await L();
  await tapQ(".ph-back");
  const seat = behind.kinds.findIndex((k) => k !== "human");
  await tapQ(`.ph-seatrow[data-seat="${seat}"]`);
  const sheet = await L();
  (await checks()).small.forEach((x) => small.add(x));
  await shot("sheet");
  await tapQ('.ph-pickrow[data-kind="random"]');
  const picked = await L();
  probe("lineup", { behind: behind.resume, resumed: resumed.phase === "playing" && resumed.steps === behind.steps, sheet: sheet.sheet && sheet.sheetIn, picked: picked.kinds[seat],
                    ok: behind.phase === "lineup" && behind.resume && resumed.phase === "playing" && resumed.steps === behind.steps && sheet.sheet && sheet.sheetIn && !picked.sheet && picked.kinds[seat] === "random" });
  for (const [i, k] of picked.kinds.entries()) if (k === "human") { await tapQ(`.ph-seatrow[data-seat="${i}"]`); await tapQ('.ph-pickrow[data-kind="heuristic"]'); }
  await tapQ(".ph-play"); await sleep(4000);
  const w = await L();
  await shot("watch");
  // Milestone 5: watching, the seats are the standings under the board; no chips, no hand.
  probe("watch", { ...w, ok: w.phase === "playing" && w.kinds.every((k) => k !== "human") && w.chips === 0 && w.rows === w.n && w.curve && w.transport === 4 && !w.hand });
} catch (e) { result.error = (result.error ? result.error + " | " : "") + String(e).slice(0, 300); }

// Milestone 4, pass and play: Blue and Orange are people, Red and White bots, up to 2 games. On every iteration no hand
// may show while a cover is up and nothing under it may be live (`leak`); each cover is looked at, then Show hand.
result.leak = 0;
try {
  const P = () => run(() => {
    const s = window.__app.get(), v = s.view, c = document.querySelector(".ph-cover");
    const vis = (q) => { const e = document.querySelector(q); return !!e && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().height > 0; };
    return { cover: c ? +c.dataset.seat : null, why: c?.querySelector(".why")?.textContent ?? "", rows: c ? c.querySelectorAll(".ph-cover-row").length : 0,
             step: s.step, holder: s.holder, human: s.human, cur: v.current_player, turn: v.current_turn, prompt: v.prompt, status: s.status, winner: v.winner,
             steps: v.steps, legal: s.legal, hand: vis(".ph-hand") || vis(".ph-you"), inert: !!document.querySelector(".ph-seat [inert]"),
             chips: [...document.querySelectorAll(".ph-chip")].map((e) => +e.dataset.seat), you: document.querySelector(".ph-you .nm")?.textContent ?? null,
             fits: c ? c.scrollHeight <= c.clientHeight + 1 : null };
  });
  const tapQ = async (q) => { const r = await rect(q); if (!r) return false; await tap(r[0] + r[2] / 2, r[1] + r[3] / 2); return true; };
  const lineup = [{ kind: "heuristic", depth: 2 }, { kind: "human", depth: 2 }, { kind: "human", depth: 2 }, { kind: "heuristic", depth: 2 }];
  let lastKey = null, answered = false;
  for (let g = 0; g < 2 && ["cover", "coverFast", "coveredInput", "replay", "jump", "showHand", "answer", "handBack", "resumeCover"].some((k) => probes[k] == null); g++) {
    await run(async ({ lineup, seed }) => { const a = window.__app; a.set({ seed, lineup, human: 1 }); await a.start(); }, { lineup, seed: 4242 + g });
    await sleep(2000);
    for (let it = 0; it < 8000; it++) {
      const x = await P();
      if (x.winner >= 0) {
        if (probes.reviewPass == null) {
          await sleep(1500); await tapQ(".ph-toreview"); await sleep(2500);
          await tapQ(".ph-key"); await sleep(900);
          const rp = await run(() => { const s = window.__app.get(); return { review: s.review, seat: s.reviewSeat, winner: s.frames[s.frames.length - 1].view.winner,
            you: /\bYou\b|\byour?\b/i.test(document.querySelector(".ph-review")?.innerText ?? ""), seatBtn: !!document.querySelector(".ph-seatpick") }; });
          await shot("review-pass");
          probe("reviewPass", { ...rp, ok: rp.review && rp.seat === rp.winner && !rp.you && rp.seatBtn });
          await tapQ(".ph-back"); await sleep(300); await tapQ(".ph-back"); await sleep(300);
        }
        break;
      }
      if (x.cover != null) {
        if (x.hand || !x.inert) result.leak++;
        const key = `${x.cover}|${x.why}|${x.turn}`;
        if (key !== lastKey) {
          lastKey = key;
          probe("cover", { seat: x.cover, chipsReseated: !x.chips.includes(x.cover), fits: x.fits, ok: !x.chips.includes(x.cover) && x.fits });
          (await checks()).small.forEach((q) => small.add(q));
          if (x.why) { if (probes.answer == null) { await shot("answer"); probe("answer", { seat: x.cover, why: x.why, ok: x.cover === x.cur && x.cover !== x.turn }); } answered = true; }
          else if (answered) { probe("handBack", { seat: x.cover, turn: x.turn, ok: x.cover === x.turn }); answered = false; }
          if (probes.replay == null && x.rows > 2) {
            await sleep(200);
            const seen = [(await P()).step];
            for (let k = 0; k < 60; k++) { await sleep(250); const y = await P(); if (y.step !== seen[seen.length - 1]) seen.push(y.step); if (y.step == null) break; }
            probe("replay", { steps: seen, ok: seen.filter((q) => q != null).length >= 2 && seen[seen.length - 1] == null });
            await shot("replay");
            const rowStep = await run(() => { const r = document.querySelectorAll(".ph-cover-row")[1]; return r ? r.getBoundingClientRect().top : null; });
            if (rowStep != null) {
              const quiet0 = await run(async () => (await import("/src/sfx.ts")).heard.count);
              await tapQ(".ph-cover-row:nth-child(2)"); await sleep(120);
              const jumped = (await P()).step;
              const quiet1 = await run(async () => (await import("/src/sfx.ts")).heard.count);
              probe("soundJump", { before: quiet0, after: quiet1, ok: quiet1 === quiet0 });
              await tapQ(".ph-replay"); await sleep(120);
              const restarted = (await P()).step;
              probe("jump", { jumped, restarted, ok: jumped != null && restarted != null && restarted < jumped });
            }
          }
        }
        // Under the cover the auto-held piece is not live. The game's first cover is the seated person's own: leave it up
        // through the bots' placements into that person's opening turn, then a tap on a legal corner must place nothing.
        if (probes.coveredInput == null && x.cover === x.human && x.steps < 20) {
          if (!(x.cur === x.human && x.legal.some((a) => a[0] === "BUILD_SETTLEMENT"))) { await sleep(100); continue; }
          const at = await run(async () => {
            const g = await import("/src/board/geometry.ts"), s = window.__app.get(), a = s.legal.find((q) => q[0] === "BUILD_SETTLEMENT");
            const p = new DOMPoint(...g.nodeXY(a[1])).matrixTransform(document.querySelector("#board-layer svg").getScreenCTM());
            return [p.x, p.y];
          });
          await tap(...at); await sleep(600);
          const y = await P();
          probe("coveredInput", { cover: y.cover, ok: y.steps === x.steps && y.cover === x.cover });
        }
        await sleep(300);
        await tapQ(".ph-showhand"); await sleep(500);
        const y = await P();
        if (y.cover == null) {
          lastKey = null;
          probe("showHand", { human: y.human, holder: y.holder, you: y.you, ok: y.human === x.cover && y.holder === x.cover && y.you === ["Red", "Blue", "Orange", "White"][x.cover] });
        }
        // Out to the lineup and back: whoever holds the phone has let it go, so a cover is up again.
        if (y.cover == null && probes.resumeCover == null && probes.showHand) {
          await tapQ(".ph-back"); await sleep(500); await tapQ(".ph-resume"); await sleep(800);
          const z = await P();
          probe("resumeCover", { cover: z.cover, holder: z.holder, ok: z.cover != null && z.holder == null && !z.hand });
        }
        continue;
      }
      if (x.cur === x.human && x.status === "idle" && x.legal.length && x.holder === x.human) {
        await policy();
        const y = await P();
        // A person's turn just ended and another person is next: the cover is up at once.
        if (probes.coverFast == null && x.prompt === "PLAY_TURN" && y.turn !== x.turn) { await sleep(300); const z = await P(); probe("coverFast", { cover: z.cover, ok: z.cover != null && !z.hand }); }
        continue;
      }
      await sleep(60);
    }
  }
  await shot("pass-end");
} catch (e) { result.error = (result.error ? result.error + " | " : "") + String(e).slice(0, 300); }
// Milestone 5: a watched game (fast bots) scrubbed back and brought live, its ending in the same block, its link opened
// cold in a fresh page; the same game's link with two people in it opens as a recording; a garbled link lands on the
// lineup and says so.
try {
  const tapQ = async (q) => { const r = await rect(q); if (!r) return false; await tap(r[0] + r[2] / 2, r[1] + r[3] / 2); return true; };
  const T = () => run(() => {
    const s = window.__app.get(), b = document.querySelector("#board-layer svg")?.getBoundingClientRect();
    const vis = (q) => { const e = document.querySelector(q); return !!e && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().height > 0; };
    return { phase: s.phase, film: s.film, at: s.view?.steps ?? null, seenTo: s.seenTo, frames: s.frames.length, paused: s.paused, winner: s.view?.winner ?? null,
             vp: s.view?.players.map((p) => p.actual_vp), box: b ? [b.x, b.y, b.width, b.height].map(Math.round).join() : null, live: !!document.querySelector(".ph-live"),
             faint: document.querySelectorAll('.ph-curve polyline[opacity="0.3"]').length, result: !!document.querySelector(".ph-result"),
             fits: (() => { const r = document.querySelector(".ph-result"); return r ? r.scrollHeight <= r.clientHeight + 1 : null; })(),
             hand: vis(".ph-hand") || vis(".ph-you"), cover: !!document.querySelector(".ph-cover"), chips: document.querySelectorAll(".ph-chip").length,
             err: document.querySelector(".ph-err")?.textContent ?? null, hash: location.hash };
  });
  await run(async () => { const a = window.__app; a.set({ seed: 999, lineup: [0, 1, 2, 3].map(() => ({ kind: "heuristic", depth: 1 })), pace: "normal" }); await a.start(); });
  let t = await T();
  for (let k = 0; k < 80 && t.seenTo < 24; k++) { await sleep(250); t = await T(); }
  const c = await rect(".ph-curve");
  await tap(c[0] + c[2] / 3, c[1] + c[3] / 2); await sleep(400);
  const scrubbed = await T();
  probe("scrub", { at: scrubbed.at, seenTo: scrubbed.seenTo, frames: scrubbed.frames, faint: scrubbed.faint, ok: scrubbed.paused && scrubbed.at < scrubbed.seenTo - 4 && Math.abs(scrubbed.at - Math.round(scrubbed.seenTo / 3)) <= 2 && scrubbed.faint > 0 && scrubbed.live });
  await shot("scrub");
  (await checks()).small.forEach((x) => small.add(x));
  const r = await rect(".ph-live"); await tap(r[0] + r[2] / 2, r[1] + r[3] / 2); await sleep(300);
  const lived = await T();
  probe("live", { at: lived.at, seenTo: scrubbed.seenTo, ok: !lived.paused && lived.at >= scrubbed.seenTo && !lived.live });
  const during = lived.box;
  await run(() => window.__app.set({ pace: "fast" }));
  for (let k = 0; k < 600 && (await T()).phase !== "over"; k++) await sleep(250);
  await sleep(600);
  const ended = await T();
  probe("watchEnd", { box: [during, ended.box], fits: ended.fits, ok: ended.phase === "over" && ended.result && ended.box === during && ended.fits });
  await shot("watch-over");
  (await checks()).small.forEach((x) => small.add(x));
  // Share answers inside the tap (a share sheet or the clipboard refuses a call made after an await): a stub records
  // whether it was called in the tap's own task.
  await sleep(1500);
  await run(() => { window.__inTap = false; window.__sync = null; addEventListener("click", () => { window.__inTap = true; setTimeout(() => { window.__inTap = false; }); }, true);
                    navigator.share = async () => { window.__sync = window.__inTap; }; });
  await tapQ(".ph-share"); await sleep(600);
  const shared = await T();
  const sync = await run(() => window.__sync);
  // Milestone 6: the review of the watched game: the winner's grades counted, the decisive moves lettered and listed,
  // the seat switched, a move opened, then back to the result.
  await tapQ(".ph-toreview"); await sleep(1500);
  for (let k = 0; k < 40 && (await run(() => Object.keys(window.__app.get().grades).length)) < 10; k++) await sleep(500);
  const rv = await run(() => { const s = window.__app.get(); return { review: s.review, seat: s.reviewSeat, winner: s.frames[s.frames.length - 1].view.winner,
    tally: [...document.querySelectorAll(".ph-tally .num")].map((e) => +e.textContent), keys: document.querySelectorAll(".ph-key").length,
    pucks: document.querySelectorAll(".ph-review .curvebox .puck").length, seatBtn: !!document.querySelector(".ph-seatpick") }; });
  probe("review", { ...rv, ok: rv.review && rv.tally.reduce((a, b) => a + b, 0) >= 10 && rv.keys > 0 && rv.pucks > 0 });
  await shot("review");
  (await checks()).small.forEach((x) => small.add(x));
  await tapQ(".ph-seatpick"); await sleep(300);
  const seat2 = await run(() => window.__app.get().reviewSeat);
  let g2 = 0;
  for (let k = 0; k < 40 && g2 < 10; k++) { await sleep(500); g2 = await run((q) => Object.values(window.__app.get().grades).filter((g) => g.seat === q).length, seat2); }
  probe("reviewSeat", { from: rv.seat, to: seat2, graded: g2, ok: rv.seat === rv.winner && rv.seatBtn && seat2 === (rv.seat + 1) % 4 && g2 >= 10 });
  await tapQ(".ph-key"); await sleep(900);
  const mv = await run(() => ({ step: window.__app.get().step, row: !!document.querySelector(".ph-review .ph-newest"),
    fits: [...document.querySelectorAll(".ph-review .tx, .ph-review .ph-coach")].every((e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1) }));
  probe("reviewMove", { ...mv, ok: mv.step != null && mv.row && mv.fits });
  await shot("review-move");
  (await checks()).small.forEach((x) => small.add(x));
  const stepLink = await run(async (st) => (await import("/src/game.ts")).shareLink(st), mv.step);
  await tapQ(".ph-back"); await sleep(400); await tapQ(".ph-back"); await sleep(700);
  const rb = await run(() => { const s = window.__app.get(); return { review: s.review, step: s.step, phase: s.phase, result: !!document.querySelector(".ph-result") }; });
  probe("reviewBack", { ...rb, ok: !rb.review && rb.step == null && rb.phase === "over" && rb.result });
  const link = shared.hash.startsWith("#/r/") ? (await run(() => location.href)) : null;
  if (link) {
    await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
    await cdp("Page.navigate", { url: link }); await sleep(5000);
    const cold = await T();
    probe("share", { len: link.length, winner: [shared.winner, cold.winner], sync, ok: sync === true && cold.phase === "over" && cold.film === "named" && cold.winner === shared.winner && cold.vp.join() === shared.vp.join() && cold.frames === shared.frames && cold.result });
    await shot("cold");
    const people = await run(async () => { const a = window.__app; a.set({ lineup: [{ kind: "heuristic", depth: 1 }, { kind: "human", depth: 2 }, { kind: "human", depth: 2 }, { kind: "heuristic", depth: 1 }] }); return (await import("/src/game.ts")).shareLink(); });
    await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
    await cdp("Page.navigate", { url: people }); await sleep(5000);
    await tapQ(".ph-rewatch"); await sleep(1500);
    const film = await T();
    // Watched from the start, the pace is there to change (Live only once scrubbed back).
    const pace = await run(() => !!document.querySelector(".ph-pace:not(.ph-live)"));
    probe("filmPeople", { phase: film.phase, at: film.at, hand: film.hand, cover: film.cover, chips: film.chips, pace, ok: pace && film.film === "named" && film.phase === "playing" && film.at > 0 && !film.hand && !film.cover && film.chips === 0 });
    // A link to one move opens the review at that move, cold.
    await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
    await cdp("Page.navigate", { url: stepLink }); await sleep(5000);
    const sl = await run(() => { const s = window.__app.get(); return { review: s.review, step: s.step, film: s.film }; });
    await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
    await cdp("Page.navigate", { url: stepLink.replace(/\/\d+$/, "/12x") }); await sleep(5000);
    const so = await run(() => { const s = window.__app.get(); return { review: s.review, step: s.step }; });
    probe("stepLink", { ...sl, want: mv.step, garbled: so, ok: sl.review && sl.step === mv.step && sl.film === "named" && so.review && so.step == null });
  } else probe("share", { hash: shared.hash, ok: false });
  await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
  await cdp("Page.navigate", { url: URL_ + "#/r/AAAAzzzz" }); await sleep(4000);
  const bad = await T();
  await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
  await cdp("Page.navigate", { url: URL_ + "#/r/" }); await sleep(4000);
  const empty = await T();
  probe("badLink", { phase: [bad.phase, empty.phase], err: [bad.err, empty.err], ok: bad.phase === "lineup" && !!bad.err && bad.film == null && empty.phase === "lineup" && !!empty.err });
  await shot("badlink");
  await run(() => localStorage.setItem("sound", "0"));
  await cdp("Page.navigate", { url: "about:blank" }); await sleep(200);
  await cdp("Page.navigate", { url: URL_ }); await sleep(3500);
  const b = await rect(".ph-board"); await tap(b[0] + b[2] / 2, b[1] + b[3] / 2); await sleep(300);
  const off = await run(async () => { const m = await import("/src/sfx.ts"), sw = [...document.querySelectorAll(".ph-switches label")];
    const snd = sw.find((l) => l.textContent === "Sound")?.querySelector("input");
    return { unlocked: m.unlocked(), switches: sw.map((l) => l.textContent), soundChecked: snd?.checked ?? null }; });
  probe("soundOff", { ...off, ok: !off.unlocked && off.soundChecked === false && off.switches.includes("Eval") && off.switches.includes("Sound") });
  (await checks()).small.forEach((x) => small.add(x));
  await shot("lineup-switches");
  await run(() => localStorage.setItem("sound", "1"));
} catch (e) { result.error = (result.error ? result.error + " | " : "") + String(e).slice(0, 300); }

if (result.leak) failed_extra.push("leak");
const missing = NEED.filter((k) => probes[k] == null);
if (pageErrors.length) result.error = (result.error ? result.error + " | " : "") + pageErrors.join(" | ");
const failed = Object.entries(probes).filter(([, v]) => v && v.ok === false).map(([k]) => k);
// Every phase of a turn has its own slab since Milestone 2: the person never meets the fallback list.
if (modes.has("ph-list")) failed.push("fallback-list");
failed.push(...failed_extra);
console.log(JSON.stringify({ ...result, roll, tapThrough, overflowX, winner, games, boxes: [...boxes].map(([k, v]) => `${v} ${k}`), modes: [...modes], small: [...small], probes, missing, failed }, null, 1));
process.exitCode = missing.length || failed.length || result.error ? 1 : 0;
ws.close();
proc.kill();
