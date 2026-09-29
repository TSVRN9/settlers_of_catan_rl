#!/bin/bash
# Depth-2 self-play rollout labels (plan Step 4): every seat v64-class vnetx, labelled siblings played out by the depth-2
# search player itself, CRN across siblings. Usage: scripts/run_d2.sh FIRST LAST GAMES (4000 games ~ 46 min of generation)
# SELFPLAY= OPP=pool,pool GEN_POOL=jsrobot,jsrobot,jsrobot,jsdroid: two jSettler-port seats at every generation table (2026-09-28)
cd "$(dirname "$0")/.."
SELFPLAY=${SELFPLAY-1} DATA_PREFIX=d2 VSPEC=${VSPEC:-vnets3x} ROLL_P=${ROLL_P:-0.02} ROLL_M=${ROLL_M:-2} ROLL_NET=all ROLL_PARK=rust GEN_EXTRA="--roll-net-depth 2 --crn${ROLL_TRADES:+ --roll-trades $ROLL_TRADES}" \
SAMPLE_P=0.03 PER_GAME=16 WIN_WEIGHT=${WIN_WEIGHT:-0} TS_KEY=ro TS_WEIGHT=3 MAX_TS=300000 AUX_WEIGHT=0 \
DATA_LAST=${DATA_LAST:-3} N_SEEDS=5 SOUP_UNIFORM=1 GATE_POOL=rab3,jsrobot,cvnet:checkpoints_value/v57.pt \
TRAIN_EXTRA="--lr 1e-4 --dropout 0 --weight-decay 0${EMA:+ --ema $EMA}${HIDDEN:+ --hidden $HIDDEN}" \
exec scripts/run_exit.sh "$1" "$2" "$3" 1000
