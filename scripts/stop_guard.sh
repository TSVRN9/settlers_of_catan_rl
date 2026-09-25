#!/bin/bash
# Claude Code Stop hook (2026-09-23): refuse to end a turn while an experiment job runs and nothing will wake Claude
# when it finishes (a PID-keyed background waiter: `while kill -0 PID ...` / `until ...`). Once per stop chain:
# with stop_hook_active set, the stop goes through with a warning, so a job that can't be waited on never loops.
input=$(cat)
jobs=$(pgrep -af '^\S*python[0-9.]* (\S*/)?(gate|ladder|screen|train_value|gen_games|soup|evaluate|tournament)\.py|(heldout|run_exit|queue_[a-z0-9_]+|run2?)\.sh|catanrl\.Launch' | grep -v stop_guard | cut -c1-110)
[ -z "$jobs" ] && exit 0
pgrep -f 'while kill -0|until ' >/dev/null && exit 0
if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = true ]; then
  jq -n --arg j "$jobs" '{systemMessage: ("Experiment jobs are running with no waiter armed:\n" + $j)}'
  exit 0
fi
jq -n --arg j "$jobs" '{decision: "block", reason: ("Experiment jobs are still running and no background waiter is armed, so nothing will wake you when they finish:\n" + $j + "\nArm a run_in_background Bash waiter keyed on the job PID (while kill -0 PID; do sleep 30; done; <print the result>) before ending the turn, or say why no wait is needed.")}'
