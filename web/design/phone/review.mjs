// Screen 6: watching bots, a cold shared link, game over and the review.
import { C, SEAT, st, shell, piece, bx, by, delta, pieceIcon, devBack, die, boardSvg, BW, BH } from './a.mjs';
import { phone, writeSections, devCard } from './lib.mjs';
import { SEAT_LO } from '../board.mjs';

const NAME = { red: 'Red', blue: 'Blue', orange: 'Orange', grey: 'White' };
const KIND = { red: 'Value-net search', blue: 'jSettler', orange: 'UCT', grey: 'Heuristic search' };
const ORDER = ['red', 'blue', 'orange', 'grey'];
const LINE = { ...SEAT, grey: SEAT_LO.grey };

// A deterministic game: four win chances over 96 steps, Red winning. Logit random walk, softmaxed.
function series(n = 96) {
  let x = 0x2545f491; const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  const z = [0, 0, 0, 0], out = [];
  for (let t = 0; t < n; t++) {
    z.forEach((_, k) => { z[k] += rnd() * 0.35; });
    if (t === 31) z[1] -= 0.9;            // B: a costly road of yours
    if (t === 23) z[0] += 0.8;            // A: Red's city
    if (t === 52) z[2] += 0.7;            // C: Orange takes longest road
    if (t > 40) z[0] += 0.055; if (t > 52 && t < 60) z[2] -= 0.12;
    const e = z.map((v) => Math.exp(v)), s = e.reduce((a, b) => a + b);
    out.push(e.map((v) => v / s));
  }
  out[n - 1] = [1, 0, 0, 0];
  return out;
}
const SER = series();
const PUCKS = [{ t: 23, k: 0, l: 'A' }, { t: 31, k: 1, l: 'B' }, { t: 52, k: 2, l: 'C' }, { t: 95, k: 0, l: 'W' }];
const PONR = 66;

/** The curve: each seat's chance over the game; the playhead is where the board is. `bold` thickens one seat. */
function curve(w, h, { at = SER.length - 1, bold = -1, pucks = true, ponr = false, upto = SER.length } = {}) {
  const X = (t) => 6 + (t / (SER.length - 1)) * (w - 12), Y = (p) => 6 + (1 - p) * (h - 12);
  const pl = (k, a, b, op) => `<polyline points="${SER.slice(a, b).map((r, i) => `${X(a + i).toFixed(1)},${Y(r[k]).toFixed(1)}`).join(' ')}" fill="none" stroke="${LINE[ORDER[k]]}" stroke-width="${k === bold ? 2.6 : bold >= 0 ? 1.3 : 1.8}" stroke-linejoin="round" opacity="${op * (bold >= 0 && k !== bold ? 0.6 : 1)}"/>`;
  const lines = [3, 2, 1, 0].map((k) => pl(k, 0, Math.min(at + 1, upto), 1) + (at + 1 < upto ? pl(k, at, upto, 0.3) : '')).join('');
  const pk = pucks ? PUCKS.filter((p) => p.t < upto).map((p) => `<g transform="translate(${X(p.t).toFixed(1)},${Y(SER[p.t][p.k]).toFixed(1)})"><circle r="7.5" fill="${SEAT[ORDER[p.k]]}"/><text y="3.6" text-anchor="middle" font-size="10" font-weight="700" fill="${ORDER[p.k] === 'grey' ? C.pine : C.chalk}" font-family="Chivo">${p.l}</text></g>`).join('') : '';
  const nr = ponr ? `<line x1="${X(PONR)}" y1="2" x2="${X(PONR)}" y2="${h - 2}" stroke="${C.moss}" stroke-width="1" stroke-dasharray="2 3"/>` : '';
  const head = `<line x1="${X(at)}" y1="0" x2="${X(at)}" y2="${h}" stroke="${C.pine}" stroke-width="1.6"/><rect x="${X(at) - 5}" y="${h - 8}" width="10" height="8" fill="${C.pine}"/>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><rect width="${w}" height="${h}" fill="${C.paper}"/><line x1="0" y1="${Y(0.25)}" x2="${w}" y2="${Y(0.25)}" stroke="${C.dust}" stroke-width="1"/>${nr}${lines}${pk}${head}</svg>`;
}

const sw = (s, n = 9) => `<i style="width:${n}px; height:${n}px; flex:0 0 ${n}px; background:${SEAT[s]}"></i>`;
const topBar = (title, right = '') => `<div style="height:40px; flex:0 0 40px; display:flex; align-items:center; padding:0 16px; gap:10px"><span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">${title}</span><span style="margin-left:auto"></span>${right}</div>`;
const evOn = `<span style="display:inline-flex; align-items:center; gap:7px; height:44px"><span style="font-size:13px; font-weight:600">Eval</span><span style="position:relative; width:34px; height:20px; border-radius:10px; background:${C.pine}"><i style="position:absolute; top:3px; left:17px; width:14px; height:14px; border-radius:50%; background:${C.chalk}"></i></span></span>`;
const boardBox = (svg = '', over = '', w = BW) => `<div style="display:flex; justify-content:center"><div style="position:relative; width:${BW}px; height:${BH}px; ${w !== BW ? `zoom:${(w / BW).toFixed(3)}` : ''}">${boardSvg(svg)}${over}</div></div>`;
/** One move as a row: seat, piece, what, change. */
const moveRow = (s, ic, what, d, { lit = true, extra = '' } = {}) => `<div class="cut5" style="height:40px; display:flex; align-items:center; gap:9px; padding:0 12px; background:${lit ? '#fff' : C.paper}; ${lit ? 'box-shadow:0 6px 14px rgba(18,33,31,.12)' : ''}">${sw(s)}<span style="font-size:13px; font-weight:600; width:50px">${NAME[s]}</span><span style="width:26px; display:inline-flex; justify-content:center">${ic}</span><span style="font-size:13px">${what}</span>${extra}<span style="margin-left:auto">${d ? delta(d) : ''}</span></div>`;
const tbtn = (g, w = 44, go = false) => `<button class="btn cut8" style="width:${w}px; height:44px; padding:0; ${go ? `background:${C.pine}; color:${C.chalk}` : ''}; font-size:17px">${g}</button>`;
const PLAY = `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 2 L14 8 L4 14 Z" fill="currentColor"/></svg>`;
const PAUSE = `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="2" width="3.6" height="12" fill="currentColor"/><rect x="9.4" y="2" width="3.6" height="12" fill="currentColor"/></svg>`;
const STEP = (dir) => `<svg width="16" height="16" viewBox="0 0 16 16" ${dir < 0 ? 'style="transform:scaleX(-1)"' : ''}><path d="M3 2 L11 8 L3 14 Z" fill="currentColor"/><rect x="11.5" y="2" width="2.5" height="12" fill="currentColor"/></svg>`;
const seatRow = (s, vp, win, { cards, dev, lead } = {}) => `<div style="height:30px; display:flex; align-items:center; gap:8px">${sw(s)}<span style="font-size:13px; font-weight:600; width:52px">${NAME[s]}</span><span style="font-size:12px; color:${C.moss}; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${KIND[s]}</span>${win != null ? `<span class="num" style="font-size:12.5px; font-weight:600; width:34px; text-align:right">${win}%</span>` : ''}<span class="d num" style="font-size:20px; width:26px; text-align:right; ${lead ? `color:${SEAT[s]}` : ''}">${vp}</span></div>`;

// A. Watching four bots, live.
const wins = SER[78].map((p) => Math.round(p * 100));
const pA = phone(`<div style="display:flex; flex-direction:column; height:100%">${topBar('Round 21', `<span style="display:inline-flex; gap:4px; margin-right:6px">${die(6, 24)}${die(2, 24)}</span>${evOn}`)}
  <div style="flex:1; display:flex; align-items:center">${boardBox(`<g transform="translate(0,-4)" filter="url(#lift)">${piece('city', 'red', 0, -88)}</g><defs><filter id="lift" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="3.5" flood-color="#12211f" flood-opacity=".35"/></filter></defs>`)}</div>
  <div style="padding:0 16px 12px; display:flex; flex-direction:column; gap:8px">
    ${moveRow('red', pieceIcon('city', 'red', 20), 'City', 6)}
    <div class="cut5" style="overflow:hidden">${curve(358, 74, { at: 78, upto: 79 })}</div>
    <div style="display:flex; gap:6px; align-items:center">${tbtn(STEP(-1))}${tbtn(PAUSE, 56, true)}${tbtn(STEP(1))}<span style="margin-left:auto"></span><button class="btn cut8" style="height:44px; padding:0 14px">2×</button></div>
    <div>${ORDER.map((s, k) => seatRow(s, [8, 6, 7, 5][k], wins[k], { lead: k === 0 })).join('')}</div>
  </div></div>`);

// B. Paused and dragged back to B: the board and the row are that moment; Live returns.
const winsB = SER[31].map((p) => Math.round(p * 100));
const pB = phone(`<div style="display:flex; flex-direction:column; height:100%">${topBar('Round 8', evOn)}
  <div style="flex:1; display:flex; align-items:center">${boardBox(`<line x1="38.1" y1="154" x2="0" y2="176" stroke="${SEAT.blue}" stroke-width="5.4" stroke-linecap="round" transform="translate(0,-4)" filter="url(#lift)"/><defs><filter id="lift" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="3.5" flood-color="#12211f" flood-opacity=".35"/></filter></defs>`)}</div>
  <div style="padding:0 16px 12px; display:flex; flex-direction:column; gap:8px">
    ${moveRow('blue', pieceIcon('road', 'blue', 20), 'Road', -12, { extra: `<span class="cut5" style="margin-left:8px; height:20px; padding:0 7px; display:inline-flex; align-items:center; background:${SEAT.blue}; color:${C.chalk}; font-size:11px; font-weight:700">B</span>` })}
    <div class="cut5" style="overflow:hidden">${curve(358, 74, { at: 31, upto: 79 })}</div>
    <div style="display:flex; gap:6px; align-items:center">${tbtn(STEP(-1))}${tbtn(PLAY, 56, true)}${tbtn(STEP(1))}<span style="margin-left:auto"></span><button class="btn cut8" style="height:44px; padding:0 14px">Live</button></div>
    <div>${ORDER.map((s, k) => seatRow(s, [3, 4, 2, 2][k], winsB[k])).join('')}</div>
  </div></div>`);

// C. A shared link opened cold: the result first, then the two ways in.
const finalVP = [10, 6, 8, 5];
const pC = phone(`<div style="display:flex; flex-direction:column; height:100%">
  <div style="height:40px; display:flex; align-items:center; padding:0 16px"><span class="d" style="font-size:16px; color:${C.moss}">Catan RL</span></div>
  <div style="flex:1; display:flex; align-items:center">${boardBox(piece('set', 'red', -76.21, -176))}</div>
  <div style="padding:0 16px 12px; display:flex; flex-direction:column; gap:10px">
    <div style="display:flex; align-items:baseline; gap:12px"><span class="d" style="font-size:34px; color:${SEAT.red}; line-height:1">Red won</span><span class="num" style="font-size:13px; color:${C.moss}">Round 24</span></div>
    <div class="cut5" style="overflow:hidden">${curve(358, 64, { pucks: true })}</div>
    <div>${[0, 2, 1, 3].map((k) => seatRow(ORDER[k], finalVP[k], null, { lead: k === 0 })).join('')}</div>
    <div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Watch</button><button class="btn go cut8" style="flex:1.4; height:50px">Review</button></div>
  </div></div>`);

// D. Game over at your table: the hand gives way to the result; VP cards turn face up.
const res = st({ you: { vp: 8, win: 0 } });
res.opps.forEach((o) => { o.win = 0; }); res.opps[0].win = 100; res.opps[0].vp = 10; res.opps[0].on = true; res.opps[1].off = true; res.opps[2].off = true;
const resultRow = (s, name, vp, extra = '', lead = false) => `<div style="height:34px; display:flex; align-items:center; gap:9px">${sw(s)}<span style="font-size:14px; font-weight:600; width:56px">${name}</span>${extra}<span class="d num" style="margin-left:auto; font-size:22px; ${lead ? `color:${SEAT[s]}` : ''}">${vp}</span></div>`;
const vpCard = (s) => `<span style="display:inline-flex; transform:rotate(-4deg)">${devCard(4, 26, 34)}</span>`;
const result = `<div style="height:281px; display:flex; flex-direction:column; gap:8px">
  <div style="display:flex; align-items:baseline; gap:10px"><span class="d" style="font-size:30px; color:${SEAT.red}; line-height:1">Red won</span><span style="font-size:14px; font-weight:600">You came second</span></div>
  <div class="cut5" style="overflow:hidden">${curve(358, 56, { bold: 1, pucks: true })}</div>
  <div>${resultRow('red', 'Red', 10, vpCard('red'), true)}${resultRow('blue', 'You', 8)}${resultRow('orange', 'Orange', 6)}${resultRow('grey', 'White', 5)}</div>
  <div style="margin-top:auto; display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Rematch</button><button class="btn go cut8" style="flex:1.4; height:50px">Review</button></div></div>`;
const pD = shell(res, { roll: [6, 4], top: 'Round 24', svg: piece('set', 'red', -76.21, -176), bottom: result });

// E. The review: the curve is the scrubber, the decisive moves are lettered on it, your own moves are graded.
const GRADE = [['Best', '#2e7d4f', 14], ['Good', '#6f8f7f', 23], ['Inaccuracy', '#c9a227', 5], ['Mistake', '#c46a2a', 2], ['Blunder', '#a5452b', 1]];
const tally = `<div style="display:flex; gap:5px">${GRADE.map(([g, c, n]) => `<div class="cut5" style="flex:1; min-width:0; height:46px; background:${C.paper}; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px"><span class="d num" style="font-size:18px; color:${c}; line-height:1">${n}</span><span style="font-size:10px; font-weight:600; color:${C.moss}">${g}</span></div>`).join('')}</div>`;
const key = (l, s, ic, what, d, round) => `<div class="cut5" style="height:38px; display:flex; align-items:center; gap:9px; padding:0 10px; background:${C.paper}"><span style="width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; background:${SEAT[s]}; color:${s === 'grey' ? C.pine : C.chalk}; font-size:11px; font-weight:700; border-radius:50%">${l}</span><span class="num" style="font-size:12px; color:${C.moss}; width:56px">Round ${round}</span><span style="font-size:13px; font-weight:600">${NAME[s] === 'Blue' ? 'You' : NAME[s]}</span><span style="display:inline-flex">${ic}</span><span style="font-size:13px">${what}</span><span style="margin-left:auto">${delta(d)}</span></div>`;
const pE = phone(`<div style="display:flex; flex-direction:column; height:100%">${topBar('Review')}
  <div style="display:flex; justify-content:center; margin:-4px 0 2px">${boardBox('', '', 300)}</div>
  <div style="padding:0 16px 12px; display:flex; flex-direction:column; gap:8px; overflow:hidden">
    <div class="cut5" style="overflow:hidden">${curve(358, 96, { bold: 1, ponr: true, at: 95 })}</div>
    ${tally}
    ${key('A', 'red', pieceIcon('city', 'red', 16), 'City', 14, 6)}
    ${key('B', 'blue', pieceIcon('road', 'blue', 16), 'Road', -12, 8)}
    ${key('C', 'orange', pieceIcon('road', 'orange', 16), 'Longest road', 11, 14)}
    ${key('W', 'red', pieceIcon('settlement', 'red', 16), 'Settlement', 9, 24)}
  </div></div>`);

// F. Stopped on your mistake: what you played, and the best move as a faint piece where it would have gone.
const ghost = `<g opacity=".5">${piece('set', 'blue', 38.1, 154)}</g>`;
const tag = (x, y, t, c) => `<span class="cut5" style="position:absolute; left:${x}px; top:${y}px; height:20px; padding:0 7px; display:inline-flex; align-items:center; background:${c}; color:#fff; font-size:11.5px; font-weight:700">${t}</span>`;
const pF = phone(`<div style="display:flex; flex-direction:column; height:100%">${topBar('Review')}
  <div style="flex:1; display:flex; align-items:center">${boardBox(`<defs><filter id="liftF" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="3.5" flood-color="#12211f" flood-opacity=".35"/></filter></defs><line x1="38.1" y1="154" x2="0" y2="176" stroke="${SEAT.blue}" stroke-width="5.4" stroke-linecap="round" transform="translate(0,-4)" filter="url(#liftF)"/>` + ghost, tag(bx(38.1) + 12, by(154), 'Best', '#2e7d4f'))}</div>
  <div style="padding:0 16px 12px; display:flex; flex-direction:column; gap:8px">
    ${moveRow('blue', pieceIcon('road', 'blue', 20), 'Road', -12, { extra: `<span style="margin-left:8px; font-size:12px; font-weight:700; color:#c46a2a">Mistake</span>` })}
    ${moveRow('blue', `<span style="opacity:.6">${pieceIcon('settlement', 'blue', 18)}</span>`, 'Settlement', 0, { lit: false, extra: `<span style="margin-left:8px; font-size:12px; font-weight:700; color:#2e7d4f">Best</span><span class="num" style="margin-left:auto; font-size:12px; font-weight:700; color:#2e7d4f">+12 over yours</span>` })}
    <div class="cut5" style="overflow:hidden">${curve(358, 74, { bold: 1, at: 31 })}</div>
    <div style="display:flex; gap:6px; align-items:center">${tbtn(STEP(-1))}${tbtn(STEP(1))}<button class="btn cut8" style="flex:1; height:44px">Next key move</button></div>
  </div></div>`);

writeSections('watch-review.html', 'Watching, sharing, reviewing', [
  { title: 'Watching bots and shared links', sub: 'No one is seated, so there is no hand: the seats move to the bottom as a standings list.', options: [
    { id: 'watch', name: 'Watching, live', phone: pA, notes: ['The newest move sits above the curve and lands on the board as its row lands. The curve is the scrubber: drag it to go back.', 'With evaluation off the curve draws each seat\'s points instead of its chance.'] },
    { id: 'scrub', name: 'Dragged back to B', phone: pB, notes: ['Pausing and dragging puts the board, the row and the standings at that moment. The lettered pucks are the moves that decided the game (the site\'s existing measure: the biggest swings past 10 points, two to five a game). Live jumps back to now.'] },
    { id: 'shared', name: 'A shared link, cold', phone: pC, notes: ['Someone opening a link knows nothing yet, so the result comes first: who won, the curve, the final points and the lineup. Watch replays it from the start; Review opens the analysis. A link to a single move opens the review at that move.'] },
  ] },
  { title: 'Game over and the review', sub: 'You (Blue) against three bots; you came second.', options: [
    { id: 'over', name: 'Game over', phone: pD, notes: ['The winning piece lands, Red\'s VP card turns face up, and the private half of the table gives way to the result, with the whole game\'s curve as the way into the review. Rematch keeps the lineup and the board.'] },
    { id: 'review', name: 'Review', phone: pE, notes: ['Board on top, the curve below with your line bold and the dashed point after which Red never trailed. Then your moves graded, counted like a chess review, and the decisive moves, each a tap from the board at that moment.', 'The grade thresholds need measuring before they are fixed, the way deciding.ts measured its floor.'] },
    { id: 'mistake', name: 'At your mistake', phone: pF, notes: ['Stepping onto a graded move shows what you played and, as a faint piece, the best move and its margin. Next key move jumps to the next decisive move or the next of your mistakes.'] },
  ] },
]);
