import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Board, { type Heat } from "../board/Board";
import Dialog from "../ui/Dialog";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import PlayerCards from "../analysis/PlayerCards";
import Forecast from "../analysis/Forecast";
import DecisionPanel from "../analysis/DecisionPanel";
import { engine, type BotKind, type BotSpec, type Canon, type Decision, type Evaluation, type GameState } from "../engine";
import { BOT_SHORT, PROMPTS, RESOURCES, RESOURCE_EMOJI, SEAT_NAMES, actionKey, fmtPct, label, outcomeText, packBundle, tradeText } from "../labels";

const BOT_OPTIONS = (["vnet", "heuristic", "random"] as BotKind[]).map((k) => ({ value: k, label: BOT_SHORT[k] }));
const SEAT_OPTIONS = SEAT_NAMES.map((n, i) => ({ value: String(i), label: n }));

interface Log { step: number; seat: number; action: Canon; note: string | null }

export default function Play() {
  const client = engine;
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const [human, setHuman] = useState(1);
  const [bots, setBots] = useState<BotSpec[]>([{ kind: "vnet", depth: 2 }, { kind: "vnet", depth: 2 }, { kind: "heuristic", depth: 2 }, { kind: "heuristic", depth: 2 }]);
  const [coach, setCoach] = useState(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Log[]>([]);
  const [evals, setEvals] = useState<Evaluation[] | null>(null);
  const [advice, setAdvice] = useState<Decision | null>(null);
  const [hover, setHover] = useState<Canon | null>(null);
  const [last, setLast] = useState<Canon | null>(null);
  const [dialog, setDialog] = useState<string | null>(null); // "trade" | "discard" | "dev" | "all"
  const gen = useRef(0);

  const lineup = useMemo(() => bots.map((b, s) => (s === human ? { kind: "human", depth: 2 } as BotSpec : b)), [bots, human]);

  const start = useCallback(async () => {
    gen.current++;
    inflight.current = false;
    setBusy("Loading engine…");
    const g = await client.newGame(seed);
    setLog([]); setLast(null); setAdvice(null);
    setEvals(await client.evaluateAll());
    setBusy(null);
    setGame(g);
  }, [client, seed]);

  // Bot turns and forced moves advance automatically; the human's decisions wait for the UI.
  // `inflight` (a ref, not state) guards re-entry so the effect is not cancelled by its own setBusy.
  const inflight = useRef(false);
  const advance = useCallback(async (action: Canon, seat: number, fromGame: GameState) => {
    const me = gen.current;
    const res = await client.apply(action);
    if (gen.current !== me) return;
    setLog((l) => [...l, { step: fromGame.view.steps, seat, action, note: outcomeText(action, res.outcome) }]);
    setLast(action);
    setAdvice(null);
    const ev = await client.evaluateAll();
    if (gen.current !== me) return;
    setEvals(ev);
    inflight.current = false;
    setBusy(null);
    setGame({ map: fromGame.map, view: res.view, legal: res.legal });
  }, [client]);

  useEffect(() => {
    if (!game || game.view.winner >= 0 || inflight.current) return;
    const seat = game.view.current_player;
    const spec = lineup[seat];
    const forced = game.legal.length === 1;
    if (spec.kind === "human" && !forced) {
      if (coach && !advice) {
        const me = gen.current;
        client.decide("vnet", 2).then((d) => { if (gen.current === me) setAdvice(d); });
      }
      return;
    }
    inflight.current = true;
    const me = gen.current;
    (async () => {
      setBusy(forced ? null : `${SEAT_NAMES[seat]} (${BOT_SHORT[spec.kind]}) is thinking…`);
      const d = forced ? null : await client.decide(spec.kind, spec.depth);
      await new Promise((r) => setTimeout(r, forced ? 120 : 350));
      if (gen.current !== me) { inflight.current = false; return; }
      await advance(d ? d.action : game.legal[0], seat, game);
    })().catch((e) => { console.error(e); inflight.current = false; setBusy(String(e)); });
  }, [game, lineup, client, coach, advice, advance]);

  const act = useCallback((a: Canon) => {
    if (!game || inflight.current) return;
    setDialog(null);
    inflight.current = true;
    setBusy("…");
    advance(a, game.view.current_player, game).catch((e) => { console.error(e); inflight.current = false; setBusy(String(e)); });
  }, [game, advance]);

  useEffect(() => {
    if (!game || game.view.current_player !== human) return;
    if (game.view.prompt === "DECIDE_TRADE") setDialog("reply");
    else if (game.view.prompt === "DECIDE_ACCEPTEES") setDialog("confirm");
  }, [game, human]);

  const heat: Heat | undefined = useMemo(() => {
    if (!advice || !coach) return undefined;
    const vals = advice.root.map(([, v]) => v ?? 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const h: Heat = {};
    for (const [a, v] of advice.root) h[actionKey(a)] = hi === lo ? 1 : ((v ?? lo) - lo) / (hi - lo);
    return h;
  }, [advice, coach]);

  const v = game?.view;
  const myTurn = !!v && v.current_player === human && v.winner < 0 && !busy && legalCount(game) > 1;
  const legal = game?.legal ?? [];
  const groups = useMemo(() => {
    const g: Record<string, Canon[]> = {};
    for (const a of legal) (g[a[0]] ??= []).push(a);
    return g;
  }, [legal]);
  const simple = (t: string) => groups[t]?.[0];
  const adviceOf = (a: Canon) => advice?.root.find(([b]) => actionKey(b) === actionKey(a))?.[1];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div>
        {!game && (
          <div className="card mb-4 grid gap-3 md:grid-cols-[1fr_1fr]">
            <div>
              <div className="label mb-1">Board seed</div>
              <div className="flex gap-2"><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="w-36" /><button className="btn" onClick={() => setSeed(Math.floor(Math.random() * 1e6))}>🎲</button></div>
            </div>
            <Select label="Your seat" value={String(human)} options={SEAT_OPTIONS} onChange={(s) => setHuman(Number(s))} />
            {bots.map((b, s) => s !== human && (
              <Select key={s} label={`${SEAT_NAMES[s]} bot`} value={b.kind} options={BOT_OPTIONS} onChange={(k) => setBots((bs) => bs.map((x, i) => (i === s ? { ...x, kind: k as BotKind } : x)))} />
            ))}
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <button className="btn btn-primary" onClick={start}>Start game</button>
              <span className="text-xs text-stone-500">Seat order is Red → Blue → Orange → White. Trade with the bank, at ports, or with other players.</span>
            </div>
          </div>
        )}
        {game && v && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">Turn {v.num_turns}</span>
              <span>· {SEAT_NAMES[v.current_player]} to {PROMPTS[v.prompt] ?? v.prompt}</span>
              {v.winner >= 0 && <span className="rounded bg-amber-500 px-2 py-0.5 font-semibold text-stone-950">🏆 {SEAT_NAMES[v.winner]} wins{v.winner === human ? " — that's you!" : ""}</span>}
              {busy && <span className="text-stone-500">{busy}</span>}
              <span className="ml-auto flex items-center gap-2"><span className="label">coach</span><Toggle label="coach" value={coach ? "on" : "off"} options={[{ value: "off", label: "off" }, { value: "on", label: "on" }]} onChange={(x) => setCoach(x === "on")} /><button className="btn" onClick={() => { gen.current++; setGame(null); }}>New game</button></span>
            </div>
            <Board map={game.map} view={v} legal={myTurn ? legal : []} onAction={act} heat={heat} highlight={hover} lastAction={last} />
            {myTurn && (
              <div className="card mt-3">
                <div className="mb-2 flex flex-wrap gap-2">
                  {simple("ROLL") && <button className="btn btn-primary" onClick={() => act(simple("ROLL")!)}>🎲 Roll {coach && <Adv v={adviceOf(simple("ROLL")!)} />}</button>}
                  {simple("END_TURN") && <button className="btn" onClick={() => act(simple("END_TURN")!)}>End turn {coach && <Adv v={adviceOf(simple("END_TURN")!)} />}</button>}
                  {simple("BUY_DEVELOPMENT_CARD") && <button className="btn" onClick={() => act(simple("BUY_DEVELOPMENT_CARD")!)}>Buy dev card {coach && <Adv v={adviceOf(simple("BUY_DEVELOPMENT_CARD")!)} />}</button>}
                  {(groups.PLAY_KNIGHT_CARD || groups.PLAY_YEAR_OF_PLENTY || groups.PLAY_MONOPOLY || groups.PLAY_ROAD_BUILDING) && <button className="btn" onClick={() => setDialog("dev")}>Play a card…</button>}
                  {groups.MARITIME_TRADE && <button className="btn" onClick={() => setDialog("trade")}>Trade with the bank… ({groups.MARITIME_TRADE.length})</button>}
                  {groups.DISCARD_RESOURCE && <button className="btn btn-primary" onClick={() => setDialog("discard")}>Discard…</button>}
                  {groups.MOVE_ROBBER && <button className="btn" onClick={() => setDialog("all")}>Choose robber target…</button>}
                  {groups.OFFER_TRADE && <button className="btn" onClick={() => setDialog("offer")}>Offer a trade…</button>}
                  {(groups.ACCEPT_TRADE || groups.REJECT_TRADE) && <button className="btn btn-primary" onClick={() => setDialog("reply")}>Answer the offer…</button>}
                  {(groups.CONFIRM_TRADE || groups.CANCEL_TRADE) && <button className="btn btn-primary" onClick={() => setDialog("confirm")}>Close the trade…</button>}
                  <button className="btn" onClick={() => setDialog("all")}>All {legal.length} legal actions…</button>
                </div>
                <p className="text-xs text-stone-500">{v.is_resolving_trade && v.prompt !== "DECIDE_TRADE" && v.prompt !== "DECIDE_ACCEPTEES" ? "" : ""}{groups.BUILD_SETTLEMENT || groups.BUILD_CITY || groups.BUILD_ROAD ? "Click a highlighted node or edge on the board to build. " : ""}{groups.MOVE_ROBBER ? "Click a highlighted tile to move the robber (the list picks who to rob). " : ""}{coach && advice ? `Coach: best is “${label(advice.action, game.map)}” at ${fmtPct(advice.value)}.` : coach ? "Coach is thinking…" : ""}</p>
              </div>
            )}
            <Dialog open={dialog === "all"} onClose={() => setDialog(null)} title="Legal actions">
              <ActionList actions={legal} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
            </Dialog>
            <Dialog open={dialog === "trade"} onClose={() => setDialog(null)} title="Trade with the bank">
              <ActionList actions={groups.MARITIME_TRADE ?? []} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
            </Dialog>
            <Dialog open={dialog === "discard"} onClose={() => setDialog(null)} title={`Discard ${v.discard_counts[human] ?? ""} card${(v.discard_counts[human] ?? 0) === 1 ? "" : "s"} (one at a time)`}>
              <ActionList actions={groups.DISCARD_RESOURCE ?? []} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
            </Dialog>
            <Dialog open={dialog === "offer"} onClose={() => setDialog(null)} title="Offer a trade">
              <OfferBuilder hand={v.players[human].hand} spent={v.spent_offers} onOffer={(give, get) => act(["OFFER_TRADE", packBundle(give), packBundle(get), -1])} />
            </Dialog>
            <Dialog open={dialog === "reply"} onClose={() => setDialog(null)} title={tradeText(v.current_trade)}>
              <ActionList actions={[...(groups.ACCEPT_TRADE ?? []), ...(groups.REJECT_TRADE ?? [])]} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
              {!groups.ACCEPT_TRADE && <p className="mt-2 text-xs text-stone-500">You do not hold what is asked, so you can only reject.</p>}
            </Dialog>
            <Dialog open={dialog === "confirm"} onClose={() => setDialog(null)} title="Who accepted your offer">
              <ActionList actions={[...(groups.CONFIRM_TRADE ?? []), ...(groups.CANCEL_TRADE ?? [])]} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
            </Dialog>
            <Dialog open={dialog === "dev"} onClose={() => setDialog(null)} title="Play a development card">
              <ActionList actions={[...(groups.PLAY_KNIGHT_CARD ?? []), ...(groups.PLAY_ROAD_BUILDING ?? []), ...(groups.PLAY_MONOPOLY ?? []), ...(groups.PLAY_YEAR_OF_PLENTY ?? [])]} onPick={act} adviceOf={coach ? adviceOf : undefined} mapOf={game.map} />
            </Dialog>
          </>
        )}
      </div>
      <aside className="space-y-3">
        {game && v && <PlayerCards view={v} names={lineup.map((b) => BOT_SHORT[b.kind])} reveal={(s) => s === human || v.winner >= 0} mover={v.current_player} />}
        {game && v && (
          <div className="card">
            <div className="label mb-1">Your hand</div>
            <div className="flex flex-wrap gap-2 text-sm">{RESOURCES.map((r, i) => <span key={r} className="rounded bg-stone-100 px-2 py-0.5 dark:bg-stone-800">{r} <b>{v.players[human].hand[i]}</b></span>)}</div>
          </div>
        )}
        {evals && v && <div className="card"><div className="label mb-1">Value-net win probability</div><Forecast evals={evals} actualVps={v.players.map((p) => p.actual_vp)} publicVps={v.players.map((p) => p.vp)} n={v.n} /></div>}
        {coach && advice && game && <div className="card"><div className="label mb-1">Coach: what the value net would do</div><DecisionPanel decision={advice} map={game.map} onHover={setHover} /></div>}
        {log.length > 0 && game && (
          <div className="card max-h-64 overflow-y-auto">
            <div className="label mb-1">Log</div>
            <ol className="space-y-0.5 text-xs">{[...log].reverse().slice(0, 60).map((l) => <li key={l.step}><span className="font-semibold">{SEAT_NAMES[l.seat]}</span> {label(l.action, game.map)}{l.note ? ` — ${l.note}` : ""}</li>)}</ol>
          </div>
        )}
      </aside>
    </div>
  );
}

function legalCount(g: GameState | null) { return g ? g.legal.length : 0; }

/** Any valid offer (the engine validates: hold what you give, no giveaways, no like-for-like, not spent this turn). */
function OfferBuilder({ hand, spent, onOffer }: { hand: number[]; spent: number[][]; onOffer: (give: number[], get: number[]) => void }) {
  const [give, setGive] = useState([0, 0, 0, 0, 0]);
  const [get, setGet] = useState([0, 0, 0, 0, 0]);
  const bump = (arr: number[], set: (a: number[]) => void, i: number, d: number, max: number) => set(arr.map((c, k) => (k === i ? Math.max(0, Math.min(max, c + d)) : c)));
  const sumGive = give.reduce((a, b) => a + b, 0), sumGet = get.reduce((a, b) => a + b, 0);
  const likeForLike = give.some((c, i) => c > 0 && get[i] > 0);
  const isSpent = spent.some((o) => o.every((c, i) => c === (i < 5 ? give[i] : get[i - 5])));
  const problem = sumGive === 0 || sumGet === 0 ? "give and receive at least one card" : likeForLike ? "the same resource cannot be on both sides" : isSpent ? "this offer was already rejected or cancelled this turn" : null;
  const row = (title: string, arr: number[], set: (a: number[]) => void, max: (i: number) => number) => (
    <div>
      <div className="label mb-1">{title}</div>
      <div className="grid grid-cols-5 gap-1">
        {RESOURCES.map((r, i) => (
          <div key={r} className="flex flex-col items-center rounded border border-stone-200 p-1 text-xs dark:border-stone-700">
            <span title={r}>{RESOURCE_EMOJI[i]}</span>
            <div className="flex items-center gap-1"><button className="btn px-1.5 py-0" onClick={() => bump(arr, set, i, -1, max(i))} aria-label={`fewer ${r}`}>−</button><b className="w-4 text-center">{arr[i]}</b><button className="btn px-1.5 py-0" onClick={() => bump(arr, set, i, 1, max(i))} aria-label={`more ${r}`}>+</button></div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      {row("You give (from your hand)", give, setGive, (i) => hand[i])}
      {row("You want", get, setGet, () => 19)}
      <div className="flex items-center gap-2">
        <button className="btn btn-primary" disabled={!!problem} onClick={() => onOffer(give, get)}>Offer</button>
        <span className="text-xs text-stone-500">{problem ?? "Each opponent answers in seat order; you then confirm one partner or cancel."}</span>
      </div>
    </div>
  );
}

function Adv({ v }: { v: number | null | undefined }) {
  return v == null ? null : <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] text-stone-900">{fmtPct(v)}</span>;
}

function ActionList({ actions, onPick, adviceOf, mapOf }: { actions: Canon[]; onPick: (a: Canon) => void; adviceOf?: (a: Canon) => number | null | undefined; mapOf: GameState["map"] }) {
  const rows = adviceOf ? [...actions].sort((a, b) => (adviceOf(b) ?? -1) - (adviceOf(a) ?? -1)) : actions;
  return (
    <ul className="space-y-1">
      {rows.map((a) => (
        <li key={actionKey(a)}><button className="btn w-full justify-between" onClick={() => onPick(a)}><span>{label(a, mapOf)}</span>{adviceOf && <Adv v={adviceOf(a)} />}</button></li>
      ))}
    </ul>
  );
}
