import bench from "../data/benchmark.json";

interface Summary { games: number; wins: number; ratio: number; ci95: number[]; mean_vp: number }
const short = (t: string) => ({ "vnet:checkpoints_value/v40.pt": "Value-net search v40 (ours)", ab: "AlphaBetaPlayer (Catanatron)", mcts100: "MCTSPlayer, 100 simulations", mcts: "MCTSPlayer, 10 simulations", vf: "ValueFunctionPlayer (greedy heuristic)", wr: "WeightedRandomPlayer" } as Record<string, string>)[t] ?? t;

export default function Results() {
  const b = bench as unknown as { pool: string[]; games_per_tournament: number; done: number; total: number; summary: Record<string, Summary>; per_tournament: Record<string, Summary>[] };
  const done = b.done === b.total;
  return (
    <div className="prose prose-stone max-w-3xl dark:prose-invert">
      <h2>Headline: 55.2% against three AlphaBeta players</h2>
      <p>Over 1,000 seeded games with the agent at seat Blue against three copies of Catanatron's <code>AlphaBetaPlayer</code>, <b>v40</b> won <b>552 (55.2%, Wilson 95% interval 52.1–58.3%)</b>. Symmetry would be 25%; AlphaBeta against itself scores 26.3%. Every number and dead end is in <a href="https://github.com/TSVRN9/settlers_of_catan_rl/blob/main/docs/FINDINGS.md">docs/FINDINGS.md</a>.</p>
      <h2>Paper-protocol tournament (Xenou et al., EUMAS 2018)</h2>
      <p>The DRRL paper ranks agents with five 4-player tournaments drawn from a pool of five, each leaving one agent out, and reports each agent's win ratio over its games. We ran that protocol with {b.games_per_tournament} games per tournament{done ? "" : ` (${b.done}/${b.total} games played so far)`}. Seats are randomly permuted per game.</p>
      <table>
        <thead><tr><th>agent</th><th>games</th><th>wins</th><th>win ratio</th><th>95% CI</th><th>mean VP</th></tr></thead>
        <tbody>
          {b.pool.map((t) => { const s = b.summary[t]; return <tr key={t}><td>{short(t)}</td><td>{s.games}</td><td>{s.wins}</td><td><b>{(100 * s.ratio).toFixed(1)}%</b></td><td>[{(100 * s.ci95[0]).toFixed(1)}, {(100 * s.ci95[1]).toFixed(1)}]</td><td>{s.mean_vp.toFixed(2)}</td></tr>; })}
        </tbody>
      </table>
      <p>For comparison, the paper's DRRL agent reached a 31% win ratio in its pool (jSettler 21%, VPI 22%, BUCT 26%, UCT 23%), 45% against three jSettlers, and 56% after 30 sequential games; the pre-trained DRL agent it cites scored 53.4% against three jSettlers. Those opponents are not the same as ours: the roadmap for playing real jSettlers and the thesis MCTS agents is in <a href="https://github.com/TSVRN9/settlers_of_catan_rl/blob/main/docs/BENCHMARK.md">docs/BENCHMARK.md</a>.</p>
    </div>
  );
}
