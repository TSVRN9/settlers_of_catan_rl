// Screen 3 (v2): a round of play, with evaluation on and off.
import { writeSections } from './lib.mjs';
import { turn } from './turn.mjs';
import { off } from './off.mjs';

const t = turn(true), o = off(true), t0 = turn(false), o0 = off(false);
writeSections('play-v2.html', 'Playing a round', [
  { title: 'Your turn', sub: 'Round 9, frame by frame, evaluation on.', options: [
    { id: 'roll', name: 'Before the roll', phone: t.p1, notes: ['The build row and the trade row are one slab with the dice on it, same height, so the board never shifts.'] },
    { id: 'produce', name: 'The roll lands', phone: t.p2, notes: ['The dice tumble mid-board, then settle into the top bar before anything else moves. The two 8s rise with the pieces they feed; cards fly to whoever earned them.'] },
    { id: 'drag', name: 'Settlement in hand', phone: t.p3, notes: ['Its four cards rise inside the hand\'s own lane, clear of the row above. The piece floats above your finger; the legal spots appear only now, sized by pips.'] },
    { id: 'built', name: 'Set down', phone: t.p4, notes: ['Bars move, the changed stretch fades in; the grade sits on open sea beside the piece, never on a token, and fades after a beat.'] },
  ] },
  { title: 'Off-turn and the seven', sub: 'The slab under your hand changes job with the phase.', options: [
    { id: 'botturn', name: 'Red\'s turn', phone: o.pA, notes: ['Red\'s chip lifts, the others step back. Moves land on top of the list as their pieces land on the board.'] },
    { id: 'offer', name: 'Red offers a trade', phone: o.pB, notes: ['The two wheat it wants rise in the hand\'s lane; beside the offer, what accepting does to each of you.'] },
    { id: 'discard', name: 'Discard on a 7', phone: o.pC, notes: ['Drag or tap cards into the slots; the fifth commits. Suggest fills them with the engine\'s pick.'] },
    { id: 'steal', name: 'Robber: who to rob', phone: o.pD, notes: ['Both neighbours rise with their hand sizes, the counts set beside them on open board. Tap one.'] },
  ] },
  { title: 'Evaluation off', sub: 'The Eval switch in the top bar; the review after the game is unaffected.', options: [
    { id: 'built0', name: 'Set down', phone: t0.p4, notes: ['No bars, no percentages, no grade: chips are just seat, points, cards and dev cards.'] },
    { id: 'botturn0', name: 'Red\'s turn', phone: o0.pA, notes: ['The move list without swings.'] },
    { id: 'offer0', name: 'Red offers a trade', phone: o0.pB, notes: ['The offer without what it does to each side.'] },
    { id: 'discard0', name: 'Discard on a 7', phone: o0.pC, notes: ['No Suggest; the slots take the whole slab.'] },
  ] },
]);
