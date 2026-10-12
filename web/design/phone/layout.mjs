// Screen 1: how the board, your controls and the live reading share a portrait phone.
import { C, SEAT, S, RES, seat, phone, card, stack, devCard, devFan, pieceIcon, devBack, die, svgBoard, write } from './lib.mjs';

const you = seat('blue');
const opps = S.seats.filter((x) => x.s !== 'blue');
const cardsIcon = (n, c = C.moss) => `<span style="display:inline-flex; align-items:center; gap:3px; color:${c}"><svg viewBox="0 0 14 16" width="11" height="13"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55"/></svg><span class="num" style="font-size:12.5px; font-weight:600">${n}</span></span>`;
const hand = (w = 52, h = 72) => RES.map((r) => S.hand[r] ? stack(r, S.hand[r], w, h) : '').join('');
const handBox = (w, h, gap = 6) => `<div style="display:flex; align-items:flex-end; gap:${gap}px">${hand(w, h)}<span style="margin-left:auto"></span>${devFan(S.devs, Math.round(w * 0.82), Math.round(h * 0.86))}</div>`;
const diceBtn = (sz = 26) => `<span style="display:inline-flex; gap:4px">${die(S.dice[0], sz, C.chalk, C.pine)}${die(S.dice[1], sz, C.chalk, C.pine)}</span>`;

// ── A: around the table ─────────────────────────────────────────────────────────────
function A() {
  const chip = (o) => `<div class="cut8" style="flex:1; background:${C.paper}; padding:8px 10px 0; display:flex; flex-direction:column; gap:3px; position:relative">
      <div style="display:flex; align-items:center; gap:6px"><i style="width:9px; height:9px; background:${SEAT[o.s]}"></i><span style="font-size:13px; font-weight:600">${o.name}</span><span class="d num" style="margin-left:auto; font-size:20px">${o.vp}</span></div>
      <div style="display:flex; gap:10px">${cardsIcon(o.cards)}<span style="display:inline-flex; align-items:center; gap:2px">${devBack(13)}<span class="num" style="font-size:12.5px; font-weight:600; color:${C.moss}">${o.dev}</span></span><span class="num" style="margin-left:auto; font-size:12.5px; font-weight:600">${o.win}%</span></div>
      <div style="height:4px; margin:5px -10px 0; background:${C.dust}"><i style="display:block; height:100%; width:${o.win}%; background:${SEAT[o.s]}"></i></div>
    </div>`;
  const supply = [['road', 9], ['settlement', 2], ['city', 3]].map(([k, n]) =>
    `<span style="display:inline-flex; flex-direction:column; align-items:center; gap:1px">${pieceIcon(k, 'blue', 26)}<span class="num" style="font-size:11px; font-weight:600; color:${C.moss}">${n}</span></span>`).join('');
  return phone(`
    <div style="display:flex; flex-direction:column; height:100%">
      <div style="height:44px; display:flex; align-items:center; padding:0 16px; gap:10px">
        <span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">Round 9</span>
      </div>
      <div style="display:flex; gap:8px; padding:0 16px">${opps.map(chip).join('')}</div>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; min-height:0; position:relative">${svgBoard(390)}<span style="position:absolute; left:18px; bottom:6px; display:flex; gap:5px; transform:rotate(-8deg)">${die(S.dice[0], 30)}<span style="transform:rotate(14deg) translateY(4px)">${die(S.dice[1], 30)}</span></span></div>
      <div style="padding:0 16px 10px; display:flex; flex-direction:column; gap:10px">
        <div style="display:flex; align-items:center; gap:8px"><i style="width:9px; height:9px; background:${SEAT.blue}"></i><span style="font-size:13px; font-weight:600">You</span><span class="d num" style="font-size:20px">6</span>
          <div style="flex:1; height:4px; background:${C.dust}; margin:0 6px"><i style="display:block; height:100%; width:${you.win}%; background:${SEAT.blue}"></i></div><span class="num" style="font-size:12.5px; font-weight:600">31%</span></div>
        ${handBox(52, 72)}
        <div style="display:flex; gap:8px; align-items:stretch">
          <div class="cut8" style="flex:1; background:${C.paper}; display:flex; align-items:center; justify-content:space-around; height:56px">${supply}<span style="display:inline-flex; flex-direction:column; align-items:center">${devBack(24)}<span class="num" style="font-size:11px; font-weight:600; color:${C.moss}">19</span></span></div>
          <button class="btn cut8" style="height:56px">Trade</button>
          <button class="btn go cut8" style="height:56px; padding:0 14px">End turn</button>
        </div>
      </div>
    </div>`);
}

// ── B: engine view ──────────────────────────────────────────────────────────────────
function B() {
  const order = ['red', 'blue', 'orange', 'grey'];
  const names = order.map((s) => { const o = seat(s); return `<div style="flex:1; display:flex; align-items:center; gap:6px"><i style="width:9px; height:9px; background:${SEAT[s]}"></i><span style="font-size:12.5px; font-weight:600">${o.name}</span><span class="d num" style="font-size:17px">${o.vp}</span></div>`; }).join('');
  const bar = order.map((s) => { const o = seat(s); return `<div style="flex:${o.win}; height:24px; background:${SEAT[s]}; color:${s === 'grey' ? C.pine : C.chalk}; display:flex; align-items:center; padding-left:6px"><span class="num" style="font-size:12.5px; font-weight:700">${o.win}%</span></div>`; }).join('');
  const head = `<div style="display:flex; flex-direction:column; gap:6px; width:100%"><div style="display:flex">${names}</div><div style="display:flex; gap:2px">${bar}</div></div>`;
  const feed = [
    ['orange', 'road', '−0.4'], ['grey', 'settlement', '+1.2'], ['red', 'city', '+4.6'], ['red', 'dev', '+0.8'], ['blue', 'dice', '8'],
  ].map(([s, k, d], i, a) => `<div class="cut5" style="flex:0 0 auto; display:flex; align-items:center; gap:6px; height:36px; padding:0 10px; background:${i === a.length - 1 ? C.pine : C.paper}; color:${i === a.length - 1 ? C.chalk : C.pine}">
      ${k === 'dice' ? `<span style="display:inline-flex; gap:3px">${die(5, 18)}${die(3, 18)}</span>` : k === 'dev' ? devBack(18) : pieceIcon(k, s, 20)}
      <span class="num" style="font-size:13px; font-weight:600">${d}</span></div>`).join('');
  const best = [['city', 'City', 41, '+10'], ['dev', 'Dev card', 34, '+3'], ['road', 'Road', 32, '+1']].map(([k, t, w, d], i) =>
    `<div class="cut8" style="flex:1; display:flex; flex-direction:column; gap:4px; padding:8px 10px; background:${i ? C.paper : '#e3ebf8'}">
      <div style="display:flex; align-items:center; gap:6px">${k === 'dev' ? devBack(18) : pieceIcon(k, 'blue', 18)}<span style="font-size:13px; font-weight:600">${t}</span></div>
      <span class="d num" style="font-size:19px">${w}%</span></div>`).join('');
  return phone(`
    <div style="display:flex; flex-direction:column; height:100%">
      <div style="height:44px; display:flex; align-items:center; padding:0 16px; gap:10px">
        <span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">Round 9</span>
      </div>
      <div style="display:flex; gap:2px; padding:0 16px">${head}</div>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; min-height:0; overflow:hidden">${svgBoard(372)}</div>
      <div style="display:flex; gap:6px; padding:0 16px; overflow:hidden; justify-content:flex-end">${feed}</div>
      <div style="display:flex; gap:6px; padding:10px 16px 0">${best}</div>
      <div style="padding:12px 16px 10px; display:flex; flex-direction:column; gap:10px">
        ${handBox(48, 66)}
        <div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1">Build</button><button class="btn cut8" style="flex:1">Trade</button><button class="btn go cut8" style="flex:1">End turn</button></div>
      </div>
    </div>`);
}

// ── C: the sheet ────────────────────────────────────────────────────────────────────
function C_() {
  const corner = (o, pos) => `<div class="cut8" style="position:absolute; ${pos}; background:rgba(247,248,244,.94); padding:7px 10px; display:flex; flex-direction:column; gap:2px; min-width:96px">
      <div style="display:flex; align-items:center; gap:6px"><i style="width:9px; height:9px; background:${SEAT[o.s]}"></i><span style="font-size:13px; font-weight:600">${o.name}</span><span class="d num" style="margin-left:auto; font-size:19px">${o.vp}</span></div>
      <div style="display:flex; gap:9px; align-items:center">${cardsIcon(o.cards)}<span class="num" style="margin-left:auto; font-size:12.5px; font-weight:700; color:${SEAT[o.s] === SEAT.grey ? C.moss : SEAT[o.s]}">${o.win}%</span></div></div>`;
  const spark = (() => {
    const v = [25, 24, 27, 26, 22, 24, 29, 28, 33, 30, 31];
    const p = v.map((y, i) => `${(i * 9.4).toFixed(1)},${(30 - (y - 15) * 1.2).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 96 32" width="96" height="32"><polyline points="${p}" fill="none" stroke="${SEAT.blue}" stroke-width="2.4" stroke-linejoin="round"/></svg>`;
  })();
  return phone(`
    <div style="position:absolute; left:-10px; right:-10px; top:40px; display:flex; justify-content:center">${svgBoard(410, [-252, -252, 504, 504])}</div>
    <div style="position:absolute; left:16px; top:4px; display:flex; align-items:center; gap:10px"><span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">Round 9</span></div>
    ${corner(seat('red'), 'left:12px; top:44px')}${corner(seat('orange'), 'right:12px; top:44px')}${corner(seat('grey'), 'left:12px; top:424px')}<span style="position:absolute; right:24px; top:430px; display:flex; gap:5px; transform:rotate(7deg)">${die(S.dice[0], 30)}<span style="transform:rotate(-15deg) translateY(3px)">${die(S.dice[1], 30)}</span></span>
    <div style="position:absolute; left:0; right:0; bottom:0; height:290px; background:${C.chalk}; box-shadow:0 -10px 30px rgba(18,33,31,.16); border-radius:22px 22px 0 0; padding:10px 16px 10px; display:flex; flex-direction:column; gap:12px">
      <i style="align-self:center; width:40px; height:5px; border-radius:3px; background:${C.dust}"></i>
      <div style="display:flex; align-items:center; gap:10px"><i style="width:10px; height:10px; background:${SEAT.blue}"></i><span class="d" style="font-size:20px">You</span><span class="d num" style="font-size:20px">6</span>
        <span style="margin-left:auto">${spark}</span><span class="d num" style="font-size:24px; color:${SEAT.blue}">31%</span></div>
      ${handBox(52, 72)}
      <div style="display:flex; gap:6px">${[['city', 'City', 41], ['dev', 'Dev', 34], ['road', 'Road', 32]].map(([k, t, w], i) => `<div class="cut5" style="flex:1; display:flex; align-items:center; gap:6px; height:34px; padding:0 9px; background:${i ? 'transparent' : '#e3ebf8'}; box-shadow:inset 0 0 0 1px ${C.dust}">${k === 'dev' ? devBack(16) : pieceIcon(k, 'blue', 16)}<span style="font-size:12.5px; font-weight:600">${t}</span><span class="num" style="margin-left:auto; font-size:12.5px; font-weight:700">${w}%</span></div>`).join('')}</div>
      <div style="display:flex; gap:8px; margin-top:auto"><button class="btn cut8" style="flex:1">Build</button><button class="btn cut8" style="flex:1">Trade</button><button class="btn go cut8" style="flex:1.3">End turn</button></div>
    </div>`);
}

write('layout.html', 'Where do the board, your hand and the reading live?',
  'All three show the same moment: round 9, your turn, you just rolled an 8 and hold eleven cards and two development cards. Pick the one that feels closest; the next screens design each phase of the game inside it.',
  [
    { id: 'a', name: 'A. Around the table', phone: A(), notes: ['Opponents sit across the top like players across a table; you sit at the bottom with your hand and your piece supply.', 'Each seat carries its live win chance as a bar. Drag a piece out of the supply onto the board to build.'] },
    { id: 'b', name: 'B. Engine view', phone: B(), notes: ['Chess-app grammar: the seats are a stacked win bar that shifts with every move, a feed of the last moves with how much each one swung, and the engine\'s best three moves for you right now.', 'Most analysis on screen at once; the board gives up a little size.'] },
    { id: 'c', name: 'C. The sheet', phone: C_(), notes: ['The board runs edge to edge with the seats floating at its corners. You live in a sheet at the bottom: your hand, your win chance and its trend.', 'Pull the sheet up for the analysis (curve, best moves); push it down to see the whole board.'] },
  ]);
