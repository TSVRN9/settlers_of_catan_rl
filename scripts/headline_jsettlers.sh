#!/bin/bash
# The headline: TOKEN vs 3 stock jSettlers (default MIX, full mode), SHARDS x 100 games, every shard at once (the box sat ~90% idle
# with 10 servers; 5 forced turn-ends in 1,000 games), each shard in its own systemd scope (stop one with `systemctl --user stop js-<name>-s<N>.scope`).
#   scripts/headline_jsettlers.sh vnet:checkpoints_value/v57.pt v57 [shards=10]
set -eu
tok=$1; name=$2; shards=${3:-10}
cd "$(dirname "$0")/.."
mkdir -p docs/benchmark/headline_$name data/headline_$name
seq 0 $((shards - 1)) | xargs -P$shards -I{} sh -c "systemd-run --user --scope -q --unit js-$name-s{} -p MemoryMax=5G -p MemorySwapMax=0 \
  env PORT=\$((8882 + {})) MIX=default JAVA_OPTS=-Xmx1g jsettlers/run.sh play 100 full '$tok' docs/benchmark/headline_$name/s{}.txt \
  > data/headline_$name/s{}.log 2>&1"
cat docs/benchmark/headline_$name/s*.txt > docs/benchmark/headline_jsettlers_$name.txt && rm -r docs/benchmark/headline_$name
uv run --no-sync python tools/jsettlers_results.py docs/benchmark/headline_jsettlers_$name.txt
