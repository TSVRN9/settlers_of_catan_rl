"""Assert-based invariant checks for catan_env.py. No pytest — run directly:

    uv run python test_env.py
"""

import os
import random
import subprocess
import sys
from pathlib import Path

import numpy as np
from catanatron import Color, Game, RandomPlayer
from catanatron.features import create_sample_vector, iter_players
from catanatron.game import TURNS_LIMIT
from catanatron.gym.envs.action_space import to_action_space
from catanatron.players.weighted_random import WeightedRandomPlayer
from catanatron.state_functions import player_key
from stable_baselines3.common.vec_env import SubprocVecEnv

from catan_env import BASE_FEATURES, FEATURES, CachedMaskVecEnv, Encoder, FastCatanatronEnv


def _random_game(seed):
    random.seed(seed)
    players = [
        RandomPlayer(Color.BLUE),
        RandomPlayer(Color.RED),
        RandomPlayer(Color.WHITE),
        RandomPlayer(Color.ORANGE),
    ]
    return Game(players, seed=seed)


def test_encoder_matches_reference(n_games=6, sample_every=25, max_ticks=600):
    """Fast encoder's base block (indices [0:len(BASE_FEATURES)]) must equal
    catanatron's own create_sample_vector, feature for feature, at many points
    across the initial-placement and mid-game phases. This is also the
    primary correctness guarantee: catanatron's own feature_extractors
    already withhold opponent hand/dev-card identities (only counts), so
    matching them means we inherit that property. EXTRA_FEATURES (production,
    buildable nodes) are catanatron's own feature_extractors too, just not
    wired into get_feature_ordering -- verified separately in
    test_extra_features_match_catanatron_reference."""
    encoder = Encoder()
    checks = 0
    for gi in range(n_games):
        game = _random_game(seed=gi)
        tick = 0
        while game.winning_color() is None and tick < max_ticks:
            game.play_tick()
            tick += 1
            if tick % sample_every == 0:
                fast = encoder.encode(game, Color.BLUE)[: len(BASE_FEATURES)]
                ref = np.array(
                    create_sample_vector(game, Color.BLUE, BASE_FEATURES),
                    dtype=np.float32,
                )
                assert np.allclose(fast, ref, atol=1e-5), (
                    f"encoder mismatch game={gi} tick={tick}: "
                    f"{[(BASE_FEATURES[i], fast[i], ref[i]) for i in range(len(BASE_FEATURES)) if not np.isclose(fast[i], ref[i], atol=1e-5)][:5]}"
                )
                checks += 1
    assert checks > 20, f"only {checks} states sampled, test is too weak"
    print(f"  encoder differential test: {checks} states verified identical to create_sample_vector")


def test_extra_features_match_catanatron_reference(n_games=4, sample_every=30, max_ticks=400):
    """Production/buildable-node features must match catanatron's own
    build_production_features(True) extractor and board.buildable_node_ids
    directly -- these are real catanatron functions, just not wired into the
    default feature_extractors list (see catan_env.py's EXTRA_FEATURES
    comment), so this is a differential test against the library itself,
    same spirit as test_encoder_matches_reference."""
    from catanatron.features import build_production_features, iter_players

    from catan_env import PRODUCTION_FEATURES

    production_features = build_production_features(True)
    encoder = Encoder()
    checks = 0
    for gi in range(n_games):
        game = _random_game(seed=100 + gi)
        tick = 0
        while game.winning_color() is None and tick < max_ticks:
            game.play_tick()
            tick += 1
            if tick % sample_every != 0:
                continue
            fast = encoder.encode(game, Color.BLUE)
            extra = dict(zip(FEATURES[len(BASE_FEATURES) :], fast[len(BASE_FEATURES) :]))

            ref_production = production_features(game, Color.BLUE)
            for name in PRODUCTION_FEATURES:
                assert abs(extra[name] - ref_production[name]) < 1e-5, (
                    f"production mismatch game={gi} tick={tick} {name}: "
                    f"{extra[name]} vs {ref_production[name]}"
                )

            for i, color in iter_players(game.state.colors, Color.BLUE):
                ref_count = len(game.state.board.buildable_node_ids(color))
                assert extra[f"P{i}_BUILDABLE_NODES"] == ref_count, (
                    f"buildable_nodes mismatch game={gi} tick={tick} P{i}: "
                    f"{extra[f'P{i}_BUILDABLE_NODES']} vs {ref_count}"
                )
            checks += 1
    assert checks > 10, f"only {checks} states sampled, test is too weak"
    print(f"  extra features (production, buildable nodes) match catanatron reference: {checks} states")


def test_encoder_returns_fresh_arrays():
    game = _random_game(seed=1)
    for _ in range(20):
        game.play_tick()
    encoder = Encoder()
    a = encoder.encode(game, Color.BLUE)
    b = encoder.encode(game, Color.BLUE)
    assert a is not b, "encoder returned the same array object twice (aliasing)"
    a[:] = -999.0
    c = encoder.encode(game, Color.BLUE)
    assert not np.array_equal(c, a), "mutating a returned array corrupted a later encode"
    print("  encoder returns independent arrays: ok")


def test_interleaved_encoders_do_not_cross_contaminate(n_games=5, rounds=8):
    """Regression test: multiple Encoder instances alive at once, on
    different random maps, interleaved -- the pattern inference_server.py's
    workers use (several games per process). A shared static-template cache
    would let one game's tile/port refresh clobber another's."""
    games = [_random_game(seed=200 + g) for g in range(n_games)]
    encoders = [Encoder() for _ in games]
    for _ in range(rounds):
        for gi, game in enumerate(games):
            for _ in range(3):
                if game.winning_color() is not None:
                    break
                game.play_tick()
            fast = encoders[gi].encode(game, Color.BLUE)[: len(BASE_FEATURES)]
            ref = np.array(
                create_sample_vector(game, Color.BLUE, BASE_FEATURES), dtype=np.float32
            )
            assert np.allclose(fast, ref, atol=1e-5), (
                f"interleaved encoder {gi} diverged from reference -- cross-contamination "
                f"from another game's static template"
            )
    print(f"  {n_games} interleaved encoders x {rounds} rounds, no cross-contamination: ok")


def test_no_opponent_hand_identity_leak(n_trials=10):
    """Swapping one hidden card for another (count-preserving) must not move
    the encoded vector for either encoder. Losing a card outright (count
    -changing) must move both, in the aggregate-count feature only -- this is
    the positive control proving the field is actually read, not dead."""
    encoder = Encoder()
    verified_count_changes = 0
    for trial in range(n_trials):
        game = _random_game(seed=100 + trial)
        for _ in range(150 + trial * 10):
            if game.winning_color() is not None:
                break
            game.play_tick()
        if game.winning_color() is not None:
            continue

        opp_color = next(c for c in game.state.colors if c != Color.BLUE)
        opp_key = player_key(game.state, opp_color)
        ps = game.state.player_state
        from catanatron.models.enums import RESOURCES

        # --- identity shuffle: -3 of resource A, +3 of resource B (count unchanged) ---
        res_a, res_b = RESOURCES[0], RESOURCES[1]
        fast_before = encoder.encode(game, Color.BLUE)
        ref_before = np.array(
            create_sample_vector(game, Color.BLUE, BASE_FEATURES), dtype=np.float32
        )
        ps[f"{opp_key}_{res_a}_IN_HAND"] += 3
        ps[f"{opp_key}_{res_b}_IN_HAND"] -= 3
        fast_after = encoder.encode(game, Color.BLUE)
        ref_after = np.array(
            create_sample_vector(game, Color.BLUE, BASE_FEATURES), dtype=np.float32
        )
        assert np.array_equal(fast_before, fast_after), (
            "fast encoder leaked opponent hand identity on a count-preserving swap"
        )
        assert np.array_equal(ref_before, ref_after), (
            "reference create_sample_vector leaked identity too -- catanatron's own "
            "feature set changed, re-audit the hidden-info assumption"
        )
        # undo
        ps[f"{opp_key}_{res_a}_IN_HAND"] -= 3
        ps[f"{opp_key}_{res_b}_IN_HAND"] += 3

        # --- positive control: actually remove a card (count changes) ---
        held = [r for r in RESOURCES if ps[f"{opp_key}_{r}_IN_HAND"] > 0]
        if not held:
            continue
        res = held[0]
        fast_before = encoder.encode(game, Color.BLUE)
        ps[f"{opp_key}_{res}_IN_HAND"] -= 1
        fast_after = encoder.encode(game, Color.BLUE)
        assert not np.array_equal(fast_before, fast_after), (
            "removing an opponent's card changed nothing -- the count feature "
            "isn't wired up (test would be vacuous otherwise)"
        )
        opp_i = next(
            i for i, c in iter_players(game.state.colors, Color.BLUE) if c == opp_color
        )
        diff = np.flatnonzero(fast_before != fast_after)
        assert list(diff) == [FEATURES.index(f"P{opp_i}_NUM_RESOURCES_IN_HAND")], (
            f"unexpected features changed: {[FEATURES[i] for i in diff]}"
        )
        ps[f"{opp_key}_{res}_IN_HAND"] += 1
        verified_count_changes += 1

    assert verified_count_changes > 5, "positive control barely ran, test is too weak"
    print(f"  no opponent-hand-identity leak, {verified_count_changes} count-mutation trials: ok")


def test_mask_and_forced_decision_skip(n_episodes=4, seed=0):
    """Mask matches playable_actions exactly, and every real decision handed
    to the policy has >1 legal action -- i.e. forced single-action decisions
    were skipped, never surfaced as a transition."""
    rng = random.Random(seed)
    total_decisions = 0
    for ep in range(n_episodes):
        env = FastCatanatronEnv(
            {
                "enemies": [
                    RandomPlayer(Color.RED),
                    RandomPlayer(Color.WHITE),
                    RandomPlayer(Color.ORANGE),
                ]
            }
        )
        _obs, info = env.reset(seed=1000 + ep)
        for _ in range(400):
            valid = info["valid_actions"]
            mask = env.action_masks()

            expected = {
                to_action_space(a, env.player_colors, env.map_type)
                for a in env.game.playable_actions
            }
            actual = {i for i, v in enumerate(mask) if v}
            assert actual == expected, "mask does not match playable_actions"
            assert sum(mask) == len(env.game.playable_actions), (
                "mask.sum() != len(playable_actions) -- two actions may have "
                "collapsed onto one index"
            )
            assert len(env.game.playable_actions) > 1, (
                "a forced (single-action) decision reached the policy -- "
                "forced-decision skip is broken"
            )
            total_decisions += 1

            action = rng.choice(valid)
            _obs, _reward, terminated, truncated, info = env.step(action)
            if terminated or truncated:
                break
    assert total_decisions > 50, f"only {total_decisions} decisions exercised"
    print(f"  mask correctness + forced-decision-skip invariant, {total_decisions} decisions: ok")


def _vec_env_factory(seed):
    def _init():
        enemies = [
            WeightedRandomPlayer(Color.RED),
            WeightedRandomPlayer(Color.WHITE),
            WeightedRandomPlayer(Color.ORANGE),
        ]
        env = FastCatanatronEnv({"enemies": enemies})
        env.reset(seed=seed)
        return env

    return _init


def test_cached_mask_matches_env_method(n_envs=3, n_steps=25, seed=0):
    """CachedMaskVecEnv answers action_masks() from the cached
    info["valid_actions"] instead of an extra env_method() IPC round trip --
    must return byte-identical masks to the ground-truth env_method() call on
    the raw (unwrapped) VecEnv at every step, including right after reset.

    General-purpose fuzz check, not the guard against episode-boundary
    staleness specifically -- it only catches that bug when a boundary
    happens to land inside this 25-step random window (~25% of runs, which
    is what made it merely intermittent instead of reliably red when that
    bug was live). test_cached_mask_survives_episode_boundary forces a
    boundary deterministically and is the real regression guard for that."""
    raw = SubprocVecEnv([_vec_env_factory(seed=seed + i) for i in range(n_envs)])
    try:
        cached = CachedMaskVecEnv(raw)
        cached.reset()
        ref_masks = np.stack(raw.env_method("action_masks"))
        got_masks = np.stack(cached.env_method("action_masks"))
        assert np.array_equal(ref_masks, got_masks), "mask mismatch right after reset"

        rng = random.Random(seed)
        for _ in range(n_steps):
            valid_per_env = raw.env_method("get_valid_actions")
            actions = np.array([rng.choice(v) for v in valid_per_env])
            cached.step_async(actions)
            cached.step_wait()
            ref_masks = np.stack(raw.env_method("action_masks"))
            got_masks = np.stack(cached.env_method("action_masks"))
            assert np.array_equal(ref_masks, got_masks), (
                "CachedMaskVecEnv diverged from ground-truth action_masks()"
            )
    finally:
        raw.close()
    print(
        f"  CachedMaskVecEnv matches ground-truth action_masks(), "
        f"{n_envs} envs x {n_steps} steps: ok"
    )


def test_search_boundary_alignment_matches_env_step(n_games=4, checks_per_game=4):
    """Regression test for evaluate.py's search-wrapper boundary bug (see
    docs/FINDINGS.md, 2026-09-01 continued-3): after game.copy() ->
    execute(action) -> advance_until_decision, the resulting state must be a
    genuine p0 decision boundary -- p0's turn, more than one legal action
    (or game over) -- never mid-turn, not-p0's-turn, or a single forced
    action. Scoring a state that violates this asks the value head about a
    state class it never saw during training (FastCatanatronEnv.step()
    always advances through exactly this before encoding), which measurably
    wrecked win rate (61.3% reactive -> 32.0% search) before this was found
    and fixed.

    Note: this does NOT compare byte-for-byte against a second, independent
    env.step() rollout of the same action -- once an opponent turn or dice
    roll intervenes, both paths draw from the same global `random` stream,
    so two independently-run stochastic continuations diverge by
    construction (first-to-run consumes the draws the second one then
    misses), regardless of whether the boundary logic is correct. The
    structural invariant below is what actually distinguishes "boundary
    aligned" from "not.\""""
    from catan_env import advance_until_decision

    checks = 0
    for gi in range(n_games):
        enemies = [WeightedRandomPlayer(c) for c in (Color.RED, Color.WHITE, Color.ORANGE)]
        env = FastCatanatronEnv({"enemies": enemies})
        env.reset(seed=300 + gi)
        terminated = truncated = False
        game_checks = 0
        while not (terminated or truncated) and game_checks < checks_per_game:
            game = env.game
            action = game.playable_actions[0]
            action_int = to_action_space(action, env.player_colors, env.map_type)
            if len(game.playable_actions) > 1:
                game_copy = game.copy()
                game_copy.execute(action)
                advance_until_decision(game_copy, env.p0.color)
                at_boundary = (
                    game_copy.winning_color() is not None
                    or game_copy.state.num_turns >= TURNS_LIMIT
                    or (
                        game_copy.state.current_color() == env.p0.color
                        and len(game_copy.playable_actions) != 1
                    )
                )
                assert at_boundary, (
                    f"advance_until_decision stopped short of a real decision "
                    f"boundary: game={gi} current_color="
                    f"{game_copy.state.current_color()} "
                    f"num_playable={len(game_copy.playable_actions)}"
                )
                checks += 1
                game_checks += 1
            _obs, _r, terminated, truncated, _info = env.step(action_int)
    assert checks > 10, f"only {checks} checks ran, test too weak"
    print(f"  search-wrapper decision-boundary alignment, {checks} checks: ok")


def _short_vec_env_factory(seed):
    def _init():
        enemies = [
            WeightedRandomPlayer(Color.RED),
            WeightedRandomPlayer(Color.WHITE),
            WeightedRandomPlayer(Color.ORANGE),
        ]
        env = FastCatanatronEnv({"enemies": enemies, "vps_to_win": 3})
        env.reset(seed=seed)
        return env

    return _init


def test_cached_mask_survives_episode_boundary(n_envs=3, seed=0, max_steps=400):
    """Regression test for the CachedMaskVecEnv staleness bug found this
    session (see docs/FINDINGS.md, 2026-09-01 continued-4): SubprocVecEnv's
    worker auto-resets a finished episode and overwrites `obs` with the new
    episode's observation, but leaves `info["valid_actions"]` at the
    just-finished game's terminal state -- caching that handed the policy a
    stale mask on the very first decision of every new episode, for the
    entire lifetime of every SubprocVecEnv-based training run on this
    project. test_cached_mask_matches_env_method only catches this when an
    episode boundary happens to fall inside its 25-step random window
    (~25% of runs); this test forces one deterministically with
    `vps_to_win=3` and checks the mask on the exact reset step."""
    raw = SubprocVecEnv([_short_vec_env_factory(seed=seed + i) for i in range(n_envs)])
    try:
        cached = CachedMaskVecEnv(raw)
        cached.reset()
        rng = random.Random(seed)
        boundary_checks = 0
        for _ in range(max_steps):
            valid_per_env = raw.env_method("get_valid_actions")
            actions = np.array([rng.choice(v) for v in valid_per_env])
            cached.step_async(actions)
            _obs, _rewards, dones, _infos = cached.step_wait()
            ref_masks = np.stack(raw.env_method("action_masks"))
            got_masks = np.stack(cached.env_method("action_masks"))
            assert np.array_equal(ref_masks, got_masks), (
                "CachedMaskVecEnv diverged from ground-truth action_masks() "
                f"(any(dones)={any(dones)})"
            )
            if any(dones):
                boundary_checks += 1
            if boundary_checks >= 3:
                break
        assert boundary_checks >= 3, (
            f"only {boundary_checks} episode boundaries hit in {max_steps} steps, "
            "test didn't exercise the bug"
        )
    finally:
        raw.close()
    print(
        f"  CachedMaskVecEnv mask correct across {boundary_checks} forced "
        f"episode-boundary resets: ok"
    )


def test_ppo_player_decodes_valid_actions_for_any_color():
    """M3 self_play.py's PPOPlayer calls to_action_space/from_action_space
    using game.state.colors (actual seating order) for a possibly-non-BLUE
    color, not FastCatanatronEnv's fixed (BLUE, RED, WHITE, ORANGE) order.
    Confirms get_action_array's output doesn't depend on tuple order (only
    on the set of colors present) and that PPOPlayer's decoded action is
    always a real legal action for whichever color it's playing -- the
    mirror of FastCatanatronEnv._decode_action's own assertion."""
    from self_play import PPOPlayer
    from catanatron.gym.envs.action_space import get_action_array

    assert get_action_array(
        (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE), "BASE"
    ) == get_action_array((Color.RED, Color.WHITE, Color.BLUE, Color.ORANGE), "BASE")

    checkpoint = Path(__file__).with_name("checkpoints_bc") / "bc_model.zip"
    assert checkpoint.exists(), f"missing {checkpoint} -- run train_bc.py first"

    for seat_color in (Color.RED, Color.WHITE, Color.ORANGE, Color.BLUE):
        others = [c for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE) if c != seat_color]
        players = {seat_color: PPOPlayer(seat_color, str(checkpoint))}
        for c in others:
            players[c] = RandomPlayer(c)
        ordered = [players[c] for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)]
        game = Game(ordered, seed=42)
        checks = 0
        while game.winning_color() is None and game.state.num_turns < TURNS_LIMIT and checks < 30:
            if game.state.current_color() == seat_color and len(game.playable_actions) > 1:
                action = players[seat_color].decide(game, game.playable_actions)
                assert action in game.playable_actions, (
                    f"PPOPlayer({seat_color}) decoded an action outside its own "
                    f"playable_actions: {action}"
                )
                checks += 1
            game.play_tick()
        assert checks > 0, f"no non-forced decisions observed for {seat_color} in 30 ticks"
    print("  PPOPlayer decodes legal actions for every seat color: ok")


def test_seeded_games_are_reproducible_across_processes():
    """Catanatron seeds through the global `random` module, so a seeded game
    should be bit-identical -- but hash randomization reorders
    `game.playable_actions` per process, so the opponents' `random.choice`
    picks differently and the game diverges. `evaluate.py` pins
    PYTHONHASHSEED to stop that; this fails if the guard is removed."""
    script = (
        "import random;"
        "from catanatron import Game, Color;"
        "from catanatron.players.weighted_random import WeightedRandomPlayer as W;"
        "random.seed(7);"
        "g=Game([W(c) for c in (Color.BLUE,Color.RED,Color.WHITE,Color.ORANGE)],seed=7);"
        "g.play();"
        "print(len(g.state.action_records), g.winning_color())"
    )
    env = dict(os.environ)
    env.pop("PYTHONHASHSEED", None)
    runs = {
        subprocess.run(
            [sys.executable, "-c", script], env=env, capture_output=True, text=True, check=True
        ).stdout.strip()
        for _ in range(8)
    }
    if len(runs) == 1:
        # Probabilistic: 8 unpinned hash-seed draws could coincidentally agree.
        # Not a regression by itself -- the assertions below are what matter.
        print(f"  note: 8 unpinned runs did not diverge this time ({runs})")

    env["PYTHONHASHSEED"] = "0"
    pinned = {
        subprocess.run(
            [sys.executable, "-c", script], env=env, capture_output=True, text=True, check=True
        ).stdout.strip()
        for _ in range(4)
    }
    assert len(pinned) == 1, f"PYTHONHASHSEED=0 did not make games reproducible: {pinned}"

    src = Path(__file__).with_name("evaluate.py").read_text()
    assert "PYTHONHASHSEED" in src and "execv" in src, (
        "evaluate.py lost its PYTHONHASHSEED re-exec guard -- win rates become "
        "unreproducible (see docs/FINDINGS.md, 2026-09-01)"
    )
    print(f"  seeded games reproducible only with PYTHONHASHSEED pinned: ok ({pinned.pop()})")


def test_value_encoding_turn_onehot():
    """value_net.encode_for_value appends a 4-one-hot of whose turn it is,
    relative to the perspective color, after the 1026 base features."""
    from value_net import N_BASE, N_FEATURES, encode_for_value

    game = _random_game(3)
    for _ in range(40):
        game.play_tick()
    enc = Encoder()
    current = game.state.current_color()
    for p0 in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE):
        x = encode_for_value(enc, game, p0)
        assert x.shape == (N_FEATURES,)
        assert np.array_equal(x[:N_BASE], enc.encode(game, p0))
        onehot = x[N_BASE:]
        rel = {c: i for i, c in iter_players(game.state.colors, p0)}[current]
        assert onehot.sum() == 1.0 and onehot[rel] == 1.0, (p0, current, onehot)
    print("  encode_for_value turn one-hot is perspective-relative: ok")


def test_gen_labels():
    """gen_games samples: label is 1 exactly for the perspective that won."""
    import gen_games

    gen_games._init_worker(["wr", "wr", "wr", "wr"], 1.0)
    seed, X, y = gen_games.play_one(7)
    game = Game([WeightedRandomPlayer(c) for c in gen_games.COLORS], seed=7)
    acc = gen_games.StateSampler(1.0, 7)
    winner = game.play(accumulators=[acc])
    from value_net import N_FEATURES

    assert X.shape[1] == N_FEATURES and X.dtype == np.float16
    assert len(y) == len(acc.colors) > 100
    assert np.array_equal(y, np.array([c == winner for c in acc.colors], dtype=np.uint8))
    assert 0 < y.mean() < 1, "both classes present"
    print(f"  gen_games labels match (winner={winner.value}, {len(y)} samples, base rate {y.mean():.2f}): ok")


def test_value_net_player_plays_legal_game():
    """ValueNetPlayer with a random net completes a game through
    AlphaBetaPlayer's search hook; the value is a probability, terminal
    states are scored exactly, and evaluate.py's --player path returns a bool."""
    import tempfile

    import torch

    import evaluate
    from value_net import ValueNet, ValueNetPlayer

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "rand.pt")
        torch.save(ValueNet().state_dict(), path)
        p = ValueNetPlayer(Color.BLUE, path)
        game = _random_game(11)
        v = p.value_function(game, Color.BLUE)
        assert 0.0 <= v <= 1.0, v
        players = [p, WeightedRandomPlayer(Color.RED), WeightedRandomPlayer(Color.WHITE), WeightedRandomPlayer(Color.ORANGE)]
        game = Game(players, seed=11)
        winner = game.play()
        assert winner is not None
        assert p.value_function(game, winner) == 1.0 and p.value_function(game, next(c for c in game.state.colors if c != winner)) == 0.0
        result = evaluate.play_one_player(f"vnet:{path}", WeightedRandomPlayer, 12)
        assert isinstance(result, bool)
    print(f"  ValueNetPlayer plays a full game via AlphaBetaPlayer's hook (winner={winner.value}): ok")


if __name__ == "__main__":
    test_encoder_matches_reference()
    test_extra_features_match_catanatron_reference()
    test_encoder_returns_fresh_arrays()
    test_interleaved_encoders_do_not_cross_contaminate()
    test_no_opponent_hand_identity_leak()
    test_mask_and_forced_decision_skip()
    test_cached_mask_matches_env_method()
    test_cached_mask_survives_episode_boundary()
    test_search_boundary_alignment_matches_env_step()
    test_ppo_player_decodes_valid_actions_for_any_color()
    test_seeded_games_are_reproducible_across_processes()
    test_value_encoding_turn_onehot()
    test_gen_labels()
    test_value_net_player_plays_legal_game()
    print("test_env.py: all invariants passed")
