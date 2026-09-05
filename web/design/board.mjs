// Shared board core for the design artboards.
import { GLYPHS } from './glyphs.mjs';
// Fixes live here so every screen inherits them:
//   1. no outline around the island — the gaps and the lattice already say where it stops
//   2. number tokens large enough for their digits and pips (see TOKEN below)
//   3. the fourth seat is a warm grey, not white, on every surface
export const C = {
  chalk:'#eef0e9', paper:'#f7f8f4', pine:'#12211f', moss:'#4a6659', dust:'#c9d0c2',
  wood:'#5f8a54', brick:'#bc6242', sheep:'#a9c774', wheat:'#e2ae3f', ore:'#8d949c', desert:'#e3dcc4',
  grid:'#dde2d6',
};
export const D = { ground:'#0d1512', panel:'#16211c', panel2:'#1d2b24', hair:'#26382f',
  text:'#eef0e9', muted:'#8fa79a', wire:'#33493d', wire2:'#22332b' };

// seat 4 was #f2f2ec, which vanished on chalk, sheep and desert. One grey, everywhere.
export const SEAT    = { red:'#c0392b', blue:'#2f6fd0', orange:'#e07b2a', grey:'#b9bfb2' };
export const SEAT_HI = { red:'#ce655a', blue:'#5d8fda', orange:'#e79859', grey:'#d4d9cd' };
export const SEAT_LO = { red:'#962c22', blue:'#2557a2', orange:'#af6021', grey:'#8d9387' };
export const SEATS = ['red','blue','orange','grey'];
export const SEAT_NAME = { red:'Red', blue:'Blue', orange:'Orange', grey:'White' };

// ---------- lattice ----------
// every tile centre is x = col*38.105, y = row*66 with col+row even (verified)
export const CX = 38.105, CY = 66, R = 44, W = 76.21;
export const TILES = [[0,0,'brick',11],[76.21,0,'sheep',10],[38.1,66,'wheat',3],[-38.1,66,'sheep',6],
  [-76.21,0,'wood',5],[-38.1,-66,'ore',4],[38.1,-66,'brick',9],[152.42,0,'wheat',5],[114.32,66,'wood',8],
  [76.21,132,'wheat',4],[0,132,'desert',0],[-76.21,132,'ore',11],[-114.32,66,'wood',12],[-152.42,0,'sheep',9],
  [-114.32,-66,'wheat',10],[-76.21,-132,'wood',8],[0,-132,'ore',3],[76.21,-132,'brick',6],[114.32,-66,'sheep',2]]
  .map(([cx,cy,res,n])=>({cx,cy,res,n,fill:C[res]}));

export const hex = (cx,cy,r=R) =>
  [[0,-r],[W/2*r/R,-r/2],[W/2*r/R,r/2],[0,r],[-W/2*r/R,r/2],[-W/2*r/R,-r/2]].map(([x,y])=>[cx+x,cy+y]);
export const pts = p => p.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
export const pips = n => n ? 6-Math.abs(7-n) : 0;
const key = (x,y) => `${Math.round(x*10)},${Math.round(y*10)}`;
const isTile = new Set(TILES.map(t=>key(t.cx,t.cy)));

// Cells carry a taper: full strength close to the island, gone by TAPER_OUT, so the
// board sits on a surface that runs out rather than inside a rectangle.
export const TAPER_IN = 210, TAPER_OUT = 430;
export function lattice(x0,y0,x1,y1) {
  const out = [];
  for (let r = Math.floor(y0/CY)-1; r <= Math.ceil(y1/CY)+1; r++)
    for (let c = Math.floor(x0/CX)-1; c <= Math.ceil(x1/CX)+1; c++) {
      if (((c+r)%2+2)%2 !== 0) continue;
      const x = c*CX, y = r*CY;
      if (isTile.has(key(x,y))) continue;
      const d = Math.hypot(x, y);
      const o = d <= TAPER_IN ? 1 : Math.max(0, 1 - (d-TAPER_IN)/(TAPER_OUT-TAPER_IN));
      if (o > 0.02) out.push([x, y, +(o*o).toFixed(3)]);   // squared, so it thins away faster than it starts
    }
  return out;
}

// ---------- the position: turn 31 ----------
export const PIECES = {
  red:    { city:[[76.21,88]], set:[[0,-88],[-114.32,-110]],
            roads:[[76.21,88,38.1,110],[38.1,110,0,88],[0,88,-38.1,110],[-114.32,-110,-152.42,-88]] },
  blue:   { city:[[38.1,22]],  set:[[114.32,154],[-38.1,-154]],
            roads:[[38.1,22,76.21,44],[114.32,154,76.21,176],[76.21,176,38.1,154],[38.1,154,0,176],
                   [-76.21,-176,-38.1,-154],[-38.1,-154,0,-176]] },
  orange: { city:[[190.52,22]],set:[[-152.42,44],[-190.52,-22]],
            roads:[[190.52,22,152.42,44],[152.42,44,152.42,88],[-152.42,-44,-190.52,-22]] },
  grey:   { city:[[76.21,-176]],set:[[152.42,-44]],
            roads:[[76.21,-176,114.32,-154],[152.42,-44,152.42,-88]] },
};
export const ROBBER = [-76.21,132];

// ---------- piece shapes ----------
export const SET = [[-7.48,8.8],[-7.48,0],[-9.24,0],[0,-8.8],[9.24,0],[7.48,0],[7.48,8.8]];
const SET_ROOF = [[-9.24,0],[0,-8.8],[9.24,0]];
const cO = [55.65,112.5];
export const CITY = [[43,123.04],[43,108.52],[46.96,108.52],[46.96,111.6],[48.72,111.6],[48.72,108.52],
  [52.68,108.52],[52.68,111.6],[54.44,111.6],[54.44,108.52],[58.4,108.52],[58.4,101.92],[62.36,101.92],
  [62.36,104.21],[64.34,104.21],[64.34,101.92],[68.3,101.92],[68.3,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);
const CITY_TOWER = [[58.4,101.92],[68.3,101.92],[68.3,123.04],[58.4,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);
const CITY_DOOR = [[49.38,123.04],[49.38,117.32],[52.68,117.32],[52.68,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);

// The plinth is the only shadow: the tile darkens where the piece stands. No strokes, ever.
export function piece(kind, seat, x, y, sc=1, cls='') {
  const body = kind==='city' ? CITY : SET;
  const base = kind==='city' ? 10.5 : 8.8, halfW = kind==='city' ? 13 : 9.5;
  const plinth = hex(0, base+0.5, halfW+4).map(([px,pz])=>[px,(pz-(base+0.5))*0.42+base+0.5]);
  const inner = kind==='city'
    ? `<polygon points="${pts(CITY_TOWER)}" fill="${SEAT_HI[seat]}"/><polygon points="${pts(CITY_DOOR)}" fill="${SEAT_LO[seat]}"/>`
    : `<polygon points="${pts(SET_ROOF)}" fill="${SEAT_HI[seat]}"/>`;
  return `<g${cls?` class="${cls}"`:''} transform="translate(${x.toFixed(2)},${(y-(kind==='city'?3:1)).toFixed(2)}) scale(${sc})">`
    + `<polygon points="${pts(plinth)}" fill="${C.pine}" opacity="0.22"/>`
    + `<polygon points="${pts(body)}" fill="${SEAT[seat]}"/>${inner}</g>`;
}
// Roads run the whole edge with round caps, so a chain fuses into one continuous line.
export const road = (seat,x1,y1,x2,y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${SEAT[seat]}" stroke-width="5.4" stroke-linecap="round"/>`;

// ---------- the number token ----------
// Was r 13.2 / 13.2px / pips at 8.36, which left the five-pip row 1.16 units of
// clearance to the sloping edge. These values take that to 3.36.
export const TOKEN = { r:16.5, font:14, base:4.2, pipCy:10.2, pipR:1.15, pipGap:3.2 };
// The token must pop about ITS OWN tile, not the board's origin. The group already
// carries transform="translate(cx,cy)", so animate the `scale` individual property:
// individual transform properties apply BEFORE the transform attribute, which means
// the scale happens in the token's local space, whose origin is the tile centre.
export function token(cx,cy,n,cls='',i=0) {
  if (!n) return '';
  const hot = n===6||n===8, ink = hot ? C.wheat : C.chalk, T = TOKEN;
  const dots = Array.from({length:pips(n)},(_,k)=>
    `<circle cx="${((k-(pips(n)-1)/2)*T.pipGap).toFixed(2)}" cy="${T.pipCy}" r="${T.pipR}" fill="${ink}"/>`).join('');
  return `<g${cls?` class="${cls}"`:''} style="--i:${i}" transform="translate(${cx.toFixed(2)},${cy.toFixed(2)})">`
    + `<polygon points="${pts(hex(0,0,T.r))}" fill="${C.pine}"/>`
    + `<text y="${T.base}" text-anchor="middle" font-size="${T.font}" font-weight="700" fill="${ink}"`
    + ` font-family="Chivo,Helvetica Neue,Arial,sans-serif">${n}</text>${dots}</g>`;
}

// ---------- resource watermarks ----------
// Lifted verbatim from the earlier rounds and placed by translation, so the shapes are
// exactly the ones that were signed off rather than a redrawing of them.
export const glyph = (res, cx, cy) => {
  const g = GLYPHS[res];
  if (!g) return '';                                   // desert carries none
  return `<g class="gl" opacity="0.13" transform="translate(${(cx-g.origin[0]).toFixed(2)},${(cy-g.origin[1]).toFixed(2)})">${g.markup}</g>`;
};

// ---------- ports ----------
// Centres are topology.json's, in unit hex radii, times S=44 — the same space the tiles
// already use. The two dock corners are derived: for every port the two nearest island
// vertices are exactly 44 away and exactly 44 apart, i.e. one coastal hex edge.
export const PORT_CENTRES = [[5.1962,0],[3.4641,3],[0.866,4.5],[-2.5981,4.5],[-4.3301,1.5],
                             [-4.3301,-1.5],[-2.5981,-4.5],[0.866,-4.5],[3.4641,-3]].map(([x,y])=>[x*44,y*44]);
// resource: -1 generic 3:1, else index into RES_ORDER. Shuffled per seed by mapgen.rs;
// this is one plausible permutation, held constant across every artboard.
export const RES_ORDER = ['wood','brick','sheep','wheat','ore'];
// the topology's own template order, which is also what the earlier rounds drew
export const PORT_RES = [0, 1, 2, 3, 4, -1, -1, -1, -1];
const ALL_VERTS = (() => {
  const m = new Map();
  for (const t of TILES) for (const [x,y] of hex(t.cx,t.cy)) m.set(key(x,y), [x,y]);
  return [...m.values()];
})();
export const portDock = (px,py) => ALL_VERTS
  .map(v => [Math.hypot(v[0]-px, v[1]-py), v]).sort((a,b)=>a[0]-b[0]).slice(0,2).map(d=>d[1]);

// ---------- the mini glyph ----------
// A watermark is a flat list of primitives and already repeats one motif: two trees, two
// crystals, two sheep, three wheat stalks, nine bricks. The port takes the first motif —
// one wheat stalk where the tile draws three — moved off the tile centre it was authored
// against and fitted to a box. Bounds are computed from the markup rather than measured,
// which for a quadratic is the control hull and so never under-covers.
const MINI_PICK = { wood:[0,1], brick:[0,1,3], sheep:[0,1,2,3], wheat:[0,1,2,3,4,5,6], ore:[0,1] };
const els = markup => markup.match(/<[^>]+\/>/g) || [];
function bbox(list) {
  let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  for (const e of list) {
    const num = a => { const m = e.match(new RegExp(`${a}="(-?[\\d.]+)"`)); return m ? +m[1] : 0; };
    const h = num('stroke-width') / 2;
    const put = (x,y) => { x0=Math.min(x0,x-h); y0=Math.min(y0,y-h); x1=Math.max(x1,x+h); y1=Math.max(y1,y+h); };
    if (e.startsWith('<rect')) { put(num('x'), num('y')); put(num('x')+num('width'), num('y')+num('height')); }
    else if (e.startsWith('<circle')) { put(num('cx')-num('r'), num('cy')-num('r')); put(num('cx')+num('r'), num('cy')+num('r')); }
    else if (e.startsWith('<ellipse')) { put(num('cx')-num('rx'), num('cy')-num('ry')); put(num('cx')+num('rx'), num('cy')+num('ry')); }
    else if (e.startsWith('<line')) { put(num('x1'), num('y1')); put(num('x2'), num('y2')); }
    else {
      const src = (e.match(/(?:points|d)="([^"]+)"/) || [])[1] || '';
      const ns = src.match(/-?\d*\.?\d+/g) || [];
      for (let i = 0; i + 1 < ns.length; i += 2) put(+ns[i], +ns[i+1]);
    }
  }
  return [x0, y0, x1, y1];
}
export function glyphMini(res, cx, cy, bw, bh, opacity = 0.55) {
  const pick = MINI_PICK[res]; if (!pick) return '';
  const list = pick.map(i => els(GLYPHS[res].markup)[i]).filter(Boolean);
  const [x0,y0,x1,y1] = bbox(list);
  const k = Math.min(bw / (x1-x0), bh / (y1-y0));
  const mx = (x0+x1)/2, my = (y0+y1)/2;
  return `<g opacity="${opacity}" transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) scale(${k.toFixed(4)})`
       + ` translate(${(-mx).toFixed(2)},${(-my).toFixed(2)})">${list.join('')}</g>`;
}

// ---------- the port badge ----------
// It was an outlined chalk disc with a colour swatch tucked inside it, and the swatch
// cleared the inner edge of that stroke by 0.26 units — sub-pixel at every size the board
// is drawn, so the stroke ate the colour. The badge is now filled like a tile instead:
// no stroke anywhere, the resource carried by the whole shape plus one motif of its glyph,
// and 3:1 in the board's own neutral because a generic port has no resource to show.
// The fill is the tile colour lightened 20% toward chalk, which is what takes pine ink
// past 4.5:1 on wood (4.16 -> 5.53) and brick (3.93 -> 5.20); the rest were already clear.
export const PORT_R = 16;
const mix = (a, b, t) => '#' + [0,2,4].map(i =>
  Math.round(parseInt(a.slice(i+1,i+3),16)*(1-t) + parseInt(b.slice(i+1,i+3),16)*t)
    .toString(16).padStart(2,'0')).join('');
export const portFill = res => res < 0 ? C.dust : mix(C[RES_ORDER[res]], C.chalk, 0.2);

export function ports() {
  return PORT_CENTRES.map(([px,py],i) => {
    const res = PORT_RES[i], generic = res < 0;
    const [a,b] = portDock(px,py);                 // badge sits on the topology centre, unmoved
    const docks = [a,b].map(([vx,vy]) =>
      `<line x1="${px.toFixed(2)}" y1="${py.toFixed(2)}" x2="${vx.toFixed(2)}" y2="${vy.toFixed(2)}"`
      + ` stroke="${C.pine}" stroke-width="2" stroke-linecap="round" opacity="0.35"/>`).join('');
    const badge = `<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${PORT_R}" fill="${portFill(res)}"/>`
      + (generic ? '' : glyphMini(RES_ORDER[res], px, py - 5, 18, 14))
      + `<text x="${px.toFixed(2)}" y="${(py+11).toFixed(2)}" text-anchor="middle" font-size="9" font-weight="700"`
      + ` fill="${C.pine}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${generic?'3:1':'2:1'}</text>`;
    return `<g class="pt">${docks}${badge}</g>`;
  }).join('');
}
export const robberMark = (x,y) => `<g transform="translate(${x.toFixed(2)},${(y-17).toFixed(2)})">`
  + `<path d="M-6 0 L-6 -4 Q-6 -10 0 -10 Q6 -10 6 -4 L6 0 Z" fill="${C.pine}"/>`
  + `<circle cx="0" cy="-13" r="4.4" fill="${C.pine}"/><rect x="-8" y="0" width="16" height="3" fill="${C.pine}"/></g>`;

// ---------- the flat board ----------
// No island outline. Layers are separate <g>s so a screen can hide the pieces
// (the deal withholds them until the game resolves) without re-rendering the board.
export function board({ w=560, view=[-268,-268,536,536], grid=true, seats=SEATS, glyphs=true, showPorts=true,
                        pieceCls='pc', tokenCls='tk', tileCls='tl', hideRobber=false } = {}) {
  const [vx,vy,vw,vh] = view;
  let g = '';
  if (grid) g += `<g class="grid">` + lattice(vx-40,vy-40,vx+vw+40,vy+vh+40)
    .map(([x,y,o])=>`<polygon points="${pts(hex(x,y,R-2.5))}" fill="none" stroke="${C.grid}" stroke-width="1.2" opacity="${o}"/>`).join('') + `</g>`;
  if (showPorts) g += `<g class="ports">${ports()}</g>`;
  g += `<g class="tiles">` + TILES.map((t,i)=>
    `<polygon class="${tileCls}" style="--i:${i}" points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('') + `</g>`;
  if (glyphs) g += `<g class="glyphs">` + TILES.map(t=>glyph(t.res,t.cx,t.cy)).join('') + `</g>`;
  g += `<g class="tokens">` + TILES.map((t,i)=>token(t.cx,t.cy,t.n,tokenCls,i)).join('') + `</g>`;
  let p = '';
  for (const s of seats) for (const [x1,y1,x2,y2] of PIECES[s].roads) p += road(s,x1,y1,x2,y2);
  for (const s of seats) {
    for (const [x,y] of PIECES[s].set)  p += piece('set',  s, x, y);
    for (const [x,y] of PIECES[s].city) p += piece('city', s, x, y);
  }
  if (!hideRobber) p += robberMark(...ROBBER);
  g += `<g class="${pieceCls}">${p}</g>`;
  const h = Math.round(w*vh/vw);
  return `<svg viewBox="${vx} ${vy} ${vw} ${vh}" width="${w}" height="${h}" style="display:block; overflow:visible" role="img" aria-label="The board">${g}</svg>`;
}

// four separate arcs — each seat's own estimate, so they do not sum to 100
export function ring(vals, r=250, sw=16) {
  const c = 2*Math.PI*r;
  return vals.map(([s,v],i)=>{
    const len = c*v/100, off = -c*(i*0.25) ;
    return `<circle cx="0" cy="0" r="${r}" fill="none" stroke="${SEAT[s]}" stroke-width="${sw}"`
      + ` stroke-dasharray="${len.toFixed(1)} ${(c-len).toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"`
      + ` transform="rotate(-90)" opacity="0.95"/>`;
  }).join('');
}

// ---------- page frame ----------
export const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Chivo:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap">`;
export const BASE = `
    body { margin: 0; }
    .L { --chalk:#eef0e9; --paper:#f7f8f4; --pine:#12211f; --moss:#4a6659; --dust:#c9d0c2;
         --ui:"Chivo","Helvetica Neue",Arial,sans-serif; --dis:"Syne","Trebuchet MS",sans-serif;
         --ease: cubic-bezier(.2,.8,.2,1); --t-feel:120ms; --t-panel:260ms; --t-board:420ms; }
    .L, .L * { box-sizing: border-box; }
    .L a { color:#2f6a57; } .L a:hover { color:#12211f; }
    .L .num { font-variant-numeric: tabular-nums; }
    .L .d { font-family: var(--dis); font-weight: 700; letter-spacing: -.02em; }
    .L .row { display:flex; align-items:center; gap:9px; }
    .L .cap { font-size:13px; color:var(--moss); line-height:1.5; }
    /* The corner cut is the board's signature. Every panel and every control carries it. */
    .L .cut  { clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px); }
    .L .cut8 { clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px); }
    .L .bar { height:10px; background:var(--dust); }
    .L .bar > i { display:block; height:100%; }
    .L .pill { display:inline-flex; align-items:center; gap:7px; height:26px; padding:0 10px;
               background:var(--pine); color:var(--chalk); font:700 12.5px var(--ui);
               clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px); }
    .L .act { display:inline-flex; align-items:center; justify-content:center; gap:8px; height:38px; padding:0 14px;
              background:var(--paper); color:var(--pine); font:600 13.5px var(--ui); white-space:nowrap;
              border:0; cursor:pointer; transition: background var(--t-feel) var(--ease);
              clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px); }
    .L .act:hover { background:#e6e9df; }
    .L .act.go { background:var(--pine); color:var(--chalk); }
    .L .act.go:hover { background:#1d322c; }
    .L .key { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 6px;
              background:var(--paper); color:var(--pine); font:600 12px var(--ui); box-shadow: inset 0 -2px 0 var(--dust); }
    .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path: inset(50%); white-space:nowrap; }`;

// ── the spine ────────────────────────────────────────────────────────────────────────
// One line, and the only chrome that survives from screen to screen. The path on the left
// says where you are and every crumb before the last is the way back to it. The right half
// says what is waiting for you, which is what makes it safe to be four views deep in
// analysis while a game is running: the game can still reach you there.
export const SEAT_DOT = { blue:'#2f6fd0', red:'#c0392b', orange:'#e07b2a', grey:'#b9bfb2' };

export const SPINE_CSS = `
    .L .spine { flex:0 0 28px; display:flex; align-items:center; gap:0; padding:0 26px;
                background:var(--chalk); border-bottom:1px solid var(--dust);
                font:500 12.5px var(--ui); }
    .L .spine .crumb { color:var(--moss); cursor:pointer; }
    .L .spine .crumb:hover { color:var(--pine); }
    .L .spine .crumb.now { color:var(--pine); font-weight:600; cursor:default; }
    .L .spine .sep { color:var(--dust); padding:0 9px; }
    .L .spine .step { margin-left:20px; padding-left:20px; border-left:1px solid var(--dust);
                      color:var(--moss); cursor:pointer; }
    .L .spine .step:hover { color:var(--pine); }
    .L .spine .warn { margin-left:auto; display:inline-flex; align-items:center; gap:7px;
                      color:var(--pine); }
    .L .spine .warn > i { width:7px; height:7px; border-radius:50%; }
    .L .spine .warn.loud { background:var(--pine); color:var(--chalk); height:20px;
                           padding:0 9px; cursor:pointer;
                           clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px); }`;

export function spine(path, warn, seat = 'blue', loud = false, step = '') {
  const crumbs = path.map((label, i) => {
    const last = i === path.length - 1;
    return (i ? '<span class="sep">\u203a</span>' : '')
         + `<span class="crumb${last ? ' now' : ''}">${label}</span>`;
  }).join('');
  // the step is not a crumb — it is where you are in the game rather than in the app, and
  // it is the door into the whole-game analysis from any play view
  const at = step ? `<span class="step">${step}</span>` : '';
  const right = warn
    ? `<span class="warn${loud ? ' loud' : ''}"><i style="background:${SEAT_DOT[seat]}"></i>${warn}</span>`
    : '';
  return `<div class="spine">${crumbs}${at}${right}</div>`;
}


// A decode reveal that is honest about accessibility: the real characters are in the
// markup and readable before any JS; the scramble is a sibling span marked aria-hidden
// that wipes away. Base state is CLEARED, so with animation off you simply read the text.
export const DECODE_CSS = `
    .L .dec { position: relative; display: inline-block; }
    .L .dec > .scr { position:absolute; left:0; top:0; right:0; bottom:0; opacity:0; pointer-events:none;
                     overflow:hidden; white-space:nowrap; color:var(--moss); }
    @keyframes wipe { from { opacity:1; clip-path: inset(0 0 0 0); }
                      99%  { opacity:1; clip-path: inset(0 0 0 100%); }
                      to   { opacity:0; clip-path: inset(0 0 0 100%); } }`;
const GLY = '▓▒░▚▞█▌▐▖▗▘▝';
export const decode = (text, cls='') => {
  const scr = [...text].map((ch,i)=> ch===' ' ? ' ' : GLY[(i*5+ch.charCodeAt(0))%GLY.length]).join('');
  return `<span class="dec ${cls}">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}`
       + `<span class="scr" aria-hidden="true">${scr}</span></span>`;
};

export const doc = (css, body, script='') => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  ${FONTS}
  <style>${BASE}${DECODE_CSS}${css}
    @media (prefers-reduced-motion: reduce) {
      .L .scr { animation: none !important; }
      .L .board, .L .panel, .L .curtain, .L .tl, .L .tk, .L .pc { transition: none !important; animation: none !important; }
    }
  </style>
</helmet>
${body}
</x-dc>
${script}
</body>
</html>
`;
