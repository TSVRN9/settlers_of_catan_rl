export default function About() {
  return (
    <div className="prose prose-stone max-w-3xl dark:prose-invert">
      <h2>What this is</h2>
      <p>A 4-player Settlers of Catan engine and two bots, running entirely in your browser. The rules engine is a Rust port of <a href="https://github.com/bcollazo/catanatron">Catanatron</a> compiled to WebAssembly; the <b>heuristic bot</b> is AlphaBeta's hand-written evaluator under an exact depth-2 expectimax search, and the <b>value-net bot</b> is the same search with the evaluator replaced by a 403k-parameter network trained by expert iteration to predict who wins.</p>
      <h2>What the panels mean</h2>
      <ul>
        <li><b>Win probability over the game</b> — the value net evaluated from each seat's own perspective after every step. Sudden drops are usually a 7 or a lost Longest Road.</li>
        <li><b>Win probability at this step</b> — the same numbers for the current position. The net also has heads for final victory points and turns remaining, but the recipe that produced v40 trained on rollout values only, so those heads are untrained and not shown.</li>
        <li><b>What the bot considered</b> — every root action of the search with its backed-up value (P(win) for the value net, a heuristic score for AlphaBeta's evaluator). The board tints the same actions as a heat map.</li>
        <li><b>Why the net rates a seat this way</b> — leave-one-group-out attribution: the change in P(win) when a group of input features (a hand, a player's production, roads…) is zeroed. It is a counterfactual on the model, not a proof about the position.</li>
        <li><b>Coach</b> (Play page) — the value-net bot's ranking of your own legal actions.</li>
      </ul>
      <h2>Rule caveats</h2>
      <ul>
        <li>No player-to-player trading (a Catanatron simplification; bank and port trades work).</li>
        <li>Catanatron issue #378 is mirrored deliberately: a road with both ends capped by enemy settlements can be under-counted for Longest Road. It keeps the Python and Rust engines step-for-step identical.</li>
        <li>Opponent hands are visible to the bots' search (the engine is fully observable), as in Catanatron.</li>
      </ul>
      <h2>Links</h2>
      <ul>
        <li><a href="https://github.com/TSVRN9/settlers_of_catan_rl">Source, findings and training code</a></li>
        <li>Xenou, Chalkiadakis, Afantenos — <a href="https://hal.science/hal-02124411v1">Deep Reinforcement Learning in Strategic Board Game Environments</a> (EUMAS 2018), the benchmark protocol on the Results page</li>
      </ul>
    </div>
  );
}
