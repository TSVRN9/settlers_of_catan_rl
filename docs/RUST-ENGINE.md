# Decision memo: rewriting the rules engine in Rust

Status: **evaluated 2026-08-31, deferred.** Re-read after M1 reports throughput.
Measurements behind this memo are in `docs/FINDINGS.md`.


## Verdict

**Attainable: yes, unusually so.** **Worth doing now: no.** Revisit on the triggers below.

The current PPO plan does not need it. At measured speed the engine already supplies
~1.7B agent-decisions/day (7 cores), so settlers-rl's entire 450M-decision budget is
roughly a day of wall-clock. Rust would change iteration speed, not what is reachable.

## Why it's unusually attainable

| Factor | Evidence |
|---|---|
| Small surface | ~3,300 LOC of rules (`state.py` 197, `game.py` 228, `apply_action.py` 604, `state_functions.py` 354, `models/` 1,783). `features.py` (543) we're rewriting regardless. |
| Fixed, tiny topology | 54 nodes, 72 edges, 19 tiles. `NUM_NODES=54`, `NUM_EDGES=72`. Fully precomputable as const tables. |
| Shallow graph deps | `networkx` appears only as a static board graph, `floyd_warshall` over a constant, and connected-components. No real graph library needed. |
| Existing spec | Catanatron ships 14 test files + 4 subdirs. Free requirements document. |
| **A perfect oracle** | **Every stochastic outcome is recorded.** `ActionRecord.result` carries dice (`(3,5)`), drawn dev card (`'KNIGHT'`), discards, **and robber steals (`result='BRICK'`) — verified**. |

That last row is the decisive one. Because outcomes are recorded, a Rust engine can
**replay a Python-generated game deterministically without matching Python's RNG**.
So: generate N random games in Python, replay each in Rust, assert equality of
`playable_actions` and player state after *every* action. Unlimited free test cases.

That is close to the ideal shape of task for an LLM: mechanical translation, an
unambiguous spec, and automated verification that needs no human judgement. It converts
an open-ended port into a burn-down against a number.

**Don't estimate this in sessions.** The honest progress metric is
**"% of N replayed games matching after every action"**, run continuously from day one.

Risk concentrates in: `longest_acyclic_path` (exhaustive DFS, subtle with cycles and
enemy-settlement breaks), initial-placement sequencing, and robber/discard/knight ordering.
Dropping player-to-player trading (already our v1 scope) removes the worst of it.

Toolchain is present: `cargo`/`rustc` 1.92.0. Binding via PyO3/maturin.

## When it becomes worth doing

Any one of these flips the verdict:

1. **Search-based (AlphaZero-style) training.** This is the strongest trigger. Catanatron
   has no make/unmake, so every node expansion needs `Game.copy()` at **27–81 µs**
   (measured twice; CPU timings here carry ±3x thermal noise). At 800 sims/move that's
   22–65 ms/move × 435 moves ≈ **9–28 s/game** → 0.25–0.8 games/s on 7 cores → 1M
   self-play games ≈ **15–46 days**. A compact Rust state clones in tens of nanoseconds.
   That two-orders-of-magnitude gap is the whole argument, and it holds at either end of
   the measured range.
   *(Separately: rollout-based MCTS is already dead in Python — a single `run_playout` is
   11–32 ms, and `MCTSPlayer` at just 10 sims costs 20–40 s/game against a 0.06 s/game
   random baseline. AlphaZero uses value-net leaf evaluation, not rollouts, so the copy
   cost above is the number that matters.)*

2. **M1's inference server can't reach batch ≥256.** Rust doesn't optimize that problem,
   it *dissolves* it: if Rust owns N games, it steps them all past their forced decisions
   and hands back one `(256, 1002)` array. No worker processes, no request/reply queues,
   no `torch.multiprocessing`, no games-per-worker tuning — the fiddliest and highest-risk
   part of the M1 design stops existing. Single-process, no IPC, no GIL.

3. **Parallel experimentation** — hyperparameter sweeps or ablations where 8 cores must
   host many concurrent runs.

## Constraints as of now

- **The premise is unvalidated.** M1 has not measured real throughput yet. Rewriting first
  is speculative optimization against a bottleneck we haven't confirmed.
- **Amdahl, and it cuts both ways.** The engine is 52 µs of the ~291 µs step (18%), so
  porting *only* the rules engine caps at **1.22x** today. After M1 shrinks the encoder to
  ~80 µs, the same rewrite caps at ~1.6x. **Both engine and encoder must be ported** for
  Rust to be worth anything — but note M1 makes the engine port relatively *more* valuable,
  not less.
- **No quick Python win to grab instead.** Profiling inside the 52 µs shows the cost is
  diffuse interpreter overhead, not one hot algorithm: 693k `enum.__hash__` and 502k
  `player_key` calls across 25 games. `longest_acyclic_path` is the largest single entry
  (~18%) and `generate_playable_actions` ~47% cumulative. A bitset rewrite of longest-road
  would help modestly; there is no single fix that changes the picture. This mildly
  strengthens the Rust case, since a port collapses all of it at once.
- **Yardstick parity — narrower than it first appears.** We do *not* need bit-exact
  whole-engine parity to keep "beat AlphaBeta" as the target. We need (a) the Rust rules
  to be correct, for training validity, and (b) the Rust obs encoder to agree with a Python
  encoder, so the trained policy can be evaluated inside Python Catanatron at 31.9 s/game —
  fine for 1000 games at milestones. The same differential oracle covers both.
- **Maintenance drift.** Catanatron is actively developed (975 commits). A fork stops
  inheriting fixes; the replay oracle is what keeps the divergence visible.
- **No prior art to lean on.** No mature Rust Catan crate exists — this is from scratch.

## Recommendation

Proceed with the plan as written. Take the M1 throughput measurement, then re-read this
memo. If M1's batching design fights back, trigger 2 is the cheapest reason to reconsider —
and it argues for Rust owning the whole env loop, not just the rules.
