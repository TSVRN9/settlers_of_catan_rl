#!/bin/bash
# Held-out check (2026-09-23 strongest-agent goal): report-only, never used to accept or reject. Opponents that no gate
# or training run sees: real jSettlers through the Java bridge, Python AlphaBeta, and a tournament pool of the thesis
# BUCT / VPI agents, DRRL and the FAST jSettler. TOKEN is a value_net.make_player token (the Python player trades like
# the arena's vnetx:).
#   scripts/heldout.sh vnet:checkpoints_value/v57.pt v57
set -eu
tok=$1; name=$2; out=docs/benchmark/heldout_$name
cd "$(dirname "$0")/.."
run() { systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 "$@"; }
echo "=== $name: real jSettlers, 100 games $(date)"
PORT=${PORT:-8882} MIX=default run jsettlers/run.sh play 100 full "$tok" "${out}_jsettlers.txt"
echo "=== $name: Python AlphaBeta, 300 games $(date)"
# ./evaluate.py, not evaluate.py: run_exit.sh's busy() guard matches "python evaluate.py" and would stop a running loop
run uv run python ./evaluate.py --player "$tok" --opponent alpha_beta --games 300 | tee "${out}_ab.txt"
echo "=== $name: pool buct / vpi / drrl / jsdroid $(date)"
run uv run python tournament.py --pool "$tok,buct,vpi,drrl,jsdroid" --games 40 --out "${out}_pool.json"
echo "=== $name done $(date)"
