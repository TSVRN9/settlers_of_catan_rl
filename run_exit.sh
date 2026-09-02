#!/bin/bash
# M4 expert-iteration loop, unattended. Usage: [ROLL_P=0.1 ROLL_M=1 TS_WEIGHT=3] ./run_exit.sh <first_k> <last_k> [games] [ab_gate_every]
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
cd "$(dirname "$0")"
first=$1; last=$2; games=${3:-4000}; every=${4:-3}
# 2026-09-02 evening (docs/FINDINGS.md): rollout-labeled children replace the base_fn pair / sibling losses --
# v27d (outcome + rollout values, no base_fn imitation) 38.2% vs v25's 32.6% on the same seeds. Generation is
# ~40 min/round at roll_p 0.1 (one rab-vs-rab playout per labeled child, ~110 ms CPU each).
ROLL_P=${ROLL_P:-0.1}; ROLL_M=${ROLL_M:-1}; TS_WEIGHT=${TS_WEIGHT:-3}; N_SEEDS=${N_SEEDS:-3}
# The candidate is a weight average (soup.py) of N_SEEDS trainings from the same warm start: one draw swings
# ±5 points, the average of three scored +4.7 over the best draw (docs/FINDINGS.md).
echo $$ > checkpoints_value/run_exit.pid  # stop with: kill $(cat checkpoints_value/run_exit.pid); never pkill -f (it matches your own shell)
# Every stage runs in its own transient cgroup with a hard memory cap and no swap: a runaway stage is killed
# alone and `|| exit 1` stops the loop; the box stays up (docs/FINDINGS.md 2026-09-02, two OOMs took it down).
run() { systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 "$@"; }
# Never start a GPU stage next to a stale one (a stalled generation once survived pkill, stuck in the GPU driver).
busy() { pgrep -f "^\S*python[0-9.]* (gen_games|evaluate|train_value)\.py" ; }  # anchored: a shell whose command text mentions the scripts must not match
if busy >/dev/null; then echo "refusing to start: stale processes: $(busy | tr '\n' ' ')"; exit 1; fi
last_shard=$(printf "shard_%04d.npz" $((games / 500 - 1)))  # gen_games --shard 500
[ -f checkpoints_value/best.txt ] || echo "checkpoints_value/v$((first - 1)).pt" > checkpoints_value/best.txt
proxy() { run uv run python evaluate.py --player "vnet:$1" --opponent rab --games 4000 --seed "$2"; }
wins_of() { echo "$1" | sed -n 's/.*: \([0-9]*\)\/4000 wins.*/\1/p'; }
for k in $(seq "$first" "$last"); do
  read -r prev _ < checkpoints_value/best.txt
  V="vnet:$prev"
  echo "=== it$k incumbent $prev"
  echo "=== it$k gen: $V x2 + rab x2, $games games  $(date)"
  if [ -f "data/it$k/$last_shard" ]; then echo "  data/it$k complete, skipping generation"; else
  if busy >/dev/null; then echo "refusing to generate: stale processes: $(busy | tr '\n' ' ')"; exit 1; fi
  run uv run python gen_games.py --lineup "$V,$V,rab,rab" --games "$games" --seed $((k * 100000)) --rank-p 0.5 --sib-p 0.3 --roll-p "$ROLL_P" --roll-m "$ROLL_M" --out "data/it$k" || exit 1; fi
  echo "=== it$k train  $(date)"
  for s in $(seq 0 $((N_SEEDS - 1))); do
    run uv run python train_value.py --data $(ls -d data/it[0-9]* | sort -V | tail -4) --init "$prev" --out "checkpoints_value/v${k}_s$s.pt" --seed "$s" --epochs 6 --rank-weight 0 --sib-weight 0 --self-sibs 0 --ts-key ro --ts-weight "$TS_WEIGHT" || exit 1
  done
  uv run python soup.py --out "checkpoints_value/v$k.pt" checkpoints_value/v${k}_s*.pt || exit 1
  seedk=$((k * 1000000 + 7))
  echo "=== it$k proxy gate: incumbent and v$k vs 3x rab, 4000 fresh games each (seed $seedk)  $(date)"
  inc=$(proxy "$prev" "$seedk") || exit 1; echo "$inc"; best_wins=$(wins_of "$inc")
  out=$(proxy "checkpoints_value/v$k.pt" "$seedk") || exit 1; echo "$out"; wins=$(wins_of "$out")
  if [ -n "$wins" ] && [ "$wins" -gt "$best_wins" ]; then
    echo "checkpoints_value/v$k.pt" > checkpoints_value/best.txt; echo "=== it$k accepted: v$k is the new incumbent ($wins > $best_wins)"
  else echo "=== it$k rejected: incumbent stays $prev ($wins <= $best_wins)"; fi
  if [ $((k % every)) -eq 0 ]; then
    echo "=== it$k gate v$k vs 3x ab, 300 games  $(date)"
    run uv run python evaluate.py --player "vnet:checkpoints_value/v$k.pt" --opponent alpha_beta --games 300 || exit 1
  fi
done
echo "=== done $(date)"
