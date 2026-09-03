import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Board, { type Heat } from "../board/Board";
import Slider from "../ui/Slider";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import WinProbTimeline from "../analysis/WinProbTimeline";
import Forecast from "../analysis/Forecast";
import DecisionPanel from "../analysis/DecisionPanel";
import AttributionPanel from "../analysis/Attribution";
import PlayerCards from "../analysis/PlayerCards";
import { engine, type BotKind, type BotSpec, type Canon, type Frame, type MapView } from "../engine";
import { BOT_SHORT, PROMPTS, SEAT_NAMES, actionKey, label, outcomeText, tradeText } from "../labels";

const BOT_OPTIONS = (["vnet", "heuristic", "random"] as BotKind[]).map((k) => ({ value: k, label: BOT_SHORT[k] }));

function readHash(): { seed: number; bots: BotSpec[]; step: number; depth: number } {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const kinds = (q.get("lineup") ?? "vnet,heuristic,heuristic,heuristic").split(",");
  const depth = Number(q.get("depth") ?? 2);
  return {
    seed: Number(q.get("seed") ?? Math.floor(Math.random() * 1e6)),
    bots: [0, 1, 2, 3].map((i) => ({ kind: (kinds[i] as BotKind) ?? "heuristic", depth })),
    step: Number(q.get("step") ?? 0),
    depth,
  };
}

export default function Watch() {
  const client = engine;
  const init = useMemo(readHash, []);
  const [seed, setSeed] = useState(init.seed);
  const [bots, setBots] = useState<BotSpec[]>(init.bots);
  const [depth, setDepth] = useState(init.depth);
  const [map, setMap] = useState<MapView | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(init.step);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<Canon | null>(null);
  const [showHeat, setShowHeat] = useState(true);
  const started = useRef(false);

  const run = useCallback(async () => {
    setRunning(true); setFrames([]); setStep(0); setPlaying(false);
    const specs = bots.map((b) => ({ ...b, depth }));
    location.hash = `#/watch?seed=${seed}&lineup=${specs.map((b) => b.kind).join(",")}&depth=${depth}`;
    // Streamed frames land as the worker plays; the first batch includes the board.
    let all: Frame[] = [];
    const res = await client.run(seed, specs, (batch) => { all = all.concat(batch); setFrames(all); });
    setMap(res.map); setFrames(res.frames); setRunning(false);
  }, [client, seed, bots, depth]);

  useEffect(() => { if (!map && frames.length) client.newGame(seed).then((g) => setMap(g.map)); }, [frames.length > 0, map, client, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  // Deep links (#/watch?seed=…) auto-run once.
  useEffect(() => { if (!started.current && location.hash.includes("seed=")) { started.current = true; run(); } }, [run]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => (s + 1 < frames.length ? s + 1 : (setPlaying(false), s))), 500);
    return () => clearInterval(t);
  }, [playing, frames.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, frames.length - 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);
  useEffect(() => {
    if (frames.length && location.hash.startsWith("#/watch")) {
      const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
      q.set("step", String(step));
      history.replaceState(null, "", `#/watch?${q.toString()}`);
    }
  }, [step, frames.length]);

  const f = frames[Math.min(step, frames.length - 1)];
  const heat: Heat | undefined = useMemo(() => {
    if (!f?.decision || !showHeat || !f.decision.root.length) return undefined;
    const vals = f.decision.root.map(([, v]) => v ?? 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const h: Heat = {};
    for (const [a, v] of f.decision.root) h[actionKey(a)] = hi === lo ? 1 : ((v ?? lo) - lo) / (hi - lo);
    return h;
  }, [f, showHeat]);
  const share = () => navigator.clipboard?.writeText(location.href);

  return (
    <div className="space-y-4">
      <div className="card grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 md:items-end">
        <div>
          <div className="label mb-1">Seed</div>
          <div className="flex gap-1"><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="w-28" disabled={running} /><button className="btn" disabled={running} onClick={() => setSeed(Math.floor(Math.random() * 1e6))}>🎲</button></div>
        </div>
        {bots.map((b, s) => <Select key={s} label={`${SEAT_NAMES[s]}`} value={b.kind} options={BOT_OPTIONS} onChange={(k) => setBots((bs) => bs.map((x, i) => (i === s ? { ...x, kind: k as BotKind } : x)))} />)}
        <div className="flex items-end gap-2">
          <div><div className="label mb-1">Depth</div><Toggle label="search depth" value={String(depth)} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }]} onChange={(d) => setDepth(Number(d))} /></div>
          <button className="btn btn-primary" onClick={run} disabled={running}>{running ? `Playing… ${frames.length} steps` : "Run game"}</button>
        </div>
      </div>

      {map && f && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <button className="btn" onClick={() => setStep(0)} title="first">⏮</button>
              <button className="btn" onClick={() => setStep((s) => Math.max(0, s - 1))} title="previous (←)">◀</button>
              <button className="btn btn-primary w-20 justify-center" onClick={() => setPlaying((p) => !p)} title="space">{playing ? "Pause" : "Play"}</button>
              <button className="btn" onClick={() => setStep((s) => Math.min(frames.length - 1, s + 1))} title="next (→)">▶</button>
              <button className="btn" onClick={() => setStep(frames.length - 1)} title="last">⏭</button>
              <span className="font-mono">step {f.step}/{frames.length - 1} · turn {f.view.num_turns}</span>
              {f.view.winner >= 0 && <span className="rounded bg-amber-500 px-2 py-0.5 font-semibold text-stone-950">🏆 {SEAT_NAMES[f.view.winner]} ({BOT_SHORT[bots[f.view.winner].kind]}) wins</span>}
              <span className="ml-auto flex items-center gap-2"><span className="label">heat</span><Toggle label="show heat" value={showHeat ? "on" : "off"} options={[{ value: "off", label: "off" }, { value: "on", label: "on" }]} onChange={(x) => setShowHeat(x === "on")} /><button className="btn" onClick={share} title="copy a link to this exact step">Share</button></span>
            </div>
            <Slider value={Math.min(step, frames.length - 1)} min={0} max={Math.max(frames.length - 1, 0)} onChange={setStep} label="step" />
            <p className="my-2 text-sm">
              {f.action ? <><span className="font-semibold">{SEAT_NAMES[f.seat]}</span> ({BOT_SHORT[bots[f.seat].kind]}) {PROMPTS[f.view.prompt] ? `— ${PROMPTS[f.view.prompt]}: ` : ": "}<span className="font-semibold">{label(f.action, map)}</span>{outcomeText(f.action, f.outcome) ? <span className="text-stone-500"> — {outcomeText(f.action, f.outcome)}</span> : null}{f.view.is_resolving_trade ? <span className="text-stone-500"> · {tradeText(f.view.current_trade)}</span> : null}</> : <span className="text-stone-500">Final position.</span>}
            </p>
            <Board map={map} view={f.view} legal={f.decision?.root.length ? f.decision.root.map(([a]) => a) : []} heat={heat} highlight={hover ?? f.action} lastAction={frames[step - 1]?.action ?? null} />
            <div className="card mt-3"><div className="label mb-1">Win probability over the game</div><WinProbTimeline frames={frames} step={Math.min(step, frames.length - 1)} onSeek={setStep} n={f.view.n} /></div>
          </div>
          <aside className="space-y-3">
            <PlayerCards view={f.view} names={bots.map((b) => BOT_SHORT[b.kind])} reveal={() => true} mover={f.seat} />
            <div className="card"><div className="label mb-1">Win probability at this step</div><Forecast evals={f.evals} actualVps={f.view.players.map((p) => p.actual_vp)} publicVps={f.view.players.map((p) => p.vp)} n={f.view.n} /></div>
            {f.decision && <div className="card"><div className="label mb-1">What {SEAT_NAMES[f.seat]} considered</div><DecisionPanel decision={f.decision} map={map} onHover={setHover} /></div>}
            {f.attribution && <div className="card"><div className="label mb-1">Why the net rates {SEAT_NAMES[f.seat]} this way</div><AttributionPanel rows={f.attribution} seat={f.seat} n={f.view.n} /></div>}
          </aside>
        </div>
      )}
      {!map && !running && <p className="text-sm text-stone-500">Pick four bots and a seed, then run the game. Use ← → to step, space to play, and Share to link to the exact step.</p>}
    </div>
  );
}
