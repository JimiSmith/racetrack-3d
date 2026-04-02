# Text Placement Specification

_Version 5 — updated 2026-04-02_

This document describes the text placement pipeline used to emboss a circuit name onto the base plate of a 3D model. It is the authoritative spec for `src/text3d.js`.

---

## Overview

The label is placed by:

1. Generating a **placement mask** over the base plate.
2. Finding **candidate rectangles** in the clear space.
3. **Scoring and sorting** candidates by composite quality.
4. **Fitting text** into every candidate and scoring each (candidate × fit) pair.
5. Returning the best-scoring pair as rank 1, second-best as rank 2, and so on.

The pipeline runs fully at build/preview time in `src/text3d.js`.

---

## Stage 1 — Placement Mask

### Grid dimensions

The base plate is divided into a grid of cells with a minimum physical size of `MIN_CELL_MM` (currently **3 mm**).

- `longCells = max(MIN_GRID_CELLS_PER_SIDE, floor(longSide / MIN_CELL_MM))`
- `cellSize = longSide / longCells`
- `shortCells = max(MIN_GRID_CELLS_PER_SIDE, round(shortSide / cellSize))`

This gives:

- an integer cell count on the long side,
- a cell size that exactly divides the long side,
- matching physical cell size on the short side,
- and a safety floor of `MIN_GRID_CELLS_PER_SIDE` (currently **8**).

### Blocked cells

A cell is **blocked** if its bounding rectangle intersects the track outline polygon:

- any rectangle corner is inside the outer ring, or
- any rectangle edge intersects any outer-ring edge.

After the per-cell test:

- blocked cells are **dilated** outward by `obstacleMarginCells`,
- and a perimeter **edge margin** of `edgeMarginCells` is also blocked.

Current rules:

- `edgeMarginCells = 1`
- `obstacleMarginCells = 1` when the short side is at least **80 mm**, otherwise `0`

### Outside-circuit mask

A second boolean mask, `outside`, is built alongside the blocked mask.

A cell is counted as **outside** when its centre point is **not inside the outer ring**. This mask is measured **before dilation** and is used to compute `fractionOutside` per candidate.

---

## Stage 2 — Candidate Rectangles

Maximal-rectangle enumeration (histogram sweep) runs over the unblocked mask rows to find all axis-aligned clear rectangles.

Candidates are deduplicated:

- if a candidate overlaps an earlier candidate by more than **90%** of the smaller area, it is discarded.

The top `MAX_CANDIDATES` candidates are retained, initially sorted by area descending.

Current value: `MAX_CANDIDATES = 16`

Each candidate carries:

- `fractionOutside` — fraction of its cells that are outside the circuit outline (pre-dilation mask, 0–1)
- `trackClearance` — minimum distance (in cells) from any cell in the candidate to the nearest blocked cell (before dilation). Normalised to [0, 1] by dividing by the longest possible distance in the grid.
- `centreDistance` — distance from the candidate centre to the base plate centre, normalised to [0, 1] by dividing by the maximum possible distance (half-diagonal of base plate).

---

## Stage 3 — Text Fitting

Text fitting is attempted for **every candidate**, not only the selected rank.

For each candidate rectangle, the algorithm tries every combination of:

- **Line count**: 1 to `MAX_TEXT_LINES` (currently **4**, or word count if fewer)
- **Word grouping**: all sequential assignments of words to lines for that line count
- **Text rotation**:
  - `[0°]` when `TEXT_ORIENTATION_FIXED`
  - `[0°, 90°]` when `TEXT_ORIENTATION_AUTO`

Each layout is rendered, scaled to fit the candidate rectangle, and scored.

A layout is rejected before scoring if its fitted average line height is below `MIN_TEXT_HEIGHT_MM` (currently **2 mm**).

---

## Stage 4 — Scoring

Every valid (candidate × text fit) pair receives a **composite score**. The score is a product of five multipliers. Their weights must be chosen so that criteria higher in the priority list dominate all criteria below them — i.e. a placement that wins on criterion N should only be beaten by one that also wins on criterion N but scores higher on criterion N+1.

### Priority order (highest to lowest)

| Priority | Criterion | Multiplier name | Range |
|---|---|---|---|
| 1 | Outside vs inside the circuit | `outsideMultiplier` | [0.5, 1.0] |
| 2 | Fewer lines preferred | `lineCountMultiplier` | [0.91, 1.0] |
| 3 | Font size within preferred range | `sizeWindowMultiplier` | [0.0, 1.0] |
| 4 | Distance from track edge | `trackClearanceMultiplier` | [0.9, 1.0] |
| 5 | Proximity to base plate centre | `centralityMultiplier` | [0.88, 1.0] |

These are then combined with the existing fit-quality terms:

```text
score = averageLineHeight
      × utilization^0.2
      × aspectPenalty
      × lineBalance
      × outsideMultiplier
      × lineCountMultiplier
      × sizeWindowMultiplier
      × trackClearanceMultiplier
      × centralityMultiplier
```

### Weight separation requirement

The multiplier ranges must be chosen so that the relative influence of each criterion strictly exceeds the combined influence of all lower-priority criteria. Specifically:

- The `outsideMultiplier` range must be wide enough that a fully-outside placement (`1.0`) beats a fully-inside placement (`0.5`) even when the inside placement wins on all lower criteria.
- The `lineCountMultiplier` range must ensure single-line beats 4-line even when 4-line wins on size, clearance, and centrality.
- And so on down the list.

The current ranges above satisfy this requirement given the fit-quality terms remain bounded near 1. Implementation should verify this with representative test cases.

### Multiplier definitions

#### outsideMultiplier

```text
outsideMultiplier = 0.5 + 0.5 × clamp(fractionOutside, 0, 1)
```

- Fully outside (`fractionOutside = 1`): `1.0`
- Fully inside (`fractionOutside = 0`): `0.5`

#### lineCountMultiplier

- 1 line → `1.00`
- 2 lines → `0.97`
- 3 lines → `0.94`
- 4 lines → `0.91`

#### sizeWindowMultiplier

Preferred height range: **16–24 pt** (`MIN_PREFERRED_HEIGHT_MM ≈ 5.64 mm`, `MAX_PREFERRED_HEIGHT_MM ≈ 8.47 mm`).

- Below hard floor (`heightMm ≤ MIN_TEXT_HEIGHT_MM = 2 mm`): `0` (rejected)
- Below preferred (`2 mm < heightMm < 5.64 mm`): `t²` where `t = (h - 2) / (5.64 - 2)`
- In preferred range: `1.0`
- Above preferred: `1 / (1 + excessRatio × 0.25)`

#### trackClearanceMultiplier

```text
trackClearanceMultiplier = 0.9 + 0.1 × clamp(normalizedClearance, 0, 1)
```

- Maximum clearance: `1.0`
- Zero clearance (adjacent to blocked cells): `0.9`

#### centralityMultiplier

```text
centralityMultiplier = 1.0 - 0.12 × clamp(centreDistance, 0, 1)
```

- At centre: `1.0`
- At maximum distance from centre: `0.88`

---

## Stage 5 — Ranking

All (candidate × text fit) pairs are sorted by composite score descending.

- Rank 1 = highest-scoring pair overall
- Rank 2 = next, and so on

Duplicate positions are broken by the smallest candidate index (stable sort).

The user-facing `textPositionRank` control selects which ranked result to use.

> **Key difference from v4**: ranking is now across all candidates × all fits. The previous system ranked candidates by area alone and only scored fits within the user-selected candidate.

---

## Size Window

See `sizeWindowMultiplier` definition above.

---

## Candidate Ranking Change Summary

In v4, the pipeline was:

1. Sort candidates by area.
2. User selects candidate rank N.
3. Fit text into candidate N.
4. Score fits within that candidate.

In v5, the pipeline is:

1. Find all candidates.
2. Fit text into **every** candidate.
3. Score all (candidate × fit) pairs with the composite formula.
4. Sort pairs by score.
5. User selects rank N from the sorted pairs.

This ensures outside placements always beat inside ones regardless of area, because the `outsideMultiplier` dominates all other factors.

---

## Constants Reference

| Constant | Current value | Notes |
|---|---|---|
| `MIN_TEXT_HEIGHT_MM` | 2 mm | Hard minimum readable text height |
| `MIN_PREFERRED_HEIGHT_MM` | ~5.64 mm (16 pt) | Soft lower bound of preferred size window |
| `MAX_PREFERRED_HEIGHT_MM` | ~8.47 mm (24 pt) | Soft upper bound of preferred size window |
| `MAX_TEXT_LINES` | 4 | Maximum wrapped lines |
| `MAX_CANDIDATES` | 16 | Candidate rectangles kept after dedup |
| `MIN_CELL_MM` | 3 mm | Minimum physical grid cell size |
| `MIN_GRID_CELLS_PER_SIDE` | 8 | Safety floor for tiny tracks |
| `edgeMarginCells` | 1 cell | Edge clearance |
| `obstacleMarginCells` | 0 or 1 cell | Circuit clearance (`1` when short side ≥ 80 mm) |
| `outsideMultiplier` | `0.5 + 0.5 × fractionOutside` | Dominant outside-circuit preference |
| `lineCountMultipliers` | `[1.0, 0.97, 0.94, 0.91]` | Line count preference |
| `trackClearanceMultiplier` | `0.9 + 0.1 × normalizedClearance` | Distance-from-track preference |
| `centralityMultiplier` | `1.0 - 0.12 × centreDistance` | Base plate centre preference |

---

## Notes

- `fractionOutside` uses the **outer ring only** (no holes), measured from cell centres on the pre-dilation mask.
- `trackClearance` is measured on the **pre-dilation** blocked mask so that the margin itself doesn't compress all clearance values to zero.
- This document describes the **target implementation**. See git history for the v4 implementation it replaces.
