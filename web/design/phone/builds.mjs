// Screen 2: layout A, with what each build costs made legible.
import { C, SEAT, S, RES, seat, phone, card, devFan, pieceIcon, devBack, die, svgBoard, write } from './lib.mjs';
import { glyphMini } from '../board.mjs';

const COST = { road: { wood: 1, brick: 1 }, settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 }, city: { wheat: 2, ore: 3 }, dev: { sheep: 1, wheat: 1, ore: 1 } };
const NAME = { road: 'Road', settlement: 'Settlement', city: 'City', dev: 'Dev card' };
const LEFT = { road: 9, settlement: 2, city: 3, dev: 19 };
// Pieces left only when they're scarce, as on desktop (Build.tsx): a bare 9 beside a road reads as a cost.
const left = (k) => LEFT[k] <= 2 ? `<span class="num" style="font-size:11px; font-weight:700; color:#a5452b; white-space:nowrap">${LEFT[k]} left</span>` : '';
const KINDS = ['road', 'settlement', 'city', 'dev'];
const can = (k) => Object.entries(COST[k]).every(([r, n]) => S.hand[r] >= n);
const opps = S.seats.filter((x) => x.s !== 'blue');

const cardsIcon = (n) => `<span style="display:inline-flex; align-items:center; gap:3px; color:${C.moss}"><svg viewBox="0 0 14 16" width="11" height="13"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55"/></svg><span class="num" style="font-size:12.5px; font-weight:600">${n}</span></span>`;
const chip = (o) => `<div class="cut8" style="flex:1; background:${C.paper}; padding:8px 10px 0; display:flex; flex-direction:column; gap:3px">
    <div style="display:flex; align-items:center; gap:6px"><i style="width:9px; height:9px; background:${SEAT[o.s]}"></i><span style="font-size:13px; font-weight:600">${o.name}</span><span class="d num" style="margin-left:auto; font-size:20px">${o.vp}</span></div>
    <div style="display:flex; gap:10px">${cardsIcon(o.cards)}<span style="display:inline-flex; align-items:center; gap:2px">${devBack(13)}<span class="num" style="font-size:12.5px; font-weight:600; color:${C.moss}">${o.dev}</span></span><span class="num" style="margin-left:auto; font-size:12.5px; font-weight:600">${o.win}%</span></div>
    <div style="height:4px; margin:5px -10px 0; background:${C.dust}"><i style="display:block; height:100%; width:${o.win}%; background:${SEAT[o.s]}"></i></div></div>`;

/** A resource token for a cost: the resource's colour carrying its glyph. Missing ones are faint, same shape. */
const mini = (res, have = true, w = 16, h = 20) => `<span class="cut5" style="display:inline-flex; align-items:center; justify-content:center; width:${w}px; height:${h}px; flex:0 0 ${w}px; background:${have ? C[res] : C.dust}"><svg viewBox="0 0 16 16" width="${w - 3}" height="${w - 3}">${glyphMini(res, 8, 8, 12, 11, have ? 0.9 : 0.35)}</svg></span>`;
/** The cost list for a build, marked against the hand: the first n of each resource you hold are solid. */
function costRow(k, w, h, gap = 3) {
  const out = [];
  for (const [r, n] of Object.entries(COST[k])) for (let i = 0; i < n; i++) out.push(mini(r, i < S.hand[r], w, h));
  return `<span style="display:inline-flex; gap:${gap}px">${out.join('')}</span>`;
}

/** The hand, as stacks. `lift` pulls the cards a build would spend up out of their stack, so the stack's count
 *  drops to what would be left; `ghost` floats a faint card per one you lack. */
function hand(w, h, lift = {}, ghost = {}) {
  const off = 5, UP = 30;
  return RES.map((r) => {
    const n = S.hand[r], up = Math.min(lift[r] || 0, n), gh = ghost[r] || 0, rest = n - up;
    let s = '';
    for (let i = 0; i < rest; i++) s += `<span style="position:absolute; left:0; top:${-(rest - 1 - i) * off}px">${card(r, i === rest - 1 ? rest : null, w, h, i < rest - 1 ? 'filter:brightness(.93)' : '')}</span>`;
    if (!rest) s += `<span class="cut8" style="position:absolute; left:0; top:0; width:${w}px; height:${h}px; background:${C.dust}; opacity:.45"></span>`;
    const base = -Math.max(rest - 1, 0) * off - UP;
    for (let j = 0; j < up + gh; j++) {
      const g = j >= up;
      s += `<span style="position:absolute; left:${j * 7}px; top:${base - j * 6}px; transform:rotate(${(j - (up + gh - 1) / 2) * 5}deg); ${g ? 'opacity:.32' : 'filter:drop-shadow(0 8px 10px rgba(18,33,31,.22))'}">${card(r, null, w, h)}</span>`;
    }
    const lifted = up + gh > 0;
    return `<span style="position:relative; display:inline-block; width:${w}px; height:${h}px; margin-top:${Math.max(n - 1, 0) * off + (lifted ? UP + 6 : 0)}px">${s}</span>`;
  }).join('');
}
const handBox = (w, h, lift, ghost) => `<div style="display:flex; align-items:flex-end; gap:6px">${hand(w, h, lift, ghost)}<span style="margin-left:auto"></span>${devFan(S.devs, Math.round(w * 0.8), Math.round(h * 0.84))}</div>`;

/** Legal settlement spots for blue on the design board, as soft discs. */
const SOCKETS = [[38.1, 154], [0, 176]];
const withSockets = (svg, on) => on ? svg.replace('</svg>', SOCKETS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="${SEAT.blue}" opacity=".5"/><circle cx="${x}" cy="${y}" r="4" fill="${SEAT.blue}"/>`).join('') + '</svg>') : svg;

function shell(buildZone, { lift, ghost, sockets, pressed } = {}) {
  return phone(`
    <div style="display:flex; flex-direction:column; height:100%">
      <div style="height:40px; flex:0 0 40px; display:flex; align-items:center; padding:0 16px; gap:10px"><span style="font-size:26px; line-height:1; color:${C.moss}">‹</span><span class="d" style="font-size:18px">Round 9</span></div>
      <div style="display:flex; gap:8px; padding:0 16px">${opps.map(chip).join('')}</div>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; min-height:0; position:relative">${withSockets(svgBoard(372), sockets)}
        <span style="position:absolute; left:16px; bottom:2px; display:flex; gap:5px; transform:rotate(-8deg)">${die(S.dice[0], 28)}<span style="transform:rotate(14deg) translateY(4px)">${die(S.dice[1], 28)}</span></span></div>
      <div style="padding:0 16px 10px; display:flex; flex-direction:column; gap:10px">
        <div style="display:flex; align-items:center; gap:8px"><i style="width:9px; height:9px; background:${SEAT.blue}"></i><span style="font-size:13px; font-weight:600">You</span><span class="d num" style="font-size:20px">6</span>
          <div style="flex:1; height:4px; background:${C.dust}; margin:0 6px"><i style="display:block; height:100%; width:31%; background:${SEAT.blue}"></i></div><span class="num" style="font-size:12.5px; font-weight:600">31%</span></div>
        ${handBox(50, 68, lift, ghost)}
        ${buildZone}
        <div style="display:flex; gap:8px"><button class="btn cut8" style="flex:1; height:50px">Trade</button><button class="btn go cut8" style="flex:1.4; height:50px">End turn</button></div>
      </div>
    </div>`);
}

// 1 + 2: build cards, each carrying its recipe.
function tiles(pressed) {
  return `<div style="display:flex; gap:6px">${KINDS.map((k) => {
    const ok = can(k), on = k === pressed;
    return `<div class="cut8" style="flex:1; min-width:0; height:84px; padding:7px 7px 8px; display:flex; flex-direction:column; justify-content:space-between; background:${on ? '#dfe8f6' : ok ? C.paper : '#e3e7de'}; color:${ok ? C.pine : C.moss}; ${on ? 'transform:translateY(-6px); box-shadow:0 8px 16px rgba(18,33,31,.18)' : ''}">
      <div style="display:flex; align-items:flex-start; justify-content:space-between">${k === 'dev' ? devBack(24) : pieceIcon(k, 'blue', 24)}${left(k)}</div>
      <span style="font-size:12px; font-weight:600; white-space:nowrap">${NAME[k]}</span>
      ${costRow(k, k === 'city' ? 13 : 15, 18, 2)}
    </div>`;
  }).join('')}</div>`;
}

// 3: the building-costs card from the box, as two-by-two equations.
function recipe() {
  const row = (k) => { const ok = can(k); return `<div class="cut5" style="display:flex; align-items:center; gap:8px; height:40px; padding:0 9px; background:${ok ? C.paper : '#e3e7de'}; color:${ok ? C.pine : C.moss}">
      <span style="width:24px; display:inline-flex; justify-content:center">${k === 'dev' ? devBack(22) : pieceIcon(k, 'blue', 22)}</span>${costRow(k, 16, 20, 3)}<span style="margin-left:auto">${left(k)}</span></div>`; };
  return `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px">${KINDS.map(row).join('')}</div>`;
}

write('builds.html', 'What each build costs, in layout A',
  'Same moment: eleven cards in hand, enough for a road, a settlement or a development card, one ore short of a city. Wood and sheep share a green, so every cost token carries its resource\'s glyph as well as its colour.',
  [
    { id: 'tiles', name: '1. Build cards', phone: shell(tiles()), notes: ['Four cards like the ones in the box, each with its piece and its cost; \'2 left\' appears only when a piece is running out. A cost token you hold is solid; one you lack is faint, so the city shows you are an ore short.', 'Cards you can\'t pay for dim. Drag one onto the board to build, or tap it.'] },
    { id: 'press', name: '2. Same, while you hold City', phone: shell(tiles('city'), { lift: { wheat: 2, ore: 3 }, ghost: { ore: 1 } }), notes: ['Touching a build card pulls the cards it would spend up out of your hand, and each stack\'s count drops to what you\'d keep. A card you lack floats faint: here, the third ore.', 'When you can pay, the board shows where it can go at the same moment; let go on a spot to build, anywhere else and the cards drop back.'] },
    { id: 'recipe', name: '3. A costs card', phone: shell(recipe()), notes: ['Closer to the building-costs card in the box: each piece next to its full recipe, two to a row. Every cost reads as one line, at the price of the piece names.', 'Holding a row lifts your cards the same way as in 2.'] },
  ]);
