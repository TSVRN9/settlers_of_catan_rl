
## replicate.mjs

The current page one is the original views with one thing changed: the board. Run

    node web/design/replicate.mjs

It reads the earlier-round files and writes `View*.dc.html`, swapping every board SVG
(identified by the shared `viewBox="-236.72 -244.2 511.56 488.4"`) for the current
`board()`, and removing the left nav. Everything else is copied byte for byte.

Two things it deliberately preserves and one it drops:

- **kept** — annotation overlays inside the board: the ring on a recommended corner, the
  rings marking what changed in a candidate future, the outlined tiles a seat draws from.
  The panel copy refers to these, so losing them is a real regression. Detected as
  `fill="none"` circles, and `fill="none"` polygons with fewer than 20 commas.
- **dropped** — the island outline, which is the 30-point `fill="none"` polygon, hence
  the comma test above.

Small boards (under 300px wide) render without grid, ports or glyphs, which are noise at
that size.

If you change the board, re-run this and the views follow. Do not hand-edit `View*.dc.html`.
