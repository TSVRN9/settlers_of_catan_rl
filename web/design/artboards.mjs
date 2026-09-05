// Surface and deep — generates the five new artboards into ./canvas
// Self-contained on purpose: gen.mjs's outputs are frozen as "earlier rounds".
import { writeFileSync } from 'node:fs';
const OUT = new URL('./canvas/', import.meta.url).pathname;

// ---------- palette ----------
const C = { chalk:'#eef0e9', paper:'#f7f8f4', pine:'#12211f', moss:'#4a6659', dust:'#c9d0c2',
  wood:'#5f8a54', brick:'#bc6242', sheep:'#a9c774', wheat:'#e2ae3f', ore:'#8d949c', desert:'#e3dcc4' };
const D = { ground:'#0d1512', panel:'#16211c', panel2:'#1d2b24', hair:'#26382f', text:'#eef0e9',
  muted:'#8fa79a', wire:'#33493d', wire2:'#22332b' };
const SEAT = { red:'#c0392b', blue:'#2f6fd0', orange:'#e07b2a', white:'#f2f2ec' };
const SEAT_HI = { red:'#ce655a', blue:'#5d8fda', orange:'#e79859', white:'#ffffff' };
const SEAT_LO = { red:'#962c22', blue:'#2557a2', orange:'#af6021', white:'#bdbdb8' };
const SEAT_NAME = { blue:'You', red:'Red', orange:'Orange', white:'White' };
const RES = [C.wood,C.brick,C.sheep,C.wheat,C.ore];

// ---------- lattice ----------
// verified: every tile centre is x = col*38.105, y = row*66, with col+row even
const CX = 38.105, CY = 66, R = 44, W = 76.21;
const TILES = [[0,0,'brick',11],[76.21,0,'sheep',10],[38.1,66,'wheat',3],[-38.1,66,'sheep',6],[-76.21,0,'wood',5],
  [-38.1,-66,'ore',4],[38.1,-66,'brick',9],[152.42,0,'wheat',5],[114.32,66,'wood',8],[76.21,132,'wheat',4],
  [0,132,'desert',0],[-76.21,132,'ore',11],[-114.32,66,'wood',12],[-152.42,0,'sheep',9],[-114.32,-66,'wheat',10],
  [-76.21,-132,'wood',8],[0,-132,'ore',3],[76.21,-132,'brick',6],[114.32,-66,'sheep',2]]
  .map(([cx,cy,res,n])=>({cx,cy,res,n,fill:C[res]}));
const hex = (cx,cy,r=R) => [[0,-r],[W/2*r/R,-r/2],[W/2*r/R,r/2],[0,r],[-W/2*r/R,r/2],[-W/2*r/R,-r/2]].map(([x,y])=>[cx+x,cy+y]);
const pts = p => p.map(([x,y])=>`${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const pips = n => n ? 6-Math.abs(7-n) : 0;
const key = (x,y) => `${Math.round(x*10)},${Math.round(y*10)}`;
const isTile = new Set(TILES.map(t=>key(t.cx,t.cy)));

// background cells: the same lattice, widened to fill a rect in board coords
function lattice(x0,y0,x1,y1) {
  const out = [];
  for (let r = Math.floor(y0/CY)-1; r <= Math.ceil(y1/CY)+1; r++)
    for (let c = Math.floor(x0/CX)-1; c <= Math.ceil(x1/CX)+1; c++) {
      if (((c+r) % 2 + 2) % 2 !== 0) continue;
      const x = c*CX, y = r*CY;
      if (isTile.has(key(x,y))) continue;
      out.push([x,y]);
    }
  return out;
}

// ---------- the position: turn 31, you are Blue ----------
const PIECES = {
  red:    { city:[[76.21,88]], set:[[0,-88],[-114.32,-110]],
            roads:[[76.21,88,38.1,110],[38.1,110,0,88],[0,88,-38.1,110],[-114.32,-110,-152.42,-88]] },
  blue:   { city:[[38.1,22]],  set:[[114.32,154],[-38.1,-154]],
            roads:[[38.1,22,76.21,44],[114.32,154,76.21,176],[76.21,176,38.1,154],[38.1,154,0,176],
                   [-76.21,-176,-38.1,-154],[-38.1,-154,0,-176]] },
  orange: { city:[[190.52,22]],set:[[-152.42,44],[-190.52,-22]],
            roads:[[190.52,22,152.42,44],[152.42,44,152.42,88],[-152.42,-44,-190.52,-22]] },
  white:  { city:[[76.21,-176]],set:[[152.42,-44]],
            roads:[[76.21,-176,114.32,-154],[152.42,-44,152.42,-88]] },
};
const ROBBER = [-76.21,132];
const ROLLED = [-76.21,-132];           // the wood 8 you just rolled

// ---------- the raise rule ----------
// A tile's six vertices carry its settlements and cities; its six edges carry its roads.
// A road that merely touches a risen settlement does not rise unless it is an edge of that tile.
const vertsOf = t => hex(t.cx,t.cy);
const vertKeys = t => new Set(vertsOf(t).map(([x,y])=>key(x,y)));
const edgeKeys = t => { const v = vertsOf(t), s = new Set();
  for (let i=0;i<6;i++){ const a=v[i], b=v[(i+1)%6]; s.add([key(...a),key(...b)].sort().join('|')); } return s; };
function riseIndex(raised) {              // raised: [[cx,cy,height], ...]
  const nodeZ = new Map(), edgeZ = new Map();
  for (const [cx,cy,z] of raised) {
    const t = { cx, cy };
    for (const k of vertKeys(t)) nodeZ.set(k, Math.max(nodeZ.get(k) ?? 0, z));
    for (const k of edgeKeys(t)) edgeZ.set(k, Math.max(edgeZ.get(k) ?? 0, z));
  }
  return {
    node: (x,y) => nodeZ.get(key(x,y)) ?? 0,
    edge: (x1,y1,x2,y2) => edgeZ.get([key(x1,y1),key(x2,y2)].sort().join('|')) ?? 0,
    tile: (cx,cy) => (raised.find(([a,b])=>key(a,b)===key(cx,cy))?.[2]) ?? 0,
  };
}

// ---------- piece shapes ----------
const SET = [[-7.48,8.8],[-7.48,0],[-9.24,0],[0,-8.8],[9.24,0],[7.48,0],[7.48,8.8]];
const SET_ROOF = [[-9.24,0],[0,-8.8],[9.24,0]];
const cO = [55.65,112.5];
const CITY = [[43,123.04],[43,108.52],[46.96,108.52],[46.96,111.6],[48.72,111.6],[48.72,108.52],[52.68,108.52],
  [52.68,111.6],[54.44,111.6],[54.44,108.52],[58.4,108.52],[58.4,101.92],[62.36,101.92],[62.36,104.21],
  [64.34,104.21],[64.34,101.92],[68.3,101.92],[68.3,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);
const CITY_TOWER = [[58.4,101.92],[68.3,101.92],[68.3,123.04],[58.4,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);
const CITY_DOOR = [[49.38,123.04],[49.38,117.32],[52.68,117.32],[52.68,123.04]].map(([x,y])=>[x-cO[0],y-cO[1]]);

// ---------- projection ----------
const K = 0.72;          // y compression
const Z = 0.62;          // one unit of height, in screen pixels
const py = (y,z=0) => y*K - z*Z;

// ---------- renderers ----------
// The plinth is the only shadow: the tile darkens where the piece stands. No strokes, ever.
function piece(kind, seat, x, y, sc=1, cls='', style='') {
  const body = kind==='city' ? CITY : SET;
  const base = kind==='city' ? 10.5 : 8.8, halfW = kind==='city' ? 13 : 9.5;
  const plinth = hex(0, base+0.5, halfW+4).map(([px,pz])=>[px,(pz-(base+0.5))*0.42+base+0.5]);
  const inner = kind==='city'
    ? `<polygon points="${pts(CITY_TOWER)}" fill="${SEAT_HI[seat]}"/><polygon points="${pts(CITY_DOOR)}" fill="${SEAT_LO[seat]}"/>`
    : `<polygon points="${pts(SET_ROOF)}" fill="${SEAT_HI[seat]}"/>`;
  return `<g class="${cls}" transform="translate(${x.toFixed(2)},${(y-(kind==='city'?3:1)).toFixed(2)}) scale(${sc})"${style}>`
    + `<polygon points="${pts(plinth)}" fill="${C.pine}" opacity="0.22"/>`
    + `<polygon points="${pts(body)}" fill="${SEAT[seat]}"/>${inner}</g>`;
}
// Roads run the whole edge with round caps, so a chain fuses into one continuous line.
function road(seat, x1,y1,x2,y2, cls='') {
  return `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"`
    + ` stroke="${SEAT[seat]}" stroke-width="5.4" stroke-linecap="round"/>`;
}
function token(cx,cy,n,z=0,cls='',extra='') {
  if(!n) return '';
  const hot = n===6||n===8, ink = hot ? C.wheat : C.chalk;
  const h = hex(0,0,13.2).map(([x,y])=>[x,y*K]);
  const dots = Array.from({length:pips(n)},(_,i)=>`<circle cx="${((i-(pips(n)-1)/2)*3.08).toFixed(2)}" cy="6.3" r="1.06" fill="${ink}"/>`).join('');
  return `<g class="${cls}" transform="translate(${cx.toFixed(2)},${py(cy,z).toFixed(2)})"${extra}>`
    + `<polygon points="${pts(h)}" fill="${C.pine}"/>`
    + `<text y="3.2" text-anchor="middle" font-size="13.2" font-weight="700" fill="${ink}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${n}</text>${dots}</g>`;
}
const robberMark = (x,y,z=0) => `<g transform="translate(${x.toFixed(2)},${(py(y,z)-15).toFixed(2)})">`
  + `<path d="M-6 0 L-6 -4 Q-6 -10 0 -10 Q6 -10 6 -4 L6 0 Z" fill="${C.pine}"/>`
  + `<circle cx="0" cy="-13" r="4.4" fill="${C.pine}"/><rect x="-8" y="0" width="16" height="3" fill="${C.pine}"/></g>`;

// ---------- the columns board ----------
// Columns run from their top face to BOT and past it: the island is a landscape, not an object.
function columns({ raised=[], BOT=430, view=[-360,-215,720,600], colCls=null, hideRobber=false, dim=null } = {}) {
  const ix = riseIndex(raised);
  const [vx,vy,vw,vh] = view;
  let s = '';
  // the abstract grid: the same lattice, continued outward as empty cells
  for (const [x,y] of lattice(vx-60, (vy)/K, vx+vw+60, (vy+vh)/K))
    s += `<polygon points="${pts(hex(x,y,R-2.5).map(([a,b])=>[a,py(b)]))}" fill="none" stroke="#dde2d6" stroke-width="1.2"/>`;
  const order = [...TILES].sort((a,b)=>a.cy-b.cy);
  for (const t of order) {
    const z = ix.tile(t.cx,t.cy), top = hex(t.cx,t.cy,R-2.5).map(([x,y])=>[x,py(y,z)]);
    const cls = colCls ? colCls(t) : '';
    const sil = [top[2],top[3],top[4],[top[4][0],BOT],[top[2][0],BOT]];
    const o = dim?.(t) ? ' opacity="0.3"' : '';
    s += `<g class="${cls}"${o}>`
      + `<polygon points="${pts(sil)}" fill="${t.fill}"/>`
      + `<polygon points="${pts([top[3],top[4],[top[4][0],BOT],[top[3][0],BOT]])}" fill="${C.pine}" opacity="0.44"/>`
      + `<polygon points="${pts([top[2],top[3],[top[3][0],BOT],[top[2][0],BOT]])}" fill="${C.pine}" opacity="0.62"/>`
      + `<polygon points="${pts(top)}" fill="${t.fill}"/>`
      + `<polygon points="${pts(top)}" fill="#ffffff" opacity="0.07"/>`
      + token(t.cx,t.cy,t.n,z) + `</g>`;
  }
  // roads first, then buildings, each at the height of the tile it belongs to
  for (const seat of Object.keys(PIECES)) for (const [x1,y1,x2,y2] of PIECES[seat].roads) {
    const z = ix.edge(x1,y1,x2,y2);
    s += road(seat, x1, py(y1,z), x2, py(y2,z));
  }
  for (const seat of Object.keys(PIECES)) {
    for (const [x,y] of PIECES[seat].set)  s += piece('set', seat, x, py(y, ix.node(x,y)));
    for (const [x,y] of PIECES[seat].city) s += piece('city', seat, x, py(y, ix.node(x,y)));
  }
  if (!hideRobber) s += robberMark(ROBBER[0], ROBBER[1], ix.tile(...ROBBER));
  return { inner: s, view: `${vx} ${vy} ${vw} ${vh}` };
}

// ---------- the wireframe board (flat, dark) ----------
function wireframe({ flick=false, scale=1 } = {}) {
  let s = '';
  let i = 0;
  const d = () => flick ? ` style="animation-delay:${(0.05 + (i++ % 19) * 0.035 + ((i*7)%5)*0.03).toFixed(3)}s"` : '';
  for (const [x,y] of lattice(-330,-300,330,300))
    s += `<polygon points="${pts(hex(x,y,R-2.5))}" fill="none" stroke="${D.wire2}" stroke-width="1"/>`;
  for (const t of TILES) {
    s += `<polygon class="${flick?'fk':''}" points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="none" stroke="${D.wire}" stroke-width="1.4"${d()}/>`;
    if (t.n) {
      const hot = t.n===6||t.n===8;
      s += `<text class="${flick?'fk':''}" x="${t.cx}" y="${t.cy+4.6}" text-anchor="middle" font-size="13" font-weight="${hot?700:400}"`
        + ` fill="${hot?C.wheat:D.muted}" font-family="Chivo,Helvetica Neue,Arial,sans-serif"${d()}>${t.n}</text>`;
    }
  }
  for (const seat of Object.keys(PIECES)) for (const [x1,y1,x2,y2] of PIECES[seat].roads)
    s += `<line class="${flick?'fk':''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${SEAT[seat]}" stroke-width="3.4" stroke-linecap="round" opacity="0.95"${d()}/>`;
  for (const seat of Object.keys(PIECES)) {
    for (const [x,y] of PIECES[seat].set)
      s += `<polygon class="${flick?'fk':''}" points="${pts(SET.map(([a,b])=>[a*0.92+x,b*0.92+y]))}" fill="none" stroke="${SEAT[seat]}" stroke-width="2"${d()}/>`;
    for (const [x,y] of PIECES[seat].city)
      s += `<polygon class="${flick?'fk':''}" points="${pts(CITY.map(([a,b])=>[a*0.92+x,b*0.92+y]))}" fill="none" stroke="${SEAT[seat]}" stroke-width="2"${d()}/>`;
  }
  s += `<circle class="${flick?'fk':''}" cx="${ROBBER[0]}" cy="${ROBBER[1]}" r="9" fill="none" stroke="${D.muted}" stroke-width="1.6"${d()}/>`;
  return `<svg viewBox="-236 -236 472 472" width="${(472*scale).toFixed(0)}" height="${(472*scale).toFixed(0)}" style="display:block; overflow:clip" role="img" aria-label="The board as a wireframe">${s}</svg>`;
}

// ---------- decode text ----------
// The real characters are in the DOM. The scramble is an ::after overlay that paints over
// them and then gets out of the way, so with animation off you simply read the text.
const GLYPHS = ['▓','7','▒','≡','4','▀','9','▌','2','░','■','5'];
function decode(text, { start=0.05, step=0.028, bg='var(--dec-bg)' } = {}) {
  let i = 0;
  const chars = [...text].map(ch => {
    if (ch === ' ') return ' ';
    const d = (start + (i++) * step + ((i*13)%7) * 0.045).toFixed(3);
    const g = GLYPHS[(i*5) % GLYPHS.length];
    return `<i style="--d:${d}s; --g:'${g}'; --bg:${bg}">${ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch}</i>`;
  }).join('');
  return `<span class="dec">${chars}</span>`;
}
const DECODE_CSS = `
    .L .dec i, .N .dec i { font-style: normal; position: relative; display: inline-block; }
    .L .dec i::after, .N .dec i::after {
      content: ""; position: absolute; inset: -0.06em -0.02em; background: transparent;
      animation: decode .58s steps(1, end) var(--d) both; }
    @keyframes decode {
      0%   { content: var(--g); background: var(--bg); }
      22%  { content: "\\2592"; background: var(--bg); }
      44%  { content: "\\258c"; background: var(--bg); }
      66%  { content: var(--g); background: var(--bg); }
      86%  { content: "\\2591"; background: var(--bg); }
      100% { content: ""; background: transparent; } }`;

// ---------- page frames ----------
const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Chivo:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap">`;
const BASE = `
    body { margin: 0; }
    .L { --chalk:#eef0e9; --paper:#f7f8f4; --pine:#12211f; --moss:#4a6659; --dust:#c9d0c2; --dec-bg:#eef0e9;
         --ui:"Chivo","Helvetica Neue",Arial,sans-serif; --dis:"Syne","Trebuchet MS",sans-serif; }
    .N { --ground:#0d1512; --panel:#16211c; --panel2:#1d2b24; --hair:#26382f; --text:#eef0e9; --muted:#8fa79a;
         --wheat:#e2ae3f; --dec-bg:#0d1512;
         --ui:"Chivo","Helvetica Neue",Arial,sans-serif; --dis:"Syne","Trebuchet MS",sans-serif; }
    .L, .N, .L *, .N * { box-sizing: border-box; }
    .L a { color:#2f6a57; } .L a:hover { color:#12211f; }
    .N a { color:var(--wheat); } .N a:hover { color:#fff; }
    .L .num, .N .num { font-variant-numeric: tabular-nums; }
    .L .d, .N .d { font-family: var(--dis); font-weight: 700; letter-spacing: -.02em; }
    .L .row, .N .row { display:flex; align-items:center; gap:9px; }
    .L .cap { font-size:13px; color:var(--moss); line-height:1.5; }
    .N .cap { font-size:13px; color:var(--muted); line-height:1.5; }
    .L .act { display:inline-flex; align-items:center; justify-content:center; gap:8px; height:38px; padding:0 13px;
              background:var(--paper); color:var(--pine); font:600 13.5px var(--ui); white-space:nowrap; }
    .L .act.go { background:var(--pine); color:var(--chalk); }
    .N .act { display:inline-flex; align-items:center; justify-content:center; gap:8px; height:36px; padding:0 12px;
              background:var(--panel2); color:var(--text); font:600 13px var(--ui); white-space:nowrap; }
    .N .act.go { background:var(--wheat); color:#12211f; }
    .L .key { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 6px;
              background:var(--paper); color:var(--pine); font:600 12px var(--ui); box-shadow: inset 0 -2px 0 var(--dust); }
    .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path: inset(50%); white-space:nowrap; }`;

const nav = (dark=false) => `<nav style="width:76px; flex:0 0 76px; background:${dark?'#0a110f':'#12211f'}; color:#eef0e9;
       display:flex; flex-direction:column; align-items:center; padding:16px 0 18px;">
    <span style="margin-bottom:22px;"><svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" style="display:block"><polygon points="15,0 27.99,7.5 27.99,22.5 15,30 2.01,22.5 2.01,7.5" fill="#e2ae3f"/></svg></span>
    <span style="display:flex; flex-direction:column; align-items:center; gap:16px;">
      <span style="position:relative; display:flex; align-items:center; justify-content:center; width:46px; height:46px;">
        <span style="position:absolute; inset:0;"><svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true" style="display:block"><polygon points="23,0 42.92,11.5 42.92,34.5 23,46 3.08,34.5 3.08,11.5" fill="#e2ae3f"/></svg></span>
        <span style="position:relative; font:700 13px var(--ui); color:#12211f;">Play</span></span>
      <span style="font:400 13px var(--ui); color:#7d9186;">Watch</span>
      <span style="font:400 13px var(--ui); color:#7d9186;">Results</span>
      <span style="font:400 13px var(--ui); color:#7d9186;">About</span>
    </span>
    <span style="margin-top:auto; writing-mode:vertical-rl; transform:rotate(180deg); font:800 19px var(--dis); letter-spacing:.06em; color:#3f5b50;">SETTLERS</span>
  </nav>`;

const doc = (css, body) => `<!doctype html>
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
      .L .dec i::after, .N .dec i::after { animation: none; }
      .fk, .col, .par, .fade { animation: none !important; }
    }
  </style>
</helmet>
${body}
</x-dc>
</body>
</html>
`;
const write = (name, html) => { writeFileSync(OUT+name, html); console.log('wrote', name, html.length); };

// ================================================================= SURFACE
// The race rail answers "who is ahead" in points and needs. Probability lives below.
const RACE = [
  { seat:'red',    vp:6, need:'A second city, and it has the ore for it.',      turns:'2 turns' },
  { seat:'blue',   vp:4, need:'Ore. The city on the wood 8 takes you to five.', turns:'3 turns' },
  { seat:'orange', vp:4, need:'Two more roads, for the longest road.',          turns:'4 turns' },
  { seat:'white',  vp:3, need:'Anything. The robber has sat on its ore since turn 24.', turns:'7 turns' },
];
// The white seat needs a darker fill here than it gets on the board: a rail is a
// data display on chalk, where #f2f2ec would read as an empty slot.
const PIP = { red:SEAT.red, blue:SEAT.blue, orange:SEAT.orange, white:'#a9afa5' };
const raceRail = () => `<div style="display:flex; flex-direction:column; gap:15px;">
      ${RACE.map(r => `<div style="display:flex; flex-direction:column; gap:5px;">
        <div style="display:flex; align-items:baseline; gap:9px;">
          <span style="width:11px; height:11px; background:${SEAT[r.seat]};${r.seat==='white'?' box-shadow: inset 0 0 0 1px #b6bdb2;':''}"></span>
          <span style="font:600 14px var(--ui); ${r.seat==='blue'?'':'color:var(--moss);'}">${SEAT_NAME[r.seat]}</span>
          <span class="num d" style="margin-left:auto; font-size:17px;">${r.vp}<span style="color:var(--moss); font-size:12.5px; font-weight:400;"> of 10</span></span>
        </div>
        <div style="display:flex; gap:3px;">${Array.from({length:10},(_,i)=>
          `<i style="flex:1; height:6px; background:${i<r.vp?PIP[r.seat]:'#dde2d6'};"></i>`).join('')}</div>
        <div style="display:flex; gap:10px; align-items:baseline;">
          <span class="cap" style="font-size:12.5px; flex:1;">${r.need}</span>
          <span class="num" style="font-size:12.5px; white-space:nowrap;">${r.turns}</span>
        </div>
      </div>`).join('')}
    </div>`;

const MOVES = [
  ['Build the city on the wood 8', 'It doubles the number you just rolled and the ore beside it.', '+2.7'],
  ['Buy a development card',       'Two cards from a knight would take the largest army off Red.',  '+0.9'],
  ['Offer two sheep for one ore',  'Orange has three ore and wants sheep. It has said yes twice.',  '+0.4'],
];
const moveList = () => MOVES.map(([t,w,v],i)=>`<div style="display:flex; gap:12px; padding:11px 12px; background:${i===0?'var(--paper)':'transparent'};">
        <span class="num d" style="font-size:15px; width:38px; flex:0 0 38px; ${i===0?'':'color:var(--moss);'}">${v}</span>
        <div><div style="font:600 13.5px var(--ui);">${t}</div><div class="cap" style="font-size:12.5px; margin-top:2px;">${w}</div></div>
      </div>`).join('');

function surfaceBody({ decoded=false } = {}) {
  const b = columns({ raised: [[...ROLLED, 26]], BOT: 470, view: [-360,-232,720,600] });
  const H = decoded ? decode('Turn 31 — your move') : 'Turn 31 — your move';
  return `
    <div class="par" style="position:absolute; left:0; right:0; top:96px; height:804px;">
      <svg viewBox="${b.view}" width="1440" height="1200" preserveAspectRatio="xMidYMin slice" style="display:block; overflow:clip" role="img" aria-label="The island as a grid of hexagonal columns">${b.inner}</svg>
    </div>
    <div class="fade" style="position:absolute; left:34px; top:30px; width:330px;">
      <div class="d" style="font-size:30px; line-height:1.1;">${H}</div>
      <div class="cap" style="margin-top:8px; font-size:14.5px;">You rolled an 8. The wood rose and paid you once and Red twice. Your road to the ore stayed on the ground, because it is not an edge of that tile.</div>
    </div>
    <div class="fade" style="position:absolute; left:34px; top:172px; width:272px;">
      <div style="font:600 12.5px var(--ui); margin-bottom:12px;">The race to ten</div>
      ${raceRail()}
    </div>
    <div class="fade" style="position:absolute; right:30px; top:30px; width:330px;">
      <div style="padding:13px 14px; background:var(--pine); color:var(--chalk);">
        <div style="font:600 12.5px var(--ui); opacity:.7;">The net says</div>
        <div style="margin-top:5px; font:400 14px var(--ui); line-height:1.5;">Take the city. Nothing else you can do this turn moves you as far, and the ore stops being a problem.</div>
        <div class="row" style="margin-top:11px; gap:8px;">
          <span class="act" style="height:32px; font-size:12.5px;">Do it</span>
          <span class="act" style="height:32px; font-size:12.5px; background:#1d322c; color:var(--chalk);">Why</span>
        </div>
      </div>
      <div style="margin-top:10px;">${moveList()}</div>
    </div>
    <div class="fade" style="position:absolute; left:34px; bottom:28px; display:flex; gap:10px;">
      <span class="act go">Build a city</span><span class="act">Buy a card</span><span class="act">Offer a trade</span><span class="act">End turn</span>
    </div>
    <div style="position:absolute; right:30px; bottom:28px; display:flex; align-items:center; gap:10px;
         font:600 12.5px var(--ui); color:var(--chalk); background:rgba(18,33,31,.72); padding:9px 13px;">
      <span>Scroll for the analysis</span>
      <svg width="13" height="15" viewBox="0 0 13 15" aria-hidden="true"><path d="M6.5 0 L6.5 12 M1.5 7.5 L6.5 13 L11.5 7.5" fill="none" stroke="#eef0e9" stroke-width="1.6"/></svg>
    </div>`;
}

write('Main.dc.html', doc(`
    .L .dec i::after { --bg: var(--chalk); }`,
`<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine); font:400 14px var(--ui); position:relative; overflow:clip;">
${surfaceBody()}
</div>`));

// ================================================================= DEEP
// Four arcs, never one divided ring: each seat's win estimate is from its own
// perspective (frames[i].evals[seat].win) and the four do not sum to 100.
const PROB = [['red',41,'+3'],['blue',33,'-2'],['orange',27,'+1'],['white',14,'-2']];
const arc = (seat, v, delay) => { const r=30, c=2*Math.PI*r;
  return `<div style="display:flex; flex-direction:column; align-items:center; gap:7px;">
    <svg width="76" height="76" viewBox="0 0 76 76" style="display:block" role="img" aria-label="${SEAT_NAME[seat]} ${v} percent">
      <circle cx="38" cy="38" r="${r}" fill="none" stroke="${D.hair}" stroke-width="6"/>
      <circle class="arc" cx="38" cy="38" r="${r}" fill="none" stroke="${SEAT[seat]}" stroke-width="6" stroke-linecap="butt"
        transform="rotate(-90 38 38)" stroke-dasharray="${(c*v/100).toFixed(1)} ${(c*(1-v/100)).toFixed(1)}"
        style="--c:${c.toFixed(1)}; animation-delay:${delay}s"/>
      <text x="38" y="43" text-anchor="middle" font-size="17" font-weight="700" fill="${D.text}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${v}</text>
    </svg>
    <div style="font:600 12.5px var(--ui); color:var(--muted);">${SEAT_NAME[seat]}</div></div>`; };

const curve = (w=320,h=92) => { const N=380;
  const paths = [['red',1.0,0.42],['blue',2.3,0.35],['orange',0.4,0.28],['white',3.1,0.16]].map(([s,ph,amp])=>{
    let d=''; for(let i=0;i<=N;i+=4){ const t=i/N;
      const y = amp + Math.sin(t*7+ph)*0.07 + Math.sin(t*17+ph)*0.03 + (s==='red'?t*0.06:0) - (s==='white'?t*0.05:0);
      d += `${i?'L':'M'}${(t*w).toFixed(1)},${(h - Math.max(0.04,Math.min(0.7,y))*h*1.35).toFixed(1)} `; }
    return `<path d="${d}" fill="none" stroke="${SEAT[s]}" stroke-width="${s==='blue'?1.9:1.2}" opacity="${s==='blue'?1:.62}"/>`; }).join('');
  const x=214/N*w;
  return `<svg viewBox="0 0 ${w} ${h+16}" width="${w}" height="${h+16}" style="display:block" role="img" aria-label="Win probability across the game">
    <rect x="0" y="0" width="${w}" height="${h}" fill="${D.panel}"/>${paths}
    <line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="${D.text}" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="0" y="${h+13}" font-size="10.5" fill="${D.muted}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">0</text>
    <text x="${x.toFixed(1)}" y="${h+13}" font-size="10.5" fill="${D.text}" text-anchor="middle" font-family="Chivo,Helvetica Neue,Arial,sans-serif">214</text>
    <text x="${w}" y="${h+13}" font-size="10.5" fill="${D.muted}" text-anchor="end" font-family="Chivo,Helvetica Neue,Arial,sans-serif">380</text></svg>`; };

const LADDER = [
  ['City on the wood 8',        62, '+2.7', true,  false],
  ['Development card',          41, '+0.9', false, true ],
  ['Two sheep for one ore',     33, '+0.4', false, false],
  ['Road toward the ore 3',     28, '+0.1', false, false],
  ['Settlement on the coast',   19, '-0.3', false, false],
  ['End turn',                  11, '-0.9', false, false],
];
const ladder = () => LADDER.map(([t,w,v,best,alt])=>`<div style="display:flex; align-items:center; gap:10px; padding:5px 0;${alt?' background:linear-gradient(90deg, rgba(226,174,63,.10), transparent);':''}">
      <span style="width:150px; flex:0 0 150px; font:${best?600:400} 12.5px var(--ui); color:${best?D.text:D.muted};">${t}</span>
      <span style="flex:1; height:7px; background:${D.panel2};"><i style="display:block; height:100%; width:${w}%; background:${best?C.wheat:D.hair};"></i></span>
      <span class="num" style="width:34px; text-align:right; font-size:12px; color:${best?D.text:D.muted};">${v}</span>
    </div>`).join('');

const ATTR = [['The city on the 11, 10 and 3', 38],['Nine cards in hand', 26],['Red’s largest army', -21],['The robber on the ore 11', -14],['Your road toward the ore', 9]];
const attribution = () => ATTR.map(([t,v])=>`<div style="display:flex; align-items:center; gap:10px; padding:4px 0;">
      <span style="width:172px; flex:0 0 172px; font:400 12px var(--ui); color:${D.muted};">${t}</span>
      <span style="flex:1; height:6px; background:${D.panel2}; position:relative;">
        <i style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:${D.hair};"></i>
        <i style="position:absolute; ${v>0?'left:50%':`right:50%`}; top:0; height:100%; width:${Math.abs(v)*0.9}%; background:${v>0?'#7fb069':'#d4735a'};"></i>
      </span>
      <span class="num" style="width:30px; text-align:right; font-size:11.5px; color:${D.muted};">${v>0?'+':''}${(v/10).toFixed(1)}</span>
    </div>`).join('');

const futureCard = (label, v, i) => `<div style="display:flex; flex-direction:column; gap:4px;">
    <svg viewBox="-215 -215 430 430" width="84" height="84" style="display:block" aria-hidden="true">
      ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="none" stroke="${i===0?D.wire:D.wire2}" stroke-width="3"/>`).join('')}
      ${Object.keys(PIECES).map(s=>PIECES[s].roads.map(([a,b,c,d2])=>`<line x1="${a}" y1="${b}" x2="${c}" y2="${d2}" stroke="${SEAT[s]}" stroke-width="7" stroke-linecap="round" opacity="${i===0?.95:.5}"/>`).join('')).join('')}
      ${i===0?`<circle cx="-38.1" cy="-154" r="30" fill="none" stroke="${C.wheat}" stroke-width="5"/>`:''}
    </svg>
    <div style="font:${i===0?600:400} 11.5px var(--ui); color:${i===0?D.text:D.muted};">${label}</div>
    <div class="num" style="font-size:11.5px; color:${i===0?C.wheat:D.muted};">${v}</div></div>`;

const DICE = [[2,1,-3.1],[3,2,-1.8],[4,3,-0.9],[5,4,0.4],[6,5,1.9],[7,6,-4.2],[8,5,5.6],[9,4,1.1],[10,3,2.8],[11,2,0.2],[12,1,-0.6]];
const diceStrip = () => DICE.map(([n,p,v])=>`<div style="display:flex; flex-direction:column; align-items:center; gap:4px; width:34px;">
      <span class="num" style="font-size:11px; color:${v>0?'#7fb069':'#d4735a'};">${v>0?'+':''}${v.toFixed(1)}</span>
      <span style="width:16px; height:${(8+Math.abs(v)*6).toFixed(0)}px; background:${v>0?'#7fb069':'#d4735a'}; opacity:${0.35+p*0.11};"></span>
      <span class="num d" style="font-size:13px; color:${n===8?C.wheat:D.muted};">${n}</span>
      <span class="num" style="font-size:10px; color:${D.muted};">${p}/36</span></div>`).join('');

function deepBody({ decoded=false } = {}) {
  const H = decoded ? decode('What the net is looking at') : 'What the net is looking at';
  return `
    <div style="position:absolute; left:0; right:0; top:0; height:6px; display:flex;">
      ${PROB.map(([s,v])=>`<i style="width:${v/1.15}%; background:${SEAT[s]};"></i>`).join('')}
    </div>
    <div style="position:absolute; left:30px; top:26px; width:340px;">
      <div class="d" style="font-size:22px; line-height:1.15; color:${D.text};">${H}</div>
      <div class="cap" style="margin-top:7px;">Step 214 of 380. Each seat's chance is that seat's own estimate, so the four do not add to a hundred. That is the model talking, not a scoreboard.</div>
    </div>
    <div style="position:absolute; left:30px; top:150px; width:340px; display:flex; justify-content:space-between;">
      ${PROB.map(([s,v],i)=>arc(s,v,(0.15+i*0.13).toFixed(2))).join('')}
    </div>
    <div style="position:absolute; left:30px; top:290px; width:340px;">
      <div style="font:600 12px var(--ui); color:${D.text}; margin-bottom:9px;">Every step, every seat</div>
      ${curve(340,100)}
      <div class="cap" style="margin-top:9px;">Red took the lead at step 148 with the largest army and has not given it back. Your dip at 214 is the seven that cost you four cards.</div>
    </div>
    <div style="position:absolute; left:30px; bottom:26px; width:340px;">
      <div style="font:600 12px var(--ui); color:${D.text}; margin-bottom:7px;">What is holding the number up, and down</div>
      ${attribution()}
    </div>
    <div style="position:absolute; left:400px; top:70px;">${wireframe({ flick:true, scale:1.24 })}</div>
    <div class="cap" style="position:absolute; left:400px; top:660px; width:584px;">
      The same board, drawn flat. Every tile the search touched at depth two is outlined; the seat colours are the only
      thing at full strength, so the white seat stays the brightest object on the board.
    </div>
    <div style="position:absolute; right:30px; top:70px; width:392px;">
      <div style="font:600 12px var(--ui); color:${D.text}; margin-bottom:9px;">Both evaluators, one position</div>
      ${ladder()}
      <div class="cap" style="margin-top:10px; padding-left:9px; border-left:2px solid ${C.wheat};">
        The wheat band is where they disagree. The hand heuristic ranks the development card first; the value net puts it second
        and takes the city. A forced move shows this list empty, because the search never ran.
      </div>
    </div>
    <div style="position:absolute; right:30px; top:420px; width:392px;">
      <div style="font:600 12px var(--ui); color:${D.text}; margin-bottom:10px;">Six futures the search weighed</div>
      <div style="display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:15px 12px;">
        ${['City on the 8','Development card','Sheep for ore','Road to the ore','Coast settlement','End turn'].map((l,i)=>futureCard(l,['36.1','34.3','33.8','33.5','33.1','32.5'][i]+'%',i)).join('')}
      </div>
    </div>
    <div style="position:absolute; right:30px; bottom:26px; width:392px;">
      <div style="font:600 12px var(--ui); color:${D.text}; margin-bottom:8px;">and the eleven rolls that average to it</div>
      <div style="display:flex; justify-content:space-between; align-items:flex-end;">${diceStrip()}</div>
    </div>`;
}

write('Deep.dc.html', doc(`
    .N .arc { animation: draw 1.05s cubic-bezier(.3,0,.2,1) both; }
    @keyframes draw { from { stroke-dashoffset: var(--c); } to { stroke-dashoffset: 0; } }
    .N .fk { animation: flick .5s steps(1,end) both; }
    @keyframes flick { 0%{opacity:0} 18%{opacity:1} 30%{opacity:0} 44%{opacity:1} 58%{opacity:.25} 74%{opacity:1} 88%{opacity:.5} 100%{opacity:1} }
    .N .dec i::after { --bg: var(--ground); }`,
`<div class="N" style="width:1440px; height:900px; background:var(--ground); color:var(--text); font:400 14px var(--ui); position:relative; overflow:clip;">
${deepBody()}
</div>`));

// ================================================================= DESCENT
// One scroller, two snapped sections. The light falls off through a gradient that is
// simply there — no scroll listener. Parallax and fade sit behind @supports, so with
// no scroll timeline the page still reads as two correct screens.
write('Descent.dc.html', doc(`
    .scr { height:900px; overflow-y:scroll; overflow-x:hidden; scroll-snap-type: y mandatory;
           overscroll-behavior: contain; scrollbar-width: none; scroll-timeline-name: --page; scroll-timeline-axis: block; }
    .scr::-webkit-scrollbar { display: none; }
    .wrap { position:relative; height:1800px; }
    .light { position:absolute; inset:0; z-index:0;
             background: linear-gradient(180deg, #eef0e9 0%, #eef0e9 34%, #b9c2b6 43%, #4a5c52 48%,
                         #1b2a23 53%, #0d1512 58%, #0d1512 100%); }
    .sec { position:relative; z-index:1; height:900px; scroll-snap-align:start; scroll-snap-stop:always; overflow:clip; }
    .N .arc { animation: draw 1.05s cubic-bezier(.3,0,.2,1) both; }
    @keyframes draw { from { stroke-dashoffset: var(--c); } to { stroke-dashoffset: 0; } }
    .fk { animation: flick .5s steps(1,end) both; }
    @keyframes flick { 0%{opacity:0} 18%{opacity:1} 30%{opacity:0} 44%{opacity:1} 58%{opacity:.25} 74%{opacity:1} 88%{opacity:.5} 100%{opacity:1} }
    .L .dec i::after { --bg: var(--chalk); } .N .dec i::after { --bg: var(--ground); }
    /* Enhancement only. Without a scroll timeline none of this runs and both screens sit correct.
       Longhands, not the shorthand: the animation shorthand resets duration to 0s, and a
       scroll-driven animation needs duration auto to span its range. Every range ends at 100%, the
       snap position, so nothing is left frozen half-played once the deep screen has arrived. */
    @supports (animation-timeline: scroll()) {
      .par, .fade, .fk, .N .arc {
        animation-duration: auto; animation-fill-mode: both;
        animation-timeline: --page; animation-iteration-count: 1; }
      .par  { animation-name: rise;  animation-timing-function: linear;        animation-range: 0% 100%; }
      .fade { animation-name: away;  animation-timing-function: linear;        animation-range: 0% 46%; }
      .fk   { animation-name: flick; animation-timing-function: steps(1, end); animation-range: 58% 100%; }
      .N .arc { animation-name: draw; animation-timing-function: cubic-bezier(.3,0,.2,1); animation-range: 66% 100%; }
      @keyframes rise { to { transform: translateY(-190px); } }
      @keyframes away { to { opacity: 0; transform: translateY(-26px); } }
    }
    @media (prefers-reduced-motion: reduce) {
      .par { animation: none !important; }
      .fade { animation: none !important; opacity: 1 !important; transform: none !important; }
    }`,
`<div style="width:1440px; height:900px; overflow:hidden; font:400 14px 'Chivo',Helvetica Neue,Arial,sans-serif;">
  <div class="scr" tabindex="0" style="width:1440px;">
    <div class="wrap">
      <div class="light"></div>
      <section class="sec L" style="color:var(--pine);" aria-label="Playing">
${surfaceBody()}
      </section>
      <section class="sec N" style="color:var(--text);" aria-label="The analysis">
${deepBody()}
      </section>
    </div>
  </div>
</div>`));

// ================================================================= REVEAL
// The reveal is the loading state. Columns hunt for their heights and their colours
// churn until the worker's run resolves; the headline decodes on the same beat.
{
  const b = columns({ BOT: 470, view: [-360,-232,720,600], hideRobber: true,
    colCls: t => 'col', });
  // per-column delay and damping, seeded off the tile so it is uneven but stable
  let i = 0;
  const styled = b.inner.replace(/<g class="col"/g, () => {
    const d = (0.06 + (i*0.07) % 0.9).toFixed(3), dur = (1.5 + ((i*13)%7)*0.13).toFixed(2);
    const hue = 40 + ((i*67) % 280); i++;
    return `<g class="col" style="--d:${d}s; --dur:${dur}s; --h:${hue}deg"`;
  });
  write('Reveal.dc.html', doc(`
    .L .col { animation: hunt var(--dur) cubic-bezier(.22,1.2,.36,1) var(--d) both,
                         churn 1.05s steps(1,end) var(--d) both; transform-box: fill-box; }
    @keyframes hunt {
      0%   { transform: translateY(-64px); }
      26%  { transform: translateY(22px); }
      48%  { transform: translateY(-31px); }
      68%  { transform: translateY(11px); }
      84%  { transform: translateY(-4px); }
      100% { transform: translateY(0); } }
    @keyframes churn {
      0%   { filter: hue-rotate(var(--h)) saturate(2.1); }
      20%  { filter: hue-rotate(calc(var(--h) * -1)) saturate(.4); }
      40%  { filter: hue-rotate(calc(var(--h) + 120deg)) saturate(1.7); }
      60%  { filter: hue-rotate(calc(var(--h) - 80deg)) saturate(2.4); }
      80%  { filter: hue-rotate(40deg) saturate(1.2); }
      100% { filter: none; } }
    .L .bar-i { animation: load 2.35s cubic-bezier(.4,0,.2,1) both; }
    @keyframes load { from { width: 4%; } to { width: 100%; } }
    .L .late { animation: appear .01s linear 2.5s both; }
    @keyframes appear { from { opacity: 0; } to { opacity: 1; } }
    .L .dec i::after { --bg: var(--chalk); }
    @media (prefers-reduced-motion: reduce) {
      .L .col { animation: none; } .L .bar-i { animation: none; width: 100%; } .L .late { animation: none; opacity: 1; } }`,
`<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine); font:400 14px var(--ui); position:relative; overflow:clip;">
    <div style="position:absolute; left:0; right:0; top:96px; height:804px;">
      <svg viewBox="${b.view}" width="1440" height="1200" preserveAspectRatio="xMidYMin slice" style="display:block; overflow:clip" role="img" aria-label="A new island being dealt">${styled}</svg>
    </div>
    <div style="position:absolute; left:34px; top:30px; width:420px;">
      <div class="d" style="font-size:30px; line-height:1.1;">${decode('Seed 4127')}</div>
      <div class="cap" style="margin-top:8px; font-size:14.5px;">${decode('Three bots are seated. You are Blue, and you place first.', {start:0.5, step:0.012})}</div>
      <div style="margin-top:20px; width:330px;">
        <div style="height:5px; background:var(--dust);"><i class="bar-i" style="display:block; height:100%; width:100%; background:var(--pine);"></i></div>
        <div class="cap" style="margin-top:7px; font-size:12.5px;">
          <span class="late">380 steps ready</span>
        </div>
      </div>
    </div>
    <div style="position:absolute; right:30px; top:30px; width:300px;">
      <div class="d" style="font-size:16px;">The loading is the reveal</div>
      <div class="cap" style="margin-top:6px;">Columns hunt for their heights and their colours churn while the worker runs. The engine streams frames back in batches of eight, so the bar is real progress, not a guess; the board only settles when the run resolves.</div>
      <div class="d" style="font-size:16px; margin-top:18px;">Why it decodes</div>
      <div class="cap" style="margin-top:6px;">A typewriter says a person is writing to you. A decode says a number arrived and is being read. The seed is a number, so it decodes. Every character is real text underneath, covered by the scramble, so it is legible to a screen reader and to anyone with motion turned off.</div>
      <div class="d" style="font-size:16px; margin-top:18px;">When it is seen</div>
      <div class="cap" style="margin-top:6px;">Once when a new game's seed arrives, on Reseed, and when a recorded game is opened for review. Never mid-game.</div>
    </div>
    <div style="position:absolute; left:34px; bottom:28px; display:flex; gap:10px;">
      <span class="act go late">Place your first settlement</span><span class="act">Reseed</span><span class="act">Change seats</span>
    </div>
</div>`));
}

// ================================================================= RAISE RULE
{
  const V = [-260,-150,520,360];
  const small = (raised, mark) => {
    const b = columns({ raised, BOT: 210, view: V, hideRobber: true });
    return `<svg viewBox="${b.view}" width="520" height="360" style="display:block; overflow:clip" aria-hidden="true">${b.inner}${mark??''}</svg>`;
  };
  const ring = (x,y,r,col) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${col}" stroke-width="2.4" stroke-dasharray="5 4"/>`;
  const up = [[...ROLLED, 30]];
  const markA = ring(-38.1, py(-154,30), 20, C.pine) + ring(-57, py(-165,30), 26, C.pine);
  const markB = ring(-19, py(-165,0), 22, C.brick);
  const seats = Object.keys(SEAT);
  const chip = (bg,label) => `<div style="display:flex; flex-direction:column; gap:7px; align-items:center;">
      <svg viewBox="-30 -22 60 44" width="96" height="70" style="display:block" aria-hidden="true">
        <rect x="-30" y="-22" width="60" height="44" fill="${bg}"/>
        ${piece('set','white',-11,4,1.05)}${piece('city','white',12,6,1.05)}</svg>
      <span class="cap" style="font-size:11.5px;">${label}</span></div>`;
  write('RaiseRule.dc.html', doc('',
`<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine); font:400 14px var(--ui); position:relative; overflow:clip; padding:26px 34px;">
  <div>
    <div style="display:flex; gap:40px; align-items:flex-start;">
      <div class="d" style="font-size:29px; line-height:1.1; width:300px; flex:0 0 300px;">What rides a raised tile</div>
      <div class="cap" style="font-size:14.5px; flex:1; min-width:0; column-count:2; column-gap:40px;">
        A tile rises when it pays. What comes up with it is decided by the tile, not by what the pieces are attached to.
        Buildings on its six corners rise. Roads along its six edges rise, and because both ends of such a road are corners
        of that tile, it travels straight up and never tilts. A road that merely touches a risen building stays on the
        ground and pulls away from it. That looks like a bug and is not: the road is lying between two other tiles, and
        neither of them moved.
      </div>
    </div>
    <div style="display:flex; gap:26px; margin-top:22px;">
      <div>
        <div style="font:600 13px var(--ui);">At rest</div>
        <div style="margin-top:8px;">${small([])}</div>
      </div>
      <div>
        <div style="font:600 13px var(--ui);">The wood 8 pays</div>
        <div style="margin-top:8px;">${small(up, markA+markB)}</div>
      </div>
      <div style="flex:1; min-width:0; padding-top:4px;">
        <div style="display:flex; flex-direction:column; gap:14px;">
          <div style="display:flex; gap:11px;"><span style="width:11px; height:11px; margin-top:3px; background:var(--pine); flex:0 0 11px;"></span>
            <div><div style="font:600 13px var(--ui);">Up with the tile</div>
            <div class="cap" style="font-size:12.5px;">Your settlement on the corner where the wood 8 meets the ore 3, and your road along the tile's north-west edge. Both are on the tile.</div></div></div>
          <div style="display:flex; gap:11px;"><span style="width:11px; height:11px; margin-top:3px; background:${C.brick}; flex:0 0 11px;"></span>
            <div><div style="font:600 13px var(--ui);">Left on the ground</div>
            <div class="cap" style="font-size:12.5px;">Your road running east toward the ore 3. It touches the settlement that just went up, but it is an edge of the ore 3 and the sea, not of the wood 8, so it stays.</div></div></div>
          <div style="display:flex; gap:11px;"><span style="width:11px; height:11px; margin-top:3px; background:var(--dust); flex:0 0 11px;"></span>
            <div><div style="font:600 13px var(--ui);">Two tiles at once</div>
            <div class="cap" style="font-size:12.5px;">A corner shared by two paying tiles takes the greater of the two heights, so a double payout never splits a building between levels.</div></div></div>
        </div>
      </div>
    </div>
    <div style="display:flex; gap:40px; margin-top:24px; align-items:flex-start;">
      <div style="flex:0 0 520px;">
        <div style="font:600 13px var(--ui);">Roads are continuous, with rounded ends</div>
        <svg viewBox="0 0 520 96" width="520" height="96" style="display:block; margin-top:8px" aria-hidden="true">
          <rect x="0" y="0" width="520" height="96" fill="${C.wood}"/>
          <line x1="30" y1="30" x2="130" y2="30" stroke="${SEAT.blue}" stroke-width="5.4" stroke-linecap="round"/>
          <line x1="130" y1="30" x2="180" y2="66" stroke="${SEAT.blue}" stroke-width="5.4" stroke-linecap="round"/>
          <line x1="180" y1="66" x2="280" y2="66" stroke="${SEAT.blue}" stroke-width="5.4" stroke-linecap="round"/>
          ${piece('set','blue',130,30,1)}
          <line x1="330" y1="30" x2="430" y2="30" stroke="${SEAT.red}" stroke-width="5.4" stroke-linecap="round"/>
          <line x1="430" y1="30" x2="480" y2="66" stroke="${SEAT.white}" stroke-width="5.4" stroke-linecap="round"/>
          ${piece('city','red',430,32,1)}
        </svg>
        <div class="cap" style="margin-top:8px;">Drawn end to end so a chain reads as one line. This reverses last round's shortened ends, which were there to keep a junction clear; the building's plinth covers the junction instead.</div>
      </div>
      <div>
        <div style="font:600 13px var(--ui);">The white seat, both screens</div>
        <div style="display:flex; gap:14px; margin-top:8px;">
          ${chip(C.sheep,'on sheep')}${chip(C.desert,'on desert')}${chip(C.wheat,'on wheat')}
          <div style="display:flex; flex-direction:column; gap:7px; align-items:center;">
            <svg viewBox="-30 -22 60 44" width="96" height="70" style="display:block" aria-hidden="true">
              <rect x="-30" y="-22" width="60" height="44" fill="${D.ground}"/>
              <polygon points="${pts(SET.map(([a,b])=>[a*0.95-11,b*0.95+4]))}" fill="none" stroke="${SEAT.white}" stroke-width="2"/>
              <polygon points="${pts(CITY.map(([a,b])=>[a*0.95+12,b*0.95+6]))}" fill="none" stroke="${SEAT.white}" stroke-width="2"/>
            </svg>
            <span class="cap" style="font-size:11.5px;">in the dark</span></div>
        </div>
        <div class="cap" style="margin-top:8px; max-width:430px;">On the lit board the plinth is what gives white an edge, since it darkens the tile beneath the piece rather than drawing round it. In the dark the white seat is simply the brightest line on the board.</div>
      </div>
    </div>
  </div>
</div>`));
}
console.log('done');
