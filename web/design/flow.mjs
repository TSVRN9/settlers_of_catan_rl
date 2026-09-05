// "One table, many views" — the new flow.
// Run: node web/design/flow.mjs
import { writeFileSync } from 'node:fs';
import { C, D, SEAT, SEAT_HI, SEAT_LO, SEATS, SEAT_NAME, TILES, hex, pts, pips, R,
         PIECES, ROBBER, SET, CITY, piece, road, token, TOKEN, board, doc, decode,
         glyph, ports, lattice } from './board.mjs';
const OUT = new URL('./canvas/', import.meta.url).pathname;
const write = (n,h) => { writeFileSync(OUT+n,h); console.log('wrote', n, h.length); };
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

// ── four gauges arranged as a ring. Each seat owns a quadrant and fills its own
//    sector, because each number is that seat's own estimate and they do not sum to 100.
function gaugeRing(vals, r=252, sw=15) {
  const c = 2*Math.PI*r, sector = c*0.25;
  return vals.map(([s,v],i)=>{
    const span = sector*0.90, fill = span*v/100, off = -sector*i - (sector-span)/2;
    return `<circle cx="0" cy="0" r="${r}" fill="none" stroke="${C.dust}" stroke-width="${sw}"`
         + ` stroke-dasharray="${span.toFixed(1)} ${(c-span).toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90)"/>`
         + `<circle class="gz" cx="0" cy="0" r="${r}" fill="none" stroke="${SEAT[s]}" stroke-width="${sw}"`
         + ` stroke-dasharray="${fill.toFixed(1)} ${(c-fill).toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90)"/>`;
  }).join('');
}
const ringLabels = (vals, r=252) => vals.map(([s,v],i)=>{
  const a = (i*90 + 45 - 90) * Math.PI/180, x = Math.cos(a)*(r+34), y = Math.sin(a)*(r+34);
  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">`
    + `<text y="-2" text-anchor="middle" font-size="19" font-weight="700" fill="${C.pine}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${v}%</text>`
    + `<text y="14" text-anchor="middle" font-size="11.5" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${SEAT_NAME[s]}</text></g>`;
}).join('');

const PROB = [['red',41],['blue',33],['orange',27],['grey',14]];

// ── the lineup: 2-4 seats, each a person or a bot. No people = a game to watch.
const BOTS = { vnet:'Value-net search', heur:'Heuristic search', rand:'Random', you:'You', p2:'Player 2' };
const chip = (seat, who, kind, extra='') => `<div class="chip" style="${extra}">
      <span class="sw" style="background:${SEAT[seat]}"></span>
      <span style="font:600 13.5px var(--ui); flex:1;">${who}</span>
      <span class="cap" style="font-size:12px;">${kind}</span>
      <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true"><path d="M0 0 L4.5 5 L9 0" fill="none" stroke="#4a6659" stroke-width="1.4"/></svg>
    </div>`;

const seatChips = () => [
  chip('blue','You','person'),
  chip('red','Value-net search','bot · depth 2'),
  chip('orange','Heuristic search','bot · depth 2'),
].join('');

// ── ranked moves, both evaluators
const LADDER = [
  ['Build the city on the wood 8', 62, '+2.7', 'best', ''],
  ['Buy a development card',       41, '+0.9', '',     'alt'],
  ['Offer two sheep for one ore',  33, '+0.4', '',     ''],
  ['Road toward the ore 3',        28, '+0.1', '',     ''],
  ['End turn',                     11, '-0.9', '',     ''],
];
const ladder = (dark=false) => LADDER.map(([t,w,v,best,alt])=>`<div class="lrow ${alt}">
        <span class="lname" style="${best?'font-weight:600;':`color:${dark?D.muted:C.moss};`}">${t}</span>
        <span class="ltrack"><i style="width:${w}%; background:${best?C.wheat:(dark?D.hair:C.dust)};"></i></span>
        <span class="num lval">${v}</span></div>`).join('');

// ── what is holding the number up and down
const ATTR = [['The city on the 11, 10 and 3',38],['Nine cards in hand',26],["Red's largest army",-21],
              ['The robber on the ore 11',-14],['Your road toward the ore',9]];
const attribution = () => ATTR.map(([t,v])=>`<div class="row" style="gap:10px; padding:3px 0;">
      <span class="cap" style="width:168px; flex:0 0 168px; font-size:12px;">${t}</span>
      <span style="flex:1; height:6px; background:var(--dust); position:relative;">
        <i style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:#b3bbaf;"></i>
        <i style="position:absolute; ${v>0?'left:50%':'right:50%'}; top:0; height:100%; width:${Math.abs(v)*0.9}%; background:${v>0?'#7d9e63':'#c0725a'};"></i>
      </span><span class="num" style="width:30px; text-align:right; font-size:11.5px; color:var(--moss);">${v>0?'+':''}${(v/10).toFixed(1)}</span></div>`).join('');

// ── the win curve
function curve(w=380,h=96,dark=false) {
  const N=380;
  const paths=[['red',1.0,.42],['blue',2.3,.35],['orange',.4,.28],['grey',3.1,.16]].map(([s,ph,amp])=>{
    let d=''; for(let i=0;i<=N;i+=4){ const t=i/N;
      const y=amp+Math.sin(t*7+ph)*.07+Math.sin(t*17+ph)*.03+(s==='red'?t*.06:0)-(s==='grey'?t*.05:0);
      d+=`${i?'L':'M'}${(t*w).toFixed(1)},${(h-Math.max(.04,Math.min(.7,y))*h*1.35).toFixed(1)} `; }
    return `<path d="${d}" fill="none" stroke="${SEAT[s]}" stroke-width="${s==='blue'?1.9:1.2}" opacity="${s==='blue'?1:.6}"/>`;}).join('');
  const x=214/N*w;
  return `<svg viewBox="0 0 ${w} ${h+16}" width="${w}" height="${h+16}" style="display:block" role="img" aria-label="Win chance across the game">
    <rect width="${w}" height="${h}" fill="${dark?D.panel:C.paper}"/>${paths}
    <line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="${dark?D.text:C.pine}" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="0" y="${h+13}" font-size="10.5" fill="${dark?D.muted:C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">0</text>
    <text x="${x.toFixed(1)}" y="${h+13}" font-size="10.5" fill="${dark?D.text:C.pine}" text-anchor="middle" font-family="Chivo,Helvetica Neue,Arial,sans-serif">214</text>
    <text x="${w}" y="${h+13}" font-size="10.5" fill="${dark?D.muted:C.moss}" text-anchor="end" font-family="Chivo,Helvetica Neue,Arial,sans-serif">380</text></svg>`;
}

// ═══════════════════════════════════════════════ shared CSS for board-bearing screens
const STAGE_CSS = `
    .L .stage { position:absolute; inset:0; overflow:clip; }
    .L .boardpos { position:absolute; left:50%; top:calc(50% - 8px); transform:translate(-50%,-50%); }
    .L .board { transition: transform var(--t-board) var(--ease); will-change: transform; }
    .L .pc { transition: opacity var(--t-board) var(--ease); }
    .L .panel { position:absolute; visibility:hidden; opacity:0;
                transition: transform var(--t-panel) var(--ease), opacity var(--t-panel) var(--ease), visibility var(--t-panel); }
    .L .panel.open { visibility:visible; opacity:1; transform:none; }
    .L .pl { left:26px; top:26px; bottom:26px; width:346px; transform:translateX(-26px); }
    .L .pr { right:26px; top:26px; bottom:26px; width:430px; transform:translateX(26px); }
    .L .pt { left:26px; top:26px; width:400px; transform:translateY(-14px); }
    .L .pb { left:26px; right:26px; bottom:76px; transform:translateY(14px); }
    .L .card { background:var(--paper); padding:16px 17px; }
    .L .chip { display:flex; align-items:center; gap:10px; padding:9px 11px; background:var(--paper);
               transition: background var(--t-feel) var(--ease); cursor:pointer; }
    .L .chip:hover { background:#e9ece3; }
    .L .sw { width:12px; height:12px; flex:0 0 12px; }
    .L .lrow { display:flex; align-items:center; gap:10px; padding:5px 0; }
    .L .lrow.alt { background:linear-gradient(90deg, rgba(226,174,63,.13), transparent); }
    .L .lname { width:172px; flex:0 0 172px; font-size:12.5px; }
    .L .ltrack { flex:1; height:7px; background:var(--dust); }
    .L .ltrack > i { display:block; height:100%; }
    .L .lval { width:34px; text-align:right; font-size:12px; }`;

// ═══════════════════════════════════════════════ 1. the walkthrough (interactive)
{
  const STEPS = [
    ['arrive',  'Arrive',   'translate(0,10px) scale(.88)'],
    ['lineup',  'Lineup',   'translate(236px,10px) scale(.72)'],
    ['dealing', 'Deal',     'translate(0,10px) scale(.92)'],
    ['playing', 'Play',     'translate(0,4px) scale(.99)'],
    ['analysis','Analysis', 'translate(-262px,6px) scale(.77)'],
    ['seven',   'A seven',  'translate(0,-24px) scale(.88)'],
    ['ending',  'Ending',   'translate(-276px,10px) scale(.60)'],
  ];
  const OPEN = { arrive:['a-arrive'], lineup:['a-lineup'], dealing:['a-deal'],
                 playing:['a-coach','a-act','a-rail'], analysis:['a-anal'],
                 seven:['a-seven'], ending:['a-result'] };

  // Everything is driven by data-step on the root. The attribute-absent base rule IS
  // the arrive frame, so the first paint before hydration is already a correct screen.
  let css = STAGE_CSS + `
    .L .head { position:absolute; left:26px; top:26px; width:392px; z-index:4; opacity:0; visibility:hidden;
               transition: opacity var(--t-panel) var(--ease), visibility var(--t-panel); }
    .L .head.on { opacity:1; visibility:visible; }
    .L .rail { position:absolute; left:26px; bottom:26px; display:flex; gap:2px; z-index:5; }
    .L .sbtn { border:0; cursor:pointer; height:30px; padding:0 12px; background:var(--paper); color:var(--moss);
               font:600 12px var(--ui); transition: background var(--t-feel) var(--ease), color var(--t-feel) var(--ease); }
    .L .sbtn:hover { background:#e3e7dc; color:var(--pine); }
    .L .sbtn.on { background:var(--pine); color:var(--chalk); }
    .L .board { transform: ${STEPS[0][2]}; }
    .L .head[data-for="arrive"] { opacity:1; visibility:visible; }
    .L .head[data-for="arrive"] .scr { animation: wipe .46s steps(9) both; }
    .L .gz { transition: stroke-dasharray var(--t-board) var(--ease); }
    /* scale, not transform: individual transform properties apply before the transform
       attribute, so each element scales about its own centre rather than the board's. */
    .L .tl, .L .tk, .L .gl, .L .pt { transform-box: fill-box; transform-origin: center; }
    @keyframes dealIn { from { opacity:0; scale:.90; } to { opacity:1; scale:1; } }
    @keyframes popIn  { from { opacity:0; scale:.5; }  to { opacity:1; scale:1; } }
    @keyframes glyphIn { from { opacity:0; scale:.9; } to { opacity:.13; scale:1; } }
    @keyframes glyphIn { from { opacity:0; scale:.9; } to { opacity:.13; scale:1; } }`;
  for (const [id,,tf] of STEPS) {
    css += `\n    .L[data-step="${id}"] .board { transform: ${tf}; }`;
    css += `\n    .L[data-step="${id}"] .head[data-for="arrive"] { opacity:0; visibility:hidden; }`;
    css += `\n    .L[data-step="${id}"] .head[data-for="${id}"] { opacity:1; visibility:visible; }`;
    css += `\n    .L[data-step="${id}"] .head[data-for="${id}"] .scr { animation: wipe .46s steps(9) both; }`;
    for (const p of OPEN[id]) css += `\n    .L[data-step="${id}"] .${p} { visibility:visible; opacity:1; transform:none; }`;
  }
  // arrive is also the base state for its panel
  css += `\n    .L .a-arrive { visibility:visible; opacity:1; transform:none; }`;
  for (const [id] of STEPS) if (id !== 'arrive')
    css += `\n    .L[data-step="${id}"] .a-arrive { visibility:hidden; opacity:0; }`;
  // the deal: tiles and numbers arrive, pieces are withheld until the game resolves
  css += `
    .L[data-step="dealing"] .pc { opacity:0; }
    .L[data-step="dealing"] .tl { animation: glyphIn .5s var(--ease) both; animation-delay: calc(var(--i) * 26ms); }
    .L[data-step="dealing"] .gl { animation: glyphIn .5s var(--ease) both; animation-delay: calc(var(--i) * 26ms + 90ms); }
    .L[data-step="dealing"] .tk { animation: popIn .42s var(--ease) both; animation-delay: calc(var(--i) * 26ms + 300ms); }
    .L[data-step="dealing"] .pt { animation: dealIn .4s var(--ease) .82s both; }
    .L[data-step="dealing"] .bar > i { animation: fill 2.1s var(--ease) both; }
    @keyframes fill { from { width: 6%; } to { width: 100%; } }`;

  const boardSvg = board({ w: 640 });

  const head = (id, title, sub, extra='') => `<div class="head" data-for="${id}">
        <div class="d" style="font-size:29px; line-height:1.1;">${decode(title)}</div>
        <div class="cap" style="margin-top:8px; font-size:14.5px;">${sub}</div>${extra}</div>`;

  const body = `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;" data-step="{{step}}">
  <div class="stage">
    <div class="boardpos"><div class="board">${boardSvg}</div></div>
  </div>

  ${head('arrive','Three bots are playing','Nothing to set up and nothing to read first. This board is live, and it will keep playing whether or not you do anything.')}
  ${head('lineup','Who is playing','Two to four seats. Each one is a person or a bot. Take a seat, or take yourself out and it becomes a game to watch.')}
  ${head('dealing','Dealing seed 4127','The tiles and the numbers resolve first. The pieces are held back until the engine has the game, so nothing on the board is ever a guess.',
    `<div style="margin-top:18px; width:330px;"><div class="bar" style="height:5px; background:var(--dust);"><i style="display:block; height:100%; width:100%; background:var(--pine);"></i></div>
     <div class="cap" style="margin-top:7px; font-size:12.5px;">Frames arrive from the worker in batches of eight.</div></div>`)}
  ${head('playing','Turn 31 — your move','You rolled an 8. A wood to you, two to Red. The net would take the city; you do not have to agree with it.')}
  ${head('analysis','Why it says that','The same board, pushed aside rather than replaced. Both evaluators ranked on this one position, and the whole game behind them.')}
  ${head('seven','Someone rolled a seven','An interrupt takes the screen instead of stacking a dialog on top of the last one. You can see what it costs before you choose.')}
  ${head('ending','Red won on turn 84','However the game was played or watched, it finishes in the same place, and that place is the way into the analysis.')}

  <!-- arrive -->
  <div class="panel pb a-arrive" style="display:flex; gap:10px; align-items:center;">
    <button class="act go">Take a seat</button><button class="act">Watch this one out</button>
    <span class="cap" style="margin-left:6px;">or press a number to sit in that seat</span>
  </div>

  <!-- lineup -->
  <div class="panel pl a-lineup">
    <div class="card" style="height:100%; display:flex; flex-direction:column;">
      <div style="font:600 12.5px var(--ui);">The lineup</div>
      <div style="margin-top:12px; display:flex; flex-direction:column; gap:6px;">${seatChips()}</div>
      <button class="act" style="margin-top:8px; width:100%; background:transparent; box-shadow: inset 0 0 0 1px var(--dust);">Add a fourth seat</button>
      <div style="margin-top:auto;">
        <div class="row" style="justify-content:space-between; padding-top:14px;">
          <span class="cap">Board seed</span><span class="num" style="font:600 13px var(--ui);">4127</span>
        </div>
        <div class="cap" style="margin-top:10px; font-size:12.5px;">Take yourself out and every seat is a bot, so the game is computed ahead and you get the scrubber instead of a turn.</div>
        <button class="act go" style="margin-top:12px; width:100%;">Deal</button>
      </div>
    </div>
  </div>

  <!-- the seat rail: tier 0, and the entry point for hand, log and race -->
  <div class="panel pl a-rail" style="top:auto; bottom:312px; height:auto; width:376px;">
    <div class="card" style="padding:12px 13px;">
      <div style="font:600 11.5px var(--ui); color:var(--moss);">click a seat, your cards, or the last line</div>
      <div style="margin-top:9px; display:flex; flex-direction:column; gap:6px;">
        ${[['red','Red',6,'34.2%'],['blue','You',4,'29.8%'],['orange','Orange',6,'24.7%'],['grey','White',4,'12.4%']].map(([s,n,vp,w])=>
          `<div style="display:flex; align-items:center; gap:9px; font-size:12.5px; cursor:pointer;">
            <span style="width:11px; height:11px; flex:0 0 11px; background:${SEAT[s]};"></span>
            <span style="flex:1; ${n==='You'?'font-weight:600;':''}">${n}</span>
            <span class="num" style="color:var(--moss);">${vp}</span>
            <span class="num" style="width:44px; text-align:right;">${w}</span></div>`).join('')}
      </div>
      <div style="margin-top:10px; padding-top:9px; border-top:1px solid var(--dust); display:flex; gap:4px; cursor:pointer;">
        ${['wood','wood','brick','sheep','wheat','wheat','ore','ore','ore'].map(r=>
          `<span style="flex:1; height:22px; background:${C[r]};"></span>`).join('')}
      </div>
      <div class="cap" style="margin-top:6px; font-size:11.5px; cursor:pointer;">Orange played a knight and took the robber off your ore.</div>
    </div>
  </div>

  <!-- deal -->
  <div class="panel pb a-deal"><span class="cap">Tiles, then numbers, then the pieces once the game resolves.</span></div>

  <!-- coach + actions while playing -->
  <div class="panel pt a-coach" style="top:auto; bottom:114px; left:26px; width:376px;">
    <div style="padding:13px 14px; background:var(--pine); color:var(--chalk);">
      <div style="font:600 12.5px var(--ui); opacity:.7;">The net says</div>
      <div style="margin-top:5px; font:400 14px var(--ui); line-height:1.5;">Take the city. It doubles the number you just rolled, and the ore stops being a problem.</div>
      <div class="row" style="margin-top:11px; gap:8px; flex-wrap:wrap;">
        <button class="act" style="height:32px; font-size:12.5px;">Do it</button>
        <button class="act" style="height:32px; font-size:12.5px; background:#1d322c; color:var(--chalk);">Why</button>
        <button class="act" style="height:32px; font-size:12.5px; background:#1d322c; color:var(--chalk);">Show me the others</button>
      </div>
      <div style="margin-top:9px; padding-top:9px; border-top:1px solid #2a3f38; font:400 11.5px var(--ui); opacity:.75;">
        Why opens the thread beside the board. Show me the others opens the futures, which is the only way in.
      </div>
    </div>
  </div>
  <div class="panel pb a-act" style="left:auto; right:26px; display:flex; gap:9px;">
    <button class="act go">Build a city</button><button class="act">Buy a card</button>
    <button class="act">Offer a trade</button><button class="act">End turn</button>
  </div>

  <!-- analysis -->
  <div class="panel pr a-anal">
    <div class="card" style="height:100%; display:flex; flex-direction:column; gap:16px;">
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:9px;">Both evaluators, one position</div>
        ${ladder()}
        <div class="cap" style="margin-top:10px; padding-left:9px; border-left:2px solid ${C.wheat}; font-size:12.5px;">
          The banded row is where they disagree. The heuristic ranks the card first; the net takes the city.</div>
      </div>
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:8px;">Every step, every seat</div>
        ${curve(396,92)}
      </div>
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:8px;">What is holding the number up, and down</div>
        ${attribution()}
      </div>
      <div class="cap" style="margin-top:auto; font-size:12.5px;">Each seat's number is its own estimate of its own chances, so the four of them do not add to a hundred. A forced move shows this panel empty, because the search never ran.</div>
    </div>
  </div>

  <!-- a seven -->
  <div class="panel a-seven" style="inset:0; background:rgba(18,33,31,.55); transform:none; display:flex; align-items:flex-end; justify-content:center; padding-bottom:96px;">
    <div class="card" style="width:620px;">
      <div class="d" style="font-size:20px;">Choose four to lose</div>
      <div class="cap" style="margin-top:6px;">You have nine cards. The net would keep the ore and both wheat.</div>
      <div style="display:flex; gap:7px; margin-top:14px;">
        ${['wood','wood','brick','sheep','sheep','wheat','wheat','ore','ore'].map((r,i)=>
          `<span style="flex:1; height:56px; background:${C[r]}; ${i<4?'box-shadow: inset 0 0 0 3px #12211f;':'opacity:.55;'}"></span>`).join('')}
      </div>
      <div class="row" style="margin-top:14px; gap:9px;">
        <button class="act go">Discard these four</button><button class="act">Let the net choose</button>
        <span class="cap" style="margin-left:auto;">then the robber moves</span>
      </div>
    </div>
  </div>

  <!-- ending -->
  <div class="panel pr a-result">
    <div class="card" style="height:100%; display:flex; flex-direction:column; gap:15px;">
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:10px;">Final standings</div>
        ${[['red','Red',10],['blue','You',8],['orange','Orange',7],['grey','White',5]].map(([s,n,v])=>
          `<div class="row" style="gap:10px; padding:3px 0;"><span class="sw" style="background:${SEAT[s]}"></span>
           <span style="width:64px; font-size:13px;">${n}</span>
           <span class="ltrack"><i style="width:${v*10}%; background:${SEAT[s]};"></i></span>
           <span class="num lval">${v}</span></div>`).join('')}
      </div>
      <div><div style="font:600 12.5px var(--ui); margin-bottom:8px;">The three moments that decided it</div>
        ${[['Step 148','Red took the largest army','−9.1'],['Step 214','The seven that cost you four cards','−6.2'],['Step 301','Orange blocked your road to the ore','−4.4']]
          .map(([a,b,c])=>`<div class="row" style="gap:10px; padding:4px 0; cursor:pointer;">
            <span class="num cap" style="width:56px; font-size:12px;">${a}</span>
            <span style="flex:1; font-size:12.5px;">${b}</span>
            <span class="num" style="font-size:12px; color:#a34a34;">${c}</span></div>`).join('')}
      </div>
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:8px;">Every step, every seat</div>
        ${curve(396,88)}
        <div class="cap" style="margin-top:7px; font-size:12.5px;">Click anywhere on the curve to open the board at that step.</div>
      </div>
      <div class="row" style="gap:22px;">
        ${[['61 of 94','matched the net'],['−18.4','cost of the rest'],['turn 61','you last led']].map(([a,b])=>
          `<div><div class="d num" style="font-size:18px;">${a}</div><div class="cap" style="font-size:11.5px; margin-top:1px;">${b}</div></div>`).join('')}
      </div>
      <div class="row" style="margin-top:auto; gap:9px;">
        <button class="act go">Open the analysis</button><button class="act">Play the same board again</button>
      </div>
    </div>
  </div>

  <div class="rail"><sc-for list="{{steps}}" as="s" hint-placeholder-count="7"><button class="{{s.cls}}" onClick="{{s.go}}">{{s.label}}</button></sc-for></div>
  <span class="cap" style="position:absolute; left:534px; bottom:33px; font-size:12.5px;">click through the journey</span>
</div>`;

  const script = `<script data-dc-script>
class Component extends DCLogic {
  renderVals() {
    const steps = ${JSON.stringify(STEPS.map(([id,label])=>({id,label})))};
    const cur = this.state.step;
    return {
      step: cur,
      steps: steps.map((s) => ({
        label: s.label,
        cls: (cur === s.id || (!cur && s.id === 'arrive')) ? 'sbtn on' : 'sbtn',
        go: () => this.setState({ step: s.id }),
      })),
    };
  }
}
</script>`;
  write('Main.dc.html', doc(css, body, script));
}

// ═══════════════════════════════════════════════ 2. the flow map
{
  const boxW = 176, boxH = 54;
  const box = (x,y,label,kind='') => {
    const fill = kind==='hub' ? C.pine : kind==='ghost' ? 'none' : C.paper;
    const col  = kind==='hub' ? C.chalk : C.pine;
    return `<g transform="translate(${x},${y})">
      <rect width="${boxW}" height="${boxH}" fill="${fill}"${kind==='ghost'?` stroke="${C.dust}" stroke-dasharray="4 4"`:''}/>
      <text x="${boxW/2}" y="${boxH/2+4.5}" text-anchor="middle" font-size="13" font-weight="${kind==='hub'?700:600}" fill="${col}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${label}</text></g>`;
  };
  const arrow = (x1,y1,x2,y2) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${C.moss}" stroke-width="1.4" marker-end="url(#ah)"/>`;
  const VIEWS=[['Coach',262,186],['Race',454,186],['Console',646,186],
               ['Futures',262,256],['Move analysis',454,256],['Game analysis',646,256]];
  const map = `<svg viewBox="0 0 900 560" width="900" height="560" style="display:block" aria-hidden="true">
    <defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="${C.moss}"/></marker></defs>
    ${box(0,0,'Arrive')}
    ${arrow(88,54,88,84)}
    ${box(0,86,'Lineup')}
    ${arrow(88,140,88,170)}
    ${box(0,172,'Deal')}
    ${arrow(88,226,88,256)}
    ${box(0,258,'The table','hub')}
    <rect x="246" y="168" width="592" height="158" fill="none" stroke="${C.dust}"/>
    <text x="246" y="158" font-size="11.5" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">views, arriving around the same board</text>
    ${arrow(176,285,246,251)}
    ${VIEWS.map(([l,x,y])=>box(x,y,l)).join('')}
    ${arrow(88,312,88,342)}
    ${box(0,344,'Interrupts')}
    <text x="0" y="418" font-size="11.5" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">a seven, the robber, a trade, a handoff</text>
    ${arrow(88,398,88,442)}
    ${box(0,444,'Ending')}
    ${arrow(176,471,246,471)}
    ${box(246,444,'Review')}
    <path d="M422 471 L610 471 L610 340" fill="none" stroke="${C.moss}" stroke-width="1.4" marker-end="url(#ah)"/>
    <text x="624" y="430" font-size="11.5" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">the same board,</text>
    <text x="624" y="446" font-size="11.5" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">at any step</text>
  </svg>`;

  const old = `<svg viewBox="0 0 300 300" width="300" height="300" style="display:block" aria-hidden="true">
    ${['Play','Watch','Results','About'].map((t,i)=>`<g transform="translate(0,${i*64})">
      <rect width="150" height="46" fill="none" stroke="${C.dust}"/>
      <text x="75" y="28" text-anchor="middle" font-size="13" fill="${C.moss}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${t}</text></g>`).join('')}
    <path d="M168 23 L168 215" stroke="#a34a34" stroke-width="1.3" stroke-dasharray="4 4"/>
    <text x="178" y="104" font-size="11.5" fill="#a34a34" font-family="Chivo,Helvetica Neue,Arial,sans-serif">switching a tab</text>
    <text x="178" y="120" font-size="11.5" fill="#a34a34" font-family="Chivo,Helvetica Neue,Arial,sans-serif">unmounts the page</text>
    <text x="178" y="136" font-size="11.5" fill="#a34a34" font-family="Chivo,Helvetica Neue,Arial,sans-serif">and takes the</text>
    <text x="178" y="152" font-size="11.5" fill="#a34a34" font-family="Chivo,Helvetica Neue,Arial,sans-serif">game with it</text>
  </svg>`;

  write('FlowNew.dc.html', doc('', `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip; padding:28px 34px;">
  <div style="display:flex; gap:44px; align-items:flex-start;">
    <div style="width:300px; flex:0 0 300px;">
      <div class="d" style="font-size:29px; line-height:1.1;">One table, many views</div>
      <div class="cap" style="margin-top:9px; font-size:14.5px;">The board is one object that never unmounts. Everything the six old screens did becomes a view that arrives around it, so nothing is ever rebuilt and nothing is ever lost.</div>
      <div style="margin-top:26px; font:600 12.5px var(--ui);">What it replaces</div>
      <div style="margin-top:10px;">${old}</div>
      <div class="cap" style="margin-top:2px; font-size:12.5px;">Play and Watch are the same screen with a different lineup, so they stop being separate places. Results and About become destinations that do not take the game down with them.</div>
    </div>
    <div style="flex:1; min-width:0;">${map}</div>
  </div>
</div>`));
}

// ═══════════════════════════════════════════════ 3. lineup
{
  const modes = [
    ['You · Value-net · Heuristic', 'played', 'three seats, one of them yours'],
    ['Value-net · Heuristic · Random · Value-net', 'watched', 'no people, so the game is computed ahead and you scrub it'],
    ['You · Player 2 · Value-net', 'hotseat', 'two people, so the screen changes hands between their turns'],
    ['You · Random', 'played', 'the smallest game the engine will deal'],
  ];
  write('Lineup.dc.html', doc(STAGE_CSS, `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;">
  <div class="stage"><div class="boardpos"><div class="board" style="transform:translate(292px,64px) scale(.80); opacity:.5;">${board({w:640})}</div></div></div>
  <div style="position:absolute; left:34px; top:30px; width:352px;">
    <div class="d" style="font-size:29px; line-height:1.1;">The lineup is the whole setup</div>
    <div class="cap" style="margin-top:9px; font-size:14.5px;">Two to four seats. Each is a person or a bot, and you edit it on the board you are already looking at rather than on a card that comes before it.</div>
    <div class="card" style="margin-top:20px;">
      <div style="font:600 12.5px var(--ui);">Seats</div>
      <div style="margin-top:11px; display:flex; flex-direction:column; gap:6px;">
        ${chip('blue','You','person')}${chip('red','Value-net search','bot · depth 2')}${chip('orange','Heuristic search','bot · depth 2')}
        <div class="chip" style="opacity:.5;"><span class="sw" style="background:${SEAT.grey}"></span>
          <span style="font:600 13.5px var(--ui); flex:1;">Add a fourth seat</span><span class="cap" style="font-size:12px;">+</span></div>
      </div>
      <div class="row" style="justify-content:space-between; margin-top:14px;">
        <span class="cap">Board seed</span>
        <span class="row" style="gap:8px;"><span class="num" style="font:600 13px var(--ui);">4127</span>
        <button class="act" style="height:26px; padding:0 9px; font-size:12px;">Re-deal</button></span>
      </div>
    </div>
    <button class="act go" style="margin-top:11px; width:100%;">Deal</button>
    <div style="margin-top:24px; font:600 12.5px var(--ui);">Why this merges Play and Watch</div>
    <div class="cap" style="margin-top:7px;">Watching is not a mode, it is a lineup with nobody in it. The engine already takes any seat count and already has a human player kind, so the only thing standing between the two tabs today is the setup form. Take yourself out and the transport bar replaces the action bar; put yourself back and it is your turn.</div>
    <div style="margin-top:18px; font:600 12.5px var(--ui);">Two people at one screen</div>
    <div class="cap" style="margin-top:7px;">A second person turns on the handoff, so nobody sees cards that are not theirs. It appears only when it has to, and never in a game with one person in it.</div>
  </div>
  <div style="position:absolute; left:420px; right:34px; top:30px;">
    <div style="font:600 12.5px var(--ui);">What the lineup decides</div>
    <div style="margin-top:11px; display:flex; flex-direction:column; gap:8px;">
      ${modes.map(([l,mode,note])=>`<div class="card" style="display:flex; align-items:center; gap:16px; padding:12px 15px;">
        <span style="flex:1; font-size:13.5px;">${l}</span>
        <span style="font:700 12px var(--ui); color:${mode==='watched'?'#2f6a57':C.pine};
              background:${mode==='watched'?'#dfe9e0':'#e6e9df'}; padding:4px 9px;">${mode}</span>
        <span class="cap" style="width:286px; flex:0 0 286px; font-size:12.5px;">${note}</span></div>`).join('')}
    </div>
  </div>
  <div style="position:absolute; right:34px; bottom:30px; width:300px; text-align:right;" class="cap">
    The board behind is the one you are configuring. Changing a seat or the seed re-deals it in place, so you are never choosing settings for something you cannot see.</div>
</div>`));
}

// ═══════════════════════════════════════════════ 4. deal
{
  const css = STAGE_CSS + `
    .L .tl, .L .tk, .L .gl, .L .pt { transform-box: fill-box; transform-origin: center; }
    .L .tl { animation: glyphIn .55s var(--ease) both; animation-delay: calc(var(--i) * 32ms); }
    .L .gl { animation: glyphIn .55s var(--ease) both; animation-delay: calc(var(--i) * 32ms + 110ms); }
    .L .tk { animation: popIn .44s var(--ease) both; animation-delay: calc(var(--i) * 32ms + 380ms); }
    .L .pt { animation: dealIn .45s var(--ease) 1s both; }
    .L .pc { opacity: 0; }
    .L .bar > i { animation: fill 2.4s var(--ease) both; }
    @keyframes dealIn { from { opacity:0; scale:.90; } to { opacity:1; scale:1; } }
    @keyframes popIn  { from { opacity:0; scale:.5; }  to { opacity:1; scale:1; } }
    @keyframes glyphIn { from { opacity:0; scale:.9; } to { opacity:.13; scale:1; } }
    @keyframes fill { from { width:6%; } to { width:100%; } }`;
  write('Deal.dc.html', doc(css, `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;">
  <div class="stage"><div class="boardpos"><div class="board" style="transform:translate(150px,0) scale(.92)">${board({w:640})}</div></div></div>
  <div style="position:absolute; left:34px; top:30px; width:360px;">
    <div class="d" style="font-size:29px; line-height:1.1;">${decode('Dealing seed 4127')}</div>
    <div class="cap" style="margin-top:9px; font-size:14.5px;">${decode('Three bots are seated. You are Blue, and you place first.')}</div>
    <div style="margin-top:20px; width:330px;">
      <div class="bar" style="height:5px; background:var(--dust);"><i style="display:block; height:100%; width:100%; background:var(--pine);"></i></div>
      <div class="cap" style="margin-top:8px; font-size:12.5px;">Frames arrive from the worker in batches of eight, so the bar is real progress rather than a guess.</div>
    </div>
    <div style="margin-top:28px; font:600 12.5px var(--ui);">The order matters</div>
    <div class="cap" style="margin-top:7px;">Tiles resolve outward from the centre, then the numbers, and the pieces are withheld entirely until the engine hands back a game. Nothing on the board is ever a placeholder that later turns out to be wrong.</div>
    <div style="margin-top:20px; font:600 12.5px var(--ui);">Why it decodes rather than types</div>
    <div class="cap" style="margin-top:7px;">A typewriter says a person is writing to you. A decode says a number arrived and is being read, which is what a seed is. Every character is real text in the markup with the scramble laid over it, so it stays readable to a screen reader and to anyone with motion turned off.</div>
  </div>
  <div style="position:absolute; left:34px; bottom:30px;" class="cap">Reload the artboard to watch it deal again.</div>
</div>`));
}

// (the old "views" artboard is retired — views.mjs writes Ladder.dc.html instead)

// ═══════════════════════════════════════════════ 6. handoff
{
  write('Handoff.dc.html', doc(STAGE_CSS, `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;">
  <div class="stage"><div class="boardpos"><div class="board" style="transform:scale(.84); filter: blur(7px); opacity:.5;">${board({w:640})}</div></div></div>
  <div style="position:absolute; inset:0; background:rgba(238,240,233,.55);"></div>
  <div style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:520px;" class="card">
    <div class="row" style="gap:11px;"><span class="sw" style="width:16px; height:16px; background:${SEAT.orange}"></span>
      <span class="d" style="font-size:23px;">Player 2, it is your turn</span></div>
    <div class="cap" style="margin-top:10px; font-size:14px;">The board and both hands are covered until you say you are ready. Nobody sees cards that are not theirs.</div>
    <div class="row" style="margin-top:18px; gap:10px;">
      <button class="act go">I am Player 2 — show the board</button>
      <span class="cap" style="margin-left:auto;">turn 12 of about 80</span>
    </div>
  </div>
  <div style="position:absolute; left:34px; top:30px; width:330px;">
    <div class="d" style="font-size:29px; line-height:1.1;">Changing hands</div>
    <div class="cap" style="margin-top:9px; font-size:14.5px;">The one new mechanic that hotseat needs. It appears only when two or more seats are people, and never in a game with one person in it.</div>
  </div>
  <div style="position:absolute; right:34px; top:30px; width:320px;">
    <div style="font:600 12.5px var(--ui);">What it covers</div>
    <div class="cap" style="margin-top:7px;">The hand, the coach, and anything in the analysis that names a specific hand. The board itself is public knowledge, but it is blurred anyway so the curtain reads as a hard stop rather than a suggestion.</div>
    <div style="margin-top:18px; font:600 12.5px var(--ui);">Why it is a deliberate tap</div>
    <div class="cap" style="margin-top:7px;">A timer would be worse: whoever is slower to look away loses information. The screen waits, however long it waits.</div>
    <div style="margin-top:18px; font:600 12.5px var(--ui);">Where it does not appear</div>
    <div class="cap" style="margin-top:7px;">Between a person and a bot, because a bot has nothing to hide from. In a three-person game it appears twice a round, between each pair of consecutive human turns.</div>
  </div>
</div>`));
}

// ═══════════════════════════════════════════════ 7. ending
{
  write('Ending.dc.html', doc(STAGE_CSS, `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;">
  <div class="stage"><div class="boardpos"><div class="board" style="transform:translate(-268px,10px) scale(.60)">${board({w:640})}</div></div></div>
  <div style="position:absolute; left:34px; top:30px; width:330px;">
    <div class="d" style="font-size:29px; line-height:1.1;">Red won on turn 84</div>
    <div class="cap" style="margin-top:9px; font-size:14.5px;">One door out of every game, however it was played. A game you watched ends here too, which is what finally connects the two halves of the site.</div>
  </div>
  <div style="position:absolute; left:34px; bottom:30px; width:400px;">
    <div style="font:600 12.5px var(--ui);">Every step, every seat</div>
    <div style="margin-top:10px;">${curve(400,96)}</div>
    <div class="cap" style="margin-top:9px; font-size:12.5px;">Click anywhere on the curve to open the board at that step. The three moments on the right are the same gesture, already aimed.</div>
  </div>
  <div style="position:absolute; right:34px; top:30px; width:452px;" class="card">
    <div style="display:flex; flex-direction:column; gap:18px;">
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:11px;">Final standings</div>
        ${[['red','Red',10],['blue','You',8],['orange','Orange',7],['grey','White',5]].map(([s,n,v])=>
          `<div class="row" style="gap:10px; padding:4px 0;"><span class="sw" style="background:${SEAT[s]}"></span>
           <span style="width:70px; font-size:13.5px;">${n}</span>
           <span class="ltrack"><i style="width:${v*10}%; background:${SEAT[s]};"></i></span>
           <span class="num lval">${v}</span></div>`).join('')}
      </div>
      <div><div style="font:600 12.5px var(--ui); margin-bottom:9px;">The three moments that decided it</div>
        ${[['Step 148','Red took the largest army','−9.1'],['Step 214','The seven that cost you four cards','−6.2'],['Step 301','Orange blocked your road to the ore','−4.4']]
          .map(([a,b,c])=>`<div class="row" style="gap:11px; padding:6px 0; cursor:pointer;">
            <span class="num cap" style="width:58px; font-size:12px;">${a}</span>
            <span style="flex:1; font-size:13px;">${b}</span>
            <span class="num" style="font-size:12.5px; color:#a34a34;">${c}</span></div>`).join('')}
      </div>
      <div>
        <div style="font:600 12.5px var(--ui); margin-bottom:9px;">How you played</div>
        <div class="row" style="gap:24px;">
          ${[['61 of 94','decisions matched the net'],['−18.4','total cost of the rest'],['turn 61','the last turn you led']].map(([a,b])=>
            `<div><div class="d num" style="font-size:19px;">${a}</div><div class="cap" style="font-size:12px; margin-top:2px;">${b}</div></div>`).join('')}
        </div>
      </div>
      <div class="row" style="gap:9px; flex-wrap:wrap;">
        <button class="act go">Open the analysis</button>
        <button class="act">Play the same board</button>
        <button class="act">New lineup</button>
      </div>
    </div>
  </div>
</div>`));
}

// ═══════════════════════════════════════════════ 8. the board, as spec
{
  // old token, reproduced for the comparison
  const oldToken = (cx,cy,n) => {
    const hot=n===6||n===8, ink=hot?C.wheat:C.chalk, P=pips(n);
    const dots=Array.from({length:P},(_,i)=>`<circle cx="${((i-(P-1)/2)*3.08).toFixed(2)}" cy="8.36" r="1.06" fill="${ink}"/>`).join('');
    return `<g transform="translate(${cx},${cy})"><polygon points="${pts(hex(0,0,13.2))}" fill="${C.pine}"/>`
      + `<text y="3.96" text-anchor="middle" font-size="13.2" font-weight="700" fill="${ink}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">${n}</text>${dots}</g>`;
  };
  const NUMS = [6,8,10,11,12,3];
  const tokenRow = (fn, y) => NUMS.map((n,i)=>fn(i*74+40, y, n)).join('');
  const tileSwatch = (res,x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C[res]}"/>`;
  // same geometry, same plinth, only the seat colour differs
  const whitePiece = (kind,x,y,sc) => piece(kind,'grey',x,y,sc)
    .replace(/#b9bfb2/g,'#f2f2ec').replace(/#d4d9cd/g,'#ffffff').replace(/#8d9387/g,'#d8d8d2');

  write('BoardSpec.dc.html', doc('', `<div class="L" style="width:1440px; height:1720px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip; padding:28px 34px;">
  <div style="display:flex; gap:40px; align-items:flex-start;">
    <div class="d" style="font-size:29px; line-height:1.1; width:300px; flex:0 0 300px;">The board, as spec</div>
    <div class="cap" style="flex:1; min-width:0; font-size:14.5px; column-count:2; column-gap:40px;">
      Everything the board is made of, with numbers rather than adjectives. Six things changed: the number tokens are bigger and now pop centred on their own tile rather than converging from the middle of the board; the resource glyphs are back; nine ports are drawn from the engine's own topology; the lattice tapers instead of stopping at an edge; the outline around the island is gone, because the gaps and the lattice already say where it stops; and the fourth seat is a warm grey rather than white.
    </div>
  </div>

  <div style="margin-top:28px; display:flex; gap:34px;">
    <div>
      <div style="font:600 13px var(--ui);">The number token</div>
      <svg viewBox="0 0 480 190" width="480" height="190" style="display:block; margin-top:10px" aria-hidden="true">
        <rect width="480" height="88" fill="${C.wood}"/>
        <rect y="94" width="480" height="88" fill="${C.wood}"/>
        <text x="8" y="16" font-size="11" fill="${C.chalk}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">before</text>
        <text x="8" y="110" font-size="11" fill="${C.chalk}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">after</text>
        ${tokenRow(oldToken, 50)}
        ${NUMS.map((n,i)=>token(i*74+40, 144, n)).join('')}
      </svg>
      <div class="cap" style="margin-top:9px; width:480px;">The five-pip row used to clear the sloping edge by 1.16 units, which is what made 6 and 8 look pinched, and the two-digit numbers sat almost edge to edge. The token is now 16.5 across the corners instead of 13.2, the digits 14px instead of 13.2, and the pips sit further in. Clearance goes to 3.36.</div>
    </div>
    <div>
      <div style="font:600 13px var(--ui);">The fourth seat</div>
      <svg viewBox="0 0 460 190" width="460" height="190" style="display:block; margin-top:10px" aria-hidden="true">
        ${['sheep','desert','wheat','wood','ore'].map((r,i)=>tileSwatch(r, i*92, 0, 92, 88)).join('')}
        ${['sheep','desert','wheat','wood','ore'].map((r,i)=>tileSwatch(r, i*92, 94, 92, 88)).join('')}
        ${[0,1,2,3,4].map(i=>whitePiece('set', i*92+30, 34, 1.5)).join('')}
        ${[0,1,2,3,4].map(i=>whitePiece('city', i*92+62, 40, 1.3)).join('')}
        ${[0,1,2,3,4].map(i=>piece('set','grey', i*92+30, 128, 1.5)).join('')}
        ${[0,1,2,3,4].map(i=>piece('city','grey', i*92+62, 134, 1.3)).join('')}
        <text x="4" y="14" font-size="11" fill="${C.pine}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">white</text>
        <text x="4" y="108" font-size="11" fill="${C.pine}" font-family="Chivo,Helvetica Neue,Arial,sans-serif">grey</text>
      </svg>
      <div class="cap" style="margin-top:9px; width:460px;">Pure white disappeared on sheep, desert and chalk, and the plinth alone was not enough to save it. The seat is now a single warm grey, body #b9bfb2 with a lighter roof, used identically on the board, in the bars and in the wheels. It keeps the name White.</div>
    </div>
  </div>

  <div style="margin-top:22px; display:flex; gap:34px;">
    <div>
      <div style="font:600 13px var(--ui);">The resource glyphs, back from the earlier rounds</div>
      <svg viewBox="0 0 620 108" width="620" height="108" style="display:block; margin-top:10px" aria-hidden="true">
        ${['wood','brick','sheep','wheat','ore','desert'].map((r,i)=>
          `<g transform="translate(${i*103+52},52)"><polygon points="${pts(hex(0,0,R-2.5))}" fill="${C[r]}"/>${glyph(r,0,0)}</g>
           <text x="${i*103+52}" y="104" text-anchor="middle" font-size="11" fill="${C.moss}" font-family="Chivo,sans-serif">${r}</text>`).join('')}
      </svg>
      <div class="cap" style="margin-top:8px; width:620px;">Lifted verbatim rather than redrawn, and placed by translation, so these are the shapes that were already signed off. They sit at 13 per cent on the tile colour, under the pieces and under the number, so they read as texture rather than as content. Desert carries none, which is what makes it read as empty.</div>
    </div>
    <div>
      <div style="font:600 13px var(--ui);">The lattice tapers</div>
      <svg viewBox="-430 -200 860 400" width="430" height="200" style="display:block; margin-top:10px" aria-hidden="true">
        ${lattice(-440,-210,440,210).map(([x,y,o])=>`<polygon points="${pts(hex(x,y,R-2.5))}" fill="none" stroke="${C.grid}" stroke-width="1.2" opacity="${o}"/>`).join('')}
        ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('')}
      </svg>
      <div class="cap" style="margin-top:8px; width:430px;">Cell opacity falls off with distance from the island, full strength to 210 units and gone by 430, squared so it thins away faster than it starts. The board sits on a surface that runs out rather than inside a box with an edge.</div>
    </div>
  </div>

  <div style="margin-top:22px; display:flex; gap:34px;">
    <div>
      <div style="font:600 13px var(--ui);">Nine ports</div>
      <svg viewBox="-268 -268 536 536" width="330" height="330" style="display:block; margin-top:10px" aria-hidden="true">
        ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}" opacity=".45"/>`).join('')}
        ${ports()}
      </svg>
    </div>
    <div style="width:390px; padding-top:26px;">
      <div class="cap">Real geometry, not a guess: the nine centres come from the engine's own topology, in unit hex radii, times the same 44 the tiles use. The two dock lines are derived rather than stored, because for every port the two nearest island corners are each exactly 44 away and exactly 44 apart, which is to say they are the two ends of one coastal edge.</div>
      <div class="cap" style="margin-top:10px;">Four are generic at three to one and five are specific at two to one, one per resource. Which port gets which is shuffled per seed; the order shown is the topology's own template, which is what the earlier rounds drew, so the new boards line up with them for comparison.</div>
      <div class="cap" style="margin-top:10px;">The badge sits on the centre itself rather than being nudged outward. An earlier pass pushed it 7px radially from the board's origin, which is not the direction of a port's own dock, so six of the nine ended up with unequal connectors and no two sat at the same distance from the coast. Unmoved, every badge is 38.1 from its edge midpoint and both its connectors are the same length.</div>
      <div class="cap" style="margin-top:10px;">It is filled like a tile, with no stroke, because the outlined version put a colour swatch inside a ring and left it 0.26 units of clearance — sub-pixel at every size the board is drawn, so the stroke ate the colour. The resource is now the whole shape plus one motif of its own glyph: one wheat stalk where the tile draws three, one sheep where it draws two. Generic ports take the board's neutral and no glyph, because they have no resource to show. That also leaves no filled shape on the board carrying a stroke: what strokes remain are the lattice, the roads and the docks, each a line in its own right rather than an outline around something else.</div>
      <div class="cap" style="margin-top:10px;">The fill is the tile colour lightened a fifth toward the ground. Pine ink beats chalk on all five resources but does not clear 4.5:1 on the two darkest — wood reads 4.16 and brick 3.93 — and the lightening takes the worst case to 5.20 while keeping the hue obvious. It also stops a port being mistaken for a tile of the same resource: it is a lighter chip of the same colour.</div>
      <div style="margin-top:12px; font:600 12px var(--ui);">For implementation</div>
      <div style="margin-top:6px; font:400 11.5px ui-monospace,Menlo,monospace; line-height:1.7; color:var(--pine);">
        centres&nbsp;&nbsp;&nbsp;topology.json ports[].center × 44<br>
        ratio&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;map.ports[id].resource &lt; 0 → 3:1<br>
        badge&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;r 16, no stroke, fill = mix(tile, chalk, .2)<br>
        3:1&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;--dust, no glyph<br>
        glyph&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;first motif of the watermark, 18×14, .55<br>
        docks&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;in the app, map.ports[id].nodes<br>
        centre&nbsp;&nbsp;&nbsp;&nbsp;unmoved: 38.1 from the edge midpoint
      </div>
    </div>
  </div>

  <div style="margin-top:22px; display:flex; gap:34px; align-items:flex-start;">
    <div>
      <div style="font:600 13px var(--ui);">No outline around the island</div>
      <div style="margin-top:10px; display:flex; gap:20px;">
        <div>
          <svg viewBox="-236 -236 472 472" width="230" height="230" style="display:block" aria-hidden="true">
            ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('')}
            <polygon points="-201,-23.21 -160.8,-46.42 -160.8,-92.84 -120.6,-116.05 -120.6,-162.47 -80.4,-185.68 -40.2,-162.47 0,-185.68 40.2,-162.47 80.4,-185.68 120.6,-162.47 120.6,-116.05 160.8,-92.84 160.8,-46.42 201,-23.21 201,23.21 160.8,46.42 160.8,92.84 120.6,116.05 120.6,162.47 80.4,185.68 40.2,162.47 0,185.68 -40.2,162.47 -80.4,185.68 -120.6,162.47 -120.6,116.05 -160.8,92.84 -160.8,46.42 -201,23.21" fill="none" stroke="#12211f" stroke-width="3" stroke-linejoin="round" opacity="0.85"/>
          </svg>
          <div class="cap" style="text-align:center; font-size:12px;">before</div>
        </div>
        <div>
          <svg viewBox="-236 -236 472 472" width="230" height="230" style="display:block" aria-hidden="true">
            ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('')}
          </svg>
          <div class="cap" style="text-align:center; font-size:12px;">after</div>
        </div>
      </div>
    </div>
    <div style="flex:1; padding-top:26px;">
      <div class="cap">The outline was doing the job the negative space already does. Removing it also removes the last hard line on the board, which matters now that no piece carries one either: what separates things is the ground showing through and the shadow underneath, consistently, everywhere.</div>
      <div class="cap" style="margin-top:12px;">The hex lattice behind the island stays. It is generated from the same loop that places the tiles, so it lines up by construction rather than by adjustment, and it is what keeps the board feeling like part of a larger surface instead of a shape floating on a page.</div>
    </div>
  </div>
</div>`));
}
console.log('done');

import './views.mjs';
import './screens.mjs';
