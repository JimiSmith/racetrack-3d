# Text Placement Specification

_Version 4 — updated 2026-04-02_

This document describes the current text placement pipeline used to emboss a circuit name onto the base plate of a 3D model. It reflects the current implementation in `src/text3d.js`.

---

## Overview

The label is placed by:

1. Generating a **placement mask** over the base plate.
2. Finding **candidate rectangles** in the clear space.
3. Fitting text into each candidate with different line counts and rotations.
4. Scoring those fits.
5. Returning the best-scoring fit from the selected candidate rank.

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

A cell is counted as **outside** when its centre point is **not inside the outer ring**. This mask is measured **before dilation** and is used only for scoring via `fractionOutside`.

---

## Stage 2 — Candidate Rectangles

Maximal-rectangle enumeration (histogram sweep) runs over the unblocked mask rows to find all axis-aligned clear rectangles.

Candidates are then deduplicated:

- if a candidate overlaps an earlier candidate by more than **90%** of the smaller area,
- it is discarded.

The top `MAX_CANDIDATES` candidates are retained, sorted by area descending.

Current value:

- `MAX_CANDIDATES = 16`

Each candidate also carries `fractionOutside`, computed from the pre-dilation `outside` mask as:

- area of outside cells inside the rectangle
- divided by rectangle area in cells.

Each retained candidate is assigned a **rank**:

- rank 1 = largest candidate,
- rank 2 = next,
- and so on.

The user-facing label placement control (`textPositionRank`) selects which ranked candidate is used.

---

## Stage 3 — Text Fitting

For the selected candidate rectangle, the algorithm tries every combination of:

- **Line count**: 1 to `MAX_TEXT_LINES` (currently **4**, or word count if fewer)
- **Word grouping**: all sequential assignments of words to lines for that line count
- **Text rotation**:
  - `[0°]` when `TEXT_ORIENTATION_FIXED`
  - `[0°, 90°]` when `TEXT_ORIENTATION_AUTO`

Each layout is rendered, scaled to fit the candidate rectangle, and scored.

A layout is rejected before scoring if its fitted average line height is below `MIN_TEXT_HEIGHT_MM`.

Current value:

- `MIN_TEXT_HEIGHT_MM = 2 mm`

---

## Current Scoring Formula

The current score is:

```text
score = averageLineHeight
      × utilization^0.2
      × aspectPenalty
      × (0.75 + lineBalance × 0.25)
      × sizeWindowMultiplier
      × lineCountMultiplier
      × centerBias
      × outsideMultiplier
```

Where:

| Factor | Description |
|---|---|
| `averageLineHeight` | Raw average glyph height before final scaling. Larger text scores higher. |
| `utilization^0.2` | Area of fitted text / area of rectangle, soft-clamped to 1. Rewards filling the space without dominating the score. |
| `aspectPenalty` | `1 / (1 + |log(rectAspect / layoutAspect)|)`. Penalizes mismatch between rectangle and fitted text aspect ratio. |
| `lineBalance` | `minLineWidth / maxLineWidth`. Rewards more even line lengths. |
| `sizeWindowMultiplier` | Preference for a target text-height band; see below. |
| `lineCountMultiplier` | Explicit per-line-count preference; see below. |
| `centerBias` | `1 - 0.12 × min(1, distanceFromCentre / maxDistance)`. Mild penalty for placements far from the base centre. |
| `outsideMultiplier` | `0.85 + 0.15 × fractionOutside`. Mild preference for candidates that lie more outside the circuit outline. |

---

## Size Window

The current implementation prefers fitted average line heights in a **16–24 pt** window.

Using typographic points (`1 pt = 25.4 / 72 mm`):

- `MIN_PREFERRED_HEIGHT_MM = 16 pt ≈ 5.64 mm`
- `MAX_PREFERRED_HEIGHT_MM = 24 pt ≈ 8.47 mm`

### Size multiplier behaviour

#### 1. Below hard minimum

If `heightMm <= MIN_TEXT_HEIGHT_MM`:

- multiplier = `0`
- the layout is effectively rejected.

#### 2. Between 2 mm and 16 pt

If `MIN_TEXT_HEIGHT_MM < heightMm < MIN_PREFERRED_HEIGHT_MM`:

```text
t = clamp((heightMm - MIN_TEXT_HEIGHT_MM) / (MIN_PREFERRED_HEIGHT_MM - MIN_TEXT_HEIGHT_MM), 0, 1)
sizeWindowMultiplier = t^2
```

This creates a progressively stronger penalty as text gets smaller.

#### 3. Inside the preferred window

If `MIN_PREFERRED_HEIGHT_MM <= heightMm <= MAX_PREFERRED_HEIGHT_MM`:

- multiplier = `1`

#### 4. Above 24 pt

If `heightMm > MAX_PREFERRED_HEIGHT_MM`:

```text
excessRatio = (heightMm - MAX_PREFERRED_HEIGHT_MM) / MAX_PREFERRED_HEIGHT_MM
sizeWindowMultiplier = 1 / (1 + excessRatio × 0.25)
```

This is a mild oversized-text penalty.

---

## Outside-Circuit Preference

Each candidate rectangle carries `fractionOutside`, measured from the pre-dilation `outside` mask.

Current formula:

```text
outsideMultiplier = 0.85 + 0.15 × clamp(fractionOutside, 0, 1)
```

That means:

- a fully interior candidate gets `0.85`
- a fully outside candidate gets `1.0`
- partial candidates scale linearly in between.

This is intentionally a mild tiebreaker rather than a hard rule.

---

## Single-Line / Line-Count Preference

The current implementation uses explicit multipliers:

- 1 line → `1.00`
- 2 lines → `0.88`
- 3 lines → `0.80`
- 4 lines → `0.72`

For line counts above 4, the last multiplier is reused.

This gives a clear preference for single-line labels when they fit well.

---

## Priority Order in Practice

The current implementation effectively prioritizes placement quality in this order:

1. **Hard minimum readability** — text below `2 mm` is rejected.
2. **Preferred size window** — strongest soft preference is for `16–24 pt` equivalent height.
3. **Line count** — fewer lines score better.
4. **Outside-circuit preference** — more outside area scores better.
5. **Fit quality** — utilization, aspect match, line balance, and centre bias refine the choice.

---

## Candidate Ranking

`textPositionRank` selects which ranked candidate rectangle is used.

Important detail:

- the ranking is by candidate area after deduplication,
- not by final text score,
- and equal-area candidates may swap order depending on grid resolution.

The scoring formula is applied **within** the selected candidate, not across all candidates.

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
| `centerBias weight` | 0.12 | Max off-centre penalty |
| `outsideMultiplier` | `0.85 + 0.15 × fractionOutside` | Mild outside-circuit preference |
| `lineCountMultipliers` | `[1.0, 0.88, 0.80, 0.72]` | Explicit line-count preferences |

---

## Notes

- The current implementation uses `fractionOutside` based on the **outer ring only**, measured from cell centres on the pre-dilation mask.
- The current grid is coarse enough to affect equal-area candidate ordering, but fine enough at `MIN_CELL_MM = 3` to avoid the overlap regression seen at `10 mm`.
- This document is intended to describe the current implementation, not future ideas.
