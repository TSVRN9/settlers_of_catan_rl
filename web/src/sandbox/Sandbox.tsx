// The sandbox (`#/sandbox`): a game at a real table, entered as it happens, read by the same net the bots play with.
// The board is set tile by tile, then every roll, placement, card and robber move goes into a log (session.ts) that
// the engine replays (sandbox.rs); the seats show their win chances from what your seat can know, and on your move
// the search ranks your options. One column, phone first; the desktop shows the same column.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Board from "../board/Board";
import Carry from "../board/Carry";
import Card from "../board/Card";
import { DESERT_FILL, PORT_FILL, PORT_GENERIC_FILL, RES_FILL, SEAT_FILL } from "../board/palette";
import { VIEWBOX, hex, portCentre, pts, tileCentre } from "../board/geometry";
import { EngineClient, isStale, type Canon, type Decision, type Evaluation, type MapView, type SandboxState, type View } from "../engine";
import { DEV_CARDS, RESOURCES, SEAT_NAMES, label } from "../labels";
import { heat, type HeldKind } from "../waiting";
import topo from "../data/topology.json";
import * as S from "./session";
import "../phone/phone.css";
import "./sandbox.css";

const SEATS = [0, 1, 2, 3];
const RES5 = [0, 1, 2, 3, 4];
const pct = (w: number | null | undefined) => (w == null ? "–" : `${Math.round(w * 100)}%`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const zero5 = () => [0, 0, 0, 0, 0];

function loadSaved(): S.Session {
  try {
    const t = localStorage.getItem(S.STORAGE_KEY);
    const s = t ? S.parse(t) : null;
    if (s) return s;
  } catch { /* storage blocked: start fresh */ }
  return S.blank();
}
function save(s: S.Session) {
  try { localStorage.setItem(S.STORAGE_KEY, S.serialize(s)); } catch { /* the file export still works */ }
}

/** The board being set up, as the engine would draw it: an unset tile as the desert, an unset port as 3:1 (the
 *  overlay marks both). */
function setupMap(b: S.Board): MapView {
  return {
    tiles: topo.tiles.map((t) => ({ id: t.id, resource: b.tiles[t.id]?.[0] ?? -1, number: b.tiles[t.id]?.[1] ?? 0, nodes: t.nodes })),
    ports: topo.ports.map((p) => ({ id: p.id, resource: b.ports[p.id] ?? -1, nodes: p.nodes })),
    edges: topo.edges as [number, number][],
  };
}
const EMPTY_VIEW: View = {
  n: 4, players: SEATS.map(() => ({ hand: zero5(), devs: zero5(), played: zero5(), vp: 0, actual_vp: 0, roads_available: 15, settlements_available: 5,
    cities_available: 4, has_road: false, has_army: false, has_rolled: false, has_played_dev: false, longest_road_length: 0, settlements: [], cities: [], roads: [] })),
  bank: [19, 19, 19, 19, 19], dev_deck: 25, owner: Array(54).fill(-1), is_city: Array(54).fill(false), road_owner: Array(72).fill(-1), road_color: -1,
  road_length: 0, robber: -1, current_player: 0, current_turn: 0, prompt: "", initial_phase: true, is_discarding: false, discard_counts: [0, 0, 0, 0],
  is_moving_knight: false, is_road_building: false, free_roads: 0, num_turns: 0, winner: -1, steps: 0, is_resolving_trade: false,
  current_trade: Array(11).fill(0), acceptees: [false, false, false, false], spent_offers: [],
};
// Reading order: tiles top row first, left to right; ports clockwise from the top.
const TILE_ORDER = topo.tiles.map((t) => ({ id: t.id, c: tileCentre(t.nodes) })).sort((a, b) => a.c[1] - b.c[1] || a.c[0] - b.c[0]).map((t) => t.id);
const PORT_ORDER = topo.ports.map((p) => ({ id: p.id, c: portCentre(p.nodes) }))
  .sort((a, b) => ((Math.atan2(a.c[0], -a.c[1]) + 2 * Math.PI) % (2 * Math.PI)) - ((Math.atan2(b.c[0], -b.c[1]) + 2 * Math.PI) % (2 * Math.PI))).map((p) => p.id);

type Sheet =
  | { kind: "menu" } | { kind: "log" } | { kind: "entry"; g: number }
  | { kind: "steal"; a: Canon } | { kind: "buy" } | { kind: "play" } | { kind: "yop" } | { kind: "mono" }
  | { kind: "bank" } | { kind: "trade" };

export default function Sandbox() {
  const client = useMemo(() => new EngineClient(), []);
  useEffect(() => () => client.terminate(), [client]);
  const [session, setSession] = useState<S.Session>(loadSaved);
  const [sim, setSim] = useState<SandboxState | null>(null);
  const [evals, setEvals] = useState<Evaluation[] | null>(null);
  const [advice, setAdvice] = useState<Decision | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [piece, setPiece] = useState<HeldKind | null>(null);
  const [robTile, setRobTile] = useState<number | null>(null);
  const [mark, setMark] = useState<Canon | null>(null);
  const hints = useRef<[number, number][]>([]);
  const gen = useRef(0);

  /** Show `next`: replay it, and keep it only if it fits — when `strictFrom` is given, entries from that index on
   *  must replay (a new entry that doesn't fit is turned away, with the engine's reason). */
  async function commit(next: S.Session, strictFrom?: number): Promise<boolean> {
    if (!next.started) { save(next); setSession(next); return true; }
    const my = ++gen.current;
    setBusy(true);
    try {
      const r = await client.sandbox(S.wire(next, hints.current));
      if (my !== gen.current) return false;
      if (strictFrom != null && r.fault && r.fault.at >= strictFrom) { setFlash(r.fault.message); return false; }
      hints.current = r.resolved;
      save(next); setSession(next); setSim(r); setFlash(null); setAdvice(null); setMark(null); setPiece(null); setRobTile(null);
      void analyse(r, next.you, my);
      return true;
    } catch (e) {
      if (!isStale(e)) setFlash(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (my === gen.current) setBusy(false);
    }
  }
  async function analyse(r: SandboxState, you: number, my: number) {
    try {
      const rd = await client.evaluateAll(you);
      if (my !== gen.current) return;
      setEvals(rd.pub);
      if (r.view.current_player === you && r.view.winner < 0 && !r.fault && r.legal.length > 1) {
        const d = await client.decide("vnet", 2, true);
        if (my === gen.current) setAdvice(d);
      }
    } catch (e) { if (!isStale(e)) setFlash(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { if (session.started) void commit(session); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const enter = (entries: Omit<S.Entry, "g">[]) => { setSheet(null); return commit(S.append(session, entries), session.log.length); };
  const back = () => { location.hash = ""; };

  if (!session.started) return <Setup session={session} onChange={(s) => void commit(s)} onBack={back} flash={flash} />;
  if (!sim) return <div className="ph sb"><Top title="Sandbox" onBack={back} /></div>;

  const v = sim.view, map = sim.map, you = session.you, cur = v.current_player;
  const pl = v.players[cur];
  const rolled = pl.has_rolled;
  const prompt = v.prompt;
  const over = v.winner >= 0;
  const faulty = !!sim.fault;
  const free = !faulty && !over && !busy;
  // The piece the board is waiting for: the game's own (the opening, the robber, Road Building), else one picked up.
  const held: HeldKind | null = !free ? null
    : prompt === "MOVE_ROBBER" ? "robber"
    : prompt === "BUILD_INITIAL_SETTLEMENT" ? "settlement"
    : prompt === "BUILD_INITIAL_ROAD" ? "road"
    : prompt === "PLAY_TURN" && v.is_road_building ? "road"
    : prompt === "PLAY_TURN" && rolled ? piece : null;
  const spots = v.initial_phase ? sim.legal : sim.placements;
  const phase = over ? "wins" : prompt === "BUILD_INITIAL_SETTLEMENT" ? "settlement" : prompt === "BUILD_INITIAL_ROAD" ? "road"
    : prompt === "DISCARD" ? `discards ${v.discard_counts[cur]}` : prompt === "MOVE_ROBBER" ? "robber"
    : v.is_road_building ? `${v.free_roads} free road${v.free_roads === 1 ? "" : "s"}` : rolled ? "turn" : "roll";
  const onPlace = (a: Canon) => {
    if (a[0] === "MOVE_ROBBER" && a[2] >= 0 && (cur === you || a[2] === you)) { setSheet({ kind: "steal", a }); return; }
    void enter([{ a, o: null }]);
  };
  const top = advice ? [...advice.root].filter(([, x]) => x != null).sort((p, q) => (q[1] ?? 0) - (p[1] ?? 0)).slice(0, 3) : [];

  return (
    <div className="ph sb">
      <Top title={<><i className="sw" style={{ background: SEAT_FILL[over ? v.winner : cur] }} />{cur === you && !over ? "You" : SEAT_NAMES[over ? v.winner : cur]} · {phase}</>}
           onBack={back} onUndo={session.log.length ? () => void commit(S.undo(session)) : undefined} onMenu={() => setSheet({ kind: "menu" })} busy={busy} />
      <div className="ph-chips sb-chips">
        {SEATS.map((i) => {
          const p = v.players[i];
          return (
            <div key={i} className={`ph-chip cut8${i === cur && !over ? " on" : ""}${i === you ? " you" : ""}`}>
              <div className="ph-chip-row" aria-label={i === you ? "You" : SEAT_NAMES[i]}>
                <i className="sw" style={{ background: SEAT_FILL[i] }} />
                <span className="d num vp">{i === you ? p.actual_vp : p.vp}</span>
                <span className="num pct">{pct(evals?.[i]?.win)}</span>
              </div>
              <div className="ph-chip-row small">
                <span className="ct"><svg viewBox="0 0 14 16" width="10" height="12" aria-hidden="true"><rect x="1" y="1" width="12" height="14" rx="1.5" fill="currentColor" opacity=".55" /></svg>
                  <span className="num">{sum(p.hand)}</span></span>
                <span className="ct"><svg viewBox="0 0 32 32" width="12" height="12" aria-hidden="true"><rect x="7" y="4" width="18" height="24" rx="2" fill="currentColor" /></svg>
                  <span className="num">{sum(p.devs)}</span></span>
              </div>
              <div className="bar"><i style={{ width: `${(evals?.[i]?.win ?? 0) * 100}%`, background: SEAT_FILL[i] }} /></div>
            </div>
          );
        })}
      </div>
      <div className="ph-board">
        <div className="sb-anchor">
          <Board map={map} view={v} highlight={mark} robberLifted={held === "robber"} />
          {held && (
            <Carry map={map} view={v} legal={spots} seat={cur} held={{ kind: held, auto: true, drag: false, x0: 0, y0: 0 }} robTile={robTile} reveal={false}
                   heat={cur === you ? heat(advice) : undefined} snapPx={24} liftPx={56} keepOnMiss
                   onPlace={onPlace} onRobTile={setRobTile} onDrop={() => setPiece(null)} onClickCarry={() => {}} />
          )}
        </div>
      </div>
      <div className="ph-seat sb-seat">
        {flash && <div className="ph-err" role="alert">{flash}</div>}
        {faulty ? (
          <div className="ph-row">
            <div className="sb-fault">{sim.fault!.message}</div>
            <button className="ph-btn go cut8" onClick={() => setSheet({ kind: "log" })}>Log</button>
          </div>
        ) : over ? null : prompt === "PLAY_TURN" && !rolled ? (
          <div className="sb-dice">
            {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
              <button key={n} className={`ph-btn cut5 d${n === 7 ? " seven" : ""}`} disabled={!free} onClick={() => void enter([{ a: ["ROLL", -1, -1, -1], o: S.SUM_PAIR[n] }])}>{n}</button>
            ))}
            <button className="ph-btn cut5 sb-knight" disabled={!free || sum(pl.devs) === 0 || pl.has_played_dev}
                    onClick={() => void enter([{ a: ["PLAY_KNIGHT_CARD", -1, -1, -1], o: null }])} aria-label="Play a knight">
              <Card dev={0} width={30} height={40} />
            </button>
          </div>
        ) : prompt === "DISCARD" ? (
          <Discard key={`${v.steps}`} need={v.discard_counts[cur]} hand={cur === you ? pl.hand : null} disabled={!free}
                   onDone={(counts) => void enter(RES5.flatMap((r) => Array.from({ length: counts[r] }, () => ({ a: ["DISCARD_RESOURCE", r, -1, -1] as Canon, o: null }))))} />
        ) : prompt === "PLAY_TURN" && rolled && !v.is_road_building ? (
          <div className="sb-turn">
            <div className="ph-row">
              {(["road", "settlement", "city"] as HeldKind[]).map((k) => (
                <button key={k} className={`ph-btn cut5${piece === k ? " go" : ""}`} disabled={!free} aria-pressed={piece === k}
                        onClick={() => setPiece(piece === k ? null : k)}>{k === "road" ? "Road" : k === "settlement" ? "Settlement" : "City"}</button>
              ))}
              <button className="ph-btn cut5" disabled={!free} onClick={() => cur === you ? setSheet({ kind: "buy" }) : void enter([{ a: ["BUY_DEVELOPMENT_CARD", -1, -1, -1], o: null }])}>Dev card</button>
            </div>
            <div className="ph-row">
              <button className="ph-btn cut5" disabled={!free || sum(pl.devs) === 0 || pl.has_played_dev} onClick={() => setSheet({ kind: "play" })}>Play</button>
              <button className="ph-btn cut5" disabled={!free} onClick={() => setSheet({ kind: "bank" })}>Bank</button>
              <button className="ph-btn cut5" disabled={!free} onClick={() => setSheet({ kind: "trade" })}>Trade</button>
              <button className="ph-btn go cut5" disabled={!free} onClick={() => void enter([{ a: ["END_TURN", -1, -1, -1], o: null }])}>End turn</button>
            </div>
          </div>
        ) : null}
        {!faulty && cur === you && !over && (
          <div className="sb-advice" aria-busy={!advice}>
            {(advice ? top : [null, null, null]).map((row, k) => row ? (
              <button key={k} className={`sb-tip cut5${mark && row[0].join() === mark.join() ? " on" : ""}`} onClick={() => setMark(mark && row[0].join() === mark.join() ? null : row[0])}>
                <span className="tx">{label(row[0], map)}</span><span className="num">{pct(row[1])}</span>
              </button>
            ) : <div key={k} className="sb-tip cut5 wait" />)}
          </div>
        )}
      </div>

      {sheet && (
        <div className="ph-scrim" onClick={() => setSheet(null)}>
          <div className="ph-sheet cut" role="dialog" onClick={(e) => e.stopPropagation()}>
            <SheetBody key={sheet.kind} sheet={sheet} session={session} sim={sim} cur={cur} you={you} close={() => setSheet(null)} setSheet={setSheet}
                       enter={enter} commit={commit} setFlash={setFlash} />
          </div>
        </div>
      )}
    </div>
  );
}

function Top({ title, onBack, onUndo, onMenu, busy }: { title: ReactNode; onBack: () => void; onUndo?: () => void; onMenu?: () => void; busy?: boolean }) {
  return (
    <div className="ph-top sb-top">
      <button className="ph-back" onClick={onBack} aria-label="Back">‹</button>
      <span className="ph-title d">{title}</span>
      {onUndo !== undefined || onMenu ? <span className="sb-tools">
        <button className="sb-icon" onClick={onUndo} disabled={!onUndo || busy} aria-label="Undo">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 -3)" /></svg>
        </button>
        <button className="sb-icon" onClick={onMenu} aria-label="Menu">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </button>
      </span> : null}
    </div>
  );
}

/** A row of the five resource cards, each a button showing its count; a tap adds one. */
function Cards({ counts, onTap, enabled, w = 52 }: { counts: number[]; onTap: (r: number) => void; enabled?: (r: number) => boolean; w?: number }) {
  return (
    <div className="sb-cards">
      {RES5.map((r) => (
        <Card key={r} resource={r} width={w} height={Math.round(w * 1.36)} count={counts[r] || undefined} selected={counts[r] > 0}
              disabled={enabled ? !enabled(r) : false} onClick={() => onTap(r)} />
      ))}
    </div>
  );
}

function Discard({ need, hand, disabled, onDone }: { need: number; hand: number[] | null; disabled: boolean; onDone: (c: number[]) => void }) {
  const [c, setC] = useState(zero5);
  const n = sum(c);
  return (
    <div className="sb-col">
      <Cards counts={c} onTap={(r) => setC((x) => x.map((y, i) => (i === r ? y + 1 : y)))} enabled={(r) => n < need && (!hand || c[r] < hand[r])} />
      <div className="ph-row">
        <button className="ph-btn cut5" disabled={!n} onClick={() => setC(zero5())}>Clear</button>
        <button className="ph-btn go cut5" disabled={disabled || n !== need} onClick={() => onDone(c)}>Discard {n}/{need}</button>
      </div>
    </div>
  );
}

interface SheetProps {
  sheet: Sheet; session: S.Session; sim: SandboxState; cur: number; you: number;
  close: () => void; setSheet: (s: Sheet | null) => void;
  enter: (e: Omit<S.Entry, "g">[]) => Promise<boolean>; commit: (s: S.Session, strictFrom?: number) => Promise<boolean>; setFlash: (f: string | null) => void;
}

function Head({ seat, text }: { seat?: number; text: string }) {
  return <div className="hd">{seat != null && <i style={{ background: SEAT_FILL[seat] }} />}<span className="d">{text}</span></div>;
}

function SheetBody(p: SheetProps) {
  const { sheet, session, sim, cur, you, close, setSheet, enter } = p;
  const v = sim.view;
  const [a, setA] = useState(zero5);
  const [b, setB] = useState(zero5);
  const [partner, setPartner] = useState<number | null>(null);
  const [res, setRes] = useState<number | null>(null);
  const [took, setTook] = useState<number[]>(() => v.players.map((pl, i) => (i === you && i !== cur ? pl.hand[0] : 0)));
  const [sure, setSure] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const others = SEATS.filter((i) => i !== cur);

  switch (sheet.kind) {
    case "steal": {
      const victim = sheet.a[2];
      return <>
        <Head seat={victim} text={victim === you ? "You lose" : `${SEAT_NAMES[victim]} loses`} />
        <Cards counts={zero5()} enabled={(r) => victim !== you || v.players[you].hand[r] > 0} onTap={(r) => void enter([{ a: sheet.a, o: [r, -1] }])} />
      </>;
    }
    case "buy":
      return <>
        <Head seat={cur} text="Dev card" />
        <div className="sb-cards">
          {[0, 1, 2, 3, 4].map((d) => <Card key={d} dev={d} width={52} height={71} onClick={() => void enter([{ a: ["BUY_DEVELOPMENT_CARD", -1, -1, -1], o: [d, -1] }])} />)}
        </div>
      </>;
    case "play":
      return <>
        <Head seat={cur} text="Play" />
        {[["Knight", ["PLAY_KNIGHT_CARD", -1, -1, -1]], ["Year of Plenty", null], ["Monopoly", null], ["Road Building", ["PLAY_ROAD_BUILDING", -1, -1, -1]]].map(([name, act], k) => (
          <button key={k} className="ph-pickrow cut5" onClick={() => act ? void enter([{ a: act as Canon, o: null }]) : setSheet({ kind: k === 1 ? "yop" : "mono" })}>
            <Card dev={k} width={26} height={35} /><b>{name as string}</b>
          </button>
        ))}
      </>;
    case "yop":
      return <>
        <Head seat={cur} text={DEV_CARDS[1]} />
        <Cards counts={a} enabled={() => sum(a) < 2} onTap={(r) => setA((x) => x.map((y, i) => (i === r ? y + 1 : y)))} />
        <div className="ph-row">
          <button className="ph-btn cut5" onClick={() => setA(zero5())}>Clear</button>
          <button className="ph-btn go cut5" disabled={sum(a) !== 2} onClick={() => {
            const rs = RES5.flatMap((r) => Array(a[r]).fill(r));
            void enter([{ a: ["PLAY_YEAR_OF_PLENTY", rs[0], rs[1], -1], o: null }]);
          }}>Take</button>
        </div>
      </>;
    case "mono":
      return <>
        <Head seat={cur} text={DEV_CARDS[2]} />
        <Cards counts={res == null ? zero5() : RES5.map((r) => (r === res ? 1 : 0))} onTap={(r) => {
          setRes(r);
          setTook(v.players.map((pl, i) => (i === you && i !== cur ? pl.hand[r] : 0)));
        }} />
        {res != null && others.map((i) => (
          <div key={i} className="sb-step">
            <i style={{ background: SEAT_FILL[i] }} /><b>{i === you ? "You" : SEAT_NAMES[i]}</b>
            <button className="ph-btn cut5" disabled={i === you || took[i] === 0} onClick={() => setTook((t) => t.map((x, j) => (j === i ? x - 1 : x)))} aria-label="One fewer">−</button>
            <span className="d num">{took[i]}</span>
            <button className="ph-btn cut5" disabled={i === you || took[i] >= 19} onClick={() => setTook((t) => t.map((x, j) => (j === i ? x + 1 : x)))} aria-label="One more">+</button>
          </div>
        ))}
        <button className="ph-btn go cut5" disabled={res == null} onClick={() => void enter([{ a: ["PLAY_MONOPOLY", res!, -1, -1], o: null, took }])}>Take {sum(took)}</button>
      </>;
    case "bank": {
      const rate = (r: number) => S.rateFor(cur, r, sim.map.ports, v.owner);
      const give = a.findIndex((x) => x > 0), get = b.findIndex((x) => x > 0);
      return <>
        <Head seat={cur} text="Bank" />
        <Cards counts={give < 0 ? zero5() : RES5.map((r) => (r === give ? rate(r) : 0))} onTap={(r) => setA(RES5.map((x) => (x === r ? 1 : 0)))} />
        <Cards counts={b} enabled={(r) => r !== give} onTap={(r) => setB(RES5.map((x) => (x === r ? 1 : 0)))} />
        <button className="ph-btn go cut5" disabled={give < 0 || get < 0} onClick={() => void enter([{ a: ["MARITIME_TRADE", give, rate(give), get], o: null }])}>
          {give < 0 || get < 0 ? "Trade" : `${rate(give)} ${RESOURCES[give]} → 1 ${RESOURCES[get]}`}
        </button>
      </>;
    }
    case "trade": {
      const ok = partner != null && sum(a) > 0 && sum(b) > 0 && RES5.every((r) => !(a[r] && b[r]));
      return <>
        <div className="ph-row">
          {others.map((i) => (
            <button key={i} className={`ph-btn cut5 sb-seatbtn${partner === i ? " go" : ""}`} aria-pressed={partner === i} onClick={() => setPartner(i)}>
              <i style={{ background: SEAT_FILL[i] }} />{i === you ? "You" : SEAT_NAMES[i]}
            </button>
          ))}
        </div>
        <Head seat={cur} text={cur === you ? "You give" : `${SEAT_NAMES[cur]} gives`} />
        <Cards counts={a} w={48} enabled={(r) => !b[r]} onTap={(r) => setA((x) => x.map((y, i) => (i === r ? y + 1 : y)))} />
        <Head seat={partner ?? undefined} text={partner == null ? "…" : partner === you ? "You give" : `${SEAT_NAMES[partner]} gives`} />
        <Cards counts={b} w={48} enabled={(r) => !a[r]} onTap={(r) => setB((x) => x.map((y, i) => (i === r ? y + 1 : y)))} />
        <div className="ph-row">
          <button className="ph-btn cut5" onClick={() => { setA(zero5()); setB(zero5()); }}>Clear</button>
          <button className="ph-btn go cut5" disabled={!ok} onClick={() => void enter(S.tradeEntries(cur, partner!, a, b))}>Trade</button>
        </div>
      </>;
    }
    case "menu":
      return <>
        <button className="ph-pickrow cut5" onClick={() => setSheet({ kind: "log" })}><b>Log</b><span className="num">{groups(session.log).length}</span></button>
        <button className="ph-pickrow cut5" onClick={() => {
          const url = URL.createObjectURL(new Blob([S.serialize(session)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `catan-sandbox-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`;
          link.click();
          URL.revokeObjectURL(url);
          close();
        }}><b>Save file</b></button>
        <button className="ph-pickrow cut5" onClick={() => file.current?.click()}><b>Load file</b></button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const s = S.parse(await f.text());
          close();
          if (!s) { p.setFlash("Not a sandbox file"); return; }
          void p.commit(s);
        }} />
        <button className={`ph-pickrow cut5${sure ? " out" : ""}`} onClick={() => { if (!sure) { setSure(true); return; } close(); void p.commit(S.blank()); }}>
          <b>{sure ? "Clear this game" : "New game"}</b>
        </button>
      </>;
    case "log":
      return <Log session={session} sim={sim} you={you} onPick={(g) => setSheet({ kind: "entry", g })} />;
    case "entry": {
      const idx = session.log.findIndex((e) => e.g === sheet.g);
      const e = session.log[idx];
      if (!e) return null;
      const actor = sim.actors[idx];
      const setO = (o: [number, number] | null) => { close(); void p.commit(S.setOutcome(session, idx, o)); };
      return <>
        <Head seat={actor} text={describe(session.log.filter((x) => x.g === sheet.g), sim.map, you)} />
        {e.a[0] === "ROLL" && (
          <div className="sb-dice">
            {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => <button key={n} className="ph-btn cut5 d" onClick={() => setO(S.SUM_PAIR[n])}>{n}</button>)}
          </div>
        )}
        {e.a[0] === "MOVE_ROBBER" && e.a[2] >= 0 && <>
          <Cards counts={e.o ? RES5.map((r) => (r === e.o![0] ? 1 : 0)) : zero5()} onTap={(r) => setO([r, -1])} />
          <button className="ph-btn cut5" disabled={!e.o} onClick={() => setO(null)}>?</button>
        </>}
        {e.a[0] === "BUY_DEVELOPMENT_CARD" && <>
          <div className="sb-cards">{[0, 1, 2, 3, 4].map((d) => <Card key={d} dev={d} width={52} height={71} selected={e.o?.[0] === d} onClick={() => setO([d, -1])} />)}</div>
          <button className="ph-btn cut5" disabled={!e.o} onClick={() => setO(null)}>?</button>
        </>}
        <button className="ph-pickrow out cut5" onClick={() => { close(); void p.commit(S.removeGroup(session, sheet.g)); }}><b>Delete</b></button>
      </>;
    }
  }
}

function groups(log: S.Entry[]) {
  const out: { g: number; at: number; entries: S.Entry[] }[] = [];
  log.forEach((e, i) => {
    const last = out[out.length - 1];
    if (last && last.g === e.g) last.entries.push(e);
    else out.push({ g: e.g, at: i, entries: [e] });
  });
  return out;
}

/** An entry group as one line: a trade by what changed hands, a discard by its cards, a roll by its sum. */
function describe(es: S.Entry[], map: MapView, you: number): string {
  const e = es[0];
  const [t, x, y] = e.a;
  if (t === "OFFER_TRADE") {
    const partner = es.find((q) => q.a[0] === "CONFIRM_TRADE")?.a[1] ?? -1;
    return `${label(e.a, map).replace(/^Offer/, "Trade")} with ${partner === you ? "you" : SEAT_NAMES[partner] ?? "?"}`;
  }
  if (t === "DISCARD_RESOURCE") return `Discard ${es.map((q) => RESOURCES[q.a[1]]).join(", ")}`;
  if (t === "ROLL") return `Roll ${e.o ? e.o[0] + e.o[1] : "?"}`;
  if (t === "MOVE_ROBBER" && y >= 0) return `${label(e.a, map)}: ${e.o ? RESOURCES[e.o[0]] : "?"}`;
  if (t === "BUY_DEVELOPMENT_CARD") return `Dev card: ${e.o ? DEV_CARDS[e.o[0]] : "?"}`;
  if (t === "PLAY_MONOPOLY" && e.took) return `Monopoly on ${RESOURCES[x]}: ${sum(e.took)}`;
  return label(e.a, map);
}

function Log({ session, sim, you, onPick }: { session: S.Session; sim: SandboxState; you: number; onPick: (g: number) => void }) {
  const gs = groups(session.log).reverse();
  const bad = sim.fault ? session.log[sim.fault.at]?.g : null;
  return (
    <div className="sb-log">
      {gs.map(({ g, at, entries }) => (
        <button key={g} className={`ph-pickrow cut5${g === bad ? " bad" : ""}`} onClick={() => onPick(g)}>
          <i style={{ background: sim.actors[at] != null ? SEAT_FILL[sim.actors[at]] : "transparent" }} />
          <span className="who"><b>{describe(entries, sim.map, you)}</b>{g === bad && <small>{sim.fault!.message}</small>}</span>
        </button>
      ))}
    </div>
  );
}

/** Setting the board: tap a tile, then its resource and number; tap a port, then its kind. Each pick moves on to the
 *  next piece still to set. Then your seat, and Start. */
function Setup({ session, onChange, onBack, flash }: { session: S.Session; onChange: (s: S.Session) => void; onBack: () => void; flash: string | null }) {
  const b = session.board;
  const firstTile = () => TILE_ORDER.find((t) => !b.tiles[t] || (b.tiles[t]![0] >= 0 && !b.tiles[t]![1]));
  const [sel, setSel] = useState<{ tile: number } | { port: number } | null>(() => {
    const t = firstTile();
    if (t != null) return { tile: t };
    const p = PORT_ORDER.find((q) => b.ports[q] == null);
    return p != null ? { port: p } : null;
  });
  const map = useMemo(() => setupMap(b), [b]);
  const left = S.left(b);
  const done = S.boardComplete(b);
  const nextAfter = (s: S.Session) => {
    const t = TILE_ORDER.find((x) => !s.board.tiles[x] || (s.board.tiles[x]![0] >= 0 && !s.board.tiles[x]![1]));
    if (t != null) return { tile: t };
    const p = PORT_ORDER.find((q) => s.board.ports[q] == null);
    return p != null ? { port: p } : null;
  };
  const go = (s: S.Session, advance: boolean) => { onChange(s); if (advance) setSel(nextAfter(s)); };
  const centres = map.tiles.map((t) => tileCentre(t.nodes));
  const tile = sel && "tile" in sel ? sel.tile : null;
  const port = sel && "port" in sel ? sel.port : null;
  const tv = tile != null ? b.tiles[tile] : null;

  return (
    <div className="ph sb">
      <Top title="Sandbox" onBack={onBack} />
      <div className="ph-board">
        <div className="sb-anchor">
          <Board map={map} view={EMPTY_VIEW} />
          <svg className="sb-over" viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}>
            {map.tiles.map((t, i) => (
              <polygon key={t.id} points={pts(hex(centres[i][0], centres[i][1], 41.5))} data-tile={t.id}
                       className={`sb-hex${b.tiles[t.id] ? "" : " unset"}${tile === t.id ? " sel" : ""}`} onClick={() => setSel({ tile: t.id })} />
            ))}
            {map.ports.map((q) => {
              const [x, y] = portCentre(q.nodes);
              return <circle key={q.id} cx={x} cy={y} r={33} data-port={q.id} className={`sb-port${b.ports[q.id] == null ? " unset" : ""}${port === q.id ? " sel" : ""}`}
                             onClick={() => setSel({ port: q.id })} />;
            })}
          </svg>
        </div>
      </div>
      <div className="ph-seat sb-seat">
        {flash && <div className="ph-err" role="alert">{flash}</div>}
        {tile != null && <>
          <div className="sb-cards">
            {[0, 1, 2, 3, 4, -1].map((r) => (
              <button key={r} className={`sb-res cut5${tv?.[0] === r ? " on" : ""}`} disabled={left.tiles[r] <= 0 && tv?.[0] !== r}
                      style={{ background: r < 0 ? DESERT_FILL : RES_FILL[r] }} aria-label={r < 0 ? "Desert" : RESOURCES[r]}
                      onClick={() => go(S.setTile(session, tile, r), r < 0)}>
                <span className="num">{left.tiles[r]}</span>
              </button>
            ))}
          </div>
          <div className="sb-nums">
            {[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((n) => (
              <button key={n} className={`ph-btn cut5 d${n === 6 || n === 8 ? " hot" : ""}${tv?.[1] === n ? " go" : ""}`}
                      disabled={!tv || tv[0] < 0 || (left.numbers[n] <= 0 && tv[1] !== n)} onClick={() => go(S.setNumber(session, tile, n), true)}>{n}</button>
            ))}
          </div>
        </>}
        {port != null && (
          <div className="sb-cards">
            {[0, 1, 2, 3, 4, -1].map((r) => (
              <button key={r} className={`sb-res cut5${b.ports[port] === r ? " on" : ""}`} disabled={left.ports[r] <= 0 && b.ports[port] !== r}
                      style={{ background: r < 0 ? PORT_GENERIC_FILL : PORT_FILL[r] }} aria-label={r < 0 ? "3:1" : `2:1 ${RESOURCES[r]}`}
                      onClick={() => go(S.setPort(session, port, r), true)}>
                <span className="num">{r < 0 ? "3:1" : "2:1"}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ph-row sb-you">
          {SEATS.map((i) => (
            <button key={i} className={`ph-btn cut5 sb-seatbtn${session.you === i ? " go" : ""}`} aria-pressed={session.you === i}
                    onClick={() => onChange({ ...session, you: i })} aria-label={`You play ${["first", "second", "third", "fourth"][i]}`}>
              <i style={{ background: SEAT_FILL[i] }} />{i + 1}
            </button>
          ))}
          <button className="ph-btn go cut5 sb-start" disabled={!done} onClick={() => onChange({ ...session, started: true })}>Start</button>
        </div>
      </div>
    </div>
  );
}
