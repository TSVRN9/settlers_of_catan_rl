// Screen 4: the moments that aren't a build: another seat's turn, an offer, a discard, the robber.
import { C, SEAT, st, shell, tiles, card, die, piece, road, hex, pts, bx, by, delta, pieceIcon, devBack, KINDS } from './a.mjs';
import { robberMark } from '../board.mjs';

const NAMES = { red: 'Red', orange: 'Orange', grey: 'White', blue: 'You' };
const on = (s, seat) => { s.opps.forEach((o) => { o.on = o.s === seat; o.off = o.s !== seat; }); return s; };
const sw = (s) => `<i style="width:9px; height:9px; flex:0 0 9px; background:${SEAT[s]}"></i>`;
const dim = (html) => `<div style="opacity:.38; pointer-events:none">${html}</div>`;
const faintButtons = dim(`<div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Trade</button><button class="btn go cut8" style="flex:1.4; height:50px">End turn</button></div>`);

// A. Red's turn. The build row and the trade row are one slab again, now the move list: each move with what it did
// to its own seat's chance. The newest lands on top; the piece lands on the board at the same moment.
export const off = (ev = true) => {
const icon = { road: pieceIcon('road', 'red', 18), dice: `<span style="display:inline-flex; gap:2px">${die(4, 14)}${die(2, 14)}</span>`, dev: devBack(18) };
const row = ([s, ic, what, d], i) => `<div class="cut5" style="height:40px; flex:0 0 40px; display:flex; align-items:center; gap:9px; padding:0 12px; background:${i ? C.paper : '#fff'}; ${i ? `opacity:${1 - i * 0.22}` : 'box-shadow:0 6px 14px rgba(18,33,31,.14)'}">
  ${sw(s)}<span style="font-size:13px; font-weight:600; width:52px">${NAMES[s]}</span><span style="width:30px; display:inline-flex; justify-content:center">${icon[ic]}</span><span style="font-size:13px">${what}</span><span style="margin-left:auto">${ev ? delta(d) : ''}</span></div>`;
const feed = `<div style="height:144px; display:flex; flex-direction:column; gap:6px; overflow:hidden">${[['red', 'road', 'Road', 2], ['red', 'dice', 'Rolled 6', -1], ['orange', 'dev', 'Dev card', 1]].map(row).join('')}</div>`;
const sA = on(st({ ev, hand: { wood: 3, brick: 2, sheep: 1, wheat: 3, ore: 2 } }), 'red');
Object.assign(sA.opps[0], { win: 40, d: 2 }); sA.you = { vp: 6, win: 30, d: -1 }; Object.assign(sA.opps[1], { win: 17, d: -1 });
const landing = `<g filter="url(#land)"><line x1="-152.42" y1="-88" x2="-152.42" y2="-44" stroke="${SEAT.red}" stroke-width="5.4" stroke-linecap="round" transform="translate(0,-5)"/></g>
  <defs><filter id="land" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="3.5" flood-color="#12211f" flood-opacity=".35"/></filter></defs>`;
const pA = shell(sA, { svg: landing, roll: [4, 2], zone: feed, buttons: '' });

// B. An offer arrives: the slab becomes the offer, with what accepting does to both of you.
const lab = (t) => `<span style="font-size:11.5px; font-weight:600; color:${C.moss}">${t}</span>`;
const offer = `<div class="cut8" style="height:84px; padding:7px 12px; background:#fff; box-shadow:0 8px 18px rgba(18,33,31,.14); display:flex; align-items:center; gap:14px">
  <div style="display:flex; flex-direction:column; gap:4px">${lab('You get')}<div style="display:flex; gap:4px">${card('ore', null, 40, 52)}</div></div>
  <div style="display:flex; flex-direction:column; gap:4px">${lab('You give')}<div style="display:flex; gap:4px">${card('wheat', null, 40, 52)}${card('wheat', null, 40, 52)}</div></div>
  ${ev ? `<div style="margin-left:auto; display:grid; grid-template-columns:auto auto; gap:6px 8px; align-items:center">
    ${sw('blue')}<span class="num" style="font-size:13px; font-weight:700; color:#2e7d4f">▲1</span>${sw('red')}<span class="num" style="font-size:13px; font-weight:700; color:#2e7d4f">▲3</span></div>` : ''}</div>`;
const offerBtns = `<div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Decline</button><button class="btn go cut8" style="flex:1.4; height:50px">Accept</button></div>`;
const sB = on(st({ ev }), 'red');
const pB = shell(sB, { roll: [4, 2], zone: offer, buttons: offerBtns, handOpts: { lift: { wheat: 2 } } });

// C. Orange rolled a 7 and you hold 11: drag five cards into the slots. The fifth one commits.
const slot = `<span class="cut8" style="width:44px; height:60px; flex:0 0 44px; background:${C.dust}; opacity:.6"></span>`;
const discard = `<div class="cut8" style="height:${ev ? 84 : 144}px; padding:0 12px; background:#e3e7de; display:flex; align-items:center; gap:6px">
  <span class="d" style="font-size:19px; margin-right:auto">Discard</span>${card('wood', null, 44, 60)}${card('wheat', null, 44, 60)}${slot}${slot}${slot}</div>`;
const sC = on(st({ ev, hand: { wood: 2, brick: 2, sheep: 1, wheat: 2, ore: 2 } }), 'orange');
const pC = shell(sC, { roll: [3, 4], zone: discard, buttons: ev ? `<div style="display:flex"><button class="btn cut8" style="flex:1; height:50px">Suggest</button></div>` : '', top: 'Orange rolled 7' });

// D. You moved the robber onto a tile with two neighbours: their pieces lift with their hand sizes; tap one to steal.
const T = [114.32, 66], VIC = [['city', 'red', 76.21, 88, 5], ['set', 'orange', 152.42, 44, 3]];
const lift = `<defs><filter id="lift2" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="7" stdDeviation="4" flood-color="#12211f" flood-opacity=".35"/></filter></defs>
  <rect x="-300" y="-300" width="600" height="600" fill="${C.chalk}" opacity=".45"/>
  <polygon points="${pts(hex(T[0], T[1], 41.5))}" fill="${C.wood}"/>${robberMark(T[0], T[1] + 6)}
  ${VIC.map(([k, s, x, y]) => `<g filter="url(#lift2)">${piece(k, s, x, y - 6, 1.45)}</g>`).join('')}`;
const backs = VIC.map(([, s, x, y, n]) => `<span style="position:absolute; left:${bx(x) + (s === 'red' ? -54 : 16)}px; top:${by(y) - 22}px; display:inline-flex; align-items:center; gap:3px; padding:3px 6px 3px 4px; background:#fff; box-shadow:0 4px 10px rgba(18,33,31,.18)" class="cut5">${devBack(16).replace(C.pine, SEAT[s])}<span class="num" style="font-size:13px; font-weight:700">${n}</span></span>`).join('');
const sD = st({ ev });
const pD = shell(sD, { svg: lift, over: backs, boardOpts: { hideRobber: true }, zone: tiles(sD, { sunk: true }), buttons: faintButtons });

return { pA, pB, pC, pD };
};
