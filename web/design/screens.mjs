// The screens a player actually sees. Dense, full-bleed, in the earlier rounds' language:
// clipped corners on every panel and control, packed rails, dark pills for live numbers.
import { writeFileSync } from 'node:fs';
import { C, D, SEAT, SEAT_HI, SEAT_LO, SEAT_NAME, TILES, hex, pts, pips, R,
         PIECES, piece, board, doc, decode } from './board.mjs';
const OUT = new URL('./canvas/', import.meta.url).pathname;
const w = (n,h) => { writeFileSync(OUT+n,h); console.log('wrote', n, h.length); };

const CSS = `
    .L .stage { position:absolute; inset:0; overflow:clip; }
    .L .bp { position:absolute; left:0; top:0; }
    .L .brd { transition: transform var(--t-board) var(--ease); }
    .L .pnl { background:var(--paper); padding:14px 15px; }
    .L .dark { background:var(--pine); color:var(--chalk); padding:14px 15px; }
    .L .hd { font:600 12px var(--ui); }
    .L .sw { width:13px; height:13px; flex:0 0 13px; }
    .L .pipline { display:flex; gap:2.5px; }
    .L .pipline > i { width:8px; height:8px; border-radius:50%; }
    .L .rw { display:flex; align-items:center; gap:9px; }
    .L .rank { display:flex; align-items:center; gap:9px; padding:5px 0; }
    .L .rank > .nm { flex:1; font-size:12.5px; }
    .L .rank > .tr { width:96px; flex:0 0 96px; height:8px; background:var(--dust); }
    .L .rank > .tr > i { display:block; height:100%; }
    .L .rank > .vl { width:44px; text-align:right; font-size:12px; }
    .L .cardw { width:34px; height:46px; }
    .L .qs { display:inline-flex; align-items:center; height:26px; padding:0 10px; background:#e4e8dd;
             font:500 12px var(--ui); cursor:pointer;
             clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px); }`;

const SHELL = (inner, extra='') => `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;"${extra}>${inner}</div>`;

// ── the board, positioned absolutely and transformed per screen
const BOARD = board({ w: 660 });
const stage = tf => `<div class="stage"><div class="bp" style="left:50%; top:50%; transform:translate(-50%,-50%);">
    <div class="brd" style="transform:${tf}">${BOARD}</div></div></div>`;

// ── header: the one line that says where you are, plus the standing meter
const header = (title, sub, meter=true) => `
  <div style="position:absolute; left:30px; top:24px; width:640px;">
    <div class="d" style="font-size:29px; line-height:1.05;">${title}</div>
    <div class="cap" style="margin-top:6px; font-size:14px; max-width:560px;">${sub}</div>
  </div>
  ${meter ? `<div class="pnl cut8" style="position:absolute; right:30px; top:24px; display:flex; align-items:center; gap:13px; padding:9px 13px;">
    <span class="cap" style="font-size:12px;">A seven next roll</span>
    <span class="d num" style="font-size:19px;">6<span style="font-weight:400; font-size:12px; color:var(--moss);"> in 36</span></span>
    <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true"><circle cx="3" cy="3" r="3" fill="${C.brick}"/><circle cx="13" cy="3" r="3" fill="${C.brick}"/><circle cx="23" cy="3" r="3" fill="${C.brick}"/><circle cx="3" cy="13" r="3" fill="${C.brick}"/><circle cx="13" cy="13" r="3" fill="${C.brick}"/><circle cx="23" cy="13" r="3" fill="${C.brick}"/></svg>
  </div>` : ''}`;

// ── the seat rail: tier 0, and where three of the four tier-1 panels are opened from
const SEATS_D = [['blue','Blue, you',4,'+1','29.8%'],['red','Red',6,'','34.2%'],
                 ['orange','Orange',6,'','24.7%'],['grey','White',4,'','12.4%']];
const seatRail = (hi='') => `<div class="pnl cut" style="position:absolute; left:30px; top:118px; width:296px;">
    ${SEATS_D.map(([s,n,vp,d,wn])=>`<div style="padding:9px 0; ${s===hi?'background:#e9ece3; margin:0 -15px; padding-left:15px; padding-right:15px;':''}${s!=='grey'?'border-bottom:1px solid var(--dust);':''} cursor:pointer;">
      <div class="rw">
        <span class="sw" style="background:${SEAT[s]};"></span>
        <span style="flex:1; font:600 13.5px var(--ui);">${n}</span>
        <span class="d num" style="font-size:16px;">${vp}${d?`<span style="font-size:11px; color:var(--moss); font-weight:400;"> ${d}</span>`:''}</span>
        <span class="num" style="width:46px; text-align:right; font-size:12.5px; color:var(--moss);">${wn}</span>
      </div>
      <div class="pipline" style="margin-top:6px;">
        ${Array.from({length:10},(_,i)=>`<i style="background:${i<vp?SEAT[s]:'#dde2d6'};"></i>`).join('')}
      </div></div>`).join('')}
    <div class="cap" style="font-size:11.5px; margin-top:10px;">Longest road to Red, largest army to Orange. Each reading is from that seat's own side.</div>
  </div>`;

// ── the running log, under the rail
const LOG = ['You rolled an 8 and took a wood.','Orange bought a knight from White for two sheep.',
             'Orange played it and took largest army; the robber came off your ore.',
             'Red built a fifth road and keeps longest road.'];
const logCard = () => `<div class="pnl cut" style="position:absolute; left:30px; top:420px; width:296px;">
    <div class="hd">This turn</div>
    <div style="margin-top:9px; display:flex; flex-direction:column; gap:8px;">
      ${LOG.map((l,i)=>`<div style="display:flex; gap:8px; cursor:pointer;">
        <span style="width:6px; height:6px; margin-top:6px; flex:0 0 6px; background:${['#2f6fd0','#e07b2a','#e07b2a','#c0392b'][i]}; border-radius:50%;"></span>
        <span style="font-size:12.5px; line-height:1.45;">${l}</span></div>`).join('')}
    </div>
  </div>`;

// ── the dock: your hand and what you can do with it
const HAND = [['wood',2],['brick',1],['sheep',1],['wheat',2],['ore',3]];
const dock = (acts=[['Build a city',1],['Settlement',0],['Road',1],['Dev card',1],['End turn',1]]) =>
`<div class="pnl cut" style="position:absolute; left:352px; right:30px; bottom:26px; display:flex; align-items:center; gap:22px;">
    <div>
      <div class="hd">Your hand</div>
      <div class="cap" style="font-size:11.5px; margin-top:2px;">nine cards — a seven takes four</div>
    </div>
    <div style="display:flex; gap:5px; cursor:pointer;">
      ${HAND.map(([r,n])=>Array.from({length:n},()=>`<span class="cardw cut8" style="background:${C[r]};"></span>`).join('')).join('')}
    </div>
    <div style="margin-left:auto; display:flex; gap:8px;">
      ${acts.map(([t,on],i)=>`<button class="act${i===0&&on?' go':''}" style="${on?'':'opacity:.42;'}">${t}</button>`).join('')}
    </div>
  </div>`;

// ── the coach's one line: tier 0, and the door to two of the tier-2 views
const coachLine = () => `<div class="dark cut" style="position:absolute; left:352px; bottom:126px; width:560px;">
    <div class="rw" style="gap:10px;">
      <span style="font:600 11.5px var(--ui); opacity:.66;">The net says</span>
      <span class="num" style="margin-left:auto; font:700 12.5px var(--ui); color:${C.wheat}; cursor:pointer;">33.6% &nbsp;+3.8</span>
    </div>
    <div style="margin-top:6px; font:400 14px var(--ui); line-height:1.5;">Build the city on the 8 wood and 3 ore. It doubles the number you just rolled, and the ore stops being a problem.</div>
    <div class="rw" style="margin-top:11px; gap:8px;">
      <button class="act" style="height:32px; font-size:12.5px;">Build it</button>
      <button class="act" style="height:32px; font-size:12.5px; background:#1d322c; color:var(--chalk);">Why</button>
      <button class="act" style="height:32px; font-size:12.5px; background:#1d322c; color:var(--chalk);">Show me the others</button>
    </div>
  </div>`;

// win-chance pill under the board, the way the old views carried it
const winPill = (x=1042, y=678) => `<div class="pill num" style="position:absolute; left:${x}px; top:${y}px;">29.8%</div>`;

// ═══════════════════════════════════════════ 1. the table (tier 0)
w('ScrTable.dc.html', doc(CSS, SHELL(`
  ${stage('translate(150px,-46px) scale(.88)')}
  ${header('Turn 31 — your move','You rolled an 8: a wood to you, a wood to Red. Orange’s knight still holds the robber on Red’s other 8.')}
  ${seatRail('blue')}
  ${logCard()}
  ${coachLine()}
  ${dock()}
  ${winPill()}
`)));

// ═══════════════════════════════════════════ 2-5. tier one, one panel at a time
const tier1 = (name, title, sub, hd, inner, hi='') => w(name, doc(CSS, SHELL(`
  ${stage('translate(-12px,-28px) scale(.82)')}
  ${header(title, sub)}
  ${seatRail(hi)}
  ${logCard()}
  <div class="pnl cut" style="position:absolute; right:30px; top:118px; bottom:26px; width:352px; display:flex; flex-direction:column;">
    <div class="rw"><span class="hd">${hd}</span>
      <span class="cap" style="margin-left:auto; font-size:11.5px;">Esc closes</span></div>
    <div style="margin-top:12px; flex:1; min-height:0;">${inner}</div>
  </div>
`)));

tier1('ScrCoach.dc.html','Why the city','The thread stays beside the board, so you can keep clicking corners while you argue with it.','The net, on this turn', `
  <div style="display:flex; flex-direction:column; gap:8px;">
    <div class="cut8" style="background:#e9ece3; padding:9px 11px; font-size:12.5px; line-height:1.45;">Orange’s knight took the robber off your ore.</div>
    <div class="dark cut8" style="margin-left:44px; padding:9px 11px; font-size:12.5px; line-height:1.45;">Why not the settlement on the 4 wheat?</div>
    <div class="cut8" style="background:#e9ece3; padding:9px 11px; font-size:12.5px; line-height:1.45;">It is a corner you can keep, but it pays less than the city:
      <div style="margin-top:7px; display:flex; flex-direction:column; gap:3px; font-weight:600;">
        <span>33.6%&nbsp; the city</span><span>30.4%&nbsp; the settlement</span><span>28.7%&nbsp; end the turn</span></div></div>
  </div>
  <div style="margin-top:14px; display:flex; gap:6px; flex-wrap:wrap;">
    ${['What if I keep the ore?','Who is closest to winning?','Is a trade worth it?'].map(q=>`<span class="qs">${q}</span>`).join('')}
  </div>`, 'blue');

tier1('ScrRace.dc.html','Everyone is racing to ten','Four races, not four percentages. Where each seat’s points come from, and what still has to happen.','The race to ten', `
  <div style="display:flex; flex-direction:column; gap:13px;">
    ${[['red','Red','value net',6,'6 turns','A second city. It has the ore and the wheat for it.'],
       ['blue','You','',4,'8 turns','Ore. The city on the 8 wood takes you to five.'],
       ['orange','Orange','heuristic',6,'9 turns','Two more roads for the longest road award.'],
       ['grey','White','heuristic',4,'14 turns','Anything. The robber has sat on its ore since turn 24.']]
      .map(([s,n,k,vp,eta,note])=>`<div class="cut8" style="padding:10px 11px; background:${s==='blue'?'#e9ece3':'transparent'}; box-shadow: inset 0 0 0 1px var(--dust);">
        <div class="rw"><span class="sw" style="background:${SEAT[s]};"></span>
          <span style="font:600 13px var(--ui);">${n}</span>
          <span class="cap" style="font-size:11px;">${k}</span>
          <span class="d num" style="margin-left:auto; font-size:16px;">${vp}</span></div>
        <div class="pipline" style="margin-top:7px;">${Array.from({length:10},(_,i)=>`<i style="background:${i<vp?SEAT[s]:'#dde2d6'};"></i>`).join('')}</div>
        <div class="rw" style="margin-top:7px; align-items:baseline;">
          <span class="cap" style="flex:1; font-size:11.5px;">${note}</span>
          <span class="num" style="font-size:11.5px;">${eta}</span></div>
      </div>`).join('')}
  </div>`);

tier1('ScrHand.dc.html','Nine cards','What you are holding and what it buys. A seven would take four of them.','Your hand', `
  <div style="display:flex; gap:6px;">
    ${HAND.map(([r,n])=>Array.from({length:n},()=>`<span class="cut8" style="flex:1; height:78px; background:${C[r]};"></span>`).join('')).join('')}
  </div>
  <div style="display:flex; gap:6px; margin-top:6px;">
    ${HAND.map(([r,n])=>`<span class="cap" style="flex:${n}; text-align:center; font-size:11px;">${r} ${n}</span>`).join('')}
  </div>
  <div class="hd" style="margin-top:16px;">What it buys</div>
  <div style="margin-top:9px; display:flex; flex-direction:column; gap:6px;">
    ${[['City','2 wheat, 3 ore','yes',1],['Settlement','one wheat short','no',0],['Road','wood, brick','yes',1],['Development card','sheep, wheat, ore','yes',1]]
      .map(([a,cost,ok,on])=>`<div class="rw" style="padding:6px 0; border-bottom:1px solid var(--dust); ${on?'':'opacity:.5;'}">
        <span style="font:600 12.5px var(--ui); width:120px;">${a}</span>
        <span class="cap" style="flex:1; font-size:11.5px;">${cost}</span>
        <span class="num" style="font-size:11.5px;">${ok}</span></div>`).join('')}
  </div>
  <div class="cap" style="margin-top:14px; font-size:11.5px;">Trading with the bank needs four of a kind, or two at your 2:1 ore port.</div>`, 'blue');

tier1('ScrLog.dc.html','The whole game so far','Every action in order. Clicking a line opens the board at that step.','The log', `
  <div style="display:flex; flex-direction:column; gap:2px;">
    ${[['31','You','rolled an 8 and took a wood','blue'],
       ['31','Orange','bought a knight from White for two sheep','orange'],
       ['31','Orange','played it and took largest army','orange'],
       ['30','Red','built a fifth road and keeps longest road','red'],
       ['30','White','traded two wheat to the bank for an ore','grey'],
       ['30','You','built a road toward the ore 3','blue'],
       ['29','Red','rolled a 6 and took two brick','red'],
       ['29','Orange','declined your trade','orange'],
       ['28','You','rolled a 7 and moved the robber to Red’s 9','blue']]
      .map(([t,who,what,s])=>`<div class="rw" style="padding:7px 0; border-bottom:1px solid var(--dust); cursor:pointer;">
        <span class="num cap" style="width:22px; flex:0 0 22px; font-size:11px;">${t}</span>
        <span class="sw" style="width:9px; height:9px; flex:0 0 9px; background:${SEAT[s]};"></span>
        <span style="flex:1; font-size:12px; line-height:1.4;"><b style="font-weight:600;">${who}</b> ${what}</span></div>`).join('')}
  </div>`);

// ═══════════════════════════════════════════ 6. a seven (interrupt)
w('ScrSeven.dc.html', doc(CSS, SHELL(`
  ${stage('translate(150px,-34px) scale(.88)')}
  <div style="position:absolute; inset:0; background:rgba(18,33,31,.5);"></div>
  ${header('Someone rolled a seven','You have nine cards, so four of them go. The net would keep the ore and both wheat.', false)}
  <div class="pnl cut" style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:660px;">
    <div class="rw"><span class="d" style="font-size:20px;">Choose four to lose</span>
      <span class="num cap" style="margin-left:auto; font-size:12px;">4 of 4 chosen</span></div>
    <div style="display:flex; gap:7px; margin-top:14px;">
      ${['wood','wood','brick','sheep','wheat','wheat','ore','ore','ore'].map((r,i)=>
        `<span class="cut8" style="flex:1; height:74px; background:${C[r]}; ${i<4?`box-shadow: inset 0 0 0 3px ${C.pine};`:'opacity:.5;'}"></span>`).join('')}
    </div>
    <div class="rw" style="margin-top:14px; gap:9px;">
      <button class="act go">Discard these four</button>
      <button class="act">Let the net choose</button>
      <span class="cap" style="margin-left:auto; font-size:12px;">then Red moves the robber</span>
    </div>
  </div>
  <div class="cap" style="position:absolute; left:30px; bottom:26px; color:var(--chalk); opacity:.8;">The board stays visible behind, because what you keep depends on what is on it.</div>
`)));

// ═══════════════════════════════════════════ 7. handoff
w('ScrHandoff.dc.html', doc(CSS, SHELL(`
  <div class="stage"><div class="bp" style="left:50%; top:50%; transform:translate(-50%,-50%);">
    <div class="brd" style="transform:translate(150px,-34px) scale(.88); filter:blur(8px); opacity:.45;">${BOARD}</div></div></div>
  <div style="position:absolute; inset:0; background:rgba(238,240,233,.6);"></div>
  <div class="pnl cut" style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:520px;">
    <div class="rw" style="gap:11px;"><span class="sw" style="width:17px; height:17px; background:${SEAT.orange};"></span>
      <span class="d" style="font-size:23px;">Player 2, it is your turn</span></div>
    <div class="cap" style="margin-top:9px; font-size:13.5px;">The board and both hands are covered until you say you are ready. Nobody sees cards that are not theirs.</div>
    <div class="rw" style="margin-top:17px; gap:10px;">
      <button class="act go">I am Player 2 — show the board</button>
      <span class="num cap" style="margin-left:auto; font-size:12px;">turn 12 of about 80</span>
    </div>
  </div>
`)));

// ═══════════════════════════════════════════ 8. futures (tier 2)
{
  const F = [['City on the 8 wood','33.6%','+3.8',1],['Development card','31.2%','+1.4',0],
             ['Settlement, 4 wheat','30.4%','+0.6',0],['Road toward the port','29.9%','+0.1',0],
             ['Two roads, both ways','29.4%','−0.4',0],['End the turn','28.7%','−1.1',0]];
  const DICE = [[2,1,'34.9'],[3,2,'34.6'],[4,3,'35.1'],[5,4,'34.1'],[6,5,'33.8'],[7,6,'30.2'],
                [8,5,'36.0'],[9,4,'33.5'],[10,3,'34.3'],[11,2,'33.3'],[12,1,'33.1']];
  const tile = (t,v,d,sel) => `<div class="pnl cut8" style="padding:10px 11px; ${sel?`box-shadow: inset 0 0 0 2px ${C.pine};`:''}">
      <div class="rw"><span style="flex:1; font:600 12.5px var(--ui);">${t}</span>
        <span class="d num" style="font-size:15px;">${v}</span></div>
      <svg viewBox="-268 -268 536 536" width="100%" height="118" style="display:block; margin-top:7px" aria-hidden="true">
        ${TILES.map(x=>`<polygon points="${pts(hex(x.cx,x.cy,R-2.5))}" fill="${x.fill}" opacity="${sel?1:.72}"/>`).join('')}
        ${Object.keys(PIECES).map(s=>PIECES[s].roads.map(([a,b,c2,d2])=>`<line x1="${a}" y1="${b}" x2="${c2}" y2="${d2}" stroke="${SEAT[s]}" stroke-width="8" stroke-linecap="round"/>`).join('')).join('')}
        ${sel?`<circle cx="-38.1" cy="-154" r="32" fill="none" stroke="${C.wheat}" stroke-width="8"/>`:''}
      </svg>
      <div class="num" style="margin-top:6px; font-size:11.5px; color:${d.startsWith('−')?'#a34a34':'#3f7a4f'};">${d}</div>
    </div>`;
  w('ScrFutures.dc.html', doc(CSS, SHELL(`
  ${header('Choose where you want to be','Six resulting positions rather than six actions. You are picking the board you want to be looking at.', false)}
  <div class="pnl cut" style="position:absolute; left:30px; top:118px; width:296px;">
    <div class="hd">Where you are now</div>
    <svg viewBox="-268 -268 536 536" width="266" height="266" style="display:block; margin-top:9px" aria-hidden="true">
      ${TILES.map(x=>`<polygon points="${pts(hex(x.cx,x.cy,R-2.5))}" fill="${x.fill}"/>`).join('')}
      ${Object.keys(PIECES).map(s=>PIECES[s].roads.map(([a,b,c2,d2])=>`<line x1="${a}" y1="${b}" x2="${c2}" y2="${d2}" stroke="${SEAT[s]}" stroke-width="8" stroke-linecap="round"/>`).join('')).join('')}
    </svg>
    <div class="rw" style="margin-top:9px;"><span class="cap" style="font-size:12px;">You, right now</span>
      <span class="d num" style="margin-left:auto; font-size:18px;">29.8%</span></div>
  </div>
  <div class="pnl cut" style="position:absolute; left:30px; top:452px; width:296px;">
    <div class="hd">What you are holding</div>
    <div style="display:flex; gap:4px; margin-top:9px;">
      ${HAND.map(([r,n])=>Array.from({length:n},()=>`<span class="cut8" style="flex:1; height:40px; background:${C[r]};"></span>`).join('')).join('')}
    </div>
    <div class="cap" style="margin-top:9px; font-size:11.5px;">Nine cards. A seven takes four, which is why ending the turn costs you more than it looks.</div>
    <button class="act go" style="margin-top:12px; width:100%;">Take the city</button>
    <button class="act" style="margin-top:7px; width:100%;">Let the net decide</button>
  </div>
  <div style="position:absolute; left:352px; right:30px; top:118px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px;">
    ${F.map(([t,v,d,sel])=>tile(t,v,d,sel)).join('')}
  </div>
  <div class="pnl cut" style="position:absolute; left:352px; right:30px; bottom:26px;">
    <div class="rw"><span class="hd">And then the dice, if you take the city</span>
      <span class="cap" style="margin-left:auto; font-size:11.5px;">33.6% is the average of these eleven, weighted by how often each is rolled</span></div>
    <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-top:11px;">
      ${DICE.map(([n,p,v])=>{const hot=n===7; return `<div style="display:flex; flex-direction:column; align-items:center; gap:4px; width:58px;">
        <span class="num" style="font-size:11.5px; color:${hot?'#a34a34':'var(--moss)'};">${v}</span>
        <span style="width:22px; height:${16+p*6}px; background:${hot?'#c0725a':C.dust};"></span>
        <span class="num d" style="font-size:13px; color:${hot?'#a34a34':'var(--pine)'};">${n}</span>
        <span class="num cap" style="font-size:10px;">${p}/36</span></div>`;}).join('')}
    </div>
  </div>
`)));
}

// ═══════════════════════════════════════════ 9. move analysis (tier 2)
{
  const LAD = [[1,'City on the 8 wood and 3 ore','33.6%',96,1,0],[2,'Buy a development card','31.2%',82,0,0],
               [3,'Settlement, 4 wheat corner','30.4%',74,0,1],[4,'Road toward the 2:1 ore port','29.9%',68,0,0],
               [5,'Offer Red two wood for a wheat','29.5%',63,0,0],[6,'End the turn','28.7%',55,0,0]];
  w('ScrMove.dc.html', doc(CSS, SHELL(`
  ${header('One decision, both bots','Step 214. Twenty-six legal actions. Rank on the board is rank in the ladder, so the position and the list are one object read two ways.', false)}
  ${stage('translate(-286px,60px) scale(.80)')}
  <div class="pnl cut" style="position:absolute; right:30px; top:118px; width:520px; bottom:26px; display:flex; flex-direction:column;">
    <div class="rw"><span class="hd">What the net weighed</span>
      <span class="cap" style="margin-left:auto; font-size:11.5px;">two turns deep, 4 812 positions, 61 ms</span></div>
    <div style="display:flex; gap:2px; margin-top:11px;">
      ${['Value net','Heuristic','Both at once'].map((t,i)=>`<span class="cut8" style="padding:6px 12px; font:600 12px var(--ui);
        background:${i===0?'var(--pine)':'#e4e8dd'}; color:${i===0?'var(--chalk)':'var(--moss)'}; cursor:pointer;">${t}</span>`).join('')}
    </div>
    <div style="margin-top:12px;">
      ${LAD.map(([r,t,v,bw,best,heur])=>`<div class="rank" style="${heur?'background:linear-gradient(90deg, rgba(226,174,63,.18), transparent); margin:0 -15px; padding-left:15px; padding-right:15px;':''}">
        <span class="num cap" style="width:14px; flex:0 0 14px; font-size:11.5px;">${r}</span>
        <span class="nm" style="${best?'font-weight:600;':''}">${t}</span>
        <span class="tr"><i style="width:${bw}%; background:${best?C.wheat:C.dust};"></i></span>
        <span class="vl num">${v}</span>
        <span style="width:13px; font-size:12px; color:var(--moss);">${best?'✓':(heur?'◇':'')}</span></div>`).join('')}
      <div class="rank"><span style="width:14px; flex:0 0 14px;"></span>
        <span class="nm cap">twenty more, all under 28%</span>
        <span class="tr"><i style="width:44%; background:var(--dust);"></i></span>
        <span class="vl num cap">27.9%</span><span style="width:13px;"></span></div>
    </div>
    <div class="dark cut8" style="margin-top:14px;">
      <div style="font:600 12.5px var(--ui);">Where the two bots part company</div>
      <div style="margin-top:5px; font-size:12.5px; line-height:1.5; opacity:.9;">The heuristic ranks the wheat corner third from top because it counts pips. The net puts it third from bottom: the corner is only reachable after a road you cannot afford this turn.</div>
    </div>
    <div style="margin-top:auto; padding-top:12px;">
      <div class="hd">Steps either side</div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        ${[['212','Bought a card',0],['213','Drew a knight',0],['214','Deciding now',1],['215','Builds the city',0],['216','Orange rolls 7',0]]
          .map(([s,t,on])=>`<div class="cut8" style="flex:1; padding:7px 8px; background:${on?'var(--pine)':'#e4e8dd'}; color:${on?'var(--chalk)':'var(--pine)'}; cursor:pointer;">
            <div class="num" style="font-size:10.5px; opacity:.7;">${s}</div>
            <div style="font-size:11px; margin-top:2px; line-height:1.3;">${t}</div></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="pill num" style="position:absolute; left:392px; top:742px;">rank 1 — 33.6%</div>
`)));
}

// ═══════════════════════════════════════════ 10. game analysis (tier 2)
{
  const N=380, GW=880, GH=232;
  const series = [['red',1.0,.42],['blue',2.3,.35],['orange',.4,.28],['grey',3.1,.16]].map(([s,ph,amp])=>{
    let d=''; for(let i=0;i<=N;i+=3){ const t=i/N;
      const y=amp+Math.sin(t*7+ph)*.07+Math.sin(t*17+ph)*.03+(s==='red'?t*.06:0)-(s==='grey'?t*.05:0);
      d+=`${i?'L':'M'}${(t*GW).toFixed(1)},${(GH-Math.max(.04,Math.min(.72,y))*GH*1.3).toFixed(1)} `; }
    return `<path d="${d}" fill="none" stroke="${SEAT[s]}" stroke-width="${s==='red'?2.4:1.6}" opacity="${s==='red'?1:.7}"/>`;}).join('');
  const MK=[[58,'Red’s first city',0],[112,'seven — you discard four',1],[163,'Orange takes longest road',0],[201,'Red’s monopoly on ore',1]];
  const x214=214/N*GW;
  w('ScrGame.dc.html', doc(CSS, SHELL(`
  ${header('Red is 214 steps into this game','Scrub anywhere on the curve and the board follows. The marks are the moments the number moved most.', false)}
  <div class="pnl cut8" style="position:absolute; right:30px; top:24px; display:flex; align-items:center; gap:9px; padding:8px 11px;">
    ${['◀','Pause','▶'].map(b=>`<span class="cut8" style="padding:5px 11px; background:#e4e8dd; font:600 12px var(--ui); cursor:pointer;">${b}</span>`).join('')}
    <span class="num cap" style="font-size:12px;">214 of 380</span>
    <span class="cut8" style="padding:5px 11px; background:#e4e8dd; font:600 12px var(--ui); cursor:pointer;">Copy a link to this step</span>
  </div>
  <div class="pnl cut" style="position:absolute; left:30px; right:30px; top:118px;">
    <div class="rw" style="gap:16px;">
      <span class="hd">Who is winning, all game</span>
      ${[['red','41.8%'],['blue','33.2%'],['orange','27.4%'],['grey','14.1%']].map(([s,v])=>
        `<span class="rw" style="gap:6px;"><span class="sw" style="width:10px; height:10px; background:${SEAT[s]};"></span>
         <span class="num" style="font-size:12px;">${SEAT_NAME[s]} ${v}</span></span>`).join('')}
      <span class="cap" style="margin-left:auto; font-size:11.5px;">four own-perspective estimates, so they do not sum to a hundred</span>
    </div>
    <svg viewBox="0 0 ${GW} ${GH+20}" width="100%" height="${GH+20}" style="display:block; margin-top:9px" role="img" aria-label="Win chance for every seat">
      ${[0,.25,.5,.75,1].map(f=>`<line x1="0" y1="${(GH*f).toFixed(0)}" x2="${GW}" y2="${(GH*f).toFixed(0)}" stroke="${C.dust}" stroke-width="1"/>`).join('')}
      ${series}
      ${MK.map(([st,l,row])=>{const x=st/N*GW; return `<line x1="${x.toFixed(0)}" y1="${row?26:12}" x2="${x.toFixed(0)}" y2="${GH}" stroke="${C.moss}" stroke-width="1" stroke-dasharray="2 3" opacity=".55"/>
        <text x="${(x+4).toFixed(0)}" y="${row?24:10}" font-size="10.5" fill="${C.moss}" font-family="Chivo,sans-serif">${l}</text>`;}).join('')}
      <line x1="${x214.toFixed(0)}" y1="0" x2="${x214.toFixed(0)}" y2="${GH}" stroke="${C.pine}" stroke-width="1.8"/>
      <text x="0" y="${GH+15}" font-size="10.5" fill="${C.moss}" font-family="Chivo,sans-serif">0</text>
      <text x="${x214.toFixed(0)}" y="${GH+15}" font-size="10.5" fill="${C.pine}" text-anchor="middle" font-family="Chivo,sans-serif">214</text>
      <text x="${GW}" y="${GH+15}" font-size="10.5" fill="${C.moss}" text-anchor="end" font-family="Chivo,sans-serif">380</text>
    </svg>
  </div>
  <div class="pnl cut" style="position:absolute; left:30px; top:452px; bottom:26px; width:296px;">
    <div class="hd">The position at 214</div>
    <svg viewBox="-268 -268 536 536" width="266" height="266" style="display:block; margin-top:9px" aria-hidden="true">
      ${TILES.map(x=>`<polygon points="${pts(hex(x.cx,x.cy,R-2.5))}" fill="${x.fill}"/>`).join('')}
      ${[[38.1,66],[76.21,132],[114.32,66],[0,-132],[-38.1,-66],[38.1,-66]].map(([x,y])=>
        `<polygon points="${pts(hex(x,y,R-2.5))}" fill="none" stroke="${SEAT.red}" stroke-width="7" stroke-linejoin="round"/>`).join('')}
      ${Object.keys(PIECES).map(s=>PIECES[s].roads.map(([a,b,c2,d2])=>`<line x1="${a}" y1="${b}" x2="${c2}" y2="${d2}" stroke="${SEAT[s]}" stroke-width="8" stroke-linecap="round"/>`).join('')).join('')}
    </svg>
    <div class="cap" style="margin-top:8px; font-size:11.5px;">Outlined: the six tiles Red draws from.</div>
  </div>
  <div class="pnl cut" style="position:absolute; left:352px; top:452px; bottom:26px; right:426px;">
    <div class="hd">What the net is leaning on</div>
    <div class="cap" style="font-size:11.5px; margin-top:2px;">leave one group out, and see how far the number moves</div>
    <div style="margin-top:11px;">
      ${[["Red’s production",-74],["Red’s hand",-52],["Red’s cities",-44],["Orange’s roads",32],["Your production",25],["Red’s roads",-24]]
        .map(([t,v])=>`<div class="rw" style="padding:5px 0;">
          <span class="cap" style="width:126px; flex:0 0 126px; font-size:12px;">${t}</span>
          <span style="flex:1; height:8px; background:var(--dust); position:relative;">
            <i style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:#b3bbaf;"></i>
            <i style="position:absolute; ${v>0?'left:50%':'right:50%'}; top:0; height:100%; width:${Math.abs(v)*0.5}%; background:${v>0?'#7d9e63':'#c0725a'};"></i></span>
          <span class="num" style="width:34px; text-align:right; font-size:11.5px;">${v>0?'+':'−'}${(Math.abs(v)/10).toFixed(1)}</span></div>`).join('')}
    </div>
    <div class="cap" style="margin-top:10px; font-size:11.5px;">Contributions to one seat’s estimate, not shares of a whole. They do not sum to the number above.</div>
  </div>
  <div class="pnl cut" style="position:absolute; right:30px; top:452px; bottom:26px; width:382px;">
    <div class="rw"><span class="hd">Where the game turned</span><span class="cap" style="margin-left:auto; font-size:11.5px;">click to jump</span></div>
    <div style="margin-top:9px;">
      ${[['201','Red’s monopoly took six ore','+9.1'],['163','Orange took longest road','+6.8'],
         ['112','A seven, you discarded four','−6.2'],['58','Red’s first city, on the 9 brick','+5.5'],
         ['147','White traded away their last ore','−4.9']]
        .map(([s,t,v])=>`<div class="rw" style="padding:7px 0; border-bottom:1px solid var(--dust); cursor:pointer;">
          <span class="num cap" style="width:26px; flex:0 0 26px; font-size:11.5px;">${s}</span>
          <span style="flex:1; font-size:12.5px; line-height:1.4;">${t}</span>
          <span class="num" style="font-size:11.5px; color:${v.startsWith('−')?'#a34a34':'#3f7a4f'};">${v}</span></div>`).join('')}
    </div>
    <button class="act" style="margin-top:12px; width:100%;">Open step 214 in move analysis</button>
  </div>
`)));
}
console.log('screens done');
