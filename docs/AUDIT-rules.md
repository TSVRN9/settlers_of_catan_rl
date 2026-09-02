# Rules audit: catanatron d3f4ad0 and the Rust port (2026-09-02)

The project pins catanatron at upstream HEAD `d3f4ad0` (2026-07-15). `catan_engine/` mirrors it step for step
(`test_env.py` replay oracles, both directions), so **every rules deviation below is shared by the Python
opponents and the Rust engine** — games are internally consistent, but not all of them are Catan.

## GitHub issues checked

| Issue | Status upstream | In this build | Verified how |
|---|---|---|---|
| #378 longest road with both ends capped by enemy settlements | **open** | **present, both engines** | repro below: a 9-edge road scored **7** |
| #376 road built through an enemy settlement on the road's end node | open, fixed by #377 (= pinned commit) | fixed | repro: BLUE's road ends at node N, RED (connected, non-initial) settles on N, the edge beyond N is not in BLUE's buildable edges; Rust `board_build_settlement` has the same endpoint-removal branch |
| #350 robber voided every tile touching the robbed tile's corners in `production_features` | closed (#358) | fixed | `encode.rs node_production` skips only the robbed tile; parity-tested vs catanatron in `test_env.py` |
| #361 discards were forced "half the hand at random" | closed (#362) | fixed (one card per DISCARD action, `Prompt::Discard`, `discard_counts`) | replay oracle |
| #345 exception placing the robber (server) | closed (#346) | n/a | — |
| #65 4:1 trade offered when a port applies, #41 game ends on largest army, #44/#51/#61 longest road / army stealing tests | closed, old | inherited fixes | replay oracle |
| #381 README bot ladder not reproducing in 1v1 | open | not a rules issue | — |

## #378 in detail

`Board.build_settlement` (endpoint case, `len(edges) == 1`) removes the settled node from the road owner's
connected component. `longest_acyclic_path` starts its DFS only from component nodes and never *enters* an enemy
node. A trail whose two ends are both enemy settlements can therefore only be started from an interior node,
so it loses an edge at each end. `catan_engine/src/board.rs` (`longest_acyclic_path` / `trail_from` / the
`vs.len() == 1` branch) is the same algorithm.

Repro (`Board` API, path `[0, 5, 16, 18, 17, 15, 14, 13, 12, 3]`, BLUE settlement at the middle node, roads built
outward to both ends):

| order | `road_length` | rules |
|---|---|---|
| roads first, then RED settles on both end nodes | 9 (no recompute on the endpoint case) | 9 |
| ... then BLUE builds any other road (recompute) | 9 | 9 |
| **RED settles on both end nodes first, then BLUE builds the roads toward them** | **7** | 9 |
| one end capped, recompute | 9 | 9 |

The third ordering is the common one in real games (settlements go down early, roads reach them later), and the
two lost edges are exactly the ones touching the enemy settlements. Effect: the Longest Road award (2 VP) can go
to the wrong player, in both the Python-AB games we evaluate against and the Rust games we train on.

**Fix (both engines, ~5 lines each):** let the trail search start from the road's enemy endpoints too — e.g. in
`longest_acyclic_path`, also seed the DFS from every enemy node that one of the player's roads touches (they are
excluded as *transit* nodes already, which is the correct rule). Keeping Python and Rust identical means patching
catanatron itself (a fork pinned in `pyproject.toml`), since the replay oracle is the port's correctness argument.
Fixing only the Rust side would break that oracle; fixing neither keeps the games consistent but wrong. This is
a decision for the owner: the target "beat `AlphaBetaPlayer`" is currently measured under the buggy rule, and
every checkpoint's number would need re-measuring under the fixed one.

## Other deviations from the official rules found while reading (not GitHub issues)

- **Bank shortage on a roll** (`apply_action.yield_resources`, `apply.rs yield_resources`): if the bank cannot pay
  a resource's full payout, *nobody* receives it. Official rule: only when more than one player would receive it;
  a single affected player takes what is left. Rare (needs a nearly empty bank), same in both engines.
- **Win check** (`Game.winning_color`): any player with actual VPs ≥ 10 wins at the moment it happens, counting
  hidden VP cards; the official rule is "on your own turn, announced". In practice VPs are only gained on one's own
  turn here (no player trades), so this only skips the announcement.
- **No player-to-player trading** — a documented simplification of catanatron, not a bug; it does change strategy.
- **Development cards**: one per turn, not on the turn bought (`OWNED_AT_START`) — correct.
- **Discard**: floor(hand / 2) when the hand exceeds 7 — correct.
- **Longest road award**: ≥ 5 and strictly longer than the holder — correct (ties keep the holder).

## Not audited

The catanatron test-suite is not installed (git dependency without tests); the Rust port's correctness argument
is the replay oracle against catanatron, not against the rules. A rules-level test-suite (scripted scenarios with
expected outcomes) would be the next step if rule fidelity matters for the goal.
