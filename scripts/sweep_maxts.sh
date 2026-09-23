#!/bin/bash
# Label-scaling sweep (docs/RESEARCH-EXPERT.md item 0): does the loop want more rollout labels per round?
# For each --max-ts budget: N_SEEDS trainings from the incumbent on the last 4 iteration directories, greedy soup
# seeded with the incumbent, 4,000-game proxy vs 3x rab on one fresh seed shared by every arm and the incumbent.
# No generation. Usage: [N_SEEDS=3 SEED=50000007] scripts/sweep_maxts.sh 100000 300000 900000
set -u
export PYTHONUNBUFFERED=1
export PYTORCH_ALLOC_CONF=expandable_segments:True
cd "$(dirname "$0")/.."
N_SEEDS=${N_SEEDS:-3}; SEED=${SEED:-50000007}; TS_WEIGHT=${TS_WEIGHT:-3}
run() { systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 "$@"; }
read -r prev _ < checkpoints_value/best.txt
data=$(ls -d data/it[0-9]* | sort -V | tail -4)
echo "=== sweep incumbent $prev, data: $data, seed $SEED  $(date)"
run uv run python evaluate.py --player "vnet:$prev" --opponent rab --games 4000 --seed "$SEED" || exit 1
for N in "$@"; do
  echo "=== max-ts $N train  $(date)"
  for s in $(seq 0 $((N_SEEDS - 1))); do
    run uv run python train_value.py --data $data --init "$prev" --out "checkpoints_value/sw${N}_s$s.pt" --seed "$s" --epochs 6 --rank-weight 0 --sib-weight 0 --self-sibs 0 --ts-key ro --ts-weight "$TS_WEIGHT" --max-ts "$N" --win-weight 0 --aux-weight 0 || exit 1
  done
  run uv run python soup.py --greedy --base "$prev" --games 1000 --seed $((SEED + 500000)) --out "checkpoints_value/sw$N.pt" checkpoints_value/sw${N}_s*.pt || exit 1
  echo "=== max-ts $N proxy  $(date)"
  run uv run python evaluate.py --player "vnet:checkpoints_value/sw$N.pt" --opponent rab --games 4000 --seed "$SEED" || exit 1
done
echo "=== sweep done $(date)"
