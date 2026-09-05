// The ladder of views. Imported by flow.mjs, so `node flow.mjs` builds everything.
import { writeFileSync } from 'node:fs';
import { C, D, SEAT, SEAT_HI, SEAT_LO, SEATS, SEAT_NAME, TILES, hex, pts, pips, R,
         PIECES, ROBBER, SET, CITY, piece, road, token, TOKEN, board, doc, decode,
         glyph, ports, PORT_CENTRES, PORT_RES, RES_ORDER, portDock, lattice,
         TAPER_IN, TAPER_OUT } from './board.mjs';
const OUT = new URL('./canvas/', import.meta.url).pathname;
const write = (n,h) => { writeFileSync(OUT+n,h); console.log('wrote', n, h.length); };

// ── the implementation note every view carries, so the artboards are buildable from
const spec = rows => `<div style="margin-top:auto; padding-top:14px;">
    <div style="font:600 11px var(--ui); color:var(--moss);">FOR IMPLEMENTATION</div>
    <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">
      ${rows.map(([k,v])=>`<div style="display:flex; gap:12px; align-items:baseline;">
        <span class="cap" style="width:104px; flex:0 0 104px; font-size:11.5px;">${k}</span>
        <span style="flex:1; font:400 11.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--pine); line-height:1.5;">${v}</span></div>`).join('')}
    </div></div>`;

const SHELL = `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
     font:400 14px var(--ui); position:relative; overflow:clip;">`;

const CSS = `
    .L .stage { position:absolute; inset:0; overflow:clip; }
    .L .boardpos { position:absolute; left:50%; top:calc(50% - 8px); transform:translate(-50%,-50%); }
    .L .card { background:var(--paper); padding:16px 17px; }
    .L .sw { width:12px; height:12px; flex:0 0 12px; }
    .L .lrow { display:flex; align-items:center; gap:10px; padding:5px 0; }
    .L .lrow.alt { background:linear-gradient(90deg, rgba(226,174,63,.13), transparent); }
    .L .lname { width:186px; flex:0 0 186px; font-size:12.5px; }
    .L .ltrack { flex:1; height:7px; background:var(--dust); }
    .L .ltrack > i { display:block; height:100%; }
    .L .lval { width:44px; text-align:right; font-size:12px; }
    .L .tag { font:700 11px var(--ui); padding:3px 8px; background:#e6e9df; }
    .L .chipq { display:inline-flex; align-items:center; height:26px; padding:0 10px; background:#e4e8dd;
                font:500 12px var(--ui); cursor:pointer; }
    .L .hitme { box-shadow: inset 0 0 0 2px ${C.wheat}; }`;

// a small board, used as a diagram
const mini = (w, extra='') => `<svg viewBox="-268 -268 536 536" width="${w}" height="${w}" style="display:block" aria-hidden="true">
    ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('')}
    ${Object.keys(PIECES).map(s=>PIECES[s].roads.map(([a,b,c,d])=>
      `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${SEAT[s]}" stroke-width="7" stroke-linecap="round"/>`).join('')).join('')}
    ${extra}</svg>`;

// ═══════════════════════════════════════════════════════ 1. the ladder
{
  const TIERS = [
    ['0', 'The table', 'full size, live', 'always there', C.pine,
     'the seat rail, the coach’s one line, legal spots, the last action, the action bar',
     'scale(1) · centred'],
    ['1', 'Slide-overs', 'shifts aside, still live', 'one control, Esc closes', '#4a6659',
     'your hand, the log, the race to ten, the coach thread',
     'translate(±230px) · scale(.78)'],
    ['2', 'Deep', 'becomes an illustration', 'a deliberate act', '#a34a34',
     'futures, move analysis, game analysis',
     'translate(−270px) · scale(.55), or hidden'],
  ];
  const ENTRIES = [
    ['Hand', '1', 'clicking your own cards in the rail'],
    ['Log', '1', 'clicking the last-action line'],
    ['Race', '1', 'clicking any seat in the rail'],
    ['Coach thread', '1', 'the <b>Why</b> button on the coach line'],
    ['Futures', '2', 'the <b>Show me the others</b> button on the coach line'],
    ['Move analysis', '2', 'clicking the recommendation’s number'],
    ['Game analysis', '2', 'clicking the curve, or arriving from the ending'],
  ];
  const tierDiagram = (tier) => {
    const bw = 150, bh = 96;
    const cfg = { '0': ['50%','none',1,''], '1': ['32%','none',.8,'right'], '2': ['26%','none',.55,'right-big'] }[tier];
    const panel = tier==='0' ? '' : tier==='1'
      ? `<rect x="${bw-46}" y="4" width="42" height="${bh-8}" fill="${C.pine}" opacity=".2"/>`
      : `<rect x="${bw-72}" y="4" width="68" height="${bh-8}" fill="${C.pine}" opacity=".34"/>`;
    const s = tier==='0' ? 0.30 : tier==='1' ? 0.24 : 0.17;
    const cx = tier==='0' ? bw/2 : tier==='1' ? bw*0.34 : bw*0.26;
    return `<svg viewBox="0 0 ${bw} ${bh}" width="${bw}" height="${bh}" style="display:block" aria-hidden="true">
      <rect width="${bw}" height="${bh}" fill="var(--paper)"/>
      <g transform="translate(${cx},${bh/2}) scale(${s})">
        ${TILES.map(t=>`<polygon points="${pts(hex(t.cx,t.cy,R-2.5))}" fill="${t.fill}"/>`).join('')}</g>
      ${panel}</svg>`;
  };
  write('Ladder.dc.html', doc(CSS, `${SHELL}
  <div style="position:absolute; inset:28px 34px;">
    <div style="display:flex; gap:40px; align-items:flex-start;">
      <div class="d" style="font-size:29px; line-height:1.1; width:300px; flex:0 0 300px;">Three depths, one board</div>
      <div class="cap" style="flex:1; min-width:0; font-size:14.5px; column-count:2; column-gap:40px;">
        The views are not five or six ways to play. They are angles on one game, and what separates them is how far they take you from playing it. A tier is a promise: at tier one you can still click the board, at tier two you have stopped playing and started reading. That is why tier two is never one careless click away.
      </div>
    </div>

    <div style="margin-top:26px; display:flex; flex-direction:column; gap:12px;">
      ${TIERS.map(([n,name,boardState,cost,col,holds,tf])=>`
      <div class="card" style="display:flex; gap:22px; align-items:center; padding:14px 16px;">
        <div style="width:34px; flex:0 0 34px;"><div class="d" style="font-size:26px; color:${col};">${n}</div></div>
        <div style="width:150px; flex:0 0 150px;">
          <div style="font:600 14px var(--ui);">${name}</div>
          <div class="cap" style="font-size:12px; margin-top:2px;">${cost}</div>
        </div>
        ${tierDiagram(n)}
        <div style="width:190px; flex:0 0 190px;">
          <div class="cap" style="font-size:12px;">the board</div>
          <div style="font:500 12.5px var(--ui); margin-top:2px;">${boardState}</div>
          <div style="font:400 11px ui-monospace,Menlo,monospace; color:var(--moss); margin-top:4px;">${tf}</div>
        </div>
        <div style="flex:1; min-width:0;">
          <div class="cap" style="font-size:12px;">what lives here</div>
          <div style="font-size:13px; margin-top:2px; line-height:1.45;">${holds}</div>
        </div>
      </div>`).join('')}
    </div>

    <div style="margin-top:26px; display:flex; gap:40px; align-items:flex-start;">
      <div style="flex:1;">
        <div style="font:600 13px var(--ui);">How each one opens</div>
        <div class="cap" style="margin-top:6px; font-size:12.5px;">Only two of the seven are a button. The rest are the thing itself being clickable, which is what stops the interface growing a toolbar it does not need.</div>
        <div style="margin-top:12px; display:flex; flex-direction:column; gap:1px;">
          ${ENTRIES.map(([v,t,how])=>`<div style="display:flex; gap:12px; align-items:baseline; padding:6px 0; border-top:1px solid var(--dust);">
            <span style="width:118px; flex:0 0 118px; font:600 12.5px var(--ui);">${v}</span>
            <span class="tag" style="background:${t==='1'?'#e2e9e0':'#f0ddd6'};">tier ${t}</span>
            <span class="cap" style="flex:1; font-size:12.5px;">${how}</span></div>`).join('')}
        </div>
      </div>
      <div style="width:400px; flex:0 0 400px;">
        <div style="font:600 13px var(--ui);">The rules that keep it honest</div>
        <div class="cap" style="margin-top:8px;">One tier-one panel at a time. Opening a second replaces the first rather than stacking, so the board never ends up boxed in on three sides.</div>
        <div class="cap" style="margin-top:9px;">Esc always goes up one tier, never straight out. From move analysis it returns you to the table, not to the lineup.</div>
        <div class="cap" style="margin-top:9px;">Tier two survives a reload and is linkable, because it is where you are when you send someone a position. Tier one is not; it is a glance, not a place.</div>
        <div class="cap" style="margin-top:9px;">Nothing at tier two can be reached while it is your turn and the clock is the only thing waiting. The game does not hurry, but the interface should not invite you to leave the table by accident.</div>
        ${spec([
          ['tier 1 panels','one at a time; <span style="color:#a34a34">Esc</span> pops one tier'],
          ['tier 2 routes','pushed to history, deep-linkable'],
          ['board element','one instance, transform only, never remounted'],
          ['reduced motion','tier changes still happen, travel does not'],
        ])}
      </div>
    </div>
  </div>
</div>`));
}

// ═══════════════════════════════════════════════════════ 2. tier one panels
{
  const HAND = [['wood',2],['brick',1],['sheep',1],['wheat',2],['ore',3]];
  const LOG = [
    'You rolled an 8 and took a wood.',
    'Orange bought a knight from White for two sheep.',
    'Orange played it and took largest army; the robber came off your ore.',
    'Red built a fifth road and keeps longest road.',
    'White traded two wheat to the bank for an ore.',
  ];
  const RACE = [['red','Red','value net',6,'6 turns'],['blue','You','',4,'8 turns'],
                ['orange','Orange','heuristic',6,'9 turns'],['grey','White','heuristic',4,'14 turns']];

  const panelFrame = (title, entry, inner, w=316) => `<div style="width:${w}px; flex:0 0 ${w}px;">
      <div style="display:flex; align-items:baseline; gap:9px;">
        <span style="font:600 13px var(--ui);">${title}</span>
        <span class="cap" style="font-size:11.5px;">opens from ${entry}</span>
      </div>
      <div class="card" style="margin-top:8px; height:330px; overflow:hidden;">${inner}</div>
    </div>`;

  const handPanel = `<div style="font:600 12px var(--ui);">Nine cards</div>
    <div class="cap" style="font-size:12px; margin-top:3px;">A seven takes four of them.</div>
    <div style="display:flex; gap:6px; margin-top:12px;">
      ${HAND.map(([r,n])=>`<div style="flex:1;"><div style="height:62px; background:${C[r]};"></div>
        <div class="cap" style="font-size:11px; text-align:center; margin-top:4px;">${n}</div></div>`).join('')}
    </div>
    <div style="margin-top:14px; font:600 12px var(--ui);">What you can afford</div>
    <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">
      ${[['City','yes'],['Settlement','no, one wheat short'],['Road','yes'],['Development card','yes']].map(([a,b])=>
        `<div style="display:flex; justify-content:space-between; font-size:12.5px;">
          <span>${a}</span><span class="cap" style="font-size:12px;">${b}</span></div>`).join('')}
    </div>`;

  const logPanel = `<div style="font:600 12px var(--ui);">This turn</div>
    <div style="margin-top:10px; display:flex; flex-direction:column; gap:9px;">
      ${LOG.map(l=>`<div style="display:flex; gap:9px;"><span style="width:5px; height:5px; margin-top:6px; flex:0 0 5px; background:var(--dust);"></span>
        <span style="font-size:12.5px; line-height:1.45;">${l}</span></div>`).join('')}
    </div>
    <div class="cap" style="margin-top:12px; font-size:11.5px;">Scroll for the whole game. Clicking a line opens the board at that step.</div>`;

  const racePanel = `<div style="font:600 12px var(--ui);">The race to ten</div>
    <div style="margin-top:11px; display:flex; flex-direction:column; gap:11px;">
      ${RACE.map(([s,n,kind,vp,eta])=>`<div>
        <div style="display:flex; align-items:baseline; gap:8px;">
          <span class="sw" style="background:${SEAT[s]}"></span>
          <span style="font:600 12.5px var(--ui);">${n}</span>
          <span class="cap" style="font-size:11px;">${kind}</span>
          <span class="cap" style="margin-left:auto; font-size:11.5px;">${eta}</span></div>
        <div style="display:flex; gap:2px; margin-top:4px;">
          ${Array.from({length:10},(_,i)=>`<i style="flex:1; height:5px; background:${i<vp?SEAT[s]:'#dde2d6'};"></i>`).join('')}</div>
      </div>`).join('')}
    </div>
    <div class="cap" style="margin-top:12px; font-size:11.5px;">Points you can see. The card nobody else knows about is the tenth slot on your own row only.</div>`;

  const coachPanel = `<div style="font:600 12px var(--ui);">Earlier this turn</div>
    <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
      <div style="background:#e9ece3; padding:8px 10px; font-size:12.5px; line-height:1.45;">Orange’s knight took the robber off your ore.</div>
      <div style="background:var(--pine); color:var(--chalk); padding:8px 10px; font-size:12.5px; line-height:1.45; margin-left:36px;">Why not the settlement on the 4 wheat?</div>
      <div style="background:#e9ece3; padding:8px 10px; font-size:12.5px; line-height:1.45;">It is a corner you can keep, but it pays less than the city does:
        <span style="display:block; margin-top:5px; font-weight:600;">33.6% city · 30.4% settlement · 28.7% end the turn</span></div>
    </div>
    <div style="margin-top:12px; display:flex; gap:6px; flex-wrap:wrap;">
      ${['What if I keep the ore?','Who is closest to winning?'].map(q=>`<span class="chipq">${q}</span>`).join('')}
    </div>`;

  write('Panels.dc.html', doc(CSS, `${SHELL}
  <div style="position:absolute; inset:28px 34px;">
    <div style="display:flex; gap:40px; align-items:flex-start;">
      <div style="width:300px; flex:0 0 300px;">
        <div class="d" style="font-size:29px; line-height:1.1;">Tier one: the board slides over</div>
        <span class="tag" style="margin-top:10px; display:inline-block; background:#e2e9e0;">tier 1</span>
      </div>
      <div class="cap" style="flex:1; min-width:0; font-size:14.5px; column-count:2; column-gap:40px;">
        Four panels that answer a question without taking the game away. The board shifts aside and stays live: you can still click a corner with one of these open, and Esc closes it. None of them is a place you navigate to, which is why none of them is in a menu — each opens from the thing it is about.
      </div>
    </div>
    <div style="display:flex; gap:20px; margin-top:26px;">
      ${panelFrame('Hand', 'your cards in the rail', handPanel)}
      ${panelFrame('Log', 'the last-action line', logPanel)}
      ${panelFrame('Race', 'any seat in the rail', racePanel)}
      ${panelFrame('Coach thread', 'the Why button', coachPanel)}
    </div>
    <div style="display:flex; gap:40px; margin-top:24px; align-items:flex-start;">
      <div style="flex:1;">
        <div style="font:600 13px var(--ui);">One geometry for all four</div>
        <div class="cap" style="margin-top:7px;">Every tier-one panel is 316 wide and docks to the same edge, so opening a second one swaps the contents rather than moving the board again. The board takes a single 420ms shift on the first open and holds still until the last one closes; the panel itself moves in 260ms.</div>
        <div class="cap" style="margin-top:9px;">Hand and Race dock left, beside the rail they came from. Log and Coach dock right, because they are a running column rather than a snapshot. The board goes the other way in each case.</div>
      </div>
      <div style="width:452px; flex:0 0 452px; display:flex; flex-direction:column;">
        ${spec([
          ['dock','316px, edge-anchored, 26px inset'],
          ['board','translate(±230px,0) scale(.78) · 420ms'],
          ['hand','view.hands[me] — counts by resource'],
          ['log','frames[].action, newest first'],
          ['race','view.points[seat], view.awards'],
          ['coach','decision.root[0] plus its rank list'],
          ['close','Esc, or the control that opened it'],
        ])}
      </div>
    </div>
  </div>
</div>`));
}

