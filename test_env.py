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
    from value_net import EXTRA_BASE, N_BASE, N_FEATURES, encode_for_value

    game = _random_game(3)
    for _ in range(40):
        game.play_tick()
    enc = Encoder()
    current = game.state.current_color()
    for p0 in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE):
        x = encode_for_value(enc, game, p0)
        assert x.shape == (N_FEATURES,)
        assert np.allclose(x[:N_BASE], enc.encode(game, p0), atol=1e-6)
        onehot = x[N_BASE:EXTRA_BASE]
        rel = {c: i for i, c in iter_players(game.state.colors, p0)}[current]
        assert onehot.sum() == 1.0 and onehot[rel] == 1.0, (p0, current, onehot)
    print("  encode_for_value turn one-hot is perspective-relative: ok")


def test_gen_labels():
    """gen_games samples: label is 1 exactly for the perspective that won."""
    import gen_games

    gen_games._init_worker(["wr", "wr", "wr", "wr"], 1.0)
    seed, part = gen_games.play_one(7)
    X, y, vp, turns_left = part["X"], part["y"], part["vp"], part["turns_left"]
    game = Game([WeightedRandomPlayer(c) for c in gen_games.COLORS], seed=7)
    acc = gen_games.StateSampler(1.0, 7)
    winner = game.play(accumulators=[acc])
    from value_net import N_FEATURES

    assert X.shape[1] == N_FEATURES and X.dtype == np.float16
    assert len(y) == len(acc.colors) > 100
    assert np.array_equal(y, np.array([c == winner for c in acc.colors], dtype=np.uint8))
    assert 0 < y.mean() < 1, "both classes present"
    assert vp.shape == (len(y), 4) and (vp[y == 1, 0] >= 10).all(), "winner's perspective must show >= 10 final VPs in slot 0"
    assert (vp[y == 0, 0] < 10).all() and (vp.max(axis=1) >= 10).all(), "exactly the winner reaches 10"
    assert turns_left.min() == 0 and np.all(np.diff(turns_left.astype(np.int32)) <= 0), "turns_left counts down to 0"
    print(f"  gen_games labels + aux targets match (winner={winner.value}, {len(y)} samples, base rate {y.mean():.2f}): ok")


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


def test_batched_search_matches_recursive():
    """ValueNetPlayer.decide() (full expansion, one forward) must equal the
    base AlphaBetaPlayer.alphabeta() recursion at depth 1 (no cutoffs there)
    once both use pinned chance outcomes, and expansion must be deterministic
    -- catanatron's execute_spectrum re-rolls the dice per 'outcome' because
    apply_roll reads action_record.result, not action.value."""
    import tempfile
    import time

    import catanatron.players.minimax as mm
    import torch

    import value_net as vn

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "rand.pt")
        torch.save(vn.ValueNet().state_dict(), path)
        p = vn.ValueNetPlayer(Color.BLUE, path, depth=1)
        enemies = [WeightedRandomPlayer(c) for c in (Color.RED, Color.WHITE, Color.ORANGE)]
        game = Game([p] + enemies, seed=5)
        for _ in range(60):
            game.play_tick()

        def leaves():
            p._leaf_obs, p._leaf_fixed = [], {}
            p._expand(game, 2)
            return [o for o in p._leaf_obs if o is not None]

        a, b = leaves(), leaves()
        assert len(a) == len(b) > 10 and all(np.array_equal(x, y) for x, y in zip(a, b)), "expansion not deterministic"

        orig = mm.expand_spectrum
        mm.expand_spectrum = vn.expand_outcomes
        try:
            checked = 0
            while game.winning_color() is None and checked < 25:
                if game.state.current_color() == Color.BLUE and len(game.playable_actions) > 1:
                    a_b = p.decide(game, game.playable_actions)
                    _, v_b = p._backup(p._expand(game, 1), p._score_leaves())
                    a_r, v_r = p.alphabeta(game.copy(), 1, float("-inf"), float("inf"), time.time() + 60, mm.DebugStateNode("r", Color.BLUE))
                    assert a_b == a_r and abs(v_b - v_r) < 1e-5, (a_b, a_r, v_b, v_r)
                    checked += 1
                game.play_tick()
        finally:
            mm.expand_spectrum = orig
    print(f"  batched expectimax == recursive AlphaBeta at depth 1 on {checked} decisions, deterministic expansion ({len(a)} leaves): ok")


def test_fast_copy_is_exact():
    """fast_copy's State/Board copies must equal catanatron's originals in
    content and be independent of the source; and an AlphaBeta game (whose
    decisions run on copies) must produce identical action records either way."""
    import pickle

    import fast_copy
    from catanatron.players.minimax import AlphaBetaPlayer

    def snapshot(state):
        d = {k: v for k, v in vars(state).items() if k not in ("board", "players")}
        b = {k: v for k, v in vars(state.board).items() if k not in ("map", "buildable_subgraph")}
        b["connected_components"] = {c: sorted(sorted(x) for x in v) for c, v in b["connected_components"].items()}
        b["player_port_resources_cache"] = {c: sorted(v, key=str) for c, v in b["player_port_resources_cache"].items()}
        b["buildable_edges_cache"] = {c: sorted(v) for c, v in b["buildable_edges_cache"].items()}
        return repr(([(k, d[k]) for k in sorted(d)], [(k, b[k]) for k in sorted(b)]))

    checked = 0
    try:
        for seed in range(3):
            game = _random_game(seed)
            while game.winning_color() is None and game.state.num_turns < 300:
                for _ in range(9):
                    if game.winning_color() is None:
                        game.play_tick()
                game.state.board.buildable_edges(Color.BLUE)
                game.state.board.get_player_port_resources(Color.RED)
                fast_copy.uninstall(); ref = game.copy()
                fast_copy.install(); fast = game.copy()
                assert snapshot(ref.state) == snapshot(fast.state), f"seed {seed} turn {game.state.num_turns}"
                before = snapshot(game.state)
                for _ in range(5):
                    if fast.winning_color() is None:
                        fast.execute(fast.playable_actions[0])
                assert snapshot(game.state) == before, "mutating the fast copy touched the original"
                checked += 1

        def ab_records(seed):
            random.seed(seed)
            players = [AlphaBetaPlayer(Color.BLUE)] + [WeightedRandomPlayer(c) for c in (Color.RED, Color.WHITE, Color.ORANGE)]
            game = Game(players, seed=seed)
            game.play()
            return [(r.action, r.result) for r in game.state.action_records]

        fast_copy.uninstall(); ref = ab_records(1)
        fast_copy.install(); fast = ab_records(1)
        assert ref == fast, "AlphaBeta game diverged under fast_copy"
    finally:
        fast_copy.install()
    print(f"  fast_copy exact + independent on {checked} states; AlphaBeta game identical ({len(ref)} records): ok")


def _rust_replay(players, seed):
    """Python plays; Rust replays every record; legal-action sets and full
    state snapshots must agree after every step. Returns (steps, error)."""
    import rust_bridge as rb

    random.seed(seed)
    game = Game(players, seed=seed)
    rs, ctx = rb.rust_state(game)
    colors = list(game.state.colors)
    steps = 0
    while game.winning_color() is None and game.state.num_turns < TURNS_LIMIT:
        py_actions = {rb.canon(a, ctx, colors) for a in game.playable_actions}
        rs_actions = set(rs.playable_actions())
        if py_actions != rs_actions:
            return steps, f"playable mismatch: only-py={sorted(py_actions - rs_actions)[:3]} only-rs={sorted(rs_actions - py_actions)[:3]}"
        record = game.play_tick()
        rs.apply(rb.canon(record.action, ctx, colors), rb.result_of(record))
        py, rust = rb.state_spec(game, ctx), rs.snapshot()
        bad = [k for k in py if py[k] != rust.get(k)]
        if bad:
            return steps, f"after {record.action.action_type.value}: " + "; ".join(f"{k}: py={py[k]!r} rs={rust.get(k)!r}"[:200] for k in bad[:3])
        steps += 1
    assert rs.winner() == (-1 if game.winning_color() is None else colors.index(game.winning_color()))
    return steps, None


def test_rust_engine_replays_python_games():
    """The Rust rules engine must reproduce catanatron step for step (the
    replay oracle from docs/RUST-ENGINE.md): every legal-action set and every
    state field, over random, weighted-random and value-function games."""
    from catanatron.players.value import ValueFunctionPlayer

    lineups = [(RandomPlayer, range(6)), (WeightedRandomPlayer, range(3)), (ValueFunctionPlayer, range(2))]
    total = 0
    for cls, seeds in lineups:
        for seed in seeds:
            steps, err = _rust_replay([cls(c) for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)], seed)
            assert err is None, f"{cls.__name__} seed {seed} diverged after {steps} steps: {err}"
            total += steps
    print(f"  Rust engine replays 11 Python games identically ({total} steps): ok")


def test_rust_encoder_matches_python():
    """catan_engine.State.encode: base block + turn one-hot equal the pure-Python
    encoder; the heuristic-summary block equals catanatron's own base_fn terms
    (value_production / reachability_features / tiles / hand synergy)."""
    import rust_bridge as rb
    from catanatron.features import build_production_features, reachability_features
    from catanatron.players.value import value_production
    from catanatron.models.enums import RESOURCES
    from value_net import EXTRA_BASE, N_FEATURES, encode_base_python

    prod_fn = build_production_features(True)
    checked = 0
    for seed in range(3):
        game = _random_game(seed)
        enc = Encoder()
        while game.winning_color() is None and game.state.num_turns < 200:
            for _ in range(13):
                if game.winning_color() is None:
                    game.play_tick()
            rs, ctx = rb.rust_state(game)
            layout = rb.layout(ctx)
            colors = list(game.state.colors)
            for p0 in range(4):
                py = encode_base_python(enc, game, colors[p0])
                ru = rs.encode(layout, p0)
                assert ru.shape == (N_FEATURES,)
                bad = np.flatnonzero(~np.isclose(py, ru[:EXTRA_BASE], atol=1e-6))
                assert len(bad) == 0, f"seed {seed} turn {game.state.num_turns} p0={p0}: {[(FEATURES[i] if i < len(FEATURES) else f'turn{i - len(FEATURES)}', py[i], ru[i]) for i in bad[:5]]}"
                ex = ru[EXTRA_BASE:]
                for i, color in iter_players(tuple(colors), colors[p0]):
                    ref_prod = value_production(prod_fn(game, color), "P0")
                    reach = reachability_features(game, color, 2)
                    ref_reach = [sum(reach[f"P0_{lvl}_ROAD_REACHABLE_{r}"] for r in RESOURCES) for lvl in range(3)]
                    b = game.state.buildings_by_color[color]
                    ref_tiles = len({t.id for n in b["SETTLEMENT"] + b["CITY"] for t in game.state.board.map.adjacent_tiles[n]})
                    got = ex[i * 5:i * 5 + 5]
                    exp = [ref_prod, *ref_reach, ref_tiles]
                    assert np.allclose(got, exp, atol=1e-5), (seed, game.state.num_turns, p0, i, got, exp)
                ps = game.state.player_state
                key = f"P{p0}"
                h = {r: ps[f"{key}_{r}_IN_HAND"] for r in RESOURCES}
                d_city = (max(2 - h["WHEAT"], 0) + max(3 - h["ORE"], 0)) / 5.0
                d_set = (max(1 - h["WHEAT"], 0) + max(1 - h["SHEEP"], 0) + max(1 - h["BRICK"], 0) + max(1 - h["WOOD"], 0)) / 4.0
                assert abs(ex[20] - (2 - d_city - d_set) / 2) < 1e-6
                checked += 1
    print(f"  Rust encoder: base block == Python, heuristic block == catanatron references, on {checked} pairs: ok")


def test_rust_search_matches_python():
    """Rust expand/backup picks the same action as ValueNetPlayer's Python
    expansion for the same net, and both see the same number of leaves."""
    import tempfile

    import torch

    import rust_bridge as rb
    from value_net import ValueNet, ValueNetPlayer, load_value_net

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "rand.pt")
        torch.save(ValueNet().state_dict(), path)
        net = load_value_net(path)
        p = ValueNetPlayer(Color.BLUE, path, depth=2)
        game = Game([p] + [WeightedRandomPlayer(c) for c in (Color.RED, Color.WHITE, Color.ORANGE)], seed=8)
        checked = 0
        while game.winning_color() is None and checked < 25:
            if game.state.current_color() == Color.BLUE and len(game.playable_actions) > 1:
                a_py = p.decide_python(game, game.playable_actions)
                n_py = len(p._leaf_obs)
                _, v_py = p._backup(p._expand(game, 2), p._score_leaves())
                rs, ctx = rb.rust_state(game)
                colors = list(game.state.colors)
                leaves, fixed = rs.expand(rb.layout(ctx), 2, colors.index(Color.BLUE))
                with torch.no_grad():
                    values = torch.sigmoid(net(torch.from_numpy(leaves))).squeeze(1).double().numpy()
                for i, v in fixed:
                    values[i] = v
                a_rs, v_rs = rs.backup(values)
                assert leaves.shape[0] == n_py, (leaves.shape, n_py)
                # exact ties between siblings are common under the heuristic prior, and the two
                # expansions order actions differently, so compare the backed-up root value
                assert abs(v_rs - v_py) < 1e-5, (v_rs, v_py, a_rs, a_py)
                checked += 1
            game.play_tick()
    print(f"  Rust search == Python search on {checked} decisions (same leaves, same root value): ok")


def test_arena_games_replay_in_python(n_games=6):
    """The Rust arena plays (rab + value-net seats, chance sampled in Rust);
    catanatron replays every logged (action, outcome) with the result pinned.
    Every action must be legal where it was played, the final Python state
    must equal the arena's final snapshot, and the winner must agree -- the
    mirror of test_rust_engine_replays_python_games."""
    import tempfile

    import torch
    from catanatron.models.enums import ActionRecord, ActionType, DEVELOPMENT_CARDS, RESOURCES

    import arena
    import gen_games
    import rust_bridge as rb
    from value_net import ValueNet

    def py_result(t, r):  # inverse of rust_bridge.result_of
        if t == ActionType.ROLL:
            return (r[0], r[1])
        if t == ActionType.BUY_DEVELOPMENT_CARD:
            return DEVELOPMENT_CARDS[r[0]]
        if t == ActionType.MOVE_ROBBER:
            return None if r[0] < 0 else RESOURCES[r[0]]
        if t == ActionType.DISCARD_RESOURCE:
            return RESOURCES[r[0]]
        return None

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "rand.pt")
        torch.save(ValueNet(hidden=64).state_dict(), path)
        steps, n_self, n_ts, n_ro = 0, 0, 0, 0
        for seed, winner, part, (game, log, snap) in arena.play([f"vnet:{path}", "rab", f"vnet:{path}", "rab"], range(40, 40 + n_games), sample_p=1.0, rank_p=1.0, sib_p=1.0, ts_p=1.0, roll_p=0.02, roll_m=2, batch=n_games, keep_log=True):
            ctx = rb.ctx_for(game)
            colors = list(game.state.colors)
            for canon, outcome in log:
                action = rb.uncanon(canon, game.state.current_color(), ctx, colors)
                assert action in game.playable_actions, (seed, steps, action, game.playable_actions[:4])
                game.execute(action, action_record=ActionRecord(action, py_result(action.action_type, outcome)))
                steps += 1
            py = rb.state_spec(game, ctx)
            # catanatron's pinned draw removes the *first* matching card (draw_from_listdeck) while a live
            # draw pops the last, so the replayed deck is a permutation of the arena's; nothing else observes order
            py["dev_deck"], snap["dev_deck"] = sorted(py["dev_deck"]), sorted(snap["dev_deck"])
            bad = [k for k in py if py[k] != snap.get(k)]
            assert not bad, (seed, bad[:3], [(py[k], snap.get(k)) for k in bad[:1]])
            assert game.winning_color() == winner, (seed, game.winning_color(), winner)
            assert (winner is None) == (part is None)
            if part is not None:
                # same schema and label logic as the Python StateSampler (test_gen_labels)
                y, vp, sx, sv, isp0 = part["y"], part["vp"], part["sib_x"], part["sib_v"], part["sib_isp0"]
                assert part["X"].shape[1] == sx.shape[2] == part["rank_c"].shape[1] == rb.N_FEATURES and sx.shape[1] == gen_games.StateSampler.K_SIB
                assert (vp[y == 1, 0] >= 10).all() and (vp[y == 0, 0] < 10).all() and part["turns_left"].min() == 0
                # self-play sets carry a one-hot of the chosen child; base_fn sets carry finite values
                onehot = np.nansum(sv, axis=1) == 1.0
                n_self += int(onehot.sum())
                assert (isp0[onehot]).all(), "self-play sibling sets are recorded from the decider's perspective"
                # search-value rows: one root + <= K_TS children per recorded value-net decision, values are probabilities
                tx, tv = part["ts_x"], part["ts_v"]
                assert tx.shape == (len(tv), rb.N_FEATURES) and len(tv) > 0 and (tv >= 0).all() and (tv <= 1).all(), (tx.shape, tv[:3])
                n_ts += len(tv)
                rx, rv = part["ro_x"], part["ro_v"]
                assert rx.shape == (len(rv), rb.N_FEATURES) and set(np.unique(rv)) <= {0.0, 0.5, 1.0}, (rx.shape, rv[:5])
                assert part["ro_n"].sum() == len(rv) and (part["ro_n"] >= 1).all(), "ro_n groups the rollout rows by decision"
                n_ro += len(rv)
        assert n_self > 0 and n_ro > 0
    print(f"  arena games replay in catanatron ({n_games} games, {steps} steps, final states equal, {n_self} self-play sibling sets, {n_ts} search-value rows, {n_ro} rollout-labeled rows): ok")


def test_longest_road_may_end_at_enemy_settlements():
    """catanatron issue #378 (docs/AUDIT-rules.md): a road whose ends are both enemy settlements must count
    its end edges. Python (the pinned fork) and the Rust port compute the same 9 on the same board, and Rust's
    own recompute (a BUILD_ROAD applied in Rust) agrees."""
    import networkx as nx
    from catanatron import Game, RandomPlayer
    from catanatron.models.board import STATIC_GRAPH as G
    from catanatron.models.enums import ActionPrompt

    import rust_bridge as rb

    path = [0, 5, 16, 18, 17, 15, 14, 13, 12, 3]  # a 9-edge simple path; ends >= 2 nodes from the middle
    mid = path[5]
    game = Game([RandomPlayer(c) for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)], seed=0)
    board = game.state.board
    board.build_settlement(Color.BLUE, mid, initial_build_phase=True)
    board.build_settlement(Color.RED, path[0], initial_build_phase=True)
    board.build_settlement(Color.RED, path[9], initial_build_phase=True)
    for i in range(5, 8):
        board.build_road(Color.BLUE, (path[i], path[i + 1]))
    for i in range(4, -1, -1):
        board.build_road(Color.BLUE, (path[i], path[i + 1]))
    last = (path[8], path[9])
    # hand the state to Rust one road short, with BLUE able to build it, then build it on both sides
    st = game.state
    st.current_player_index = list(st.colors).index(Color.BLUE)
    st.current_prompt = ActionPrompt.PLAY_TURN
    st.is_initial_build_phase = False
    key = f"P{st.current_player_index}"
    st.player_state[f"{key}_HAS_ROLLED"] = True
    st.player_state[f"{key}_WOOD_IN_HAND"] += 1
    st.player_state[f"{key}_BRICK_IN_HAND"] += 1
    rs, ctx = rb.rust_state(game)
    rs.apply(("BUILD_ROAD", ctx.edge_idx[tuple(sorted(last))], -1, -1), None)
    board.build_road(Color.BLUE, last)
    py, rust = board.road_length, rs.snapshot()["road_length"]
    assert py == rust == 9, (py, rust)
    print(f"  longest road capped by enemy settlements at both ends counts all 9 edges (python {py}, rust {rust}): ok")


def _far_node(G, buildings, extra=()):
    """A node at distance >= 2 from every building (the distance rule) and from `extra`."""
    import networkx as nx

    for n in sorted(G.nodes):
        if all(nx.shortest_path_length(G, n, b) >= 2 for b in list(buildings) + list(extra)):
            return n
    raise AssertionError("no free node")


def _rust_ready(game, color, **hand):
    """Hand the Python game to Rust with `color` on turn in PLAY_TURN, rolled, holding `hand`."""
    from catanatron.models.enums import ActionPrompt

    import rust_bridge as rb

    st = game.state
    st.current_player_index = st.current_turn_index = list(st.colors).index(color)
    st.current_prompt = ActionPrompt.PLAY_TURN
    st.is_initial_build_phase = False
    key = f"P{st.current_player_index}"
    st.player_state[f"{key}_HAS_ROLLED"] = True
    for res, n in hand.items():
        st.player_state[f"{key}_{res}_IN_HAND"] += n
    return rb.rust_state(game)


def test_longest_road_break_sets_card_aside():
    """Official rule (docs/AUDIT-rules.md): after a road is broken, the Longest Road card goes to the unique
    longest road of >= 5, otherwise it is set aside (the previous holder loses its 2 VP) until someone has one.
    catanatron d3f4ad0 handed it to the first player with the (tied, possibly < 5) maximum. Python fork
    (Board + maintain_longest_road) and Rust (BUILD_SETTLEMENT / BUILD_ROAD applied) side by side."""
    import networkx as nx
    from catanatron import Game, RandomPlayer
    from catanatron.models.board import STATIC_GRAPH as G
    from catanatron.state_functions import maintain_longest_road

    path = [0, 5, 16, 18, 17, 15, 14, 13, 12, 3]
    game = Game([RandomPlayer(c) for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)], seed=0)
    st, board = game.state, game.state.board
    colors = list(st.colors)
    blue = colors.index(Color.BLUE)
    vp = lambda c: st.player_state[f"P{colors.index(c)}_VICTORY_POINTS"]  # noqa: E731

    def road(color, edge):
        maintain_longest_road(st, *board.build_road(color, edge))

    board.build_settlement(Color.BLUE, path[2], initial_build_phase=True)
    for i in range(2, 9):
        road(Color.BLUE, (path[i], path[i + 1]))
    for i in range(1, -1, -1):
        road(Color.BLUE, (path[i], path[i + 1]))
    assert (board.road_color, board.road_length, vp(Color.BLUE)) == (Color.BLUE, 9, 2)
    # RED: a 5-road far away
    rp = [_far_node(G, board.buildings, extra=path)]
    while len(rp) < 6:
        rp.append(next(v for v in G.neighbors(rp[-1]) if v not in rp and all(nx.shortest_path_length(G, v, x) >= 2 for x in path)))
    board.build_settlement(Color.RED, rp[0], initial_build_phase=True)
    for i in range(5):
        road(Color.RED, (rp[i], rp[i + 1]))
    assert board.road_color == Color.BLUE
    # WHITE plows BLUE at path[4] (2 nodes from BLUE's settlement): pieces of 4 and 5 edges -> tie with RED at 5
    cut = path[4]
    off = next(v for v in G.neighbors(cut) if v not in path)
    w0 = next(v for v in G.neighbors(off) if v != cut and all(nx.shortest_path_length(G, v, b) >= 2 for b in board.buildings))
    board.build_settlement(Color.WHITE, w0, initial_build_phase=True)
    road(Color.WHITE, (w0, off))
    road(Color.WHITE, (off, cut))
    rs, ctx = _rust_ready(game, Color.WHITE, WOOD=1, BRICK=1, SHEEP=1, WHEAT=1)
    rs.apply(("BUILD_SETTLEMENT", cut, -1, -1), None)
    maintain_longest_road(st, *board.build_settlement(Color.WHITE, cut))
    snap = rs.snapshot()
    assert board.road_color is None and board.road_length == 5 and vp(Color.BLUE) == 0, (board.road_color, board.road_length, vp(Color.BLUE))
    assert snap["road_color"] == -1 and snap["road_length"] == 5 and not snap["has_road"][blue] and snap["vp"][blue] == 0, (snap["road_color"], snap["road_length"], snap["vp"])
    # BLUE extends its 5-piece to 6: unique longest again -> takes the card back
    end = path[9]
    ext = next(v for v in G.neighbors(end) if board.get_edge_color((end, v)) is None)
    rs2, ctx2 = _rust_ready(game, Color.BLUE, WOOD=1, BRICK=1)
    rs2.apply(("BUILD_ROAD", ctx2.edge_idx[tuple(sorted((end, ext)))], -1, -1), None)
    road(Color.BLUE, (end, ext))
    snap2 = rs2.snapshot()
    assert (board.road_color, board.road_length, vp(Color.BLUE)) == (Color.BLUE, 6, 2)
    assert snap2["road_color"] == blue and snap2["road_length"] == 6 and snap2["has_road"][blue] and snap2["vp"][blue] == 2, snap2["vp"]
    print("  longest road: broken into a tie -> card set aside (holder -2 VP), unique 6 takes it back; python == rust: ok")


def test_bank_shortage_pays_a_sole_recipient():
    """Official rule: a resource the bank cannot fully pay is withheld from everyone, unless only one player
    would receive it, who takes what is left. Python fork (yield_resources) and Rust (ROLL applied)."""
    from catanatron import Game, RandomPlayer
    from catanatron.apply_action import yield_resources
    from catanatron.models.board import STATIC_GRAPH as G
    from catanatron.models.enums import RESOURCES

    def scenario(two_recipients):
        game = Game([RandomPlayer(c) for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)], seed=1)
        board = game.state.board
        tile = next(t for t in board.map.land_tiles.values() if t.resource is not None)
        nodes = list(tile.nodes.values())
        board.build_settlement(Color.BLUE, nodes[0], initial_build_phase=True)
        board.build_city(Color.BLUE, nodes[0])  # BLUE wants 2
        if two_recipients:
            n2 = next(n for n in nodes if n != nodes[0] and n not in G.neighbors(nodes[0]))
            board.build_settlement(Color.RED, n2, initial_build_phase=True)  # RED wants 1
        return game, tile, RESOURCES.index(tile.resource)

    # sole recipient, bank holds 1 of 2 wanted -> gets 1
    game, tile, r = scenario(False)
    bank = [19] * 5
    bank[r] = 1
    pay, _ = yield_resources(game.state.board, bank, tile.number)
    assert pay[Color.BLUE][r] == 1, pay
    game.state.resource_freqdeck = bank
    rs, _ = _rust_ready(game, Color.WHITE)
    rs.apply(("ROLL", -1, -1, -1), (tile.number // 2, tile.number - tile.number // 2))
    snap = rs.snapshot()
    blue = list(game.state.colors).index(Color.BLUE)
    assert snap["hand"][blue][r] == 1 and snap["bank"][r] == 0, (snap["hand"][blue], snap["bank"])
    # two recipients want 3, bank holds 2 -> nobody gets any
    game, tile, r = scenario(True)
    bank = [19] * 5
    bank[r] = 2
    pay, _ = yield_resources(game.state.board, bank, tile.number)
    assert pay[Color.BLUE][r] == 0 and pay[Color.RED][r] == 0, pay
    game.state.resource_freqdeck = bank
    rs, _ = _rust_ready(game, Color.WHITE)
    rs.apply(("ROLL", -1, -1, -1), (tile.number // 2, tile.number - tile.number // 2))
    snap = rs.snapshot()
    red = list(game.state.colors).index(Color.RED)
    assert snap["hand"][blue][r] == 0 and snap["hand"][red][r] == 0 and snap["bank"][r] == 2, snap["bank"]
    print("  bank shortage: sole recipient takes what is left, two recipients get nothing; python == rust: ok")


def test_win_only_on_own_turn():
    """Official rule: reaching the target counts on the player's own turn. Python fork (Game.winning_color) and Rust."""
    from catanatron import Game, RandomPlayer

    import rust_bridge as rb

    game = Game([RandomPlayer(c) for c in (Color.BLUE, Color.RED, Color.WHITE, Color.ORANGE)], seed=2)
    st = game.state
    st.current_turn_index = 0
    st.player_state["P1_ACTUAL_VICTORY_POINTS"] = 10
    rs, _ = rb.rust_state(game)
    assert game.winning_color() is None and rs.winner() == -1
    st.current_turn_index = 1
    rs, _ = rb.rust_state(game)
    assert game.winning_color() == st.colors[1] and rs.winner() == 1
    print("  10 VP wins on the player's own turn only; python == rust: ok")


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
    test_batched_search_matches_recursive()
    test_fast_copy_is_exact()
    test_rust_engine_replays_python_games()
    test_rust_encoder_matches_python()
    test_rust_search_matches_python()
    test_arena_games_replay_in_python()
    test_longest_road_may_end_at_enemy_settlements()
    test_longest_road_break_sets_card_aside()
    test_bank_shortage_pays_a_sole_recipient()
    test_win_only_on_own_turn()
    print("test_env.py: all invariants passed")
