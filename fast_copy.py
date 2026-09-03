"""Drop-in replacements for catanatron's State.copy / Board.copy.

Measured (docs/FINDINGS.md, M4 speed-up section): Game.copy() is 36% of a
search-player game and ~40 us/call, of which two copy.deepcopy calls on
board caches and two pickle round-trips are ~90%. The structures are flat
(dicts of lists of tuples / sets of ints), so comprehension copies are exact
and ~10x cheaper. Same semantics: every mutable container the engine mutates
in place is copied one level deep, which is as deep as they go.
"""

from collections import defaultdict

from catanatron.game import Game
from catanatron.models.board import Board
from catanatron.state import State


def _board_copy(self):
    board = Board(self.map, initialize=False)
    board.map = self.map  # immutable, shared
    board.buildings = self.buildings.copy()
    board.roads = self.roads.copy()
    board.connected_components = defaultdict(
        list, {color: [set(c) for c in comps] for color, comps in self.connected_components.items()}
    )
    board.board_buildable_ids = self.board_buildable_ids.copy()
    board.road_lengths = self.road_lengths.copy()
    board.road_color = self.road_color
    board.road_length = self.road_length
    board.robber_coordinate = self.robber_coordinate
    board.buildable_subgraph = self.buildable_subgraph
    board.buildable_edges_cache = {c: list(v) for c, v in self.buildable_edges_cache.items()}
    board.player_port_resources_cache = {c: set(v) for c, v in self.player_port_resources_cache.items()}
    return board


def _state_copy(self):
    s = State([], None, initialize=False)
    s.players = self.players
    s.discard_limit = self.discard_limit
    s.friendly_robber = self.friendly_robber
    s.board = self.board.copy()
    s.player_state = self.player_state.copy()
    s.color_to_index = self.color_to_index
    s.colors = self.colors
    s.resource_freqdeck = self.resource_freqdeck.copy()
    s.development_listdeck = self.development_listdeck.copy()
    s.buildings_by_color = {c: defaultdict(list, {k: list(v) for k, v in d.items()}) for c, d in self.buildings_by_color.items()}
    s.action_records = self.action_records.copy()
    s.num_turns = self.num_turns
    s.current_player_index = self.current_player_index
    s.current_turn_index = self.current_turn_index
    s.current_prompt = self.current_prompt
    s.is_initial_build_phase = self.is_initial_build_phase
    s.is_discarding = self.is_discarding
    s.is_moving_knight = self.is_moving_knight
    s.is_road_building = self.is_road_building
    s.free_roads_available = self.free_roads_available
    s.is_resolving_trade = self.is_resolving_trade
    s.current_trade = self.current_trade
    s.acceptees = self.acceptees
    s.spent_offers = self.spent_offers
    s.discard_counts = self.discard_counts.copy()  # apply_discard decrements in place
    return s


ORIGINALS = {"State.copy": State.copy, "Board.copy": Board.copy}


def install():
    State.copy = _state_copy
    Board.copy = _board_copy


def uninstall():
    State.copy = ORIGINALS["State.copy"]
    Board.copy = ORIGINALS["Board.copy"]
