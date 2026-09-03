export default function About() {
  return (
    <div className="prose prose-stone max-w-3xl dark:prose-invert">
      <h2>Overview</h2>
      <p>A 4-player Settlers of Catan engine and two bots, running in the browser. The rules engine is a Rust port of <a href="https://github.com/bcollazo/catanatron">Catanatron</a> compiled to WebAssembly; the <b>heuristic bot</b> is AlphaBeta's hand-written evaluator under an exact depth-2 expectimax search, and the <b>value-net bot</b> is the same search with the evaluator replaced by a 403k-parameter network trained by expert iteration to predict who wins.</p>
      <h2>Panels</h2>
      <ul>
        <li><b>Win probability over the game</b> — the value net evaluated from each seat's own perspective after every step. Drops usually follow a 7 or a lost Longest Road.</li>
        <li><b>Win probability at this step</b> — the same numbers for the current position. The net also has heads for final victory points and turns remaining, but the recipe that produced v40 trained on rollout values only, so those heads are untrained and not shown.</li>
        <li><b>What the bot considered</b> — every root action of the search with its backed-up value (P(win) for the value net, a heuristic score for AlphaBeta's evaluator). The board tints the same actions as a heat map.</li>
        <li><b>Why the net rates a seat this way</b> — leave-one-group-out attribution: the change in P(win) when a group of input features (a hand, a player's production, roads…) is zeroed. It is a counterfactual on the model, not a statement about the position.</li>
        <li><b>Coach</b> (Play page) — the value-net bot's ranking of your own legal actions.</li>
      </ul>
      <h2>Rule caveats</h2>
      <ul>
        <li>Player-to-player trading follows the official rules (on your turn after rolling, no giveaways, no like-for-like), with one house rule so games always end: an offer everyone rejected or the offerer cancelled cannot be repeated that turn. Bots decide trades 1-ply with their own evaluator; they never search over offers.</li>
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
