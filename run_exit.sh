#!/bin/bash
# M4 expert-iteration loop, unattended. Usage: ./run_exit.sh <first_k> <last_k> [games] [ab_gate_every]
# Iteration k: 2 seats of v(k-1) + 2 Rust-AlphaBeta seats in the Rust arena (gen_games.py / arena.py)
# -> data/itk; train vk on the last 4 iterations' data (outcome + aux + rank + sibling losses),
# warm-started from v(k-1); 4000-game proxy gate vs 3x Rust AlphaBeta every iteration (~2.5 min, ±1.4 pt),
# 300-game gate vs 3x Python AlphaBeta -- the number docs/FINDINGS.md reports -- every ab_gate_every
# iterations (~10 min). Log: whatever stdout is redirected to.
set -u
export PYTHONUNBUFFERED=1
cd "$(dirname "$0")"
first=$1; last=$2; games=${3:-4000}; every=${4:-3}
last_shard=$(printf "shard_%04d.npz" $((games / 500 - 1)))  # gen_games --shard 500
for k in $(seq "$first" "$last"); do
  prev=checkpoints_value/v$((k - 1)).pt
  V="vnet:$prev"
  echo "=== it$k gen: $V x2 + rab x2, $games games  $(date)"
  if [ -f "data/it$k/$last_shard" ]; then echo "  data/it$k complete, skipping generation"; else
  uv run python gen_games.py --lineup "$V,$V,rab,rab" --games "$games" --seed $((k * 100000)) --rank-p 0.5 --sib-p 0.3 --out "data/it$k" || exit 1; fi
  echo "=== it$k train  $(date)"
  uv run python train_value.py --data $(ls -d data/it[0-9]* | sort -V | tail -4) --init "$prev" --out "checkpoints_value/v$k.pt" --epochs 6 --rank-weight 0.5 --sib-weight 1 --self-sibs 0 || exit 1
  echo "=== it$k proxy gate v$k vs 3x rab, 4000 games  $(date)"
  uv run python evaluate.py --player "vnet:checkpoints_value/v$k.pt" --opponent rab --games 4000 || exit 1
  if [ $((k % every)) -eq 0 ]; then
    echo "=== it$k gate v$k vs 3x ab, 300 games  $(date)"
    uv run python evaluate.py --player "vnet:checkpoints_value/v$k.pt" --opponent alpha_beta --games 300 || exit 1
  fi
done
echo "=== done $(date)"
