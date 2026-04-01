# Text Placement Specification

_Version 2 — updated 2026-04-01_

This document describes the full text placement pipeline used to emboss a circuit name onto the base plate of a 3D model, including existing behaviour and the criteria for future improvements.

---

## Overview

The label is placed by:

1. Generating a **placement mask** over the base plate (grid of cells blocked by the circuit outline).
2. Finding **candidate rectangles** — the largest clear rectangles in the unblocked grid cells.
3. For each candidate, **fitting text** (line-wrapping, optional 90° rotation) into the rectangle and scoring it.
4. Returning the **highest-scoring placement** from the top-ranked candidate.

The pipeline runs fully at build/preview time in `src/text3d.js`.

---

## Stage 1 — Placement Mask

### Grid dimensions

The base plate is divided into a grid of cells. The grid resolution tracks the aspect ratio of the base plate:

- Long side → `LONG_SIDE_GRID_CELLS` cells (currently 96).
- Short side → scaled proportionally, clamped between `⌈MIN_GRID_CELLS / aspectRatio⌉` and `LONG_SIDE_GRID_CELLS` (min 24 cells on the short side).

### Blocked cells

A cell is **blocked** if its centre point falls inside the track footprint (inside the outer ring of the buffered outline, and not inside any hole).

After the per-cell test, blocked cells are **dilated** outward by `obstacleMarginCells` (1 cell when the short side ≥ 80 mm, 0 otherwise), giving a small clearance gap around the circuit.

An **edge margin** of `edgeMarginCells` (1 cell) is also marked blocked around the full perimeter to prevent text touching the model edge.

---

## Stage 2 — Candidate Rectangles

Maximal-rectangle enumeration (histogram sweep) runs over the unblocked mask rows to find all axis-aligned clear rectangles.

Candidates are then **deduplicated**: any rectangle that overlaps an earlier one by more than 90% of its area (by smaller area) is discarded. The top `MAX_CANDIDATES` (currently 12) are retained, sorted by area descending.

Each candidate is assigned a **rank** (1 = largest, 12 = smallest). The user-exposed "Label placement" control (`textPositionRank`) selects which rank to use; rank 1 is the default.

---

## Stage 3 — Text Fitting

For the selected candidate rectangle, the algorithm tries every combination of:

- **Line count**: 1 to `MAX_TEXT_LINES` (currently 4, or word count if fewer).
- **Word grouping**: all sequential assignments of words to lines for the given line count.
- **Text rotation**: [0°] when `TEXT_ORIENTATION_FIXED`; [0°, 90°] when `TEXT_ORIENTATION_AUTO`.

For each combination the text is rendered, scaled to fill the rectangle, and scored by `scoreTextFit`.

### Current `scoreTextFit` formula

```
score = averageLineHeight
      × utilization^0.2
      × aspectPenalty
      × (0.75 + lineBalance × 0.25)
      × lineCountPenalty
      × centerBias
```

Where:

| Factor | Description |
|---|---|
| `averageLineHeight` | Raw height of an average glyph in scaled mm. Larger text scores higher. |
| `utilization^0.2` | Area of fitted text / area of rectangle, soft-clamped. Rewards filling the space. |
| `aspectPenalty` | `1 / (1 + |log(rectAspect / layoutAspect)|)`. Penalises mismatch between rectangle and text aspect ratio. |
| `lineBalance` | `minLineWidth / maxLineWidth`. Rewards even line lengths. |
| `lineCountPenalty` | `max(0.72, 1 − (lineCount − 1) × 0.08)`. Discourages many lines. |
| `centerBias` | `1 − 0.12 × clamp(dist(rectCentre, baseCentre) / maxDist, 0, 1)`. Small penalty for placements far from centre. |

### Hard filter

A candidate layout is **rejected** before scoring if the fitted scale produces a text height below `MIN_TEXT_HEIGHT_MM` (currently 2 mm).

---

## Proposed Scoring Improvements

The three new criteria are **scoring bonuses** — they influence the choice but cannot override a clearly better placement.

### 3.1 — Text size window (14 pt – 28 pt)

_Target: text is large enough to read on a print, but not so large it overwhelms the model._

- Convert the current hard floor `MIN_TEXT_HEIGHT_MM = 2` to a **preference signal**:
  - Below **14 pt equivalent**: apply a **size penalty** (progressively stronger as size falls below target).
  - In range **14 – 28 pt**: no penalty; small bonus for being in the sweet spot.
  - Above **28 pt equivalent**: apply a mild **over-size penalty** (large text at the cost of many lines is not ideal).
- Note: "pt" here means _typographic points at 96 dpi converted to mm_ for comparison to the fitted `averageLineHeight`.
  - 14 pt ≈ 4.94 mm; 28 pt ≈ 9.88 mm.
- The hard floor of 2 mm is retained as an absolute reject threshold.

### 3.2 — Outside-circuit preference

_Target: text placed in clear space outside the circuit boundary scores higher than text inside a hole or tight interior gap._

- The placement mask already blocks cells inside the circuit footprint, so **candidates that are entirely clear are already preferred over partially blocked ones**.
- Add a **fraction-outside score**: for each candidate rectangle, compute the proportion of its area that lies _outside_ the circuit outline (i.e. in unblocked, non-dilated cells). A fully outside rectangle receives the full bonus; a partially inside one receives a proportional bonus.
  - Suggested weight: multiply `scoreTextFit` result by `(0.85 + 0.15 × fractionOutside)`.
  - This is a mild multiplier (≤ 15% uplift) so it does not override significantly better fits inside.

### 3.3 — Single-line preference

_Target: a single clean label on one line is preferred over multi-line wrapping when feasible._

- Strengthen the existing `lineCountPenalty`:
  - Current formula: `max(0.72, 1 − (lineCount − 1) × 0.08)`.
  - Proposed: scale the bonus for single-line more explicitly — single-line layouts receive a `×1.0` multiplier; two-line `×0.88`; three-line `×0.80`; four-line `×0.72`.
  - The exact shape is intentionally similar to the current curve, but with a larger step from 1→2 lines to push harder for single-line.
- This naturally combines with the size window: if a single-line layout at 14 pt fits, it beats a two-line layout at 16 pt.

---

## Priority Order

When multiple criteria conflict, the following order applies (highest priority first):

1. **Hard reject**: text height < 2 mm (absolute minimum — no compromise).
2. **Size window** (3.1): strong preference for 14–28 pt range.
3. **Single-line** (3.3): prefer fewer lines.
4. **Outside-circuit** (3.2): mild tiebreaker toward clear exterior space.
5. **Existing factors** (utilization, aspect, balance, centerBias): fine-grained quality.

---

## Candidate Ranking (user-visible)

The user selects a placement rank (1–3 visible in the UI, up to 12 internally). Rank 1 is always the largest-area candidate rectangle. The scoring criteria above apply within a given candidate — they do not reorder candidates.

---

## Constants Reference

| Constant | Current value | Notes |
|---|---|---|
| `MIN_TEXT_HEIGHT_MM` | 2 mm | Hard reject below this |
| `MAX_TEXT_LINES` | 4 | Maximum wrapped lines |
| `MAX_CANDIDATES` | 12 | Candidate rectangles kept after dedup |
| ~~`LONG_SIDE_GRID_CELLS`~~ | ~~96~~ | **Superseded** — replaced by cell-size-based approach (see below) |
| `MIN_CELL_MM` | 10 mm | Minimum physical cell size. Long-side cell count = `floor(longSide / MIN_CELL_MM)`, rounded to nearest integer so that count cells divide the long side exactly. Short side uses the same cell size. |
| `MIN_GRID_CELLS_PER_SIDE` | 8 | Safety floor — ensures tiny tracks still get a usable grid even when `floor(longSide / MIN_CELL_MM)` would be very small. |
| `edgeMarginCells` | 1 cell | Edge clearance |
| `obstacleMarginCells` | 0 or 1 cell | Circuit clearance (0 when short side < 80 mm) |
| `centerBias weight` | 0.12 | Max penalty for off-centre placement |
| _proposed_ `MIN_PREFERRED_HEIGHT_MM` | ~4.94 mm (14 pt) | Soft lower bound on text height |
| _proposed_ `MAX_PREFERRED_HEIGHT_MM` | ~9.88 mm (28 pt) | Soft upper bound on text height |
| _proposed_ `outsideBonus max` | 0.15 multiplier | Max uplift for fully-outside placement |
| _proposed_ `lineCountMultipliers` | [1.0, 0.88, 0.80, 0.72] | Per-line-count multipliers |

---

## Open Questions

- Should the size window be expressed in mm (physical print size) or pts (font rendering units)? Currently proposing mm for implementation simplicity.
- Should "outside-circuit" preference also consider distance from the circuit edge (further out = higher bonus), or just a binary inside/outside split?
- Should `textPositionRank` re-score candidates under the new criteria, or continue to be a pure area-rank selector?
