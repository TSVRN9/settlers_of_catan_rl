#!/bin/bash
# Training-recipe sweep, no generation: each argument is one arm = extra train_value.py flags (quoted string).
# Per arm: N_SEEDS draws from the incumbent on the last 4 iteration directories, greedy soup seeded with the
# incumbent, 4,000-game proxy vs 3x rab on one fresh seed shared by every arm and the incumbent; the per-draw
# 1,000-game scores the soup prints are the finer signal. Generalises sweep_maxts.sh (2026-09-22).
# Usage: [N_SEEDS=3 SEED=51000007] scripts/sweep_train.sh "--max-ts 900000 --epochs 2" "--max-ts 900000 --lr 3e-4"
set -u
export PYTHONUNBUFFERED=1
export PYTORCH_ALLOC_CONF=expandable_segments:True
cd "$(dirname "$0")/.."
N_SEEDS=${N_SEEDS:-3}; SEED=${SEED:-51000007}; TS_WEIGHT=${TS_WEIGHT:-3}
run() { systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 "$@"; }
read -r prev _ < checkpoints_value/best.txt
data=$(ls -d data/it[0-9]* | sort -V | tail -4)
echo "=== sweep incumbent $prev, data: $(echo $data), seed $SEED  $(date)"
run uv run python evaluate.py --player "vnet:$prev" --opponent rab --games 4000 --seed "$SEED" || exit 1
for arm in "$@"; do
  name=$(echo "$arm" | tr -c 'A-Za-z0-9.\n' '_' | sed 's/_*$//; s/^_*//')
  echo "=== arm [$arm] train  $(date)"
  for s in $(seq 0 $((N_SEEDS - 1))); do
    run uv run python train_value.py --data $data --init "$prev" --out "checkpoints_value/sw_${name}_s$s.pt" --seed "$s" --epochs 6 --rank-weight 0 --sib-weight 0 --self-sibs 0 --ts-key ro --ts-weight "$TS_WEIGHT" --win-weight 0 --aux-weight 0 $arm || exit 1
  done
  run uv run python soup.py --greedy --base "$prev" --games 1000 --seed $((SEED + 500000)) --out "checkpoints_value/sw_$name.pt" checkpoints_value/sw_${name}_s*.pt || exit 1
  echo "=== arm [$arm] proxy  $(date)"
  run uv run python evaluate.py --player "vnet:checkpoints_value/sw_$name.pt" --opponent rab --games 4000 --seed "$SEED" || exit 1
done
echo "=== sweep done $(date)"
