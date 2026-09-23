// web/design/mobile.mjs — phone-width artboards for the four remaining views.
// Shares board.mjs's rendering (board(), spine(), doc(), tokens, palette, fonts, corner
// cuts) with the desktop set, so a phone artboard reads as the same product. What's new is
// everything below the board: on the Table the four corner-docked panels become a bottom
// tab strip time-sharing one band, each tab its own artboard (a different state is a
// different artboard here, same as desktop's separate views); the other three screens keep
// the band but drop the tabs, since each has exactly one thing to show there.
// Implementation notes live as sticky annotations on the canvas (canvas.json), not drawn
// onto the artboards — see docs/UI-REWRITE.md, "Phones".
import { writeFileSync } from 'node:fs';
import { C, SEAT, SEAT_NAME, PIECES, board, spine, doc, glyphMini, SPINE_CSS } from './board.mjs';

const OUT = new URL('./canvas/', import.meta.url).pathname;
const write = (n, h) => { writeFileSync(OUT + n, h); console.log('wrote', n, h.length); };

const W = 390, H = 844;
const SPINE_H = 28, TAB_H = 56, PANEL_H = 360;
const STAGE_H = H - SPINE_H - TAB_H - PANEL_H;      // 400 when tabs are shown
const STAGE_H_NOTABS = H - SPINE_H - PANEL_H;       // 456 on the three view-only screens

const CSS = SPINE_CSS + `
  .L .stage { position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .L .panel { flex:0 0 ${PANEL_H}px; padding:16px 20px 14px;
              display:flex; flex-direction:column; gap:9px; overflow-y:auto; overflow-x:hidden; }
  .L .panel > * { flex-shrink:0; }
  .L .tabstrip { flex:0 0 ${TAB_H}px; display:flex; align-items:center; gap:8px; padding:0 20px;
                 border-top:1px solid var(--dust); background:var(--chalk); }
  .L .dim { opacity:0.42; }
  .L .arow { display:flex; align-items:center; justify-content:space-between; gap:10px;
             height:44px; flex:0 0 44px; padding:0 13px; background:var(--paper); }
  .L .arow.go { background:var(--pine); color:var(--chalk); justify-content:center; font:600 13.5px var(--ui); }
  .L .aname { font:500 13px var(--ui); }
  .L .costs { display:flex; gap:2px; flex:0 0 auto; }
  .L .lrow { display:flex; align-items:center; gap:10px; background:var(--paper); padding:6px 10px; }
  .L .lname { width:150px; flex:0 0 150px; font-size:12.5px; }
  .L .ltrack { flex:1; height:7px; background:var(--dust); }
  .L .ltrack > i { display:block; height:100%; }
  .L .lval { width:38px; flex:0 0 38px; text-align:right; font-size:11.5px; }`;

const shell = (spineHtml, stageHtml, panelHtml, tabsHtml, stageH) => `<div class="L" style="width:${W}px; height:${H}px;
     background:var(--chalk); color:var(--pine); font:400 14px var(--ui); display:flex; flex-direction:column; overflow:hidden;">
  ${spineHtml}
  <div class="stage" style="flex:0 0 ${stageH}px;">${stageHtml}</div>
  <div class="panel">${panelHtml}</div>
  ${tabsHtml || ''}
</div>`;

const tabs = active => `<div class="tabstrip">${['Hand', 'Actions', 'Coach', 'Seats'].map(t =>
  `<div class="act${t === active ? ' go' : ''}" style="flex:1;">${t}</div>`).join('')}</div>`;

// the same 10x10 hexagon the desktop's own cost-pip markup uses, one per resource unit
const pip = res => `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style="display:block">
  <polygon points="5,0 9.33,2.5 9.33,7.5 5,10 0.67,7.5 0.67,2.5" fill="${C[res]}"/></svg>`;
const costs = list => `<div class="costs">${list.map(pip).join('')}</div>`;

// a hand-card tile: the glyph icon, a big count, a resource-colour bottom bar — the same
// three-part card desktop's hand rail and Console/Futures reuse everywhere a resource is held
const CARD_W = 60, CARD_H = 76;
const card = (res, count, ring = false) => `<div class="cut8" style="width:${CARD_W}px; height:${CARD_H}px; flex:0 0 ${CARD_W}px;
    background:var(--paper); position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center;
    ${ring ? `box-shadow:inset 0 0 0 2px ${C.pine};` : ''}">
  <svg width="${CARD_W}" height="${CARD_H - 24}" viewBox="0 0 ${CARD_W} ${CARD_H - 24}" aria-hidden="true">
    ${glyphMini(res, CARD_W / 2, (CARD_H - 24) / 2, CARD_W * 0.55, (CARD_H - 24) * 0.55, 0.85)}</svg>
  <span class="d num" style="font-size:19px; margin-top:1px;">${count}</span>
  <span style="position:absolute; left:0; right:0; bottom:0; height:4px; background:${C[res]};"></span></div>`;

// a ranked-move row: name, a bar sized to its win%, the win% — Console's ranked list.
// 'go' rings the active/top move the same way Move's ◇ rings the heuristic's pick.
const rankRow = (name, pct, active) => `<div class="lrow"${active ? ` style="box-shadow:inset 0 0 0 1.5px ${C.pine};"` : ''}>
  <span class="lname" style="width:132px; flex:0 0 132px;">${name}</span>
  <div class="ltrack"><i style="width:${pct}%; background:${C.pine};"></i></div>
  <span class="lval num">${pct}%</span></div>`;

// one line of the live event feed: a seat-coloured diamond + a sentence
const logRow = (seat, text) => `<div class="row" style="gap:8px; align-items:flex-start;">
  <span style="width:7px; height:7px; flex:0 0 7px; margin-top:4px; background:${SEAT[seat]}; transform:rotate(45deg);"></span>
  <span style="font-size:12px; line-height:1.45;">${text}</span></div>`;

// one column of the dice-outcome strip: the roll, its pip glyph, a bar (height exaggerated
// for legibility, not literal) and the resulting win% if that number comes up
const diceCol = (roll, label, barPct, hot) => {
  const dots = { 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 3, 9: 3, 10: 2, 11: 2, 12: 1 }[roll] || 2;
  return `<div style="display:flex; flex-direction:column; align-items:center; gap:2px; width:28px; flex:0 0 28px;">
    <span style="font:600 10.5px var(--ui); color:${hot ? C.brick : C.pine};">${roll}</span>
    <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="${1 + dots * 0.4}" fill="${hot ? C.brick : C.moss}"/></svg>
    <div style="width:4px; height:26px; background:var(--dust); position:relative;">
      <div style="position:absolute; bottom:0; width:100%; height:${barPct}%; background:${hot ? C.brick : C.pine};"></div></div>
    <span style="font-size:9px; color:var(--moss);">${label}%</span></div>`;
};

// one card of the "steps either side" filmstrip: step, seat, one line, a magnitude bar —
// the current step is wheat, matching production's Move.tsx (not a dark pine card)
const filmCard = (step, seat, action, mag, current) => `<div class="cut8" style="flex:0 0 84px; width:84px; padding:7px 8px;
    background:${current ? C.wheat : 'var(--paper)'}; color:${C.pine};
    display:flex; flex-direction:column; gap:3px;">
  <div class="row" style="gap:5px;">
    <span class="num" style="font-size:10.5px; opacity:0.7;">${step}</span>
    <span style="width:7px; height:7px; flex:0 0 7px; border-radius:50%; background:${SEAT[seat]}; margin-left:auto;"></span></div>
  <span style="font-size:10.5px; line-height:1.3;">${action}</span>
  <div style="height:5px; background:rgba(18,33,31,.12); margin-top:auto;">
    <div style="height:100%; width:${mag}%; background:${mag >= 0 ? C.wood : C.brick};"></div></div></div>`;

// the whole-game strip, shared by Table's seek bar and Move analysis in production
// (web/src/views/Strip.tsx): wheat fill to the current step, seat-coloured lettered event
// markers, a pine handle — not an invented scrubber idiom
const scrubber = (frac, events) => `<div style="position:relative; height:8px; margin:24px 0 8px; background:var(--dust);">
  <div style="position:absolute; left:0; top:0; bottom:0; width:${frac}%; background:${C.wheat};"></div>
  ${events.map(({ pct, seat, letter }) => `<span class="num" style="position:absolute; left:${pct}%; top:-15px; width:11px; height:11px;
      margin-left:-5.5px; border-radius:50%; background:${SEAT[seat]}; color:${seat === 'grey' ? C.pine : C.chalk};
      font:700 7.5px var(--ui); display:flex; align-items:center; justify-content:center;">${letter}</span>`).join('')}
  <span style="position:absolute; left:${frac}%; top:-4px; bottom:-4px; width:3px; margin-left:-1.5px; background:${C.pine};"></span></div>`;

// a translucent ring on the exact viewBox the board itself uses, so it lands on the piece
// without re-deriving the board's own screen transform. The tight box (not board.mjs's
// padded default) is the same literal crop the desktop views use, so the island fills the
// frame instead of floating in a wide margin — see UI-REWRITE.md's VIEWBOX note.
const VIEW = [-236.72, -244.2, 511.56, 488.4];
const BOARD_W = 350;
const ringOverlay = (x, y, w) => {
  const h = Math.round(w * VIEW[3] / VIEW[2]);
  return `<svg viewBox="${VIEW.join(' ')}" width="${w}" height="${h}"
    style="position:absolute; pointer-events:none;"><circle cx="${x}" cy="${y}" r="15" fill="none"
    stroke="${C.pine}" stroke-width="3.4"/></svg>`;
};

// ═══════════════════════════════════════════════════════ MobileTable (+ its Hand/Coach/Seats tabs)
{
  const tableStage = `<div>${board({ w: BOARD_W, view: VIEW })}</div>`;
  const tableSpine = spine(['Table'], 'your turn', 'blue', false, 'turn 31');
  const writeVariant = (file, active, panelHtml) =>
    write(file, doc(CSS, shell(tableSpine, tableStage, panelHtml, tabs(active), STAGE_H)));

  // — Actions —
  const actionRows = [
    ['Road', ['wood', 'brick'], false],
    ['Settlement · the 8 wood · 3 ore corner', ['wood', 'brick', 'sheep', 'wheat'], false],
    ['Buy a development card', ['sheep', 'wheat', 'ore'], true],
    ['Bank trade', [], false],
  ].map(([name, cs, dim]) => `<div class="arow cut8${dim ? ' dim' : ''}"><span class="aname">${name}</span>${costs(cs)}</div>`).join('');
  writeVariant('MobileTable.dc.html', 'Actions', actionRows + `<div class="arow cut8 go">End turn</div>`);

  // — Hand — the same 9-card hand (wood 2, brick 1, sheep 1, wheat 2, ore 3) desktop's own
  // Table/Console examples use, ore ringed since it's what the coach's build below needs
  const hand = [['wood', 2, false], ['brick', 1, false], ['sheep', 1, false], ['wheat', 2, false], ['ore', 3, true]];
  const handPanel = `<div class="cap" style="text-align:center;">Your hand</div>
    <div class="row" style="gap:6px; justify-content:center; margin-top:2px;">${hand.map(([r, c, ring]) => card(r, c, ring)).join('')}</div>
    <div style="text-align:center; font-size:12px; color:${C.brick}; margin-top:2px;">nine cards — a seven takes four</div>
    <div class="row" style="gap:8px; margin-top:auto;">
      <div class="act" style="flex:1;">Offer a trade</div>
      <div class="act dim" style="flex:1;">Bank trade</div></div>`;
  writeVariant('MobileTableHand.dc.html', 'Hand', handPanel);

  // — Coach — the recommendation (desktop's Table box) plus Console's full ranked list,
  // "why it's not close" box and search-stats line, all in the one scrollable panel. The
  // dedicated Coach view's chat transcript stays out — same content, different register,
  // already said once here.
  const coachRanked = [
    ['City · the 8 wood and 3 ore corner', 33.6, true],
    ['Buy a development card', 31.2, false],
    ['Settlement · the 4 wheat corner', 30.4, false],
    ['Road toward the port', 29.9, false],
    ['Offer Red two wood for a wheat', 29.5, false],
    ['End turn', 28.7, false],
  ];
  const coachPanel = `<div class="cap">The net would take the ringed corner</div>
    <div style="font:700 15px var(--ui); margin-top:2px;">City on the 8 wood and 3 ore corner</div>
    <div class="row" style="gap:10px; align-items:baseline; margin-top:8px;">
      <span class="d" style="font-size:29px;">33.6%</span>
      <span class="cap">yours if you build it now</span></div>
    <p style="font-size:12.5px; line-height:1.5; margin:8px 0 0;">It banks three ore a seven would otherwise
      take, and doubles a corner that pays on an 8 Red can no longer collect. Ending the turn instead reads 28.7%.</p>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:10px;">
      ${coachRanked.map(([n, p, a]) => rankRow(n, p, a)).join('')}</div>
    <div class="cut8" style="background:var(--paper); padding:9px 11px; margin-top:8px;">
      <div style="font:600 12px var(--ui);">Why it is not close</div>
      <div style="font-size:12px; line-height:1.5; margin-top:3px;">Ending the turn on nine cards hands a
        seven — one roll in six — a four-card discard. The city spends five of them and pays out on the tile
        Orange's robber cannot reach.</div></div>
    <div style="font-size:11px; color:var(--moss); margin-top:6px;">Two turns deep, 4 812 positions, 61 ms.</div>
    <div class="row" style="gap:8px; margin-top:10px;">
      <div class="act" style="flex:1;">Every legal move</div>
      <div class="act" style="flex:1;">Turn it off</div></div>`;
  writeVariant('MobileTableCoach.dc.html', 'Coach', coachPanel);

  // — Seats — shield, name, VP (the human seat's hidden dev-card VP as a +N), a pip bar, win%.
  // Win% here is this game's own turn-31 reading (from MobileGame's curve), not desktop's
  // unrelated example numbers — the game has to agree with itself across screens.
  const seatRow = (seat, vp, hidden, pipLit, winPct) => {
    const pips = Array.from({ length: 13 }, (_, i) =>
      `<span style="width:6px; height:6px; flex:0 0 6px; background:${i < pipLit ? SEAT[seat] : '#d7dccf'};"></span>`).join('');
    return `<div class="row cut8" style="background:var(--paper); padding:8px 10px; gap:10px;">
      <svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true">
        <polygon points="5,0 9.33,2.5 9.33,7.5 5,10 0.67,7.5 0.67,2.5" fill="${SEAT[seat]}"/></svg>
      <span style="font:600 13px var(--ui); width:58px; flex:0 0 58px;">${SEAT_NAME[seat]}${seat === 'blue' ? ', you' : ''}</span>
      <span class="num" style="width:30px; flex:0 0 30px;">${vp}${hidden ? `<span style="font-size:10.5px; color:var(--moss);">+${hidden}</span>` : ''}</span>
      <div class="row" style="gap:1.5px; flex:1;">${pips}</div>
      <span class="num" style="width:40px; flex:0 0 40px; text-align:right;">${winPct}%</span></div>`;
  };
  const thisTurn = [
    ['blue', 'You rolled an 8 and took a wood.'],
    ['orange', 'Orange bought a knight from White for two sheep.'],
    ['orange', 'Orange played it and took largest army; the robber came off your ore.'],
    ['blue', 'You built the coast road and reclaimed longest road.'],
    ['white', 'White traded two wheat to the bank for an ore.'],
  ];
  const seatsPanel = `<div style="display:flex; flex-direction:column; gap:7px;">
      ${seatRow('blue', 8, 1, 10, 97)}${seatRow('red', 5, 0, 6, 2)}${seatRow('orange', 4, 0, 4, 1)}${seatRow('grey', 3, 0, 3, 0)}</div>
    <div style="font-size:11.5px; color:var(--moss); margin-top:8px;">Longest road to Blue, largest army to Orange.</div>
    <div class="cap" style="margin-top:12px;">This turn</div>
    <div style="display:flex; flex-direction:column; gap:8px; margin-top:4px;">
      ${thisTurn.map(([seat, text]) => logRow(seat === 'white' ? 'grey' : seat, text)).join('')}</div>`;
  writeVariant('MobileTableSeats.dc.html', 'Seats', seatsPanel);
}

// ═══════════════════════════════════════════════════════ MobileFutures
{
  const main = board({ w: BOARD_W, view: VIEW, seats: ['blue', 'red'] });
  const stage = `<div>${main}</div>`;

  // roll, resulting win% label, bar height (exaggerated for legibility), hot = the seven
  const dice = [
    [2, 35.1, 70, false], [3, 34.6, 66, false], [4, 36.0, 78, false], [5, 35.2, 71, false],
    [6, 36.8, 84, false], [7, 30.2, 28, true], [8, 34.9, 68, false], [9, 33.7, 58, false],
    [10, 32.8, 50, false], [11, 33.5, 56, false], [12, 34.1, 62, false],
  ];
  const panel = `<div class="row" style="justify-content:space-between; align-items:baseline;">
      <span class="d" style="font-size:26px;">62%</span>
      <span class="cap">win probability, this candidate</span></div>
    <div class="row" style="justify-content:space-between; align-items:baseline; margin-top:2px;">
      <span style="font-size:12.5px; color:var(--moss);">your 8 wood corner becomes a city</span>
      <span class="num" style="font-size:12.5px; color:${C.wood};">+3.8</span></div>
    <div class="row" style="justify-content:space-between; align-items:baseline; margin-top:6px;">
      <span style="font-size:12px; color:var(--moss);">you, right now — 29.8%</span></div>
    <div class="row" style="gap:8px; margin-top:8px;">
      <div class="arow cut8 go" style="flex:1;">Build it</div>
      <div class="act" style="flex:1;">Let the net decide</div></div>
    <div class="cap" style="margin-top:12px;">And then the dice, if you take the city</div>
    <div class="row" style="gap:4px; justify-content:space-between; margin-top:4px;">
      ${dice.map(([roll, label, barPct, hot]) => diceCol(roll, label, barPct, hot)).join('')}</div>`;

  const body = shell(
    spine(['Table', 'Futures'], null, 'blue', false, 'candidate 1 of 6'),
    stage, panel, null, STAGE_H_NOTABS,
  );
  write('MobileFutures.dc.html', doc(CSS, body));
}

// ═══════════════════════════════════════════════════════ MobileGame
{
  // The same 31-turn game as MobileTable/MobileMove (turn 31 in progress, turn 24 the
  // decision under review) — a whole-game curve worth reading is one that resolves,
  // not a schematic: it ends with a winner near 100% and everyone else trailing away.
  const seats = ['blue', 'red', 'orange', 'grey'];
  const N = 31;
  const noise = (i, seed) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
  // linear interpolation between hand-placed keyframes, plus small deterministic per-seat
  // jitter so the line reads as per-turn evaluations rather than a drawn trend
  const curveFor = (keyframes, seed, amp) => Array.from({ length: N }, (_, t) => {
    let lo = keyframes[0], hi = keyframes[keyframes.length - 1];
    for (let k = 0; k < keyframes.length - 1; k++)
      if (t >= keyframes[k][0] && t <= keyframes[k + 1][0]) { lo = keyframes[k]; hi = keyframes[k + 1]; break; }
    const f = (t - lo[0]) / (hi[0] - lo[0] || 1);
    const v = lo[1] + (hi[1] - lo[1]) * f + (noise(t, seed) - 0.5) * amp * 2;
    return Math.max(1, Math.min(99, v));
  });
  const series = {
    blue: curveFor([[0, 27], [12, 42], [19, 47], [24, 62], [30, 97]], 1, 4),
    red: curveFor([[0, 26], [12, 24], [19, 12], [24, 15], [30, 2]], 2, 4),
    orange: curveFor([[0, 24], [12, 21], [19, 25], [24, 14], [30, 1]], 3, 3),
    grey: curveFor([[0, 23], [12, 13], [19, 16], [24, 9], [30, 0]], 4, 3),
  };

  const cw = BOARD_W, plotH = 210, topPad = 8, botPad = 22;
  const xs = i => (i / (N - 1)) * cw;
  const ys = v => topPad + plotH - (v / 100) * plotH;
  const line = s => `<polyline points="${series[s].map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ')}"
      fill="none" stroke="${SEAT[s]}" stroke-width="2.2"/>`;

  const swings = [
    ['turn 12', 'blue', 'Blue’s second city', '+18'],
    ['turn 19', 'red', 'a seven on Red’s 8', '−11'],
    ['turn 24', 'blue', 'longest road changes hands', '+9'],
  ];
  const marker = ([t, seat]) => {
    const turn = +t.slice(5) - 1;
    return `<circle cx="${xs(turn).toFixed(1)}" cy="${ys(series[seat][turn]).toFixed(1)}" r="3.6" fill="${SEAT[seat]}"/>`;
  };
  const tick = t => `<text x="${xs(t - 1).toFixed(1)}" y="${topPad + plotH + 16}"
      text-anchor="${t === 1 ? 'start' : t === N ? 'end' : 'middle'}"
      font-size="10" font-family="Chivo,Helvetica Neue,Arial,sans-serif" fill="${C.moss}">turn ${t}</text>`;

  const legend = `<div class="row" style="gap:16px; justify-content:center; margin-bottom:8px;">
    ${seats.map(s => `<span class="row" style="gap:5px;">
      <span style="width:9px; height:9px; flex:0 0 9px; background:${SEAT[s]};"></span>
      <span class="cap" style="font-size:11.5px;">${SEAT_NAME[s]}</span></span>`).join('')}</div>`;
  const curve = `<svg viewBox="0 0 ${cw} ${topPad + plotH + botPad}" width="${cw}" height="${topPad + plotH + botPad}"
      style="display:block" aria-hidden="true">
    ${seats.map(line).join('')}
    ${swings.map(marker).join('')}
    ${[1, 12, 19, 24, 31].map(tick).join('')}</svg>`;
  const stage = `<div style="display:flex; flex-direction:column; align-items:center;">${legend}${curve}</div>`;

  const swingRows = swings.map(([t, seat, what, d]) => `<div class="lrow">
      <span style="width:9px; height:9px; flex:0 0 9px; background:${SEAT[seat]};"></span>
      <span class="cap" style="width:50px; flex:0 0 50px;">${t}</span>
      <span style="flex:1; font-size:12.5px;">${what}</span><span class="num" style="font-size:12.5px;">${d}</span></div>`).join('');

  // "What the net is leaning on" — desktop's attribution bars, the same seat+category
  // labels desktop's own ViewGame uses, top factor emphasized
  const attributions = [
    ['Blue’s production', 5.2, true], ['Red’s hand', -4.4, false], ['Blue’s cities', 3.2, false],
    ['Orange’s roads', -2.4, false], ['Red’s roads', -2.1, false], ['Blue’s devs', 1.6, false],
  ];
  const attrRow = ([label, v, top]) => {
    const barW = 84, half = barW / 2, mag = Math.min(Math.abs(v), 10) / 10 * half, neg = v < 0;
    return `<div class="row"${top ? ` style="background:var(--paper); padding:3px 6px; margin:0 -6px;"` : ''}>
      <span class="cap" style="width:110px; flex:0 0 110px; font-size:11px;">${label}</span>
      <div style="position:relative; width:${barW}px; height:7px; flex:0 0 ${barW}px; background:var(--dust);">
        <span style="position:absolute; left:${half}px; top:-2px; width:1px; height:11px; background:var(--pine);"></span>
        <span style="position:absolute; ${neg ? `right:${half}px;` : `left:${half}px;`} top:0; width:${mag.toFixed(1)}px; height:100%;
          background:${neg ? C.brick : C.wood};"></span></div>
      <span class="num" style="width:36px; flex:0 0 36px; text-align:right; font-size:11px;">${v > 0 ? '+' : ''}${v}</span></div>`;
  };
  const attrRows = `<div class="cap" style="margin-top:4px;">What the net is leaning on</div>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">${attributions.map(attrRow).join('')}</div>`;

  const turned = `<div class="cut8" style="background:var(--paper); padding:9px 11px;">
    <div style="font:600 12px var(--ui);">Where the game turned</div>
    <div style="font-size:12px; line-height:1.5; margin-top:3px;">At turn 24, Blue built the coast road and
      reclaimed longest road — worth nine points, and it's the swing that put the game out of reach.</div></div>`;

  const panel = `<div style="display:flex; flex-direction:column; gap:8px;">${swingRows}${turned}${attrRows}</div>`;

  const body = shell(
    spine(['Table', 'Game'], null, 'blue', false, ''),
    stage, panel, null, STAGE_H_NOTABS,
  );
  write('MobileGame.dc.html', doc(CSS, body));
}

// ═══════════════════════════════════════════════════════ MobileMove
// Matches production (web/src/views/Move.tsx), not the earlier round's invented three-way
// "Value net / Heuristic / Both at once" tab — that control was never built; production
// shows both readings on one ladder always, a heuristic-rank column beside the net's own,
// with a ring on whichever row the heuristic actually top-ranked. Caught after the user
// flagged that the toggle doesn't exist in the shipped app.
{
  const boardHtml = board({ w: BOARD_W, view: VIEW });
  const [tx, ty] = PIECES.blue.set[0];
  const stage = `<div style="position:relative;">${boardHtml}${ringOverlay(tx, ty, BOARD_W)}</div>`;

  const scrub = scrubber(24 / 31 * 100, [
    { pct: 12 / 31 * 100, seat: 'blue', letter: 'C' },
    { pct: 19 / 31 * 100, seat: 'red', letter: '7' },
    { pct: 24 / 31 * 100, seat: 'blue', letter: '★' },
  ]);

  const head = `<div class="row" style="justify-content:space-between; align-items:baseline;">
      <span style="font:700 15px var(--ui);">What Blue weighed</span>
      <span class="cap" style="font-size:10px;">two turns deep, 18 940 positions, 96 ms</span></div>
    <div class="cap row" style="gap:8px; font-size:10px; margin-top:8px;">
      <span style="width:14px; flex:0 0 14px;"></span><span style="flex:1;"></span>
      <span style="width:80px; flex:0 0 80px;"></span>
      <span style="width:34px; flex:0 0 34px; text-align:right;">value net</span>
      <span style="width:32px; flex:0 0 32px; text-align:right;">heuristic</span></div>`;

  // rank, name, value-net win% (bar scaled to the top row), heuristic's ordinal for this
  // same move, and whether this row is the heuristic's own top pick (rings it, like
  // production's `theirs` boxShadow)
  const rows = [
    ['Settle · the 8 wood · 3 ore corner', 34.6, '2nd', false],
    ['Road toward the coast', 32.1, '4th', false],
    ['Buy a development card', 30.8, '1st', true],
    ['End turn', 27.4, '3rd', false],
  ];
  const top = rows[0][1];
  const ladder = rows.map(([name, pct, hrank, theirs], i) => `<div class="lrow"${theirs ? ` style="box-shadow:inset 0 0 0 1.5px ${C.pine};"` : ''}>
      <span class="num" style="width:14px; flex:0 0 14px; color:${i === 0 ? C.wheat : 'var(--moss)'}; font-weight:700;">${i + 1}</span>
      <span style="flex:1; font-size:12.5px; font-weight:${i === 0 ? 600 : 400};">${name}</span>
      <div style="width:80px; height:7px; flex:0 0 80px; background:var(--dust);">
        <i style="display:block; height:100%; width:${(pct / top * 100).toFixed(1)}%; background:${i === 0 ? C.wheat : '#c8b98a'};"></i></div>
      <span class="d num" style="width:34px; flex:0 0 34px; text-align:right; font-size:11.5px;">${pct}%</span>
      <span class="num" style="width:32px; flex:0 0 32px; text-align:right; font-size:11px;
        color:${theirs ? C.pine : 'var(--moss)'}; font-weight:${theirs ? 700 : 400};">${hrank}</span></div>`).join('');

  const disagree = `<div class="cut8" style="background:var(--pine); color:var(--chalk); padding:10px 12px;">
    <div class="row" style="justify-content:space-between; align-items:baseline;">
      <span style="font:700 14px var(--ui);">The two bots disagree here</span>
      <span class="cap" style="color:var(--dust); font-size:10.5px;">the net has it 3rd</span></div>
    <div style="font-size:12px; line-height:1.5; margin-top:5px;">The heuristic wants buying a development card:
      it keeps the ore free for a bank trade the net doesn't weigh the same way. The net takes
      <b style="color:${C.wheat};">the settlement on the 8 wood and 3 ore corner</b>: it reads four ply further
      out and prices the seven's discard risk more precisely. It is <b style="color:${C.wheat};">+3.8</b> ahead
      by the net's own reading.</div></div>`;

  // steps either side: 2 before, this one, 2 after — a native horizontal scroller, not the
  // swipe gesture Futures already owns
  const steps = [
    [22, 'orange', 'Bought a card', 30, false], [23, 'orange', 'Drew a knight', 45, false],
    [24, 'blue', 'Deciding now', 100, true], [25, 'blue', 'Builds the city', 62, false],
    [26, 'red', 'Red rolls a 7', -38, false],
  ];
  const film = `<div style="display:flex; justify-content:space-between; align-items:baseline; margin-top:2px;">
      <span style="font:600 12.5px var(--ui);">Steps either side</span>
      <span class="cap" style="font-size:10.5px;">how much the mover's chance moved</span></div>
    <div style="display:flex; gap:6px; overflow-x:auto; padding:8px 0 4px;">
      ${steps.map(([s, seat, action, mag, cur]) => filmCard(s, seat, action, mag, cur)).join('')}</div>`;

  const panel = scrub + head
    + `<div style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">${ladder}</div>`
    + disagree + film;

  const body = shell(
    spine(['Table', 'turn 24', 'Move'], null, 'blue', false, ''),
    stage, panel, null, STAGE_H_NOTABS,
  );
  write('MobileMove.dc.html', doc(CSS, body));
}
