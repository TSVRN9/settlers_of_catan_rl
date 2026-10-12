// Screen 5: pass-and-play. Blue and Orange are people, Red and White are bots.
import { C, SEAT, st, shell, card, die, delta, pieceIcon, devBack, BOTTOM_H } from './a.mjs';
import { writeSections } from './lib.mjs';
import { lift, fly, A_, B_ } from './turn.mjs';
import { piece, bx, by } from './a.mjs';

const INK = { blue: C.chalk, red: C.chalk, orange: C.pine, grey: C.pine };
const NAME = { red: 'Red', blue: 'Blue', orange: 'Orange', grey: 'White' };
const SEATS = {
  red: { s: 'red', name: 'Red', vp: 7, cards: 8, dev: 1, win: 36 },
  blue: { s: 'blue', name: 'Blue', vp: 7, cards: 7, dev: 2, win: 35 },
  orange: { s: 'orange', name: 'Orange', vp: 5, cards: 4, dev: 0, win: 17 },
  grey: { s: 'grey', name: 'White', vp: 4, cards: 9, dev: 1, win: 12 },
};
// The table re-seats for whoever holds the phone: they sit at the bottom, the rest clockwise from their left.
const ORDER = ['red', 'blue', 'orange', 'grey'];
const seatFor = (me, o = {}) => {
  const i = ORDER.indexOf(me), opps = [1, 2, 3].map((k) => ({ ...SEATS[ORDER[(i + k) % 4]] }));
  return st({ me: { s: me, name: NAME[me] }, opps, you: { vp: SEATS[me].vp, win: SEATS[me].win }, ...o });
};

/** The cover: the next seat's colour over the private half of the table. What happened since they last held the phone
 *  is public, so it is on the cover; the hand is not. */
const icon = { road: (s) => pieceIcon('road', s, 16), settlement: (s) => pieceIcon('settlement', s, 16), dev: () => devBack(16), dice: () => `<span style="display:inline-flex; gap:2px">${die(5, 13)}${die(3, 13)}</span>`, seven: () => `<span style="display:inline-flex; gap:2px">${die(3, 13)}${die(4, 13)}</span>` };
const crow = ([s, ic, what, d], ev, state = 'done') => `<div class="cut5" style="height:32px; display:flex; align-items:center; gap:8px; padding:0 10px; background:${state === 'now' ? '#fff' : 'rgba(247,248,244,.9)'}; color:${C.pine}; ${state === 'next' ? 'opacity:.5' : state === 'now' ? 'box-shadow:0 6px 14px rgba(18,33,31,.22); transform:scale(1.02)' : ''}">
  <i style="width:8px; height:8px; background:${SEAT[s]}"></i><span style="font-size:12.5px; font-weight:600; width:48px">${NAME[s]}</span><span style="width:26px; display:inline-flex; justify-content:center">${icon[ic](s)}</span><span style="font-size:12.5px">${what}</span><span style="margin-left:auto">${ev && d ? delta(d) : ''}</span></div>`;
/** `at` is the replay's position: rows before it are done, the row at it is playing, the rest are still to come.
 *  The strip above the rows is one segment per move, like a stories bar; the round arrow replays from the start. */
function cover(seat, { rows = [], ev = true, head = '', btn = 'Show hand', at = rows.length, t = 1, replay = true }) {
  const seg = (i) => `<i style="flex:1; height:4px; background:rgba(247,248,244,.35); position:relative"><i style="position:absolute; inset:0; width:${i < at ? 100 : i === at ? t * 100 : 0}%; background:${INK[seat]}"></i></i>`;
  return `<div class="cut" style="height:${BOTTOM_H}px; background:${SEAT[seat]}; color:${INK[seat]}; padding:16px 14px 14px; display:flex; flex-direction:column; gap:8px">
    <div style="display:flex; align-items:baseline; gap:12px"><span class="d" style="font-size:34px; line-height:1">${NAME[seat]}</span>${head}</div>
    ${replay && rows.length > 1 ? `<div style="display:flex; gap:4px; margin-top:2px">${rows.map((_, i) => seg(i)).join('')}</div>` : ''}
    <div style="display:flex; flex-direction:column; gap:5px; margin-top:2px">${rows.map((r, i) => crow(r, ev, i < at ? 'done' : i === at ? 'now' : 'next')).join('')}</div>
    <div style="margin-top:auto; display:flex; gap:8px">${replay && rows.length > 1 ? `<button class="btn cut8" style="width:54px; height:54px; padding:0; background:rgba(247,248,244,.9); color:${C.pine}; font-size:22px" aria-label="Replay">↺</button>` : ''}<button class="btn cut8" style="flex:1; height:54px; background:${C.pine}; color:${C.chalk}; font-size:16px">${btn}</button></div></div>`;
}

const since = [['grey', 'road', 'Road', 1], ['red', 'dev', 'Dev card', 1], ['blue', 'dice', 'Rolled 8'], ['blue', 'settlement', 'Settlement', 4]];
const ph = (ev) => {
  // Orange's view: chips are White, Red, Blue; Orange's own share flies into the cover.
  const RED_ = [186, -52], BLUE_ = [308, -52], COVER = [250, 420];
  const flights = fly('wood', A_, RED_, 0.6) + fly('wood', B_, RED_, 0.5) + fly('wood', B_, COVER, 0.45) + fly('wood', A_, BLUE_, 0.55);
  const r3 = seatFor('orange', { ev }); r3.opps[1].cards = 5; r3.opps[1].gain = 3; r3.opps[2].cards = 6; r3.opps[2].gain = 1;
  const pr3 = shell(r3, { roll: [5, 3], svg: lift, over: flights, bottom: cover('orange', { rows: since, ev, at: 2, t: 0.5 }) });
  const landing = `<defs><filter id="land2" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="9" stdDeviation="4" flood-color="#12211f" flood-opacity=".35"/></filter></defs><g filter="url(#land2)">${piece('set', 'blue', 38.1, 146, 1.25)}</g>`;
  const pr4 = shell(seatFor('orange', { ev }), { roll: [5, 3], svg: landing, bottom: cover('orange', { rows: since, ev, at: 3, t: 0.4 }) });
  const p1 = shell(seatFor('orange', { ev }), { roll: [5, 3], top: 'Round 9', svg: piece('set', 'blue', 38.1, 154), bottom: cover('orange', { rows: since, ev }) });
  const rollSlab = `<button class="cut" style="height:144px; border:0; background:${C.pine}; color:${C.chalk}; display:flex; align-items:center; justify-content:center; gap:18px">
    <span style="display:flex; gap:10px; transform:rotate(-6deg)">${die(4, 54, C.chalk, C.pine)}<span style="transform:rotate(12deg) translateY(6px)">${die(2, 54, C.chalk, C.pine)}</span></span><span class="d" style="font-size:30px">Roll</span></button>`;
  const p2 = shell(seatFor('orange', { ev, hand: { wood: 1, brick: 0, sheep: 1, wheat: 0, ore: 2 }, devs: [] }), { roll: null, top: 'Round 10', zone: rollSlab, buttons: '' });
  const seven = `<span style="font-size:15px; font-weight:600">Discard 5</span>`;
  const p3 = shell(seatFor('blue', { ev }), { roll: [3, 4], top: 'Orange rolled 7', bottom: cover('blue', { rows: [['orange', 'seven', 'Rolled 7']], ev, head: seven, replay: false }) });
  const lab = (t) => `<span style="font-size:11.5px; font-weight:600; color:${C.moss}">${t}</span>`;
  const offer = `<div class="cut8" style="height:84px; padding:7px 12px; background:#fff; box-shadow:0 8px 18px rgba(18,33,31,.14); display:flex; align-items:center; gap:14px">
    <div style="display:flex; flex-direction:column; gap:4px">${lab('You get')}<div style="display:flex; gap:4px">${card('ore', null, 40, 52)}</div></div>
    <div style="display:flex; flex-direction:column; gap:4px">${lab('You give')}<div style="display:flex; gap:4px">${card('wheat', null, 40, 52)}${card('wheat', null, 40, 52)}</div></div>
    ${ev ? `<div style="margin-left:auto; display:grid; grid-template-columns:auto auto; gap:6px 8px; align-items:center"><i style="width:9px; height:9px; background:${SEAT.blue}"></i><span class="num" style="font-size:13px; font-weight:700; color:#a5452b">▼1</span><i style="width:9px; height:9px; background:${SEAT.orange}"></i><span class="num" style="font-size:13px; font-weight:700; color:#2e7d4f">▲4</span></div>` : ''}</div>`;
  const s4 = seatFor('blue', { ev, hand: { wood: 2, brick: 1, sheep: 0, wheat: 2, ore: 2 } });
  s4.opps.forEach((o) => { o.on = o.s === 'orange'; o.off = o.s !== 'orange'; });
  const p4 = shell(s4, { roll: [4, 2], top: 'Round 10', zone: offer, buttons: `<div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Decline</button><button class="btn go cut8" style="flex:1.4; height:50px">Accept</button></div>`, handOpts: { lift: { wheat: 2 } } });
  return { pr3, pr4, p1, p2, p3, p4 };
};

const a = ph(true);
writeSections('handoff-v2.html', 'Pass and play', [
  { title: 'Pass and play: the replay', sub: 'Blue and Orange are people at one phone; Red and White are bots. Blue just ended the turn.', options: [
    { id: 'r3', name: 'Replaying Blue\'s roll', phone: a.pr3, notes: ['End turn covers the private half in Orange\'s colour and the board replays every move since Orange last played, at about a second a move, while the phone changes hands. The row playing is lit; the strip above shows where the replay is.', 'Here, move three of four: the 8s rise and the wood flies, into the chips and into Orange\'s cover.'] },
    { id: 'r4', name: 'Replaying Blue\'s settlement', phone: a.pr4, notes: ['The settlement lands as its row lights. Bars move with each move when evaluation is on.'] },
    { id: 'cover', name: 'Caught up', phone: a.p1, notes: ['At the end the board is the present. ↺ replays from the start; tapping a row jumps the board to just before that move. Show hand ends the replay wherever it is.'] },
    { id: 'reveal', name: 'Orange\'s turn', phone: a.p2, notes: ['The cover lifts; the bottom row carries the seat\'s own name rather than "You".'] },
  ] },
  { title: 'Mid-turn answers', sub: 'Only the answer passes; nothing to replay.', options: [
    { id: 'discard', name: 'A 7 mid-turn', phone: a.p3, notes: ['A seven, an offer or a steal reaching another person passes the phone for just that answer, then back under a cover in the turn player\'s colour.'] },
    { id: 'answer', name: 'Blue answers Orange', phone: a.p4, notes: ['The offer as Blue sees it after Show hand.'] },
  ] },
]);
