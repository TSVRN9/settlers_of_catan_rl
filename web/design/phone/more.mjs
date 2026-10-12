// Screen 7: starting a game (lineup, the opening draft) and the rest of a turn (your own offer, dev cards).
import { C, SEAT, st, shell, tiles, card, die, piece, bx, by, delta, pieceIcon, devBack, boardSvg, BW, BH, BOTTOM_H, mini } from './a.mjs';
import { phone, writeSections, devCard, devFan } from './lib.mjs';
import { robberMark } from '../board.mjs';

const NAME = { red: 'Red', blue: 'Blue', orange: 'Orange', grey: 'White' };
const sw = (s, n = 9) => `<i style="width:${n}px; height:${n}px; flex:0 0 ${n}px; background:${SEAT[s]}"></i>`;
const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const evSw = (on = true) => `<span style="display:inline-flex; align-items:center; gap:7px; height:44px"><span style="font-size:13px; font-weight:600; color:${on ? C.pine : C.moss}">Eval</span><span style="position:relative; width:34px; height:20px; border-radius:10px; background:${on ? C.pine : C.dust}"><i style="position:absolute; top:3px; left:${on ? 17 : 3}px; width:14px; height:14px; border-radius:50%; background:${C.chalk}"></i></span></span>`;
const lift = (id) => `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="7" stdDeviation="4" flood-color="#12211f" flood-opacity=".35"/></filter></defs>`;

// H1. The lineup: who sits where, the board, and Play. Four rows, one per seat, each a tap away from its picker.
const SEATS = [['red', 'Value-net search', 'search · depth 2'], ['blue', 'You', 'person'], ['orange', 'jSettler', 'SOCRobotBrain, smart'], ['grey', 'UCT', 'MCTS · 5,000 playouts']];
const seatLine = ([s, who, sub], open) => `<div class="cut8" style="height:58px; display:flex; align-items:center; gap:12px; padding:0 14px; background:${open ? '#fff' : C.paper}; ${open ? 'box-shadow:0 6px 14px rgba(18,33,31,.14)' : ''}">
  <i style="width:14px; height:34px; background:${SEAT[s]}"></i><div style="display:flex; flex-direction:column; gap:2px; min-width:0"><span style="font-size:15px; font-weight:600">${who}</span><span style="font-size:12px; color:${C.moss}">${sub}</span></div><span style="margin-left:auto; font-size:22px; color:${C.moss}">›</span></div>`;
const shuffle = `<button class="btn cut8" style="position:absolute; right:8px; bottom:4px; height:40px; padding:0 12px; font-size:13px">New board</button>`;
const lineup = (open = -1, sheet = '') => phone(`<div style="display:flex; flex-direction:column; height:100%; position:relative">
  <div style="height:44px; display:flex; align-items:center; padding:0 16px"><span class="d" style="font-size:22px">Catan RL</span></div>
  <div style="display:flex; justify-content:center"><div style="position:relative; width:${BW}px; height:${BH}px">${boardSvg()}${shuffle}</div></div>
  <div style="padding:6px 16px 12px; display:flex; flex-direction:column; gap:6px; margin-top:auto">
    ${SEATS.map((x, i) => seatLine(x, i === open)).join('')}
    <div style="display:flex; gap:8px; align-items:center">${evSw(true)}<button class="btn go cut8" style="flex:1; height:54px; font-size:16px; margin-left:12px">Play</button></div>
  </div>${sheet}</div>`);
const H1 = lineup();

// H2. Tapping a seat opens its picker over the lineup: who can sit there, each bot with its measured strength.
const BOTS = [['Person', 'person', ''], ['Value-net search', 'search · depth 2', '67%'], ['Heuristic search', 'search · depth 2', '29%'], ['jSettler', 'SOCRobotBrain, smart', '31%'], ['jSettler fast', 'SOCRobotBrain, fast', '22%'], ['UCT', 'MCTS · 5,000 playouts', '37%'], ['BUCT', 'MCTS · 5,000 playouts', '40%'], ['VPI', 'MCTS · 1,500 playouts', '22%'], ['DRRL', 'trades by DRRL', '8%'], ['Random', 'uniform over legal moves', '']];
const pick = ([n, sub, m], on) => `<div class="cut5" style="height:48px; display:flex; align-items:center; gap:10px; padding:0 12px; background:${on ? '#dfe8f6' : C.paper}">
  <div style="display:flex; flex-direction:column; gap:1px"><span style="font-size:14px; font-weight:600">${n}</span><span style="font-size:11.5px; color:${C.moss}">${sub}</span></div>
  <span class="num" style="margin-left:auto; font-size:13px; font-weight:700">${m}</span></div>`;
const sheet = `<div style="position:absolute; inset:0; background:rgba(18,33,31,.28)"></div>
  <div class="cut" style="position:absolute; left:0; right:0; bottom:0; height:560px; background:${C.chalk}; padding:10px 16px 14px; display:flex; flex-direction:column; gap:6px; box-shadow:0 -10px 30px rgba(18,33,31,.2)">
    <i style="align-self:center; width:40px; height:4px; border-radius:2px; background:${C.dust}; margin-bottom:6px"></i>
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px"><i style="width:14px; height:26px; background:${SEAT.orange}"></i><span class="d" style="font-size:22px">Orange</span><span style="margin-left:auto; font-size:11.5px; color:${C.moss}">wins vs 3 jSettlers</span></div>
    ${BOTS.map((b, i) => pick(b, i === 3)).join('')}</div>`;
const H2 = lineup(2, sheet);

// O1/O2. The opening is its own phase: no build cards, no trade, no dice. The draft order sits in the top bar;
// the slab is your supply, holding exactly the piece you place next.
const DRAFT = ['red', 'blue', 'orange', 'grey', 'grey', 'orange', 'blue', 'red'];
const draft = (at) => `<span style="display:inline-flex; align-items:center; gap:3px">${DRAFT.map((s, i) => `<i style="width:${i === at ? 14 : 9}px; height:${i === at ? 14 : 9}px; background:${SEAT[s]}; opacity:${i < at ? 0.3 : 1}; ${i === 3 ? 'margin-right:5px' : ''}"></i>`).join('')}</span>`;
const supply = (held) => `<div class="cut" style="height:144px; background:${C.paper}; display:flex; align-items:center; justify-content:center; gap:34px">
  ${held === 'set' ? `<span class="cut8" style="width:80px; height:80px; background:${C.dust}; opacity:.5"></span>` : `<span style="filter:drop-shadow(0 8px 10px rgba(18,33,31,.22))">${pieceIcon('settlement', 'blue', 72)}</span>`}
  <span style="opacity:.3">${pieceIcon('road', 'blue', 52)}</span></div>`;
const open = st({ hand: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }, devs: [] });
open.opps.forEach((o) => { o.vp = o.s === 'red' ? 1 : 0; o.cards = 0; o.dev = 0; o.win = 25; }); open.you = { vp: 0, win: 25 };
const openBoard = { seats: [] };
const redOne = piece('set', 'red', 0, -88);
const O1 = shell(open, { roll: null, top: 'Opening', zone: supply(), buttons: '', boardOpts: openBoard, svg: redOne }).replace('<span style="margin-left:auto"></span>', `<span style="margin-left:auto"></span>${draft(1)}<span style="width:8px"></span>`);
// Holding it: spots appear, sized by pips; the one under the finger lifts and shows the three tiles it would touch.
const SPOTS = [[38.1, 22, 12], [0, 44, 11], [-38.1, 22, 10], [76.21, 44, 9], [-76.21, 44, 8], [114.32, 22, 8], [38.1, -22, 9], [-38.1, -22, 8], [114.32, -22, 7], [-114.32, 22, 6], [76.21, 88, 7], [-76.21, -88, 7], [38.1, 110, 8], [-38.1, 110, 6], [152.42, 44, 5], [-152.42, -44, 6], [-114.32, -66 - 44, 4]];
const spots = SPOTS.map(([x, y, p]) => `<circle cx="${x}" cy="${y}" r="${2 + p * 0.75}" fill="${SEAT.blue}" opacity=".45"/>`).join('');
const held = `<ellipse cx="38.1" cy="28" rx="13" ry="4.5" fill="${C.pine}" opacity=".25"/>` + piece('set', 'blue', 38.1, 8, 1.7);
const O2 = shell(open, { roll: null, top: 'Opening', zone: supply('set'), buttons: '', boardOpts: openBoard, svg: redOne + spots + held, over: `<span style="position:absolute; left:${bx(38.1) - 16}px; top:${by(22) + 34}px; width:48px; height:48px; border-radius:50%; background:${C.pine}; opacity:.14"></span>` }).replace('<span style="margin-left:auto"></span>', `<span style="margin-left:auto"></span>${draft(1)}<span style="width:8px"></span>`);

// T1. Your own offer: the slab becomes give / get. Tap cards in the hand to give them, tap resources to ask.
const lab = (t) => `<span style="font-size:11.5px; font-weight:600; color:${C.moss}; width:34px">${t}</span>`;
const tok = (r, n) => `<span style="position:relative; opacity:${n ? 1 : 0.4}">${mini(r, true, 30, 36)}${n ? `<span class="num" style="position:absolute; right:-5px; top:-6px; background:${C.pine}; color:${C.chalk}; font-size:10.5px; font-weight:700; padding:1px 4px">${n}</span>` : ''}</span>`;
const builder = `<div class="cut8" style="height:84px; padding:4px 10px; background:#fff; box-shadow:0 8px 18px rgba(18,33,31,.14); display:flex; flex-direction:column; justify-content:space-around">
  <div style="display:flex; align-items:center; gap:8px">${lab('Give')}${RES.map((r) => tok(r, r === 'wood' ? 2 : 0)).join('')}<span style="margin-left:auto">${delta(2)}</span></div>
  <div style="display:flex; align-items:center; gap:8px">${lab('Get')}${RES.map((r) => tok(r, r === 'ore' ? 1 : 0)).join('')}</div></div>`;
const offerBtns = `<div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Bank 4:1</button><button class="btn go cut8" style="flex:1.4; height:50px">Offer</button></div>`;
const T1 = shell(st(), { zone: builder, buttons: offerBtns, handOpts: { lift: { wood: 2 } } });

// T2. Answers come back on the chips; tap an accepting seat to trade with it.
const t2 = st();
const ans = { red: 'yes', orange: 'no', grey: 'wait' };
const T2base = shell(t2, { zone: builder.replace('box-shadow:0 8px 18px rgba(18,33,31,.14)', 'opacity:.9'), buttons: `<div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Withdraw</button></div>`, handOpts: { lift: { wood: 2 } } });
const badge = (s) => ({ yes: `<span style="display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 9px; background:#2e7d4f; color:#fff; font-size:12px; font-weight:700" class="cut5">Accepts</span>`, no: `<span style="display:inline-flex; align-items:center; height:24px; padding:0 9px; background:${C.dust}; color:${C.moss}; font-size:12px; font-weight:700" class="cut5">No</span>`, wait: `<span style="display:inline-flex; align-items:center; gap:3px; height:24px; padding:0 9px; background:${C.paper}; font-size:14px; font-weight:700; color:${C.moss}" class="cut5">···</span>` })[ans[s]];
// The answers hang under each chip, on open board, never over a chip's numbers.
const T2 = T2base.replace(/(<div class="cut8" data-seat="(red|orange|grey)"[\s\S]*?<\/div>\s*<\/div>)/g, (m) => m);
const answers = `<div style="position:absolute; left:16px; right:16px; top:${47 + 40 + 64}px; display:flex; gap:8px; z-index:4">${['red', 'orange', 'grey'].map((s) => `<div style="flex:1; display:flex; justify-content:center">${badge(s)}</div>`).join('')}</div>`;
const T2f = T2.replace('<i class="homebar"></i>', answers + '<i class="homebar"></i>');

// D1. A Knight is dragged out of the fan like a piece; leaving the hand it becomes the robber.
const k1 = st();
const fanNoKnight = devFan([3], 40, 57);
const knightLift = `${lift('kn')}<g filter="url(#kn)">${robberMark(114.32, 66 - 4)}</g>`;
const D1 = shell(k1, { zone: tiles(k1), svg: knightLift, devs: `<span style="display:inline-flex; gap:0">${fanNoKnight}</span>`, over: `<span style="position:absolute; left:${bx(114.32) - 24}px; top:${by(66) + 30}px; width:48px; height:48px; border-radius:50%; background:${C.pine}; opacity:.14"></span><span style="position:absolute; left:${bx(114.32) + 18}px; top:${by(66) + 2}px; transform:rotate(10deg); opacity:.55">${devCard(0, 30, 42)}</span>` });

// D2. Year of Plenty: the card lifts into the slab and the bank's five resources are the choice; two taps take two.
const k2 = st();
const yop = `<div class="cut8" style="height:144px; padding:12px; background:#fff; box-shadow:0 8px 18px rgba(18,33,31,.14); display:flex; flex-direction:column; gap:10px">
  <div style="display:flex; align-items:center; gap:10px">${devCard(1, 30, 42)}<span class="d" style="font-size:18px">Year of Plenty</span><span style="margin-left:auto; display:inline-flex; gap:5px">${card('ore', null, 26, 34)}<span class="cut8" style="width:26px; height:34px; background:${C.dust}; opacity:.6"></span></span></div>
  <div style="display:flex; gap:6px; justify-content:space-between">${RES.map((r) => `<span style="flex:1; display:flex; justify-content:center; ${r === 'ore' ? 'transform:translateY(-4px)' : ''}">${card(r, null, 52, 62)}</span>`).join('')}</div></div>`;
const D2 = shell(k2, { zone: yop, buttons: '', devs: devFan([0, 3], 40, 57) });

writeSections('start-trade-dev.html', 'Starting, trading, dev cards', [
  { title: 'Starting a game', sub: 'The lineup, then the opening draft as its own phase.', options: [
    { id: 'lineup', name: 'Lineup', phone: H1, notes: ['One row per seat: who sits there. Tap to change. Pass and play turns on when a second seat is a person. With no person seated, Play becomes Watch.'] },
    { id: 'picker', name: 'Choosing Orange\'s seat', phone: H2, notes: ['Every occupant with its one-line description and its measured win rate against three stock jSettlers, the same figures as the site\'s bot cards.'] },
    { id: 'opening', name: 'Opening', phone: O1, notes: ['No build cards, no trade, no dice: the slab is your supply with the one piece you place next, the road after it waiting. The snake order sits in the top bar, the current pick bigger.'] },
    { id: 'opening-held', name: 'Opening, settlement in hand', phone: O2, notes: ['Holding it, every legal corner appears as a dot sized by its pips, so the reading is the dot itself. Let go to place; the road follows from that corner.'] },
  ] },
  { title: 'Your offer and dev cards', sub: 'Main phase, round 9.', options: [
    { id: 'offer-build', name: 'Building an offer', phone: T1, notes: ['Trade turns the slab into give and get. Tapping cards in your hand moves them to Give (they lift); tapping a resource asks for one. Bank and port buttons appear only when the engine allows that exact trade.'] },
    { id: 'offer-answers', name: 'Answers', phone: T2f, notes: ['Each seat\'s answer hangs under its chip as it arrives. Tap an accepting seat to trade with it; Withdraw puts your cards back.'] },
    { id: 'knight', name: 'Playing a Knight', phone: D1, notes: ['Dev cards play like pieces: drag the Knight out of the fan and it becomes the robber in your hand. Tap works too, for the cards that have no target.'] },
    { id: 'yop', name: 'Year of Plenty', phone: D2, notes: ['The card takes the slab; the five resources are the choice. The first tap fills the first slot, the second takes both.'] },
  ] },
]);
