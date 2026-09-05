# Design canvas

The implementation spec for the client redesign, published as a Claude Design canvas:
https://claude.ai/code/artifact/dd5dfb20-2e25-44a1-8924-65cda26a1da1

Page one, **Getting around**, is how you move between the views and what happens while you
do. Page two, **Views**, is the six screens themselves. Everything after that is earlier
rounds, kept for the reasoning in its sticky notes rather than as live proposals.

## Build

    node web/design/replicate.mjs   # the six views, from the earlier rounds
    node web/design/routes.mjs      # the flow page — needs the views to exist first
    node web/design/flow.mjs        # the journey artboards (imports views.mjs)

Order matters for the first two: `routes.mjs` builds its frames out of the `View*.dc.html`
files, so a change to the views has to be replicated before the frames are rebuilt.

## Files

- `board.mjs` — the shared core, and the single place the board is defined: palette,
  lattice, the turn-31 position, pieces, number tokens, resource glyphs, ports.
- `glyphs.mjs` — generated. The resource watermarks, lifted verbatim from the earlier
  rounds and keyed by the tile centre they were authored against.
- `flow.mjs` — the journey artboards: the clickable walkthrough, the flow map, lineup,
  dealing, handoff, ending, and the board spec sheet.
- `views.mjs` — the ladder and the views: tier-1 panels, futures, move analysis,
  game analysis.
- `replicate.mjs` — the six views, generated from the earlier-round files. It changes four
  things and nothing else: the board, the removed nav, the removed display headline and its
  sentence, and the spine. Where a removed sentence was an instruction rather than a
  situation it is moved onto the control it describes (`INSTRUCTIONS`), not deleted.
- `routes.mjs` — the Getting around page: three routing models, the door inventory, the
  travel table, the input map, and nine full-size transition frames. A frame is a real view
  file with its spine rewritten, a few override rules appended and an overlay dropped on
  top — never a redrawing.
- `measured.json` — the six boards' rects, read out of the browser. Regenerate by serving
  `canvas/` and reading `getBoundingClientRect()` on each `svg[viewBox="-236.72 …"]`,
  normalised so the `.L` root is 1440 wide. Re-measure after anything that moves a board.
- `artboards.mjs` — frozen. Generates the shelved surface/deep set only.

## Decisions the flow encodes

- One line of chrome, the spine: the path on the left, the turn beside it, and whatever is
  waiting on the right. Esc pops one crumb. There is no tab bar and no command palette.
- Three verbs, never two at once. A view moves the board; time moves the pieces; a
  hypothetical divides the board into six and brings one back.
- The board is one element that never unmounts, so a view change is a transform between two
  measured rects rather than a page.
- A new game is offered at the ending only. Review of a live game runs on a second worker
  driven by `Engine.replay(record, steps)`, so the live engine is never freed.

## Decisions the board encodes

- No stroke, outline or halo on any piece; the plinth is the only shadow. No outline
  around the island either.
- The fourth seat is a warm grey (`#b9bfb2`), not white, everywhere.
- Number tokens are `r 16.5` with 14px digits and pips at `cy 10.2`. The old `r 13.2`
  left five-pip rows 1.16 units of clearance to the sloping edge; this gives 3.36.
- Tokens animate the `scale` individual property, never `transform`, so each pops about
  its own tile rather than the board's origin.
- Ports come from `topology.json` centres times 44. Their two dock corners are derived
  rather than stored: for every port the two nearest island vertices are exactly 44 away
  and exactly 44 apart. Port resources are shuffled per seed.
- The port badge is filled like a tile: `r 16`, no stroke, the tile colour lightened 20%
  toward chalk so pine ink clears 4.5:1 on wood and brick too, carrying one motif of the
  resource's own glyph. Generic ports are `--dust` with no glyph. No filled shape on the
  board carries a stroke now: the only strokes left are the lattice cells, the roads and the
  port docks, and each of those is a line in its own right rather than an outline drawn
  around something else.
- The lattice tapers with distance from the island, squared, rather than ending at an edge.

## Watch out

Renaming an artboard means renaming it in `canvas/` **and** in `canvas.json` before the
generator next runs. Generating a file whose name is already taken has silently
overwritten an artboard twice. The names in use by the generators are `View*` (six),
`Fr[ABC]*` (nine), `Doors`, `Routes`, `Travel`, `Keys`, and everything `flow.mjs` and
`views.mjs` write.
