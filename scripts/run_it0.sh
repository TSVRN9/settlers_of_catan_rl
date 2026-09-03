#!/bin/bash
# M4 iteration 0, unattended. Log: checkpoints_value/it0.log
export PYTHONUNBUFFERED=1
cd "$(dirname "$0")/.."  # repo root
echo "=== calibration: ab vs 3x ab, 300 games  $(date)"; uv run python evaluate.py --player ab --opponent alpha_beta --games 300
echo "=== gen it0: ab,ab,ab,ab 5000 games  $(date)"; uv run python gen_games.py --lineup ab,ab,ab,ab --games 5000 --out data/it0
echo "=== train v0  $(date)"; uv run python train_value.py --data data/it0 --out checkpoints_value/v0.pt --epochs 10
echo "=== eval v0 vs 3x ab, 300 games  $(date)"; uv run python evaluate.py --player vnet:checkpoints_value/v0.pt --opponent alpha_beta --games 300
echo "=== done $(date)"
