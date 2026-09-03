# Implementation handoff

Milestone-by-milestone instructions. **Read `docs/FINDINGS.md` first** — it has the
measured baseline and the Catanatron API notes, and will save you a day of rediscovery.

## Ground rules

1. **One milestone per session.** Each has a gate. Do not start the next until the gate
   passes with output you actually ran and read.
2. **Never claim a gate passed without pasting the command output.** "Should work" is not
   a gate.
3. **Do not re-benchmark the baseline.** It is in `docs/FINDINGS.md`.
4. **Keep it small.** Flat files, no packages, no config classes, no abstract base classes.
   One implementation means no interface. If you are writing a factory, stop.
5. **Every non-trivial piece leaves one `assert`-based check** in `test_env.py`. No pytest,
   no fixtures, no per-function suites.
6. If a gate fails twice, **stop and report** with the numbers. Do not keep tuning blindly.

## Design invariants — violating these silently ruins training

- **The agent is `Color.BLUE`.** The env asserts enemies don't collide with it.
- **Never call the policy at batch 1.** All inference goes through `legacy/ppo/inference_server.py`.
  Batch-1 costs more than the obs encoder (245 µs vs 239 µs); the 19x XPU speedup only
  exists at batch ≥256.
- **`Adam(foreach=False)`, always.** The default `foreach=True` resets the iGPU.
- **Forced decisions (57% of all decisions) are skipped for encode+policy only.** The
  engine still advances them. They must **not** enter the PPO rollout buffer as
  transitions — the discount applies per *decision*, not per engine tick.
- **Opponent hands are hidden.** Catanatron's state exposes everything; the encoder must
  deliberately withhold opponent resource/dev-card identities and expose only what a real
  player can infer (counts, and bounds from observed trades/robberies). Do not encode
  `player_state` opponent card identities. Getting this wrong trains a cheating agent that
  looks great and means nothing.

---

## M0 — skeleton

**Goal:** project set up, a game plays end to end.

1. `uv init --python 3.12` (3.14 does **not** resolve `torch+xpu` — verified).
2. `pyproject.toml` deps: `catanatron[gym] @ git+https://github.com/bcollazo/catanatron`,
   `torch` (from the XPU index), `sb3-contrib`, `gymnasium`, `numpy`.
   (`sb3-contrib 2.9.0` + `stable-baselines3 2.9.0` verified to resolve against the
   `gymnasium 0.29.1` that catanatron pins — no conflict.)
   The torch XPU index needs:
   ```toml
   [[tool.uv.index]]
   name = "pytorch-xpu"
   url = "https://download.pytorch.org/whl/xpu"
   explicit = true

   [tool.uv.sources]
   torch = { index = "pytorch-xpu" }
   ```
3. Sanity script: 4-player game with `RandomPlayer`s, print winner and turn count.

**Gate:** a game plays, a winner is returned, `torch.xpu.is_available()` is `True`.

---

## M1 — custom env + batched inference (the hard one)

This is where the project succeeds or fails. Budget most of your effort here.

### 1. Observation encoder (`catan_env.py`)

Replace `create_sample_vector` (239 µs). It is slow because it builds a flat Python list
with ~100k `enum.__hash__` and 15k `Counter.update` calls per 1500 encodes.

Approach: preallocate one `np.float32` buffer and write slices into it. Precompute
everything static at construction (node/edge/tile index maps, the feature layout) so the
hot path is array writes, not dict lookups or enum hashing. Prefer incremental updates for
anything the engine already tracks.

Encode at minimum: board topology (tile resource/number/robber), your buildings, opponent
buildings, your exact hand, opponent hand **sizes only**, dev cards played (public) vs
held (yours only), ports, longest road / largest army, VPs, bank deck, turn phase.

**Do not** encode opponent hand contents or the dev-card deck order.

### 2. Action space + masking

Flat `Discrete(370)` (4-player value — confirmed, `Discrete(332)` is the 2-player env).
Build a boolean mask from `game.playable_actions` each decision.

The mask is the highest-risk correctness surface in the project: a wrong mask trains
silently and produces a plausible-looking agent that is subtly broken. Test it.

### 3. Forced-decision skipping

```
while len(game.playable_actions) == 1:
    game.execute(game.playable_actions[0])   # advance, no encode, no policy call
```
Only encode and query when `len(playable_actions) > 1`. Expect ~435 policy calls/game
instead of 1010. Do not push the skipped steps into the rollout buffer.

### 4. Batched inference server (`legacy/ppo/inference_server.py`)

Worker processes step envs and push `(worker_id, game_id, obs, mask)` onto a queue. One
server process gathers requests (up to a max batch, or a short timeout), runs one batched
XPU forward, and returns actions on per-worker reply queues.

**You need two independent axes, not one.** A game blocks while awaiting its action, so
in-flight requests ≈ `workers × games per worker`.

- *Processes* get you CPU cores. Env stepping is GIL-bound Python, so a single process
  caps at ~1,753 steps/s no matter what; ~7 worker processes is how you reach 7 cores.
- *Multiple games per worker* get you batch size. 7 workers × 1 game = **mean batch 7**,
  which does not clear the batch-256 threshold the XPU speedup depends on. Batch 256
  needs ~256 concurrent games, i.e. **~37 games per worker**.

So: run many game instances per worker, interleaved. Each worker advances a game through
its forced decisions, parks it when it reaches a real decision, and moves to the next —
so the games are naturally at different steps and never need to be in lockstep. The
timeout flush is a **safety valve for stragglers, not an alternative** to running many
games per worker.

(This interleaving is also why in-process vectorization was not chosen — not because
forced-decision skipping breaks it, but because one Python process cannot saturate 7
cores.)

**Measure and log the mean achieved batch size.** If it is far below 256 after tuning
games-per-worker, report the number rather than proceeding — the design's premise is unmet.

Use `torch.multiprocessing`. Keep the XPU context in the server process only — do not
initialize torch XPU in workers.

**Gate (all three, with pasted output):**
- Encoder **≥3x faster** than `create_sample_vector` at 4 players (i.e. ≤80 µs), measured
  by a benchmark you add as `legacy/ppo/bench_env.py`.
- `test_env.py` passes: mask matches `playable_actions`; encoder leaks no hidden info
  (encode a real state, mutate an opponent's resource counts in `state.player_state` in
  place, re-encode, assert the two arrays are identical); forced-decision skip drops no
  transitions.
- Aggregate neural self-play throughput measured and written into `docs/FINDINGS.md`,
  with mean achieved inference batch size. **M2+ budgets come from this number.**

---

## M2 — MaskablePPO vs fixed opponents

`sb3_contrib.MaskablePPO` with `ActionMasker`. Opponents: 3x `WeightedRandomPlayer`.

Reward: sparse win/loss is correct but slow to learn. Start with win = +1, loss = 0, plus
a small dense shaping term on VP gain. Keep shaping small — settlers-rl found dense
rewards easy to game into perverse strategies.

Net: start small (~3x512 MLP). We are simulation-bound; a bigger net costs throughput and
buys little. Do not scale the net to fix a learning problem.

`Adam(foreach=False)`. Checkpoint every N updates. Log win rate, episode length, entropy,
explained variance.

**Gate:** >90% win rate vs 3x `WeightedRandomPlayer` over 200 games.

---

## M3 — self-play with opponent pool

Maintain a pool of historical checkpoints; sample 3 opponents per game, biased toward
recent (settlers-rl sampled from earlier versions with a recency bias). This is what
prevents the policy from overfitting to one opponent.

PPO is on-policy: **only the learning agent's transitions go into the buffer.** Discard
opponent-policy experience. This is wasteful and correct.

Regression check: `evaluate.py --opponent value_function --games 200` (~1.26 s/game, so
~4 min on 7 cores). Run this often.

**Gate:** >50% win rate vs 3x `ValueFunctionPlayer`. Note 25% is chance in a 4-player game.

---

## M4 — beat AlphaBeta

**Reframed 2026-09-01** (see FINDINGS.md, "M4 reframed"). The reactive-policy
line (PPO, BC, self-play) is exhausted far below the M3 gate. AlphaBeta's edge
is its depth-2 expectimax; we keep that search and replace its hand heuristic
with a learned win-probability net — expert iteration.

```
uv run python evaluate.py --player ab --opponent alpha_beta --games 300           # calibration, ~25%
uv run python gen_games.py --lineup ab,ab,ab,ab --games 5000 --out data/it0       # ~2-4 h
uv run python train_value.py --data data/it0 --out checkpoints_value/v0.pt
uv run python evaluate.py --player vnet:checkpoints_value/v0.pt --opponent alpha_beta --games 300
# iteration k: 3 vnet seats + 1 ab seat keeps the data anchored to the target opponent
uv run python gen_games.py --lineup vnet:V,vnet:V,vnet:V,ab --games 5000 --out data/itk
uv run python train_value.py --data data/it0 ... data/itk --init V --out checkpoints_value/vk.pt
```

Decision rule per iteration: keep going unless the new net's Wilson upper
bound (300 games) is below the previous best's point estimate. Levers held in
reserve, in order, only on evidence: `prunning=True` (AB's own
`list_prunned_actions`), depth 3, search-value targets instead of outcomes,
Rust engine only if >20k games/iteration are needed.

The factored-action-head rewrite is retired: BC showed the flat head can
represent VFP-quality play (FINDINGS.md, "BC-from-VFP result").

`AlphaBetaPlayer` costs ~2.5 s per seat-game, so 1000 games vs 3x AB is
~20-40 min on 7 cores depending on our own seat's cost. Run it **at
milestones only, never per checkpoint.**

**Gate:** >50% win rate vs 3x `AlphaBetaPlayer` over 1000 games, reported with a
confidence interval (Wilson interval on a binomial proportion; 1000 games gives roughly
±3 points, so a 52% result is *not* a pass).

---

## M5 (optional) — test-time MCTS

`Game.copy()` is 81 µs and the median branching factor is 1, so search is cheap. Wrap the
trained policy in MCTS at inference only. Catan is stochastic (dice) and imperfect
information — use chance nodes and determinization; do not pretend it is perfect-info.

Keep this out of the training loop.

---

## Files to create

| File | Purpose |
|---|---|
| `pyproject.toml` | uv, Python 3.12, torch+xpu index |
| `catan_env.py` | gym env: obs encoder, mask, forced-decision skip, reward |
| `legacy/ppo/inference_server.py` | batching queue + XPU forward |
| `legacy/ppo/train.py` | MaskablePPO + self-play opponent pool (M2/M3, dormant since M4's reframe) |
| `value_net.py` | M4: `ValueNet`, `ValueNetPlayer(AlphaBetaPlayer)`, `make_player` |
| `gen_games.py` | M4: parallel games → (state, perspective, won) samples |
| `train_value.py` | M4: value-net regression |
| `evaluate.py` | win rate vs a named bot, with Wilson CI |
| `test_env.py` | assert-based invariants (mask, info leakage, skip correctness) |
| `legacy/ppo/bench_env.py` | encoder + throughput, compared against `docs/FINDINGS.md` |

## Verification commands

```bash
uv run python test_env.py                                        # invariants
uv run python legacy/ppo/bench_env.py                                       # M1 gate
uv run python evaluate.py --opponent weighted_random --games 200  # M2 gate
uv run python evaluate.py --opponent value_function  --games 200  # M3 gate
uv run python evaluate.py --opponent alpha_beta      --games 1000 # M4 gate (~1 h)
```
