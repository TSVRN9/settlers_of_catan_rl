// Replicate the old views, changing four things and nothing else.
//
// Layout, panels, copy, numbers and spacing are left byte for byte as they were. The edits:
//   1. every board SVG (identified by the shared viewBox) is re-rendered with the current
//      board: plinth pieces with no strokes, larger number tokens, resource glyphs, the
//      restored ports, the grey fourth seat, no island outline, tapered lattice
//   2. the 76px left nav is removed, which was asked for earlier
//   3. the display headline and its sentence are removed from the top of every view — the
//      spine names the view now, so the headline was saying it twice and saying it grandly.
//      Where that sentence was an instruction rather than a situation, it moves to the
//      control it describes instead of being deleted (INSTRUCTIONS below)
//   4. the spine goes in at the top: the path on the left, whatever is waiting on the right.
//      It is the only permanent chrome in the app
import { readFileSync, writeFileSync } from 'node:fs';
import { board, spine, SPINE_CSS } from './board.mjs';

const DIR = new URL('./canvas/', import.meta.url).pathname;
const VB = '-236.72 -244.2 511.56 488.4';        // every old board carries exactly this

const SOURCES = [
  ['Console.dc.html',           'ViewConsole.dc.html'],
  ['PlayCoach.dc.html',         'ViewCoach.dc.html'],
  ['PlayFutures.dc.html',       'ViewFutures.dc.html'],
  ['AnalyzerInspector.dc.html', 'ViewMove.dc.html'],
  ['AnalyzerTimeline.dc.html',  'ViewGame.dc.html'],
  ['Table.dc.html',             'ViewTable.dc.html'],
];

// what each view's spine says at rest
// path, what is waiting, whose colour it is, and the step — which is a door of its own,
// into the whole-game analysis, from any view where a game is being played
const SPINE = {
  'ViewTable.dc.html':   [['Table'], 'your turn', 'blue', false, 'turn 31'],
  'ViewConsole.dc.html': [['Table', 'Console'], 'your turn', 'blue', false, 'turn 31'],
  'ViewCoach.dc.html':   [['Table', 'Coach'], 'your turn', 'blue', false, 'turn 31'],
  'ViewFutures.dc.html': [['Table', 'Futures'], 'your turn', 'blue', false, 'turn 31'],
  'ViewGame.dc.html':    [['Table', 'Step 214'], 'your turn', 'blue'],
  'ViewMove.dc.html':    [['Table', 'Step 214', "Red's move"], 'your turn', 'blue'],
};

// ── the headline, and the sentences that were really instructions ────────────────────
// Most of those sentences said what the screen already shows and go without replacement.
// Three of them told you how to work a control. Those move onto the control.
const INSTRUCTIONS = [
  ['ViewGame.dc.html',    'Who is winning, all game', 'after-row',
   'drag anywhere on the curve to move through the game'],
  ['ViewMove.dc.html',    'What Red weighed', 'after-row',
   'the outlined rank is what the heuristic would have played instead'],
  ['ViewFutures.dc.html', '<!-- the futures -->', 'after-open',
   'the ring on each marks what changed'],
];

// ── element scanning, because these are hand-written files and not a tree ─────────────
function endOfElement(s, i) {           // i is at the '<' of an open tag
  const tag = /^<(\w+)/.exec(s.slice(i))[1];
  const re = new RegExp(`</?${tag}\\b`, 'g');
  re.lastIndex = i;
  let depth = 0;
  for (let m; (m = re.exec(s)); ) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (!depth) return s.indexOf('>', m.index) + 1;
  }
  return s.length;
}

// The headline is always the first `.d` carrying a font-size, and the sentence under it is
// always the moss-coloured div that follows it. Both go.
function dropHeadline(s) {
  const i = s.indexOf('<div class="d" style="font-size:');
  if (i < 0) return [s, false];
  let end = endOfElement(s, i);
  const gap = /^\s*/.exec(s.slice(end))[0].length;
  const next = s.slice(end + gap);
  if (next.startsWith('<div style="margin-top:') && /^[^>]*color:var\(--moss\)/.test(next))
    end = endOfElement(s, end + gap);
  return [s.slice(0, i) + s.slice(end), true];
}

const caption = t => `<div style="font-size:12px; color:var(--moss); margin-top:6px;">${t}</div>`;

function relocate(s, anchor, mode, text) {
  const i = s.indexOf(anchor);
  if (i < 0) return [s, false];
  if (mode === 'after-open') {                        // as the first child of what follows
    const at = s.indexOf('>', s.indexOf('<', i + anchor.length)) + 1;
    return [s.slice(0, at) + caption(text) + s.slice(at), true];
  }
  const at = endOfElement(s, s.lastIndexOf('<div class="row"', i));   // under the title row
  return [s.slice(0, at) + caption(text) + s.slice(at), true];
}

// The spine sits above everything, so the root becomes a column and the old body is its
// second child. Nothing inside that body moves.
function addSpine(s, [path, warn, seat, loud, step]) {
  const i = s.indexOf('<div class="L"');
  const head = s.slice(i, s.indexOf('>', i) + 1);
  return s.slice(0, i)
       + head.replace('display:flex;', 'display:flex; flex-direction:column;')
       + spine(path, warn, seat, loud, step)
       + s.slice(i + head.length);
}

const addCSS = s => s.replace('</style>', SPINE_CSS + '</style>');

const attr = (tag, n) => (tag.match(new RegExp(`${n}="([^"]+)"`)) || [])[1];

// Overlays are annotation, not board: the ring on the recommended corner, the ring that
// marks what changed in a candidate, the outlined tiles a seat draws from. The copy
// refers to them, so they are lifted out of the old SVG and put back on top of the new
// board. The one thing deliberately not carried over is the island outline, which is the
// 30-point polygon and was asked to go.
function overlays(seg) {
  const out = [];
  for (const m of seg.matchAll(/<circle\b[^>]*fill="none"[^>]*\/>/g)) out.push(m[0]);
  for (const m of seg.matchAll(/<polygon\b[^>]*fill="none"[^>]*\/>/g))
    if ((m[0].match(/,/g) || []).length < 20) out.push(m[0]);
  return out.join('');
}

function swapBoards(src) {
  let out = '', i = 0, n = 0, marks = 0;
  for (;;) {
    const a = src.indexOf('<svg', i);
    if (a < 0) break;
    const close = src.indexOf('</svg>', a);
    if (close < 0) break;
    const end = close + 6;
    const head = src.slice(a, src.indexOf('>', a) + 1);
    if (attr(head, 'viewBox') === VB) {
      const w = parseFloat(attr(head, 'width'));
      // small boards are illustrations inside a panel: the grid, ports and watermarks
      // would only be noise at that size, so they carry tiles, pieces and numbers alone
      const small = w < 300;
      const keep = overlays(src.slice(a, end));
      const svg = board({ w, view: VB.split(' ').map(Number),
                          grid: !small, showPorts: !small, glyphs: !small });
      out += src.slice(i, a) + svg.replace('</svg>', keep + '</svg>');
      n++; marks += (keep.match(/<(circle|polygon)/g) || []).length;
      i = end;
    } else {
      out += src.slice(i, end);
      i = end;
    }
  }
  return [out + src.slice(i), n, marks];
}

// the left bar, removed. Its sibling is flex:1 so the content simply reflows to full width.
function dropNav(s) {
  const a = s.indexOf('<nav');
  if (a < 0) return [s, false];
  const b = s.indexOf('</nav>', a);
  if (b < 0) return [s, false];
  return [s.slice(0, a) + s.slice(b + 6), true];
}

for (const [from, to] of SOURCES) {
  let s = readFileSync(DIR + from, 'utf8');
  const [withBoards, count, marks] = swapBoards(s);
  const [noNav, navGone] = dropNav(withBoards);
  let [out, headGone] = dropHeadline(noNav);

  let moved = 0;
  for (const [file, anchor, mode, text] of INSTRUCTIONS)
    if (file === to) { const [o, ok] = relocate(out, anchor, mode, text); out = o; moved += ok ? 1 : 0; }

  // a new game is offered at the ending now, not from a header while one is running
  out = out.replace('<span class="act cut8" style="height:38px;">New game</span>', '');

  out = addCSS(addSpine(out, SPINE[to]));
  writeFileSync(DIR + to, out);
  console.log(`${to.padEnd(20)} from ${from.padEnd(24)} boards ${count}  overlays ${marks}  `
    + `nav ${navGone ? 'out' : '—'}  headline ${headGone ? 'out' : '—'}  moved ${moved}  spine in`);
}
