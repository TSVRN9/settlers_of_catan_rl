// Screen 3: one turn of yours, start to finish, in layout A with the build cards.
import { C, SEAT, st, shell, tiles, card, die, piece, hex, pts, token, TILES, bx, by } from './a.mjs';
import { S } from './lib.mjs';

// Before the roll the build row and the trade/end row are one slab: the dice. Same footprint, so the board never moves.
const rollSlab = `<button class="cut" style="height:144px; border:0; background:${C.pine}; color:${C.chalk}; display:flex; align-items:center; justify-content:center; gap:18px">
  <span style="display:flex; gap:10px; transform:rotate(-6deg)">${die(4, 54, C.chalk, C.pine)}<span style="transform:rotate(12deg) translateY(6px)">${die(2, 54, C.chalk, C.pine)}</span></span>
  <span class="d" style="font-size:30px">Roll</span></button>`;

const HOT = TILES.filter((t) => t.n === 8);
const FEED = [['set', 'blue', -38.1, -154], ['set', 'red', -114.32, -110], ['city', 'red', 76.21, 88], ['set', 'orange', 152.42, 44]];
export const lift = `<defs><filter id="lift" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="7" stdDeviation="6" flood-color="#12211f" flood-opacity=".32"/></filter></defs>
  <rect x="-300" y="-300" width="600" height="600" fill="${C.chalk}" opacity=".55"/>
  ${HOT.map((t) => `<g filter="url(#lift)" transform="translate(${t.cx},${t.cy}) scale(1.09) translate(${-t.cx},${-t.cy})"><polygon points="${pts(hex(t.cx, t.cy, 41.5))}" fill="${t.fill}"/>${token(t.cx, t.cy, t.n)}</g>`).join('')}
  ${FEED.map(([k, s, x, y]) => piece(k, s, x, y)).join('')}`;
// Cards in flight, each with two fading copies behind it along its path.
export const fly = (res, [x0, y0], [x1, y1], t) => [0.12, 0.06, 0].map((back, i) => {
  const u = t - back, x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
  return `<span style="position:absolute; left:${x - 15}px; top:${y - 20}px; transform:rotate(${(x1 - x0) / 40}deg); opacity:${[0.18, 0.4, 1][i]}; filter:drop-shadow(0 6px 8px rgba(18,33,31,.3))">${card(res, null, 30, 40)}</span>`;
}).join('');
export const A_ = [bx(-76.21), by(-132)], B_ = [bx(114.32), by(66)], RED = [64, -52], ORANGE = [186, -52], YOU = [32, 440];
export const turn = (ev = true) => {
const before = st({ ev, hand: { wood: 2, brick: 2, sheep: 1, wheat: 3, ore: 2 } });
const p1 = shell(before, { roll: null, zone: rollSlab, buttons: '' });

// The roll: the dice land mid-board, the two 8s rise with the pieces they feed, everything else sinks back.
const flights = fly('wood', A_, RED, 0.62) + fly('wood', B_, RED, 0.5) + fly('wood', B_, ORANGE, 0.55) + fly('wood', A_, YOU, 0.42);
const rolled = st({ ev, hand: { wood: 2, brick: 2, sheep: 1, wheat: 3, ore: 2 } });
rolled.opps[0].gain = 3; rolled.opps[1].gain = 1;
const p2 = shell(rolled, { svg: lift, over: flights, zone: tiles(rolled, { sunk: true }), handOpts: { arrive: { wood: 1 } } });

// A settlement in hand: the spots it can go appear, sized by what they produce; the nearest has caught it.
const SPOTS = [[38.1, 154, 3], [0, 176, 0]];
const spots = SPOTS.map(([x, y, p]) => `<circle cx="${x}" cy="${y}" r="${5 + p * 2.2}" fill="${SEAT.blue}" opacity=".28"/><circle cx="${x}" cy="${y}" r="3" fill="${SEAT.blue}"/>`).join('');
const caught = `<ellipse cx="38.1" cy="160" rx="13" ry="4.5" fill="${C.pine}" opacity=".25"/>` + piece('set', 'blue', 38.1, 140, 1.7);
const finger = `<span style="position:absolute; left:${bx(38.1) + 8 - 24}px; top:${by(154) + 34}px; width:48px; height:48px; border-radius:50%; background:${C.pine}; opacity:.14"></span>`;
const p3 = shell(st({ ev }), { svg: spots + caught, over: finger, zone: tiles(st({ ev }), { held: 'settlement' }), handOpts: { lift: { wood: 1, brick: 1, sheep: 1, wheat: 1 } } });

// Set down: the settlement is on the board, the bars moved, and the move gets its grade where it landed.
const after = st({ ev, hand: { wood: 2, brick: 1, sheep: 0, wheat: 2, ore: 2 }, left: { road: 9, settlement: 1, city: 3, dev: 19 }, you: { vp: 7, win: 35, d: 4 } });
[[36, -2], [17, -1], [12, -1]].forEach(([w, d], i) => Object.assign(after.opps[i], { win: w, d }));
const grade = `<span class="cut5" style="position:absolute; left:${bx(38.1) + 24}px; top:${by(154) + 2}px; height:22px; padding:0 8px; display:inline-flex; align-items:center; gap:5px; background:#2e7d4f; color:#fff; font-size:12px; font-weight:700; box-shadow:0 4px 10px rgba(18,33,31,.2)">Best<span class="num" style="font-weight:600; opacity:.85">+4</span></span>`;
const p4 = shell(after, { svg: piece('set', 'blue', 38.1, 154), over: ev ? grade : '', zone: tiles(after) });
return { p1, p2, p3, p4 };
};

