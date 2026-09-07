#!/usr/bin/env bash
# Build the bridge bot and run bots-only games on a headless JSettlers server (docs/BENCHMARK.md Phase B).
#
#   jsettlers/run.sh build
#   [PORT=8882] [MIX=default|smart|fast] [TURN_TIMEOUT=30] jsettlers/run.sh play <games> <full|trades|log> <player-token> <results-file> [bots=4] [pause=1]
#
# `play` starts the server with <bots> built-in robots (the server wants at least 4 of its own) plus one bridge bot (jsettlers.bots.percent3p=25 seats it in every 4-player game) (started in the server JVM
# through jsettlers.bots.start3p) and asks for <games> bots-only games; the bridge bot writes one line
# per finished game to <results-file>. Built-in bot names decide their strategy: "robot N" = smart,
# "droid N" = fast (SOCServer.ROBOT_PARAMS_SMARTER / _DEFAULT).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
JS=$ROOT/vendor/JSettlers2/jsettlers-2.6.10
JAR=$JS/JSettlersServer-2.6.10.jar
OUT=$ROOT/jsettlers/out

case "${1:-}" in
  build)
    mkdir -p "$OUT"
    javac --release 17 -cp "$JAR" -d "$OUT" "$ROOT"/jsettlers/*.java
    echo "built $OUT"
    ;;
  play)
    games=${2:?games}; mode=${3:?mode}; player=${4:?player token}; results=${5:?results file}; bots=${6:-4}; pause=${7:-1}
    port=${PORT:-8882}; mix=${MIX:-default}   # MIX=smart|fast pins every built-in robot's parameter set (Launch.java)
    cd "$ROOT"
    # bridge.* are JVM properties (read by our classes); jsettlers.* must follow the main class, the
    # server parses its own -D arguments
    exec java -cp "$JAR:$OUT" \
      -Dbridge.mode="$mode" -Dbridge.player="$player" -Dbridge.repo="$ROOT" -Dbridge.results="$results" -Dbridge.mix="$mix" \
      catanrl.Launch \
      -Djsettlers.startrobots="$bots" -Djsettlers.bots.start3p=1,catanrl.BridgeClient \
      -Djsettlers.bots.botgames.total="$games" -Djsettlers.bots.botgames.parallel=1 \
      -Djsettlers.bots.botgames.shutdown=Y -Djsettlers.bots.fast_pause_percent="$pause" \
      -Djsettlers.bots.timeout.turn=${TURN_TIMEOUT:-30} -Djsettlers.bots.percent3p=25 \
      "$port" 20
    ;;
  *)
    echo "usage: $0 build | play <games> <mode> <player> <results> [bots] [pause]" >&2
    exit 2
    ;;
esac
