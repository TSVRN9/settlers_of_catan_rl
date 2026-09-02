#!/bin/bash
# M4 expert-iteration loop, unattended. Usage: ./run_exit.sh <first_k> <last_k> [games]
# Iteration k: 2 seats of v(k-1) + 2 Rust-AlphaBeta seats (rank pairs recorded from those)
# -> data/itk; train vk on all data so far (outcome + aux + rank losses), warm-started from
# v(k-1); 300-game gate vs 3x Python AlphaBeta. Log: checkpoints_value/exit.log
set -u
export PYTHONUNBUFFERED=1
cd "$(dirname "$0")"
first=$1; last=$2; games=${3:-5000}
for k in $(seq "$first" "$last"); do
  prev=checkpoints_value/v$((k - 1)).pt
  V="vnet:$prev"
  echo "=== it$k gen: $V x2 + rab x2, $games games  $(date)"
  uv run python gen_games.py --lineup "$V,$V,rab,rab" --games "$games" --seed $((k * 100000)) --rank-p 0.5 --out "data/it$k" || exit 1
  echo "=== it$k train  $(date)"
  uv run python train_value.py --data $(ls -d data/it[0-9]* | sort -V | sed -n "1,$((k + 1))p") --init "$prev" --out "checkpoints_value/v$k.pt" --epochs 10 || exit 1
  echo "=== it$k eval v$k vs 3x ab, 300 games  $(date)"
  uv run python evaluate.py --player "vnet:checkpoints_value/v$k.pt" --opponent alpha_beta --games 300 || exit 1
done
echo "=== done $(date)"
