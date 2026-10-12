// Layout A ("around the table") as a parametrised shell, so each phase of a turn is drawn from one state.
import { C, SEAT, S, RES, phone, card, devFan, pieceIcon, devBack, die, devCard } from './lib.mjs';
import { glyphMini, board, TILES, hex, pts, token, piece, road } from '../board.mjs';
export { C, SEAT, RES, card, die, devCard, piece, road, TILES, hex, pts, token, glyphMini, pieceIcon, devBack };

export const COST = { road: { wood: 1, brick: 1 }, settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 }, city: { wheat: 2, ore: 3 }, dev: { sheep: 1, wheat: 1, ore: 1 } };
export const NAME = { road: 'Road', settlement: 'Settlement', city: 'City', dev: 'Dev card' };
export const KINDS = ['road', 'settlement', 'city', 'dev'];

/** The state a phone is drawn from; `st()` copies the shared mock state with overrides. */
export const st = (o = {}) => ({
  hand: { ...S.hand }, devs: S.devs, left: { road: 9, settlement: 2, city: 3, dev: 19 },
  ev: true, me: { s: 'blue', name: 'You' }, you: { vp: 6, win: 31 }, opps: S.seats.filter((x) => x.s !== 'blue').map((x) => ({ ...x })), ...o,
});
const can = (s, k) => Object.entries(COST[k]).every(([r, n]) => s.hand[r] >= n);
const left = (s, k) => s.left[k] <= 2 ? `<span class="num" style="font-size:11px; font-weight:700; color:#a5452b; white-space:nowrap">${s.left[k]} left</span>` : '';

const cardsIcon = (n, gain) => `<span style="display:inline-flex; align-items:center; gap:3px; color:${C.moss}"><svg viewBox="0 0 14 16" width="11" height="13"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55"/></svg><span class="num" style="font-size:12.5px; font-weight:${gain ? 800 : 600}; color:${gain ? '#2e7d4f' : 'inherit'}">${n}</span></span>`;
/** A win chance with an optional change flag: the bar keeps the old width as a ghost so the move reads as a move. */
export const delta = (d) => d ? `<span class="num" style="font-size:11.5px; font-weight:700; color:${d > 0 ? '#2e7d4f' : '#a5452b'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : '';
/** A win bar; after a move the changed stretch stays faint for a beat, so a gain or a loss reads as one. */
const bar = (s, win, d, h = 4, m = '') => { const lo = d ? Math.min(win, win - d) : win, hi = d ? Math.max(win, win - d) : win;
  return `<div style="position:relative; height:${h}px; background:${C.dust}; ${m}"><i style="position:absolute; left:0; top:0; height:100%; width:${lo}%; background:${SEAT[s]}"></i>${d ? `<i style="position:absolute; left:${lo}%; top:0; height:100%; width:${hi - lo}%; background:${SEAT[s]}; opacity:.35"></i>` : ''}</div>`; };
export const chip = (o, ev = true) => `<div class="cut8" data-seat="${o.s}" style="flex:1; min-width:0; background:${o.on ? '#fff' : C.paper}; padding:${M.chipPad}px 10px 0; display:flex; flex-direction:column; gap:3px; ${o.on ? 'box-shadow:0 6px 14px rgba(18,33,31,.16); transform:translateY(-2px)' : o.off ? 'opacity:.55' : ''}">
    <div style="display:flex; align-items:center; gap:6px"><i style="width:9px; height:9px; background:${SEAT[o.s]}"></i><span style="font-size:13px; font-weight:600">${o.name}</span><span class="d num" style="margin-left:auto; font-size:20px">${o.vp}</span></div>
    <div style="display:flex; gap:10px; align-items:center">${cardsIcon(o.cards + (o.gain || 0), o.gain)}<span style="display:inline-flex; align-items:center; gap:2px">${devBack(13)}<span class="num" style="font-size:12.5px; font-weight:600; color:${C.moss}">${o.dev}</span></span>${ev ? `<span style="margin-left:auto" class="num"><span style="font-size:12.5px; font-weight:600">${o.win}%</span></span>` : ''}</div>
    ${ev ? bar(o.s, o.win, o.d, 4, 'margin:5px -10px 0') : '<div style="height:8px"></div>'}</div>`;

/** A cost token: the resource's colour carrying its glyph; a missing one is a dust slot. */
export const mini = (res, have = true, w = 16, h = 20) => `<span class="cut5" style="display:inline-flex; align-items:center; justify-content:center; width:${w}px; height:${h}px; flex:0 0 ${w}px; background:${have ? C[res] : C.dust}"><svg viewBox="0 0 16 16" width="${w - 3}" height="${w - 3}">${glyphMini(res, 8, 8, 12, 11, have ? 0.9 : 0.35)}</svg></span>`;
export function costRow(s, k, w, h, gap = 3) {
  const out = [];
  for (const [r, n] of Object.entries(COST[k])) for (let i = 0; i < n; i++) out.push(mini(r, i < s.hand[r], w, h));
  return `<span style="display:inline-flex; gap:${gap}px">${out.join('')}</span>`;
}

const off = 5, LANE = 30, DEEP = 4;
/** The hand as stacks. `lift` pulls the cards a build spends up out of their stacks; `ghost` floats one faint card per
 *  card you lack; `arrive` marks a card landing on a stack (the production fly-in's last frame). */
export function hand(s, w, h, { lift = {}, ghost = {}, arrive = {} } = {}) {

  return RES.map((r) => {
    const n = s.hand[r], up = Math.min(lift[r] || 0, n), gh = ghost[r] || 0, rest = n - up;
    let x = '';
    const shown = Math.min(rest, DEEP);
    for (let i = rest - shown; i < rest; i++) x += `<span style="position:absolute; left:0; top:${-(rest - 1 - i) * off}px">${card(r, i === rest - 1 ? rest : null, w, h, i < rest - 1 ? 'filter:brightness(.93)' : '')}</span>`;
    if (!rest) x += `<span class="cut8" style="position:absolute; left:0; top:0; width:${w}px; height:${h}px; background:${C.dust}; opacity:.45"></span>`;
    const base = -(LANE - 2);
    for (let j = 0; j < up + gh; j++) {
      const g = j >= up;
      x += `<span style="position:absolute; left:${j * 7}px; top:${base + Math.abs(j - (up + gh - 1) / 2) * 2}px; transform:rotate(${(j - (up + gh - 1) / 2) * 5}deg); ${g ? 'opacity:.32' : 'filter:drop-shadow(0 8px 10px rgba(18,33,31,.22))'}">${card(r, null, w, h)}</span>`;
    }
    if (arrive[r]) x += `<span style="position:absolute; left:6px; top:${base}px; transform:rotate(7deg); filter:drop-shadow(0 10px 12px rgba(18,33,31,.25))">${card(r, null, w, h)}</span>`;
        return `<span data-res="${r}" style="position:relative; display:inline-block; width:${w}px; height:${h}px; margin-top:${Math.max(Math.min(n, DEEP) - 1, 0) * off}px">${x}</span>`;
  }).join('');
}
export const handBox = (s, w, h, o, devs = '') => `<div style="display:flex; align-items:flex-end; gap:6px; height:${h + (DEEP - 1) * off}px">${hand(s, w, h, o)}<span style="margin-left:auto"></span>${devs || devFan(s.devs, Math.round(w * 0.8), Math.round(h * 0.84))}</div>`;

/** The four build cards. `held` is the one picked up (its slot shows empty); `sunk` sinks every card (before the roll). */
export function tiles(s, { pressed, held, sunk } = {}) {
  return `<div style="display:flex; gap:6px">${KINDS.map((k) => {
    if (k === held) return `<div class="cut8" style="flex:1; min-width:0; height:${M.tileH}px; background:${C.dust}; opacity:.5"></div>`;
    const ok = !sunk && can(s, k), on = k === pressed;
    return `<div class="cut8" style="flex:1; min-width:0; height:${M.tileH}px; padding:${M.tileH < 80 ? 5 : 7}px 7px ${M.tileH < 80 ? 6 : 8}px; display:flex; flex-direction:column; justify-content:space-between; background:${on ? '#dfe8f6' : ok ? C.paper : '#e3e7de'}; color:${ok ? C.pine : C.moss}; ${on ? 'transform:translateY(-6px); box-shadow:0 8px 16px rgba(18,33,31,.18)' : ''}">
      <div style="display:flex; align-items:flex-start; justify-content:space-between">${k === 'dev' ? devBack(24) : pieceIcon(k, s.me.s, 24)}${left(s, k)}</div>
      <span style="font-size:12px; font-weight:600; white-space:nowrap">${NAME[k]}</span>
      ${costRow(s, k, k === 'city' ? 13 : 15, 18, 2)}
    </div>`;
  }).join('')}</div>`;
}

/** Metrics a small-phone mock overrides: card and slab sizes, chip padding, board width, the phone frame. */
export const M = { cw: 50, ch: 68, tileH: 84, btnH: 50, chipPad: 8, bw: 372, frame: null };
export const BW = 372, VIEW = [-252, -238, 504, 476], K = BW / VIEW[2], BH = Math.round(VIEW[3] * K);
/** Board space → px inside the board box. */
export const bx = (x) => (x - VIEW[0]) * K, by = (y) => (y - VIEW[1]) * K;
/** The board, with `under` drawn inside the SVG on top of the pieces and `over` as HTML in the board's own box. */
export const boardSvg = (under = "", o = {}) => board({ w: BW, view: VIEW, ...o }).replace(/<\/svg>$/, under + "</svg>");

const evSwitch = (on) => `<span style="display:inline-flex; align-items:center; gap:7px; height:44px; padding-left:6px"><span style="font-size:13px; font-weight:600; color:${on ? C.pine : C.moss}">Eval</span><span style="position:relative; width:34px; height:20px; border-radius:10px; background:${on ? C.pine : C.dust}"><i style="position:absolute; top:3px; left:${on ? 17 : 3}px; width:14px; height:14px; border-radius:50%; background:${C.chalk}"></i></span></span>`;
const topDice = (d) => d ? `<span style="display:inline-flex; gap:4px; margin-right:6px">${die(d[0], 24)}${die(d[1], 24)}</span>` : '';
export const endRow = (extra = '') => `<div style="display:flex; gap:8px">${extra || `<button class="btn cut8" style="flex:1; height:${M.btnH}px">Trade</button><button class="btn go cut8" style="flex:1.4; height:${M.btnH}px">End turn</button>`}</div>`;

/** The seated block's natural height: You row, gap, hand, gap, slab (build row, gap, buttons). */
export const BOTTOM_H = 24 + 10 + 68 + (DEEP - 1) * off + 10 + 144;
export function shell(s, { svg = '', over = '', roll = S.dice, zone = '', buttons = endRow(), handOpts, devs, top = "Round 9", boardOpts, bottom } = {}) {
  return (M.frame || phone)(`
    <div style="display:flex; flex-direction:column; height:100%">
      <div style="height:40px; flex:0 0 40px; display:flex; align-items:center; padding:0 16px; gap:10px"><span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">${top}</span><span style="margin-left:auto"></span>${topDice(roll)}${evSwitch(s.ev)}</div>
      <div style="display:flex; gap:8px; padding:0 16px; position:relative; z-index:2">${s.opps.map((o) => chip(o, s.ev)).join('')}</div>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; min-height:0">
        <div style="position:relative; width:${M.bw}px; height:${Math.round(M.bw * VIEW[3] / VIEW[2])}px">${board({ w: M.bw, view: VIEW, ...boardOpts }).replace(/<\/svg>$/, svg + '</svg>')}${over}</div></div>
      <div style="padding:0 16px 10px; display:flex; flex-direction:column; gap:10px; position:relative; z-index:3">${bottom ? `<div style="height:${BOTTOM_H}px">${bottom}</div>` : `
        <div style="display:flex; align-items:center; gap:8px; height:24px; ${handOpts && (handOpts.lift || handOpts.ghost) ? 'opacity:0' : ''}"><i style="width:9px; height:9px; background:${SEAT[s.me.s]}"></i><span style="font-size:13px; font-weight:600">${s.me.name}</span><span class="d num" style="font-size:20px">${s.you.vp}</span>
          ${s.ev ? `<div style="flex:1; margin:0 6px">${bar(s.me.s, s.you.win, s.you.d)}</div>${delta(s.you.d)}<span class="num" style="font-size:12.5px; font-weight:600">${s.you.win}%</span>` : ''}</div>
        ${handBox(s, M.cw, M.ch, handOpts, devs)}
        ${zone}
        ${buttons}`}
      </div>
    </div>`);
}
