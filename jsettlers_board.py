"""JSettlers' classic 4-player board <-> catanatron's BASE map (docs/BENCHMARK.md Phase B).

The Java bridge sends the board and every piece in JSettlers coordinates (hex coords 0xRC, node
coords; roads and ports as node pairs). Here they become a catanatron CatanMap on the BASE
template, so rust_bridge.Ctx, the value net's per-node features and the Rust engine see a board
they were built for. Both grids are pointy-top hexes with corners numbered clockwise from north;
JSettlers' nine port facings around the water ring are catanatron's in the same cyclic order, so
a rotation lands every JSettlers port on a BASE port (three do, the ring being three-fold
symmetric; `selfcheck()` verifies the round trip on random boards under every rotation).

JSettlers geometry (soc.game.SOCBoard, Thomas' dissertation appendix A): hex neighbours at
NE +0x02, E +0x22, SE +0x20, SW -0x02, W -0x22, NW -0x20; hex corners N +0x01, NE +0x12,
SE +0x21, S +0x10, SW -0x01, NW -0x10. Hex types CLAY 1, ORE 2, SHEEP 3, WHEAT 4, WOOD 5,
DESERT 6; port types MISC 0 then the same numbers.
"""

from catanatron.models.coordinate_system import Direction, UNIT_VECTORS
from catanatron.models.enums import BRICK, ORE, SHEEP, WHEAT, WOOD, NodeRef
from catanatron.models.map import BASE_MAP_TEMPLATE, CatanMap, LandTile, Port, initialize_tiles

CENTER = 0x77
LAND_HEXES = [0x33, 0x35, 0x37, 0x53, 0x55, 0x57, 0x59, 0x73, 0x75, 0x77, 0x79, 0x7B, 0x95, 0x97, 0x99, 0x9B, 0xB7, 0xB9, 0xBB]
JS_DIRS = [0x02, 0x22, 0x20, -0x02, -0x22, -0x20]  # NE, E, SE, SW, W, NW (clockwise)
JS_CORNERS = [0x01, 0x12, 0x21, 0x10, -0x01, -0x10]  # N, NE, SE, S, SW, NW (clockwise)
CAT_DIRS = [Direction.NORTHEAST, Direction.EAST, Direction.SOUTHEAST, Direction.SOUTHWEST, Direction.WEST, Direction.NORTHWEST]
CAT_CORNERS = [NodeRef.NORTH, NodeRef.NORTHEAST, NodeRef.SOUTHEAST, NodeRef.SOUTH, NodeRef.SOUTHWEST, NodeRef.NORTHWEST]
JS_RESOURCE = {1: BRICK, 2: ORE, 3: SHEEP, 4: WHEAT, 5: WOOD, 6: None}  # hex types; ports: 0 = 3:1, else the same
# soc.game.SOCBoard4p: port edges clockwise from upper-left, and the hex each faces (facing = direction port -> land)
PORT_EDGES = [0x27, 0x5A, 0x9C, 0xCC, 0xC9, 0xA5, 0x72, 0x42, 0x24]


def _add(c, d):
    return (c[0] + d[0], c[1] + d[1], c[2] + d[2])


def hex_map(rotation):
    """JSettlers land hex coord -> catanatron cube coord, the centre pinned and the grid rotated by `rotation` sixths."""
    out = {CENTER: (0, 0, 0)}
    frontier = [CENTER]
    land = set(LAND_HEXES)
    while frontier:
        h = frontier.pop()
        for i, d in enumerate(JS_DIRS):
            n = h + d
            if n in land and n not in out:
                out[n] = _add(out[h], UNIT_VECTORS[CAT_DIRS[(i + rotation) % 6]])
                frontier.append(n)
    assert len(out) == 19 and set(out.values()) == {c for c, t in BASE_MAP_TEMPLATE.topology.items() if t is LandTile}, rotation
    return out


def node_map(rotation, tiles):
    """JSettlers node coord -> catanatron node id, given catanatron `tiles` (coordinate -> Tile)."""
    out = {}
    for h, cube in hex_map(rotation).items():
        tile = tiles[cube]
        for k, off in enumerate(JS_CORNERS):
            js_node = h + off
            cat_node = tile.nodes[CAT_CORNERS[(k + rotation) % 6]]
            assert out.setdefault(js_node, cat_node) == cat_node, "inconsistent corner geometry"
    assert len(out) == 54
    return out


def _base_port_pairs(tiles):
    from catanatron.models.map import PORT_DIRECTION_TO_NODEREFS

    pairs = {}
    for t in tiles.values():
        if isinstance(t, Port):
            a, b = PORT_DIRECTION_TO_NODEREFS[t.direction]
            pairs[frozenset((t.nodes[a], t.nodes[b]))] = t
    return pairs


def find_rotation(port_pairs, tiles=None):
    """A rotation under which every JSettlers port (node pair) sits on a BASE port. The BASE port ring has
    three-fold symmetry (its facings repeat every 120 degrees), so three rotations fit; the smallest is
    taken, and any is a valid isomorphism (a rotated board is the same board to every consumer here)."""
    tiles = tiles or initialize_tiles(BASE_MAP_TEMPLATE)
    base = _base_port_pairs(tiles)
    hits = []
    for r in range(6):
        nm = node_map(r, tiles)
        if all(frozenset(nm[n] for n in pair) in base for pair in port_pairs):
            hits.append(r)
    assert len(hits) == 3, f"port layout matches {len(hits)} rotations, expected 3"
    return hits[0]


def catan_map(hexes, ports, rotation=None):
    """A catanatron CatanMap on the BASE template from a JSettlers board.

    hexes: {js_hex_coord: (type, number)} for the 19 land hexes (number 0 on the desert);
    ports: [(type, js_node_a, js_node_b)] for the 9 ports.
    Returns (CatanMap, node_map js_node -> node id, hex_map js_hex -> cube coord)."""
    probe = initialize_tiles(BASE_MAP_TEMPLATE)  # geometry only; resources are reassigned below
    pairs = [(a, b) for _, a, b in ports]
    r = find_rotation(pairs, probe) if rotation is None else rotation
    hm, nm = hex_map(r), node_map(r, probe)
    base_ports = _base_port_pairs(probe)
    port_res = {}
    for ptype, a, b in ports:
        port_res[base_ports[frozenset((nm[a], nm[b]))].id] = JS_RESOURCE[ptype] if ptype else None
    cube_of = {cube: h for h, cube in hm.items()}
    tile_res, numbers, port_list = [], [], []
    for coord, kind in BASE_MAP_TEMPLATE.topology.items():
        if kind is LandTile:
            t, n = hexes[cube_of[coord]]
            tile_res.append(JS_RESOURCE[t])
            if JS_RESOURCE[t] is not None:
                numbers.append(n)
        elif isinstance(kind, tuple):
            port_list.append(port_res[probe[coord].id])
    # initialize_tiles pops from the end of each list while walking the topology in order
    tiles = initialize_tiles(BASE_MAP_TEMPLATE, numbers[::-1], port_list[::-1], tile_res[::-1], number_placement="random")
    m = CatanMap.from_tiles(tiles)
    return m, node_map(r, tiles), hm


def selfcheck():
    """Random BASE boards, described in JSettlers coordinates through the inverse maps, come back identical."""
    import random

    from catanatron.models.map import PORT_DIRECTION_TO_NODEREFS

    random.seed(3)
    for _ in range(3):
        for r in range(6):
            src = CatanMap.from_tiles(initialize_tiles(BASE_MAP_TEMPLATE))
            hm = hex_map(r)
            nm = node_map(r, src.tiles)
            inv_hex = {cube: h for h, cube in hm.items()}
            inv_node = {v: k for k, v in nm.items()}
            js_type = {v: k for k, v in JS_RESOURCE.items()}
            hexes = {inv_hex[c]: (js_type[t.resource], t.number or 0) for c, t in src.land_tiles.items()}
            ports = []
            for p in src.ports_by_id.values():
                a, b = PORT_DIRECTION_TO_NODEREFS[p.direction]
                ports.append((0 if p.resource is None else js_type[p.resource], inv_node[p.nodes[a]], inv_node[p.nodes[b]]))
            assert find_rotation([(a, b) for _, a, b in ports]) == r % 2
            m, nm2, hm2 = catan_map(hexes, ports, rotation=r)
            assert hm2 == hm and nm2 == nm
            for c, t in src.land_tiles.items():
                u = m.land_tiles[c]
                assert (u.resource, u.number, u.nodes) == (t.resource, t.number, t.nodes), c
            for pid, p in src.ports_by_id.items():
                assert m.ports_by_id[pid].resource == p.resource and m.ports_by_id[pid].nodes == p.nodes
    print("jsettlers_board: 18 round trips over all 6 rotations: ok")


if __name__ == "__main__":
    selfcheck()
