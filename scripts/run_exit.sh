#!/bin/bash
# M4 expert-iteration loop, unattended. Usage: [ROLL_P=0.1 ROLL_M=1 TS_WEIGHT=3] scripts/run_exit.sh <first_k> <last_k> [games] [ab_gate_every]
# Iteration k: 2 seats of the incumbent (best proxy score so far, checkpoints_value/best.txt) + 2 Rust-AlphaBeta
# seats in the Rust arena (gen_games.py / arena.py) -> data/itk; train vk on the last 4 iterations' data
# (outcome + aux + rank + sibling losses), warm-started from the incumbent; 4000-game proxy gate vs 3x Rust
# AlphaBeta on FRESH seeds every iteration, for both the incumbent and vk (2 x ~2.5 min, ±1.4 pt each) -- vk
# becomes the incumbent only if it wins more games on those seeds (successive checkpoints swing 3-5 points, early
# stopping on held-out loss does not track play, and a fixed-seed incumbent score is a winner's-curse draw, FINDINGS);
# 300-game gate vs 3x Python AlphaBeta -- the number docs/FINDINGS.md reports -- every ab_gate_every
# iterations (~10 min). Log: whatever stdout is redirected to.
set -u
export PYTHONUNBUFFERED=1
export PYTORCH_ALLOC_CONF=expandable_segments:True  # XPU caching allocator otherwise hoards 4-6 GB (docs/FINDINGS.md)
cd "$(dirname "$0")/.."  # repo root
first=$1; last=$2; games=${3:-4000}; every=${4:-10}  # the Python AlphaBeta gate is slow (~10 min): every 10th round, not 3rd (2026-09-22)
# 2026-09-02 evening (docs/FINDINGS.md): rollout-labeled children replace the base_fn pair / sibling losses --
# v27d (outcome + rollout values, no base_fn imitation) 38.2% vs v25's 32.6% on the same seeds. Generation is
# ~40 min/round at roll_p 0.1 (one rab-vs-rab playout per labeled child, ~110 ms CPU each).
ROLL_P=${ROLL_P:-0.3}; ROLL_M=${ROLL_M:-1}; TS_WEIGHT=${TS_WEIGHT:-3}; N_SEEDS=${N_SEEDS:-5}; MAX_TS=${MAX_TS:-300000}; WIN_WEIGHT=${WIN_WEIGHT:-0}; AUX_WEIGHT=${AUX_WEIGHT:-0}
# ROLL_NET=all|own: the rollout policy is the incumbent net at one ply (valuenet.rs decide_net_rollout, 2026-09-22) instead
# of base_fn, for every seat or for the labeled decider only, so the labels are the value of the *net's* continuation rather
# than AlphaBeta's -- the plateau's cause (FINDINGS). DATA_LAST: how many iteration directories the training window spans.
# SELFPLAY=1: the incumbent in all four seats (outcome-label self-play, 2026-09-25); DATA_PREFIX: data/<prefix>k directories,
# so a series windows only its own rounds; SAMPLE_P: outcome rows per tick (gen_games default 0.5); PER_GAME: at most this
# many outcome rows per game in training (0 = all).
DATA_PREFIX=${DATA_PREFIX:-it}; PER_GAME=${PER_GAME:-0}
roll_net=${ROLL_NET:+--roll-net $ROLL_NET}; DATA_LAST=${DATA_LAST:-4}; TRAIN_EXTRA=${TRAIN_EXTRA:-}; TS_P=${TS_P:-0}; TS_KEY=${TS_KEY:-ro}; LINEUP_NET=${LINEUP_NET:-}  # extra train_value.py flags, e.g. "--lr 1e-4 --dropout 0" (2026-09-22: the default lr 1e-3 + dropout 0.3 step costs ~5 points per draw by itself, FINDINGS)
# Rollout values only (docs/FINDINGS.md 2026-09-03): with the outcome loss on, a draw from v31 scored 30%; without it 51%;
# rollout-only 53% -- the 1-bit game outcome shared by ~150 correlated states per game was pulling the net away from play.
# The candidate is a greedy weight average (soup.py --greedy) of N_SEEDS trainings from the same warm start: one
# draw swings ±5 points, the plain average of three scored +4.7 over the best draw, and the greedy soup (add a draw
# only if a 1,000-game proxy does not drop) rejected the two bad draws out of five (docs/FINDINGS.md).
echo $$ > checkpoints_value/run_exit.pid  # stop with: kill $(cat checkpoints_value/run_exit.pid); never pkill -f (it matches your own shell)
# Every stage runs in its own transient cgroup with a hard memory cap and no swap: a runaway stage is killed
# alone and `|| exit 1` stops the loop; the box stays up (docs/FINDINGS.md 2026-09-02, two OOMs took it down).
run() { systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 "$@"; }
# Never start a GPU stage next to a stale one (a stalled generation once survived pkill, stuck in the GPU driver).
busy() { pgrep -f "^\S*python[0-9.]* (gen_games|evaluate|train_value)\.py" ; }  # anchored: a shell whose command text mentions the scripts must not match
if busy >/dev/null; then echo "refusing to start: stale processes: $(busy | tr '\n' ' ')"; exit 1; fi
last_shard=$(printf "shard_%04d.npz" $((games / 500 - 1)))  # gen_games --shard 500
[ -f checkpoints_value/best.txt ] || echo "checkpoints_value/v$((first - 1)).pt" > checkpoints_value/best.txt
# Gate (2026-09-22): gate.py plays candidate and incumbent on the same seeds in blocks and stops by SPRT (accept /
# reject / cap keeps the incumbent); the old fixed 4,000-game pair had ~35% power at 1.5 points and accepted ties.
# The greedy soup returns the incumbent untouched when no draw improves on it (round 47: all five below it);
# gating that against itself is 5 minutes for an exact tie.
same_net() { uv run python -c "import sys,torch; a,b=[torch.load(p,map_location='cpu') for p in sys.argv[1:]]; sys.exit(0 if a.keys()==b.keys() and all(torch.equal(a[k],b[k]) for k in a) else 1)" "$1" "$2"; }
for k in $(seq "$first" "$last"); do
  read -r prev _ < checkpoints_value/best.txt
  V="${VSPEC:-vnet}:${LINEUP_NET:-$prev}"  # LINEUP_NET: another net (or an a.pt+b.pt ensemble) plays the generation seats; training and gating stay on the incumbent
  echo "=== it$k incumbent $prev"
  lineup="$V,$V,${OPP:-rab,rab}"; [ -n "${SELFPLAY:-}" ] && lineup="$V,$V,$V,$V"
  out="data/$DATA_PREFIX$k"
  echo "=== it$k gen: $lineup (${GEN_POOL:-}), $games games, roll_p $ROLL_P roll_m $ROLL_M $roll_net sample_p ${SAMPLE_P:-0.5} -> $out  $(date)"
  if [ -f "$out/$last_shard" ]; then echo "  $out complete, skipping generation"; else
  if busy >/dev/null; then echo "refusing to generate: stale processes: $(busy | tr '\n' ' ')"; exit 1; fi
  run uv run python gen_games.py --lineup "$lineup" ${GEN_POOL:+--pool $GEN_POOL} --games "$games" --seed $((k * 100000)) --rank-p 0 --sib-p 0 --roll-p "$ROLL_P" --roll-m "$ROLL_M" $roll_net --ts-p "$TS_P" ${SAMPLE_P:+--sample-p $SAMPLE_P} ${GEN_EXTRA:-} --out "$out" || exit 1; fi
  echo "=== it$k train  $(date)"
  for s in $(seq 0 $((N_SEEDS - 1))); do
    run uv run python train_value.py --data $(ls -d data/$DATA_PREFIX[0-9]* | sort -V | tail -"$DATA_LAST") --init "$prev" --out "checkpoints_value/v${k}_s$s.pt" --seed "$s" --epochs 6 --rank-weight 0 --sib-weight 0 --self-sibs 0 --ts-key "$TS_KEY" --ts-weight "$TS_WEIGHT" --max-ts "$MAX_TS" --win-weight "$WIN_WEIGHT" --aux-weight "$AUX_WEIGHT" --per-game "$PER_GAME" $TRAIN_EXTRA || exit 1
  done
  if [ -n "${SOUP_UNIFORM:-}" ]; then  # 2026-09-23: the greedy soup selects on 1,000 games vs 3x rab; the pool goal averages the draws unselected
    run uv run python soup.py --out "checkpoints_value/v$k.pt" checkpoints_value/v${k}_s*.pt || exit 1
  else
    run uv run python soup.py --greedy --base "$prev" --games 1000 --seed $((k * 1000000 + 500000)) --out "checkpoints_value/v$k.pt" checkpoints_value/v${k}_s*.pt || exit 1
  fi
  seedk=$((k * 1000000 + 7))
  if same_net "$prev" "checkpoints_value/v$k.pt"; then echo "=== it$k rejected: the soup kept no draw, v$k == $prev, gate skipped"; else
  echo "=== it$k gate: v$k vs $prev, paired SPRT vs 3x rab, blocks of 1000 to ${GATE_MAX:-12000} games (seed $seedk)  $(date)"
  if run uv run python gate.py "${VSPEC:-vnet}:checkpoints_value/v$k.pt" "${VSPEC:-vnet}:$prev" --seed "$seedk" --max "${GATE_MAX:-12000}" ${GATE_POOL:+--pool $GATE_POOL}; then
    echo "checkpoints_value/v$k.pt" > checkpoints_value/best.txt; echo "=== it$k accepted: v$k is the new incumbent"
  else echo "=== it$k rejected: incumbent stays $prev"; fi; fi
  if [ $((k % every)) -eq 0 ]; then
    read -r best _ < checkpoints_value/best.txt
    echo "=== it$k gate incumbent $best vs 3x ab, 300 games  $(date)"
    run uv run python evaluate.py --player "vnet:$best" --opponent alpha_beta --games 300 || exit 1
  fi
done
echo "=== done $(date)"
