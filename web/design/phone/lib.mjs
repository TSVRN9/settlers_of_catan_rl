// Shared pieces for the phone mockups. The board, palette and glyphs come from web/design/board.mjs
// so every mock is drawn in the product's own vocabulary.
import { writeFileSync } from 'node:fs';
import { C, SEAT, SEAT_HI, SEAT_LO, SET, CITY, board, glyphMini, pts, FONTS } from '../board.mjs';
export { C, SEAT, SEAT_HI, SEAT_LO, board, FONTS };

// Pages are written to ./out/ (gitignored) and reviewed in a browser.
export const W = 390, H = 844, TOP = 47, HOME = 34;

// The one game state every option draws: round 9, your main turn just after rolling an 8.
export const S = {
  you: 'blue',
  seats: [
    { s: 'red', name: 'Red', vp: 7, cards: 5, dev: 1, win: 38 },
    { s: 'blue', name: 'You', vp: 6, cards: 11, dev: 2, win: 31 },
    { s: 'orange', name: 'Orange', vp: 5, cards: 3, dev: 0, win: 18 },
    { s: 'grey', name: 'White', vp: 4, cards: 9, dev: 1, win: 13 },
  ],
  hand: { wood: 3, brick: 2, sheep: 1, wheat: 3, ore: 2 },
  devs: [0, 3],
  dice: [5, 3],
};
export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const seat = (s) => S.seats.find((x) => x.s === s);

export const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #dfe3da; font-family: "Chivo", "Helvetica Neue", Arial, sans-serif; color: ${C.pine}; }
  .wrap { padding: 28px 28px 60px; }
  .wrap > h2 { font: 700 26px "Syne", sans-serif; letter-spacing: -.02em; margin: 0 0 6px; }
  .wrap > p.sub { margin: 0 0 26px; color: ${C.moss}; font-size: 15px; max-width: 760px; line-height: 1.5; }
  .row3 { display: flex; gap: 36px; flex-wrap: wrap; align-items: flex-start; }
  .opt { width: ${W}px; cursor: pointer; }
  .opt h3 { font: 700 18px "Syne", sans-serif; margin: 16px 0 6px; }
  .opt p { margin: 0 0 6px; font-size: 13.5px; line-height: 1.5; color: ${C.moss}; }
  .opt.selected .phone { outline: 4px solid ${C.pine}; outline-offset: 6px; }
  .phone { position: relative; width: ${W}px; height: ${H}px; border-radius: 46px; overflow: hidden; background: ${C.chalk};
           box-shadow: 0 0 0 10px #1b1f1d, 0 24px 60px rgba(18,33,31,.35); }
  .status { position: absolute; left: 0; right: 0; top: 0; height: ${TOP}px; display: flex; align-items: center; justify-content: space-between;
            padding: 6px 30px 0 34px; font: 600 15px -apple-system, "Helvetica Neue", sans-serif; z-index: 50; }
  .status .isl { position: absolute; left: 50%; top: 11px; width: 122px; height: 34px; margin-left: -61px; border-radius: 20px; background: #000; }
  .homebar { position: absolute; left: 50%; bottom: 8px; width: 134px; height: 5px; margin-left: -67px; border-radius: 3px; background: ${C.pine}; z-index: 50; }
  .ui { position: absolute; left: 0; right: 0; top: ${TOP}px; bottom: ${HOME}px; }
  .d { font-family: "Syne", sans-serif; font-weight: 700; letter-spacing: -.02em; }
  .num { font-variant-numeric: tabular-nums; }
  .cut  { clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px); }
  .cut8 { clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px); }
  .cut5 { clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 48px; padding: 0 18px; border: 0;
         background: ${C.paper}; color: ${C.pine}; font: 600 15px "Chivo", sans-serif; white-space: nowrap; }
  .btn.go { background: ${C.pine}; color: ${C.chalk}; }
  .ghost { position: absolute; inset: 0; pointer-events: none; }
`;

export const statusBar = () => `<div class="status"><span>9:41</span><i class="isl"></i><span style="letter-spacing:2px">▮▮▮</span></div>`;
export const phone = (inner, bg = C.chalk) =>
  `<div class="phone" style="background:${bg}">${statusBar()}<div class="ui">${inner}</div><i class="homebar"></i></div>`;

/** A resource card: paper, its glyph, a resource-coloured foot, the count in display numerals. */
export function card(res, count, w = 52, h = 72, extra = '') {
  const glyph = `<svg viewBox="0 0 32 32" width="${Math.round(w * 0.5)}" height="${Math.round(w * 0.5)}" style="position:absolute; top:${Math.round(h * 0.13)}px" aria-hidden="true">${glyphMini(res, 16, 16, 24, 22, 0.85)}</svg>`;
  return `<span class="cut8" style="position:relative; display:inline-flex; flex-direction:column; align-items:center; justify-content:flex-end; width:${w}px; height:${h}px; flex:0 0 ${w}px; background:${C.paper}; border-bottom:${Math.max(4, Math.round(h / 16))}px solid ${C[res]}; padding-bottom:${Math.round(h * 0.06)}px; box-shadow:0 2px 6px rgba(18,33,31,.18); ${extra}">${glyph}${count != null ? `<span class="d num" style="font-size:${Math.round(h * 0.26)}px; line-height:1">${count}</span>` : ''}</span>`;
}
/** A stack: one card per copy, offset so the pile's height says the count before the number does. */
export function stack(res, n, w = 52, h = 72) {
  const off = 5;
  let s = '';
  for (let i = n - 1; i >= 1; i--) s += `<span style="position:absolute; left:0; top:${-i * off}px">${card(res, null, w, h, 'filter:brightness(.93)')}</span>`;
  return `<span style="position:relative; display:inline-block; width:${w}px; height:${h}px; margin-top:${(n - 1) * off}px">${s}<span style="position:absolute; left:0; top:0">${card(res, n, w, h)}</span></span>`;
}
const DEV = [
  `<path d="M16 3 L27 7.5 V15.5 C27 22 22 26.5 16 29 C10 26.5 5 22 5 15.5 V7.5 Z" fill="${C.pine}"/>`,
  `<g><rect x="6" y="5" width="13" height="18" rx="1.5" fill="${C.pine}" opacity=".45"/><rect x="13" y="9" width="13" height="18" rx="1.5" fill="${C.pine}"/></g>`,
  `<path d="M4 25 L6.5 9 L12 16 L16 6 L20 16 L25.5 9 L28 25 Z" fill="${C.pine}"/>`,
  `<g stroke="${C.pine}" stroke-width="4.2" stroke-linecap="round"><path d="M5 15 L17 8"/><path d="M15 25 L27 18"/></g>`,
  `<path d="M16 3 L19.6 11.6 L28.9 12.4 L21.8 18.4 L24 27.5 L16 22.6 L8 27.5 L10.2 18.4 L3.1 12.4 L12.4 11.6 Z" fill="${C.pine}"/>`,
];
export const DEV_NAME = ['Knight', 'Year of Plenty', 'Monopoly', 'Road Building', 'Victory point'];
export function devCard(k, w = 44, h = 64, extra = '') {
  return `<span class="cut8" style="position:relative; display:inline-flex; align-items:center; justify-content:center; width:${w}px; height:${h}px; flex:0 0 ${w}px; background:${C.paper}; border-bottom:${Math.max(4, Math.round(h / 16))}px solid ${C.pine}; box-shadow:0 2px 6px rgba(18,33,31,.18); ${extra}"><svg viewBox="0 0 32 32" width="${Math.round(w * 0.55)}" height="${Math.round(w * 0.55)}" aria-hidden="true">${DEV[k]}</svg></span>`;
}

/** Piece shapes from the board, for supplies and build cards. */
export function pieceIcon(kind, s = 'blue', size = 28) {
  if (kind === 'road') return `<svg viewBox="-14 -14 28 28" width="${size}" height="${size}"><line x1="-10" y1="6" x2="10" y2="-6" stroke="${SEAT[s]}" stroke-width="5.4" stroke-linecap="round"/></svg>`;
  const body = kind === 'city' ? CITY : SET;
  return `<svg viewBox="${kind === 'city' ? '-15 -15 30 30' : '-12 -12 24 24'}" width="${size}" height="${size}"><polygon points="${pts(body)}" fill="${SEAT[s]}"/></svg>`;
}
export function devBack(size = 24) {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}"><rect x="7" y="4" width="18" height="24" rx="2" fill="${C.pine}"/><path d="M16 9 L20 16 L16 23 L12 16 Z" fill="${C.chalk}" opacity=".5"/></svg>`;
}

/** Dice faces as pips. */
export function die(n, size = 34, bg = C.paper, ink = C.pine) {
  const P = { 1: [[2, 2]], 2: [[1, 1], [3, 3]], 3: [[1, 1], [2, 2], [3, 3]], 4: [[1, 1], [3, 1], [1, 3], [3, 3]], 5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]], 6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]] }[n] || [];
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}" style="display:block; filter:drop-shadow(0 2px 3px rgba(18,33,31,.28))"><rect x="1" y="1" width="38" height="38" rx="8" fill="${bg}"/>${P.map(([x, y]) => `<circle cx="${x * 10}" cy="${y * 10}" r="3.6" fill="${ink}"/>`).join('')}</svg>`;
}

export const svgBoard = (w, view = [-252, -238, 504, 476]) => board({ w, view });

export function write(name, title, sub, options) {
  const body = `<div class="wrap"><h2>${title}</h2><p class="sub">${sub}</p><div class="row3">${options.map((o) =>
    `<div class="opt" data-choice="${o.id}" onclick="toggleSelect(this)">${o.phone}<h3>${o.name}</h3>${o.notes.map((n) => `<p>${n}</p>`).join('')}</div>`).join('')}</div></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${FONTS}<style>${CSS}</style></head><body>${body}</body></html>`;
  writeFileSync(new URL('./out/' + name, import.meta.url), html);
  console.log('wrote', name, html.length);
}

/** Dev cards as one fanned pile: overlapping, slightly turned, so two cards take one card's room and a bit. */
export function devFan(ks, w = 44, h = 62, step = 22) {
  const n = ks.length, mid = (n - 1) / 2;
  return `<span style="position:relative; display:inline-block; width:${w + step * (n - 1)}px; height:${h}px; flex:0 0 auto">${ks.map((k, i) =>
    `<span style="position:absolute; left:${i * step}px; top:0; transform:rotate(${(i - mid) * 4}deg); transform-origin:50% 120%">${devCard(k, w, h)}</span>`).join('')}</span>`;
}

/** Several titled rows of phones on one page (the companion shows one file at a time). */
export function writeSections(name, title, sections) {
  const body = sections.map((x) => `<div class="wrap"><h2>${x.title}</h2><p class="sub">${x.sub}</p><div class="row3">${x.options.map((o) =>
    `<div class="opt" data-choice="${o.id}" onclick="toggleSelect(this)">${o.phone}<h3>${o.name}</h3>${o.notes.map((n) => `<p>${n}</p>`).join('')}</div>`).join('')}</div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${FONTS}<style>${CSS}</style></head><body>${body}</body></html>`;
  writeFileSync(new URL('./out/' + name, import.meta.url), html);
  console.log('wrote', name, html.length);
}
