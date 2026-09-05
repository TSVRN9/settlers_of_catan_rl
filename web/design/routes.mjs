// Getting around: how you reach the six views, and what moves when you do.
//
// Two kinds of artboard here.
//
//   Frames  are the real views. Each one is a `View*.dc.html` file with its spine rewritten,
//           a few override rules appended, and sometimes an overlay dropped on top. They
//           depict one moment of a transition. The resting states are not duplicated here:
//           the views themselves are the resting states, on the next page.
//   Boards  state the model — the doors, the routing, the travel table, the input map.
//
// Board rects come from `measured.json`, read out of the browser once so the numbers in
// the travel table are the ones the screens actually draw.
import { readFileSync, writeFileSync } from 'node:fs';
import { C, SEAT, SEAT_DOT, board, doc, spine, decode, TILES, hex, pts, R } from './board.mjs';

const DIR = new URL('./canvas/', import.meta.url).pathname;
const M = JSON.parse(readFileSync(new URL('./measured.json', import.meta.url).pathname, 'utf8'));
const write = (n, h) => { writeFileSync(DIR + n, h); console.log(`${n.padEnd(16)} ${(h.length/1024).toFixed(0)}K`); };

// ── frames, built out of the views themselves ────────────────────────────────────────
const GLY = '▓▒░▚▞█▌▐▖▗▘▝';
const scram = t => [...t].map((ch,i)=> /[\s.%]/.test(ch) ? ch : GLY[(i*7+ch.charCodeAt(0))%GLY.length]).join('');

function frame(src, { path, warn, seat='blue', loud=false, step='', css='', overlay='', swap=[] }) {
  let s = readFileSync(DIR + src + '.dc.html', 'utf8');
  const a = s.indexOf('<div class="spine">'), b = s.indexOf('</div>', a) + 6;
  s = s.slice(0, a) + spine(path, warn, seat, loud, step) + s.slice(b);
  for (const [from, to] of swap) s = s.split(from).join(to);
  if (css) s = s.replace('</style>', css + '</style>');
  if (overlay) {
    const i = s.lastIndexOf('</div>');            // just inside the .L root
    s = s.slice(0, i) + overlay + s.slice(i);
    s = s.replace(/(<div class="L" style="[^"]*)/, '$1 position:relative;');
  }
  return s;
}

const OVER = inner => `<div style="position:absolute; inset:0; pointer-events:none;">${inner}</div>`;

// A caption is an annotation printed over a frame, not part of it, so it carries its own
// ground and can sit anywhere without colliding with what the screen already draws.
const note = (pos, text, w = 300) => `<div style="position:absolute; ${pos} width:${w}px;
  background:var(--chalk); padding:11px 13px; font:400 13px var(--ui); color:var(--moss); line-height:1.5;
  clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px);">${text}</div>`;
const scrim = o => `<div style="position:absolute; inset:0; background:rgba(18,33,31,${o});"></div>`;

// a ghost of the board, mid-flight: tiles only, so it reads as a copy in motion
const ghost = (w, x, y, op) => `<div style="position:absolute; left:${x}px; top:${y}px;
  transform:translate(-50%,-50%); opacity:${op};">${board({ w, grid:false, showPorts:false, glyphs:false })}</div>`;

// ═══════════════════════════════════════════ A. the table divides into futures
{
  const T = M.ViewTable.boards[0], F = M.ViewFutures.boards;

  // A1 — the door, pressed. 0ms.
  write('FrA1.dc.html', frame('ViewTable', {
    path: ['Table'], warn: 'your turn', step: 'turn 31',
    css: `
    .L .press { background:var(--pine) !important; color:var(--chalk) !important; }
    .L .presshalo { outline:2px solid ${C.wheat}; outline-offset:3px; }`,
    swap: [['<span class="act cut8">Every legal move</span>',
            '<span class="act cut8 press presshalo">Every legal move</span>']],
    overlay: OVER(`${note('left:26px; top:166px;', `<b style="color:var(--pine); font-weight:600;">0ms.</b> The door is inside
        the recommendation, where the question was already being asked. Nothing has moved yet.`, 262)}`),
  }));

  // A2 — the board dividing. 140ms. Drawn on the screen it is arriving at, faint underneath,
  // because the boards are travelling toward slots that belong to Futures, not to the table.
  const arcs = F.slice(1).map(f =>
    `<path d="M${T.cx} ${T.cy} Q ${(T.cx+f.cx)/2} ${(T.cy+f.cy)/2 - 90} ${f.cx} ${f.cy}"
       fill="none" stroke="${C.moss}" stroke-width="1.3" stroke-dasharray="5 6" opacity=".6"/>`).join('');
  // the easing is cubic-bezier(.2,.8,.2,1), so a third of the way through a 420ms move is
  // already about three quarters of the distance — the six are nearly home at 140ms
  const ghosts = F.slice(1).map((f, i) => {
    const t = 0.74 + i * 0.015;
    return ghost(Math.round(T.w + t * (f.w - T.w)), T.cx + t * (f.cx - T.cx), T.cy + t * (f.cy - T.cy), 0.62);
  }).join('');
  write('FrA2.dc.html', frame('ViewFutures', {
    path: ['Table', 'Futures'], warn: 'your turn', step: 'turn 31',
    css: `
    .L > div:nth-child(2) { opacity:.1; }`,
    overlay: OVER(`${ghost(T.w, T.cx, T.cy, .3)}${ghosts}
      <svg viewBox="0 0 1440 900" width="1440" height="900" style="position:absolute; inset:0;" aria-hidden="true">${arcs}</svg>
      ${note('left:14px; top:552px;', `<b style="color:var(--pine); font-weight:600;">140ms.</b> A hypothetical
        divides the board. Six copies pull out of the live one, which fades where it stood — the only transition
        in the app where the board becomes more than one thing, and the reason a future does not feel like a
        page. The screen they land on is still arriving underneath them.`, 268)}`),
  }));

  // A3 — landed, and the reading arriving. 420ms.
  const nums = ['33.6%','31.2%','30.4%','29.9%','29.4%','28.7%','+3.8','+1.4','+0.6','+0.1','−0.4','−1.1'];
  write('FrA3.dc.html', frame('ViewFutures', {
    path: ['Table', 'Futures'], warn: 'your turn', step: 'turn 31',
    css: `
    .L p, .L aside { opacity:.3; }
    .L section .cut > .row + span { opacity:1; }
    .L .scrmb { color:var(--moss); }`,
    swap: nums.map(n => [`>${n}<`, `><span class="scrmb">${scram(n)}</span><`]),
    overlay: OVER(`${note('left:14px; top:566px;', `<b style="color:var(--pine); font-weight:600;">420ms.</b> The six have
        landed. The boards arrive first because they were already drawn; the readings resolve after, digit by
        digit, because they are being computed. Prose just fades in — only the numbers decode.`, 268)}`),
  }));

  // A4 — the return, which is not the same gesture as backing out.
  const chosen = F[1], t = 0.45;
  write('FrA4.dc.html', frame('ViewFutures', {
    path: ['Table'], warn: 'your turn', step: 'turn 31',
    css: `
    .L section { opacity:.16; }
    .L aside { opacity:.4; }`,
    overlay: OVER(`${ghost(Math.round(chosen.w + t*(T.w-chosen.w)), chosen.cx + t*(T.cx-chosen.cx), chosen.cy + t*(T.cy-chosen.cy), .92)}
      <svg viewBox="0 0 1440 900" width="1440" height="900" style="position:absolute; inset:0;" aria-hidden="true">
        <path d="M${chosen.cx} ${chosen.cy} Q ${(chosen.cx+T.cx)/2} ${(chosen.cy+T.cy)/2 - 70} ${T.cx} ${T.cy}"
          fill="none" stroke="${C.pine}" stroke-width="1.4" stroke-dasharray="5 6" opacity=".45"/>
      </svg>
      ${note('left:14px; top:552px;', `<b style="color:var(--pine); font-weight:600;">Play the city.</b> The five
        you did not take fade where they stand; the one you did grows back into the live board and the city is
        built as it lands. Backing out does the opposite — the six shrink into one and nothing is built.`, 268)}`),
  }));
}

// ═══════════════════════════════════════════ B. reviewing a game that is still running
{
  const T = M.ViewTable.boards[0], G = M.ViewGame.boards[0], V = M.ViewMove.boards[0];
  const at = (t, a, b) => a + t * (b - a);

  // B1 — the board travelling from the table to the game curve, and the curve drawing.
  {
    const t = 0.72;
    write('FrB1.dc.html', frame('ViewGame', {
      path: ['Table', 'Step 214'], warn: 'your turn',
      css: `
    .L > div:nth-child(2) { opacity:.12; }`,
      overlay: OVER(`${ghost(Math.round(at(t, T.w, G.w)), at(t, T.cx, G.cx), at(t, T.cy, G.cy), .75)}
        <svg viewBox="0 0 1440 900" width="1440" height="900" style="position:absolute; inset:0;" aria-hidden="true">
          <path d="M${T.cx} ${T.cy} Q ${(T.cx+G.cx)/2 - 40} ${(T.cy+G.cy)/2} ${G.cx} ${G.cy}"
            fill="none" stroke="${C.moss}" stroke-width="1.3" stroke-dasharray="5 6" opacity=".6"/>
          <rect x="828" y="118" width="586" height="196" fill="${C.paper}" opacity=".72"/>
          <line x1="826" y1="118" x2="826" y2="314" stroke="${C.wheat}" stroke-width="2"/>
        </svg>
        ${note('right:26px; top:340px;', `<b style="color:var(--pine); font-weight:600;">A view moves the board.</b>
          574 to 406, one travel of 420ms, and the pieces on it do not move at all — you are looking at the same
          position from further away. The curve draws left to right underneath, because it is being read out of
          frames the worker already has.`, 352)}`),
    }));
  }

  // B2 — a click on the curve becomes a decision: the board grows to its largest.
  {
    const t = 0.7;
    write('FrB2.dc.html', frame('ViewMove', {
      path: ['Table', 'Step 214', "Red's move"], warn: 'your turn',
      css: `
    .L > div:nth-child(2) { opacity:.14; }`,
      overlay: OVER(`${ghost(Math.round(at(t, G.w, V.w)), at(t, G.cx, V.cx), at(t, G.cy, V.cy), .8)}
        <svg viewBox="0 0 1440 900" width="1440" height="900" style="position:absolute; inset:0;" aria-hidden="true">
          <path d="M${G.cx} ${G.cy} Q ${(G.cx+V.cx)/2 + 30} ${(G.cy+V.cy)/2 - 60} ${V.cx} ${V.cy}"
            fill="none" stroke="${C.moss}" stroke-width="1.3" stroke-dasharray="5 6" opacity=".6"/>
        </svg>
        ${note('right:26px; top:120px;', `<b style="color:var(--pine); font-weight:600;">A point on the curve is a
          decision.</b> The board grows to 628, the largest it is drawn anywhere, because this is the one screen
          where the board is the evidence rather than the game. The spine has grown a third crumb, and the game
          is still running behind all of it.`, 352)}`),
    }));
  }

  // B3 — Esc, twice: back to your own turn, along the way it came.
  write('FrB3.dc.html', frame('ViewTable', {
    path: ['Table'], warn: 'your turn', step: 'turn 31',
    css: `
    .L svg[viewBox="-236.72 -244.2 511.56 488.4"] { opacity:.9; }`,
    overlay: OVER(`<svg viewBox="0 0 1440 900" width="1440" height="900" style="position:absolute; inset:0;" aria-hidden="true">
        <path d="M${V.cx} ${V.cy} Q ${(V.cx+T.cx)/2} ${(V.cy+T.cy)/2 + 60} ${T.cx} ${T.cy}"
          fill="none" stroke="${C.dust}" stroke-width="1.3" stroke-dasharray="5 6"/>
      </svg>
      ${note('left:26px; top:166px;', `<b style="color:var(--pine); font-weight:600;">Esc, twice.</b> Each press
        pops one crumb and the board travels back the way it came — 628, then 406, then 574. Nothing was rebuilt
        on the way out or the way back, because nothing was ever unmounted.`, 262)}`),
  }));
}

// ═══════════════════════════════════════════ C. the game reaches you where you are
{
  write('FrC1.dc.html', frame('ViewGame', {
    path: ['Table', 'Step 214'], warn: 'Red offers you two wood', seat: 'red', loud: true,
    overlay: OVER(`${note('right:26px; top:340px;', `<b style="color:var(--pine); font-weight:600;">Nothing else moves.</b> You
        are two views from the table and a seat has just offered you a trade. The whole of the interruption is
        one word changing colour in the spine — no dialog over the analysis, no jump. That is what the right-hand
        half is for, and why being deep in a view is safe while a game runs.`, 352)}`),
  }));

  // a chalk panel behind it, so the recommendation it covers does not leave orphan lines
  const offer = `<div style="position:absolute; right:20px; top:104px; width:350px; height:326px; background:var(--chalk);"></div>
    <div style="position:absolute; right:34px; top:120px; width:322px; background:var(--paper); padding:15px 16px;
      clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);">
      <div style="display:flex; align-items:center; gap:9px;">
        <span style="width:13px; height:13px; background:${SEAT.red};"></span>
        <span style="font:600 13.5px var(--ui);">Red offers</span>
        <span style="margin-left:auto; font:400 12px var(--ui); color:var(--moss);">turn 31</span>
      </div>
      <div style="display:flex; align-items:center; gap:12px; margin-top:13px;">
        <span style="display:flex; gap:5px;">
          <span style="width:34px; height:46px; background:${C.wood};"></span>
          <span style="width:34px; height:46px; background:${C.wood};"></span></span>
        <span style="font:400 19px var(--dis); color:var(--moss);">for</span>
        <span style="display:flex; gap:5px;"><span style="width:34px; height:46px; background:${C.ore};"></span></span>
      </div>
      <div style="margin-top:12px; font:400 12.5px var(--ui); color:var(--moss); line-height:1.5;">
        The net reads it at <b style="color:var(--pine);">29.1%</b> against 29.8% for declining. It wants the ore
        more than Red is admitting.</div>
      <div style="display:flex; gap:8px; margin-top:13px;">
        <span class="act cut8" style="height:34px; font-size:12.5px;">Accept</span>
        <span class="act go cut8" style="height:34px; font-size:12.5px;">Decline</span>
        <span style="margin-left:auto; align-self:center; font:400 12px var(--ui); color:var(--moss);">Esc returns you</span>
      </div>
    </div>`;

  write('FrC2.dc.html', frame('ViewTable', {
    path: ['Step 214', 'Table'], warn: 'Red is waiting', seat: 'red', loud: true, step: 'turn 31',
    overlay: OVER(offer + `${note('left:26px; top:166px;', `<b style="color:var(--pine); font-weight:600;">Pressing it brings you
        back.</b> The offer opens on the table, where the board it depends on is. The crumb you left is still on
        the spine, so the analysis is one press away once the trade is answered — the path bends rather than
        resetting.`, 262)}`),
  }));
}

// ═══════════════════════════════════════════ the doors, on the screen that carries them
// Holding ? dims the screen and names every door on it. It is one keypress, it teaches the
// whole interface in one look, and it exists because a screen with no menu has to be able
// to answer "what can I do here?" out loud.
{
  const DOORS = [
    [1222, 252, 105, 34, '1', 'Move analysis', 'the recommendation’s own number', 'new'],
    [1120, 410, 135, 38, '2', 'Futures',       '“Every legal move”', 'have'],
    [1120, 460, 62,  32, '3', 'Coach',         '“Why”', 'new'],
    [ 79,    5,  65, 17, '4', 'Game analysis', 'the turn on the spine', 'new'],
    [ 862, 316,  118, 30, '5', 'Console',      'any seat’s reading on the ring', 'have'],
    [  40, 780, 310, 100,'6', 'Console',       'your own hand', 'have'],
    [ 470, 292, 376, 376,'7', 'the board itself', 'lit corners build, lit edges lay road', 'have'],
  ];
  const marker = ([x, y, w, h, n, , , kind]) => {
    const below = y < 40;                       // the spine's own marker has no room above it
    return `
    <div style="position:absolute; left:${x - 6}px; top:${y - 6}px; width:${w + 12}px; height:${h + 12}px;
       box-shadow: inset 0 0 0 1.5px ${kind === 'new' ? C.wheat : C.chalk}; ${n === '7' ? 'border-radius:50%;' : ''}"></div>
    <div style="position:absolute; left:${x - 6}px; top:${below ? y + h + 9 : y - 26}px; height:19px; padding:0 7px;
       display:flex; align-items:center; background:${kind === 'new' ? C.wheat : C.chalk};
       color:${C.pine}; font:700 11.5px var(--ui);">${n}</div>`;
  };

  // door 3 does not exist on the screen yet, so it is drawn as the button it will be
  const whyButton = `<div style="position:absolute; left:1120px; top:460px; height:32px; padding:0 13px;
      display:flex; align-items:center; background:${C.wheat}; color:${C.pine}; font:600 12.5px var(--ui);
      clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);">Why</div>`;

  const list = DOORS.map(([, , , , n, opens, how, kind]) => `
    <div style="display:flex; gap:11px; align-items:baseline; padding:8px 0; border-top:1px solid rgba(238,240,233,.22);">
      <span style="width:19px; flex:0 0 19px; height:19px; display:flex; align-items:center; justify-content:center;
        background:${kind === 'new' ? C.wheat : C.chalk}; color:${C.pine}; font:700 11.5px var(--ui);">${n}</span>
      <span style="flex:1;">
        <span style="display:block; font:600 13px var(--ui); color:${C.chalk};">${opens}</span>
        <span style="display:block; font:400 12px var(--ui); color:rgba(238,240,233,.62); margin-top:2px;">${how}</span>
      </span>
      ${kind === 'new' ? `<span style="font:700 10px var(--ui); color:${C.wheat};">NEW</span>` : ''}
    </div>`).join('');

  write('Doors.dc.html', frame('ViewTable', {
    path: ['Table'], warn: 'your turn', step: 'turn 31',
    overlay: scrim('.72') + OVER(`${whyButton}${DOORS.map(marker).join('')}
      <div style="position:absolute; left:14px; top:60px; width:324px; padding:14px 16px 18px;
         background:rgba(18,33,31,.88);
         clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);">
        <div style="font:700 11px var(--ui); color:${C.wheat}; letter-spacing:.04em;">HOLDING ?</div>
        <div style="margin-top:7px; font:400 13px var(--ui); color:rgba(238,240,233,.78); line-height:1.5;">
          Every door on this screen, and what it opens. Four of the seven are the thing itself being clickable
          rather than a control added for the purpose, which is what keeps this screen from growing a toolbar.
          Three are new.</div>
        <div style="margin-top:14px;">${list}</div>
        <div style="margin-top:16px; font:400 12px var(--ui); color:rgba(238,240,233,.55); line-height:1.5;">
          Every other view answers the same key with its own list. Nothing here is a place you could not have
          found by pointing at what you were already looking at.</div>
      </div>`),
  }));
}

// ═══════════════════════════════════════════ boards that state the model
const SHELL = inner => `<div class="L" style="width:1440px; height:900px; background:var(--chalk); color:var(--pine);
   font:400 14px var(--ui); position:relative; overflow:clip;">${inner}</div>`;
const CSS = `
    .L .card { background:var(--paper); padding:16px 17px; }
    .L .hd { font:600 12.5px var(--ui); }
    .L .k { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px;
            padding:0 7px; background:var(--paper); color:var(--pine); font:600 12px var(--ui);
            box-shadow: inset 0 -2px 0 var(--dust); }
    .L .mono { font:400 11.5px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .L .verdict { display:inline-block; font:700 10.5px var(--ui); padding:4px 8px; letter-spacing:.03em; }
    .L table { border-collapse:collapse; width:100%; }
    .L th { text-align:left; font:600 11px var(--ui); color:var(--moss); padding:0 0 7px; }
    .L td { padding:8px 0; border-top:1px solid var(--dust); font-size:12.5px; vertical-align:top; }`;

// ── 1. three ways this could have been routed ────────────────────────────────────────
{
  const mini = (kind) => {
    const f = { chalk:C.chalk, paper:C.paper, pine:C.pine, dust:C.dust, moss:C.moss };
    const screen = (x,y,w,h,extra='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f.paper}" stroke="${f.dust}"/>${extra}`;
    if (kind === 'point') return `<svg viewBox="0 0 300 150" width="300" height="150" aria-hidden="true">
      ${screen(0,0,300,150)}
      <g transform="translate(150,78)">${TILES.slice(0,7).map(t=>`<polygon points="${pts(hex(t.cx*0.19,t.cy*0.19,R*0.19))}" fill="${t.fill}"/>`).join('')}</g>
      <circle cx="150" cy="60" r="13" fill="none" stroke="${C.wheat}" stroke-width="2"/>
      <path d="M150 47 L150 24" stroke="${f.moss}" stroke-width="1.2" stroke-dasharray="3 3"/>
      <text x="150" y="18" text-anchor="middle" font-size="10" fill="${f.moss}" font-family="Chivo,Arial">the thing answers</text></svg>`;
    if (kind === 'spine') return `<svg viewBox="0 0 300 150" width="300" height="150" aria-hidden="true">
      ${screen(0,0,300,150)}
      <rect x="0" y="0" width="300" height="17" fill="${f.chalk}"/><line x1="0" y1="17" x2="300" y2="17" stroke="${f.dust}"/>
      <text x="9" y="12" font-size="9" fill="${f.moss}" font-family="Chivo,Arial">Table</text>
      <text x="38" y="12" font-size="9" fill="${f.dust}" font-family="Chivo,Arial">›</text>
      <text x="47" y="12" font-size="9" font-weight="700" fill="${f.pine}" font-family="Chivo,Arial">Futures</text>
      <circle cx="258" cy="8.5" r="3" fill="${SEAT.blue}"/>
      <text x="266" y="12" font-size="9" fill="${f.pine}" font-family="Chivo,Arial">turn</text>
      <g transform="translate(150,88)">${TILES.slice(0,7).map(t=>`<polygon points="${pts(hex(t.cx*0.19,t.cy*0.19,R*0.19))}" fill="${t.fill}"/>`).join('')}</g></svg>`;
    return `<svg viewBox="0 0 300 150" width="300" height="150" aria-hidden="true">
      ${screen(0,0,300,150)}
      ${[0,1,2].map(i=>`<g transform="translate(${58+i*96},78) scale(${1-i*0.3})">
        ${TILES.slice(0,7).map(t=>`<polygon points="${pts(hex(t.cx*0.19,t.cy*0.19,R*0.19))}" fill="${t.fill}" opacity="${1-i*0.28}"/>`).join('')}</g>`).join('')}
      <path d="M20 132 L280 132" stroke="${f.moss}" stroke-width="1.2" marker-end="url(#zr)"/>
      <defs><marker id="zr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="${f.moss}"/></marker></defs>
      <text x="20" y="126" font-size="9" fill="${f.moss}" font-family="Chivo,Arial">this turn</text>
      <text x="238" y="126" font-size="9" fill="${f.moss}" font-family="Chivo,Arial">whole game</text></svg>`;
  };

  const MODELS = [
    ['point', 'Point at it',
     'Nothing is a menu. Every view opens from the object it is about, and there is no chrome at all — you ask a question of a corner, a seat, a number.',
     'Click the corner, then the step you want inside what opens.',
     ['Nothing to learn if you already know what you want.', 'Nothing on screen you did not ask for.'],
     ['A first game has no idea any of it is there.', 'The way back is whatever you remember pressing.'],
     'not on its own', '#e8ded4'],
    ['spine', 'A spine of places',
     'The doors stay in the content, exactly as above, and one line at the top says where you are, how you got there, and what the game wants. Everything else is contextual.',
     'Click the number, and the crumb behind you is the way back.',
     ['Discoverable without a toolbar: the path teaches the shape.', 'An interrupt has somewhere to appear from any depth.', '28px, and it never grows.'],
     ['One permanent line is one line of chrome.'],
     'this is the one', '#dfe9e0'],
    ['zoom', 'One continuous zoom',
     'Scope becomes a single axis. Zoom out from your turn to the whole game; zoom into a turn to read a decision. Navigation stops existing — there is only how far out you are standing.',
     'Zoom out until the game is a strip, then zoom into step 214.',
     ['Beautiful, and honest about what these views are: distances.', 'One gesture instead of seven doors.'],
     ['Needs new chrome on every view to say where the zoom is.', 'Coach and Console are not distances, so they fall outside it.', 'Reopens the character the replication just restored.'],
     'shelved, worth returning to', '#e8ded4'],
  ];

  write('Routes.dc.html', doc(CSS, SHELL(`
    <div style="position:absolute; inset:30px 34px;">
      <div style="display:flex; gap:40px; align-items:flex-start;">
        <div style="width:300px; flex:0 0 300px;">
          <div class="d" style="font-size:23px; line-height:1.15;">Three ways this could<br>have been routed</div>
        </div>
        <div class="cap" style="flex:1; min-width:0; font-size:14px; column-count:2; column-gap:40px;">
          The six views are angles on one game, so the question is not which page you are on but how far you have
          walked from playing it. A tab bar answers that badly: it makes six peers out of things that are not
          peers, and switching one takes the game down with it. These three survive being asked what the copy
          already written on the screens implies.
        </div>
      </div>
      <div style="position:absolute; left:0; right:0; top:132px; bottom:126px; display:flex; gap:22px;">
        ${MODELS.map(([kind, name, what, route, pros, cons, verdict, vc]) => `
        <div class="card cut" style="flex:1; min-width:0; display:flex; flex-direction:column; gap:13px;">
          <div style="display:flex; align-items:baseline; gap:10px;">
            <span class="d" style="font-size:19px;">${name}</span>
            <span class="verdict" style="margin-left:auto; background:${vc};">${verdict.toUpperCase()}</span>
          </div>
          ${mini(kind)}
          <div style="font-size:13px; line-height:1.5;">${what}</div>
          <div>
            <div class="hd">Table to a past decision</div>
            <div class="cap" style="margin-top:4px; font-size:12.5px;">${route}</div>
          </div>
          <div>
            <div class="hd">What it buys</div>
            ${pros.map(p => `<div class="cap" style="margin-top:5px; font-size:12.5px;">— ${p}</div>`).join('')}
          </div>
          <div>
            <div class="hd">What it costs</div>
            ${cons.map(p => `<div class="cap" style="margin-top:5px; font-size:12.5px; color:#8a5a44;">— ${p}</div>`).join('')}
          </div>
        </div>`).join('')}
      </div>
      <div style="position:absolute; left:0; right:0; bottom:0; display:flex; gap:40px; align-items:flex-start;">
        <div style="width:300px; flex:0 0 300px; font:600 13px var(--ui);">Why the middle one</div>
        <div class="cap" style="flex:1; min-width:0; font-size:13px; column-count:2; column-gap:40px;">
          It is the first model plus a single line. Every door it uses was already written into the screens —
          “Show me the others”, “All 14 moves”, “What Red considered”, “drag anywhere on the curve” — so it adds
          no vocabulary, only a way of knowing where you stand and somewhere for the game to reach you from.
          The third is the more interesting idea and the wrong place to spend the character: it would put new
          chrome on all six screens to explain a gesture, days after taking a nav bar off them.
        </div>
      </div>
    </div>`)));
}

// ── 2. what the board actually does between views ────────────────────────────────────
{
  const T = M.ViewTable.boards[0];
  const ROWS = [
    ['Table',        'ViewTable',   M.ViewTable.boards[0],   'the game itself'],
    ['Console',      'ViewConsole', M.ViewConsole.boards[0], 'the same turn, counted'],
    ['Coach',        'ViewCoach',   M.ViewCoach.boards[0],   'the same turn, argued with'],
    ['Futures',      'ViewFutures', M.ViewFutures.boards[1], 'six of them, at once'],
    ['Game analysis','ViewGame',    M.ViewGame.boards[0],    'the whole game, from further off'],
    ['Move analysis','ViewMove',    M.ViewMove.boards[0],    'one decision, closest of all'],
  ];
  const VERBS = [
    ['A view moves the board', 'the board translates and scales to that view’s rect', 'the pieces on it', C.pine],
    ['Time moves the pieces',  'pieces step and resolve; the scrubber runs',          'the board’s rect', '#4a6659'],
    ['A hypothetical divides it', 'one board becomes six, and one comes back',        'everything else',  '#a34a34'],
  ];
  const track = (w) => `<span style="display:flex; align-items:center; gap:8px;">
      <span style="display:block; width:${(w / 628 * 88).toFixed(1)}px; height:9px; background:${C.pine};"></span>
      <span class="mono">${w}</span></span>`;

  // the same six rects, drawn where they actually sit on the artboard — the ladder as a
  // picture, since a column of numbers does not show that the board also travels
  const nest = `<svg viewBox="0 0 1440 900" width="486" height="304" style="display:block; background:${C.paper};" aria-hidden="true">
    ${ROWS.map(([name, , b], i) => `<g>
      <rect x="${b.cx - b.w/2}" y="${b.cy - b.h/2}" width="${b.w}" height="${b.h}" fill="none"
        stroke="${i === 0 ? C.pine : C.moss}" stroke-width="${i === 0 ? 4 : 2.4}"
        stroke-dasharray="${i === 0 ? '' : '9 8'}" opacity="${i === 0 ? 1 : .8}"/>
      <text x="${b.cx - b.w/2 + 8}" y="${b.cy - b.h/2 + 26}" font-size="19" font-weight="${i === 0 ? 700 : 500}"
        fill="${i === 0 ? C.pine : C.moss}" font-family="Chivo,Arial">${name}</text>
      <circle cx="${b.cx}" cy="${b.cy}" r="4" fill="${i === 0 ? C.pine : C.moss}"/>
    </g>`).join('')}
    <rect x="1" y="1" width="1438" height="898" fill="none" stroke="${C.dust}" stroke-width="2"/>
  </svg>`;

  write('Travel.dc.html', doc(CSS, SHELL(`
    <div style="position:absolute; inset:30px 34px;">
      <div style="display:flex; gap:40px; align-items:flex-start;">
        <div style="width:300px; flex:0 0 300px;">
          <div class="d" style="font-size:23px; line-height:1.15;">The board never<br>unmounts, so it travels</div>
        </div>
        <div class="cap" style="flex:1; min-width:0; font-size:14px; column-count:2; column-gap:40px;">
          Every view already drew the board at a size of its own, and those sizes were measured out of the six
          screens rather than chosen here. Read as one element that is never rebuilt, they stop being six
          drawings and become one ladder: a view change is a transform, and this table is what it transforms to.
        </div>
      </div>

      <div style="display:flex; gap:22px; margin-top:24px;">
        <div style="flex:1; min-width:0;">
          <table>
            <tr><th style="width:150px;">view</th><th style="width:150px;">board</th><th style="width:96px;">from Table</th>
                <th style="width:118px;">centre</th><th></th></tr>
            ${ROWS.map(([name, file, b, note]) => `<tr>
              <td style="font-weight:600;">${name}${name === 'Futures' ? '<span class="cap" style="font-weight:400;"> ×6</span>' : ''}</td>
              <td>${track(b.w)}</td>
              <td class="mono">${(b.w / T.w).toFixed(3)}×</td>
              <td class="mono">${b.cx}, ${b.cy}</td>
              <td class="cap" style="font-size:12px;">${note}</td></tr>`).join('')}
          </table>
          <div class="cap" style="margin-top:9px; font-size:12px;">
            Measured in the browser at 1440×900, centres from the artboard’s top-left, after the headline came
            out. Futures is one row because its six candidates are the same rect at three columns and two rows.
          </div>
          <div style="margin-top:14px; display:flex; gap:18px; align-items:flex-start;">
            ${nest}
            <div class="cap" style="flex:1; min-width:0; font-size:12.5px;">
              The same six, drawn where they sit. Every travel in the app is a line between two of these
              rectangles, which is why the transitions could be specified before anything was built: the ends
              were already decided by the screens.
              <span style="display:block; margin-top:9px;">The board drifts left as you go deeper — centred at
              the table, moved aside for the reading in analysis. That drift is the feeling of leaving the game
              in order to look at it.</span>
            </div>
          </div>
        </div>

        <div style="width:392px; flex:0 0 392px;">
          <div class="hd">Three verbs, and never two at once</div>
          <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
            ${VERBS.map(([v, moves, holds, col]) => `<div class="card cut8" style="padding:12px 14px;">
              <div style="font:600 13.5px var(--ui); color:${col};">${v}</div>
              <div style="margin-top:6px; display:flex; gap:10px; font-size:12.5px;">
                <span class="cap" style="width:52px; flex:0 0 52px; font-size:12px;">moves</span><span>${moves}</span></div>
              <div style="margin-top:3px; display:flex; gap:10px; font-size:12.5px;">
                <span class="cap" style="width:52px; flex:0 0 52px; font-size:12px;">holds</span><span class="cap" style="font-size:12.5px;">${holds}</span></div>
            </div>`).join('')}
          </div>
          <div class="cap" style="margin-top:10px; font-size:12.5px;">
            Scrubbing while a view is arriving queues behind it. Two verbs at once is how an interface stops
            being readable — you cannot tell what caused what.
          </div>
        </div>
      </div>

      <div style="position:absolute; left:0; right:0; bottom:0; display:flex; gap:22px; align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div class="hd">Timing, which is already in the stylesheet</div>
          <div style="margin-top:9px; display:flex; gap:26px;">
            ${[['--t-board', '420ms', 'the board’s travel between two views'],
               ['--t-panel', '260ms', 'a panel arriving or leaving beside it'],
               ['--t-feel',  '120ms', 'a control answering a press']].map(([v, ms, what]) => `
              <div style="flex:1;">
                <div class="d num" style="font-size:20px;">${ms}</div>
                <div class="mono" style="color:var(--moss); margin-top:2px;">${v}</div>
                <div class="cap" style="font-size:12px; margin-top:3px;">${what}</div>
              </div>`).join('')}
          </div>
        </div>
        <div style="width:392px; flex:0 0 392px;">
          <div class="hd">The rules that keep it honest</div>
          <div class="cap" style="margin-top:8px; font-size:12.5px;">One easing everywhere:
            <span class="mono">cubic-bezier(.2,.8,.2,1)</span>, so a third of the way through a travel is about
            three quarters of the distance. Esc pops one crumb and the board returns along the path it came by.
            Under reduced motion the board still changes size — it just arrives there.</div>
        </div>
      </div>
    </div>`)));
}

// ── 3. what you actually do with your hands ──────────────────────────────────────────
{
  const INPUT = [
    ['Table',         'touch the board', 'lit corners take a settlement or a city, lit edges take a road', 'space holds every legal move up at once'],
    ['Console',       'the action bar',  'each button carries its cost in pips, and dims when you cannot pay', 'the board stays clickable behind it'],
    ['Coach',         'type, or a chip', 'three suggested questions sit under the composer for when you have none', 'a percentage in a reply is a door'],
    ['Futures',       'pick a board',    'the card is the whole answer; clicking it commits the move', 'Esc folds the six back into one'],
    ['Move analysis', '← → and the ladder', 'the ranked list is the board: rank on the board is rank in the ladder', 'the segmented control swaps whose search you are reading'],
    ['Game analysis', 'drag the curve',  'anywhere on it, and the reading underneath follows', 'hovering an attribution row lights it on the board'],
  ];
  const KEYS = [
    ['Esc',   'up one crumb — never straight out'],
    ['← →',   'one step back or on, wherever time is showing'],
    ['space', 'in a play view, hold every legal move up; in a review view, play or pause'],
    ['?',     'hold to name every door on this screen'],
    ['1–4',   'jump to a seat’s reading'],
    ['⌘K',    'nothing. There is no command palette, because there are seven doors and they are all visible'],
  ];
  const HASH = [
    ['#/g/4127',                'the table, live, seed 4127'],
    ['#/g/4127/futures',        'the six, on the turn you are on'],
    ['#/g/4127/step/214',       'the whole game, parked at a step'],
    ['#/g/4127/step/214/move',  'that one decision, which is the link you send someone'],
  ];

  write('Keys.dc.html', doc(CSS, SHELL(`
    <div style="position:absolute; inset:30px 34px;">
      <div style="display:flex; gap:40px; align-items:flex-start;">
        <div style="width:300px; flex:0 0 300px;">
          <div class="d" style="font-size:23px; line-height:1.15;">One primary input<br>per view</div>
        </div>
        <div class="cap" style="flex:1; min-width:0; font-size:14px; column-count:2; column-gap:40px;">
          A view is defined as much by what your hands do in it as by what it shows. Each of the six has exactly
          one thing you mostly do, and the rest of what it offers is arranged around that. Where two views would
          have wanted the same key, the conflict is resolved rather than papered over.
        </div>
      </div>

      <div style="margin-top:24px; display:flex; gap:22px;">
        <div style="flex:1; min-width:0;">
          <table>
            <tr><th style="width:132px;">view</th><th style="width:158px;">what you mostly do</th><th>how it behaves</th></tr>
            ${INPUT.map(([v, primary, how, also]) => `<tr>
              <td style="font-weight:600;">${v}</td>
              <td>${primary}</td>
              <td><span style="display:block;">${how}</span>
                  <span class="cap" style="display:block; font-size:12px; margin-top:3px;">${also}</span></td></tr>`).join('')}
          </table>
        </div>
        <div style="width:392px; flex:0 0 392px;">
          <div class="hd">The whole key map</div>
          <div style="margin-top:10px; display:flex; flex-direction:column; gap:9px;">
            ${KEYS.map(([k, what]) => `<div style="display:flex; gap:11px; align-items:baseline;">
              <span class="k" style="flex:0 0 auto;">${k}</span>
              <span class="cap" style="flex:1; font-size:12.5px;">${what}</span></div>`).join('')}
          </div>
          <div class="card cut8" style="margin-top:14px; padding:12px 14px;">
            <div style="font:600 12.5px var(--ui);">The one real collision</div>
            <div class="cap" style="margin-top:5px; font-size:12.5px;">Space wants to be “show me everything I
              could do” at the table and “play” in a review. It can be both, because a play view and a review
              view are never on screen together — the spine says which one you are in, and the key follows it.</div>
          </div>
        </div>
      </div>

      <div style="position:absolute; left:0; right:0; top:456px; bottom:126px; display:flex; gap:22px; align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div class="hd">What is running underneath, so that any of this is possible</div>
          <div class="cap" style="margin-top:8px; font-size:13px; max-width:600px;">
            Today a tab switch unmounts the page and takes the game with it, and starting a run frees the
            engine the other tab was using. Neither survives this flow, because in it you are never anywhere
            else. Reviewing a game while it is still being played is the one thing that needs more than the app
            has: a second worker, replaying the record the live one is writing.
          </div>
          <svg viewBox="0 0 600 168" width="490" height="137" style="display:block; margin-top:11px;" aria-hidden="true">
            <rect x="0" y="8" width="266" height="66" fill="${C.paper}" stroke="${C.dust}"/>
            <text x="14" y="32" font-size="13" font-weight="600" fill="${C.pine}" font-family="Chivo,Arial">worker A — the game</text>
            <text x="14" y="52" font-size="12" fill="${C.moss}" font-family="Chivo,Arial">one engine, never freed while a game lives</text>
            <rect x="0" y="92" width="266" height="66" fill="${C.paper}" stroke="${C.dust}" stroke-dasharray="5 4"/>
            <text x="14" y="116" font-size="13" font-weight="600" fill="${C.pine}" font-family="Chivo,Arial">worker B — the review</text>
            <text x="14" y="136" font-size="12" fill="${C.moss}" font-family="Chivo,Arial">replay(record, step), asked whatever you ask</text>
            <path d="M266 41 L360 41" stroke="${C.moss}" stroke-width="1.4" marker-end="url(#ka)"/>
            <path d="M266 125 L360 125" stroke="${C.moss}" stroke-width="1.4" marker-end="url(#ka)"/>
            <path d="M133 74 L133 92" stroke="${C.moss}" stroke-width="1.4" stroke-dasharray="4 4" marker-end="url(#ka)"/>
            <text x="140" y="88" font-size="11.5" fill="${C.moss}" font-family="Chivo,Arial">the record, as it is written</text>
            <defs><marker id="ka" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="${C.moss}"/></marker></defs>
            <rect x="362" y="8" width="238" height="150" fill="none" stroke="${C.dust}"/>
            <text x="376" y="32" font-size="13" font-weight="600" fill="${C.pine}" font-family="Chivo,Arial">one board</text>
            <text x="376" y="52" font-size="12" fill="${C.moss}" font-family="Chivo,Arial">the live position, or a replayed one</text>
            <text x="376" y="80" font-size="12" fill="${C.moss}" font-family="Chivo,Arial">the spine says which, and whose turn</text>
            <text x="376" y="108" font-size="12" fill="${C.moss}" font-family="Chivo,Arial">it is waiting on</text>
          </svg>
        </div>
        <div style="width:392px; flex:0 0 392px;">
          <div class="hd">What that buys, in the flow</div>
          <div class="cap" style="margin-top:8px; font-size:12.5px;">You can open the whole-game curve in the
            middle of your own game, walk back to the turn that went wrong, ask what the net saw there, and come
            back to a table that has not moved. Worker A never hears about any of it.</div>
          <div class="cap" style="margin-top:9px; font-size:12.5px;">It is also what makes the spine’s right-hand
            half possible: worker A goes on running while you read, so when a seat offers you a trade there is
            something live to announce it.</div>
          <div class="cap" style="margin-top:9px; font-size:12.5px;">The wasm already exposes
            <span class="mono">replay(record, steps)</span> and nothing in the app calls it. This is what it is
            for.</div>
        </div>
      </div>

      <div style="position:absolute; left:0; right:0; bottom:0; display:flex; gap:22px; align-items:flex-start;">
        <div style="flex:1; min-width:0;">
          <div class="hd">What a link carries</div>
          <div style="margin-top:9px; display:flex; flex-direction:column; gap:6px;">
            ${HASH.map(([h, what]) => `<div style="display:flex; gap:14px; align-items:baseline;">
              <span class="mono" style="width:230px; flex:0 0 230px; color:var(--pine);">${h}</span>
              <span class="cap" style="flex:1; font-size:12.5px;">${what}</span></div>`).join('')}
          </div>
        </div>
        <div style="width:392px; flex:0 0 392px;">
          <div class="hd">What survives a reload</div>
          <div class="cap" style="margin-top:8px; font-size:12.5px;">A review link survives, because a step is a
            fact about a record. A live game does not: it is one engine in one worker, and reloading is starting
            over. So the review views are linkable and the table is not, and the ending is where a game becomes
            something you can send.</div>
        </div>
      </div>
    </div>`)));
}
