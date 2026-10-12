// Screen 8: the same turn on small phones, with the compact metrics the layout steps down to.
import { C, M, st, shell, tiles } from './a.mjs';
import { writeSections } from './lib.mjs';

/** A phone frame of any size: status bar `top`, gesture bar `home`. */
const frameAt = (w, h, top, home, r) => (inner) => `<div class="phone" style="width:${w}px; height:${h}px; border-radius:${r}px; background:${C.chalk}">
  <div class="status" style="height:${top}px; padding:0 18px; font-size:13px">${top > 22 ? '<span>9:41</span><span></span><span style="letter-spacing:2px">▮▮▮</span>' : '<span></span><span>9:41</span><span style="letter-spacing:2px">▮▮▮</span>'}</div>
  <div class="ui" style="top:${top}px; bottom:${home}px">${inner}</div>${home ? '<i class="homebar" style="bottom:5px; width:110px; margin-left:-55px; height:4px"></i>' : ''}</div>`;

const DEVICES = [
  { id: 'se', name: '375 × 667', w: 375, h: 667, top: 20, home: 0, r: 8, m: { cw: 44, ch: 60, tileH: 70, btnH: 46, chipPad: 6, bw: 300 } },
  { id: 'android', name: '360 × 780', w: 360, h: 780, top: 24, home: 16, r: 30, m: { cw: 46, ch: 63, tileH: 80, btnH: 48, chipPad: 8, bw: 352 } },
];
const options = [];
for (const d of DEVICES) {
  Object.assign(M, d.m, { frame: frameAt(d.w, d.h, d.top, d.home, d.r) });
  const s = st();
  options.push({ id: d.id + '-turn', name: `${d.name}, your turn`, phone: shell(s, { zone: tiles(s) }), notes: [`Cards ${d.m.cw}×${d.m.ch}, build cards ${d.m.tileH} tall, board ${d.m.bw} wide.`] });
  options.push({ id: d.id + '-held', name: `${d.name}, City in hand`, phone: shell(s, { zone: tiles(s, { pressed: 'city' }), handOpts: { lift: { wheat: 2, ore: 3 }, ghost: { ore: 1 } } }), notes: ['The lane and the yielding You row hold at this size too.'] });
}
Object.assign(M, { cw: 50, ch: 68, tileH: 84, btnH: 50, chipPad: 8, bw: 372, frame: null });

writeSections('small.html', 'Small phones', [
  { title: 'Small phones', sub: 'The board takes whatever height is left; cards, build cards and buttons step down a size below 700 tall or 375 wide.', options },
]);
