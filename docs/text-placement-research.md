# Text Placement Research for racetrack-3d

> **App context:** Fully client-side, browser-only, must remain fast on phones/iPhone Safari.  
> **Use case:** Place embossed circuit-name text on the base plate in the largest visually appropriate empty rectangular area, avoiding the track outline and other no-go zones.  
> **Current state:** `src/text/placement.ts` chooses either the bounding box of the largest infield hole or a small fallback strip near the base edge, then scales a single-line string to fit.

---

## Executive summary

### Recommended direction

#### 🥇 V1: Grid-based occupancy + largest empty axis-aligned rectangle

For this app, the best first implementation is **not** an exact computational-geometry solver. It is a **deterministic occupancy-grid approach**:

1. Rasterize the base plate into a modest 2D grid.
2. Mark cells blocked by:
   - the track polygon/ridge footprint
   - hole/no-go polygons
   - an optional safety margin around those obstacles
3. Run a **largest all-empty axis-aligned rectangle** algorithm on the grid.
4. Evaluate the top few candidate rectangles with a text-fitting routine that tries:
   - multiple line counts
   - uniform scaling
   - centered alignment
5. Pick the candidate with the best score.

This is the best v1 because it is:

- easy to reason about
- robust across conventional circuits and street circuits
- fast enough in JS for phone browsers
- deterministic
- simple to test
- naturally extensible later

#### 🥈 V2: Candidate refinement + optional rotation sweep

If v1 produces awkward results for diagonal or irregular free spaces, the next step should be:

- keep the same occupancy foundation
- add **local refinement** around the best rectangle
- optionally test a **small fixed angle set** (for example `-20°, -10°, 0°, 10°, 20°`) by rotating the occupancy test frame or rotating the candidate rectangle only

This gives most of the visual upside of rotated placement without jumping straight to hard-to-maintain exact geometry.

#### Avoid for now

- full exact largest-empty-rectangle solvers over arbitrary polygonal obstacles
- general rectangle packing libraries
- continuous arbitrary-angle optimization

Those are academically nice, but overkill for a browser-first STL/3MF hobby app where maintainability and predictable output matter more than squeezing out the mathematically perfect rectangle.

---

## Problem framing

### Current geometry model

From the current code:

- `src/geometry.js`
  - projects OSM lat/lon to local XY metres
  - builds `outlinePoints` as `{ outerRing, holes }`
  - builds `basePlate` as an axis-aligned rectangle `{ minX, maxX, minY, maxY, width, height }`
- `src/model.js`
  - scales the whole model to fit a 200 mm bounding target
  - builds the base plate mesh
  - builds the track mesh
  - calls `buildTextMesh(trackName, outlinePoints, basePlate, scale, ...)`
- `src/text/placement.ts`
  - currently picks a text placement area from either:
    - the **bounding box of the largest hole** (`getPrimaryPlacement`), or
    - a **fallback strip near the lower-left edge** (`getFallbackPlacement`)
  - creates a single-line font path
  - scales it uniformly to fit the chosen rectangle
  - triangulates the text mesh

### Actual placement problem

The real problem is not “put text in the biggest hole.” It is:

> Given a base plate rectangle and a set of blocked 2D regions, find the best rectangular text box in the remaining free area, then fit multiline text inside it.

### Inputs

A future text-placement stage should think in these terms:

- **Container**: the base plate rectangle
- **Blocked regions**:
  - the raised track footprint (`outlinePoints.outerRing` minus holes)
  - optional margin around the track so text does not look cramped
  - any additional no-go zones later
- **Free space**: base plate minus blocked regions
- **Goal**: find a rectangle in free space that maximizes practical text readability, not just raw area

### Important nuance: “best text rectangle” is not always “largest area rectangle”

The mathematically largest rectangle is often a good proxy, but text readability depends on more than area:

- a very long thin strip may have large area but fit text badly
- a slightly smaller, squarer rectangle may support larger letters over multiple lines
- centered placement within a visually calm region may look better than an edge-hugging maximum

So the architecture should be:

1. generate candidate rectangles from geometry
2. evaluate them with a **text-fit score**
3. choose the best scored rectangle

---

## Candidate algorithms

## 1. Exact axis-aligned largest empty rectangle (computational geometry)

### Idea

Treat obstacles as polygonal regions inside the base rectangle. Compute the largest axis-aligned rectangle that lies fully in free space.

### Pros

- mathematically clean
- exact for the chosen formulation
- deterministic

### Cons

- implementation complexity rises quickly with arbitrary polygons and holes
- robust polygon clipping / event handling in browser JS is annoying
- hard to maintain compared with a raster/grid approach
- exact optimum may not look best for text anyway

### Suitability here

**Low for v1.** The app already works with polygon rings, but building a reliable exact largest-empty-rectangle solver around arbitrary polygonal obstacles is more engineering than this feature needs.

---

## 2. Maximal empty rectangles from obstacle coordinates

### Idea

Generate a family of candidate empty rectangles whose sides align to obstacle vertices and plate boundaries, then test which are empty and score best.

This is a common middle ground between exact continuous geometry and brute force.

### Pros

- more geometric than rasterization
- can produce strong candidates without scanning every possible rectangle
- deterministic

### Cons

- still non-trivial with polygon edges, not just points
- needs careful emptiness testing against polygons
- candidate count can blow up unless pruned

### Suitability here

**Medium, but better as a refinement strategy than a first implementation.** Useful if later you want a more exact axis-aligned result while staying simpler than a full exact solver.

---

## 3. Occupancy grid + largest empty rectangle in a binary matrix

### Idea

Rasterize free/blocked space onto a 2D grid. Then solve:

> Find the largest axis-aligned rectangle containing only free cells.

This can be done efficiently with the standard **largest rectangle in a histogram** technique applied row-by-row.

### How it works

1. Choose a grid resolution, for example 64×64, 96×96, or adaptive by plate aspect ratio.
2. For each cell center or small sample set, decide whether the cell is blocked.
3. Build a binary matrix:
   - `1 = free`
   - `0 = blocked`
4. For each row, accumulate vertical free heights.
5. Run largest-rectangle-in-histogram on that row.
6. Keep the best rectangle over all rows.

### Pros

- simple and robust
- very fast in JS
- easy to unit test
- easy to add margins by dilating blocked cells
- works for arbitrary track shapes and future no-go zones
- deterministic

### Cons

- approximate, depends on grid resolution
- axis-aligned only unless extended
- can miss narrow free slivers smaller than a cell

### Suitability here

**Excellent for v1.** This is the best balance for racetrack-3d.

---

## 4. Occupancy grid + maximal empty rectangle enumeration

### Idea

Instead of only the single largest-area rectangle in the binary matrix, enumerate several strong rectangles and score them by text fit.

### Why this matters

For text, area alone is not enough. A few top candidates can be compared by:

- final fitted font size
- line count
- aspect ratio match to the text block
- distance from obstacles
- visual centering

### Pros

- still simple enough
- much better visual outcomes than “take biggest area blindly”
- easy to combine with multiline fitting

### Cons

- a little more code than the single-best rectangle algorithm
- need candidate deduping / pruning

### Suitability here

**Very good for v1 or v1.1.** If implemented, this is likely the sweet spot.

---

## 5. Distance-field / clearance-map approach

### Idea

Build a scalar field over the plate where each cell stores distance to the nearest obstacle or boundary. Then find rectangles centered in regions with high clearance, or use the field to score candidate rectangles.

### Pros

- better visual quality; favors calm open space
- useful to penalize placements that technically fit but feel cramped
- easy to add on top of occupancy-grid logic

### Cons

- by itself, does not directly solve rectangle fitting
- best used as a scoring term, not the only algorithm

### Suitability here

**High as a secondary scoring signal.** Great addition after basic occupancy works.

---

## 6. Rotated rectangle search

### Idea

Allow the text rectangle to rotate. This can capture large diagonal spaces, especially for oblong or skewed circuits.

### Practical variants

#### A. Fixed-angle sweep

Try a small set of angles. For each angle:

- rotate blocked geometry into the test frame, or rotate the candidate frame logically
- run the same axis-aligned occupancy algorithm
- rotate the winning rectangle back

#### B. Local angle refinement

After finding the best axis-aligned rectangle, try a few nearby angles and see if readability improves.

#### C. Full continuous optimization

Search over arbitrary angle and rectangle parameters.

### Pros

- can greatly improve certain layouts
- handles diagonal empty spaces better

### Cons

- more expensive
- more implementation complexity
- rotated embossed text may look less intentional on rectangular bases
- diagonal labels may clash with the app’s clean, product-like visual style

### Suitability here

**Maybe for v2, but not default v1.** For many printed base plates, horizontal text aligned to the plate looks better and more premium than arbitrary rotation.

---

## 7. Rectangle packing formulations

### Idea

Model the track and no-go zones as placed rectangles or polygon approximations, then use rectangle-packing style algorithms to insert a label rectangle.

### Suitability here

**Low.** This problem is not really “pack many rectangles”; it is “find one best empty rectangle.” Packing language can inspire heuristics, but a dedicated empty-space search is cleaner.

---

## 8. Polygon decomposition into convex pieces / trapezoids

### Idea

Subtract blocked geometry from the base plate to form free-space polygons, decompose them, then fit rectangles in each region.

### Pros

- more exact geometric structure
- nice if you later want arbitrary placements for logos or badges too

### Cons

- polygon boolean operations are the hard part
- more fragile in browser-only geometry pipelines

### Suitability here

**Interesting later, not justified now.** The grid method is lower risk.

---

## Text fitting strategies inside the chosen rectangle

## 1. Multiline line breaking by candidate line count

### Recommended strategy

Do not rely on generic paragraph line breaking. For circuit names, the best practical approach is:

1. tokenize text by spaces, preserving meaningful pieces
2. try line counts from `1` to `min(4, wordCount)`
3. for each line count, generate balanced groupings of words
4. compute unscaled text block width/height
5. apply a uniform scale to fit the candidate rectangle
6. choose the layout with the best score

For names like:

- `Silverstone Circuit`
- `Circuit de Spa-Francorchamps`
- `Autodromo Internazionale Enzo e Dino Ferrari`
- `Las Vegas Strip Circuit`

this works much better than a single-line fit.

### Practical grouping heuristic

Use balanced greedy wrapping:

- estimate target line width = total text advance / desired line count
- accumulate words until adding another would exceed the target too much
- compare nearby break variants

For short names, brute force over all legal break positions is also fine because word counts are tiny.

---

## 2. Uniform scaling to maximize readable size

Given a multiline layout with measured text block bounds:

- `scale = min(rect.width / textWidth, rect.height / textHeight)`

This should remain the core sizing rule.

### Important detail

Score by **final cap height / x-height proxy**, not raw rectangle fill. The goal is readable embossed letters, not perfect area utilization.

---

## 3. Aspect-ratio-aware scoring

The candidate rectangle and the text block should have compatible aspect ratios.

### Good score components

- fitted letter height
- rectangle utilization
- aspect-ratio mismatch penalty
- penalty for too many lines
- optional bonus for centered/calm placement

Example conceptual score:

```text
score = fittedLetterHeight
      * utilization^0.35
      * clearanceBonus
      * aspectMatchPenalty
      * lineCountPenalty
```

You do not need a fancy formula; just avoid letting area dominate everything.

---

## 4. Choosing line count automatically

### Suggested limits

- try `1..4` lines
- maybe cap at `3` lines for most tracks unless the name is unusually long

### Preference order

Prefer the option with the largest fitted letter height, subject to:

- minimum letter height threshold
- no line being absurdly short unless it materially improves fit
- avoid or penalize widows like a single tiny last word on its own line

For example:

- `Las Vegas` + `Strip Circuit` is good
- `Circuit de` + `Spa-` + `Francorchamps` may be worse than `Circuit de` + `Spa-Francorchamps`

A small heuristic penalty for highly uneven line widths helps a lot.

---

## 5. Centering and alignment

### Default recommendation

- horizontally center text within the chosen rectangle
- vertically center the multiline block
- center each line

This matches the current app style and is usually the most product-like outcome.

### Optional future controls

- left-align within rectangle for very long names
- plate-relative horizontal alignment presets
- tighter letter spacing or tracking for edge cases

But centered multiline should be the default.

---

## Recommended approach for racetrack-3d

## Why the current implementation is too limited

Current `src/text/placement.ts` behavior is intentionally simple:

- pick the largest hole by polygon area
- use its axis-aligned bounding box if large enough
- otherwise use a small base-edge strip
- fit a single line inside it

This fails or looks weak when:

- the largest true empty region is not an infield hole
- the hole exists but its bounding box overlaps awkwardly with track geometry visually
- the best free space is outside the track rather than inside it
- the track is a street circuit with little or no proper infield
- a long circuit name would look much better over 2–3 lines

## Best v1 algorithm

### Recommendation

Use:

> **Adaptive occupancy grid + top-N axis-aligned empty rectangles + multiline text-fit scoring**

### Why this is the right choice

It matches the app’s constraints:

- **browser-only**: pure JS, no heavy geometry dependency required
- **phone/Safari performance**: a 64×64 or 96×96 grid is tiny
- **robustness**: handles holes, weird street circuits, and arbitrary future no-go zones
- **maintainability**: understandable code, easy tests
- **determinism**: same input gives same output
- **visual quality**: scoring can prefer readable, balanced placements over raw area

## Suggested geometric interpretation

Treat the blocked region as:

- the track footprint polygon represented by `outlinePoints.outerRing` with `holes`
- plus a configurable clearance margin

Conceptually:

```text
freeSpace = basePlateRect - dilatedTrackFootprint - extraNoGoZones
```

Then search for rectangles fully inside `freeSpace`.

### Important note about the current track polygon

`buildTrackOutline()` returns a buffered polygon of the track centerline, which may contain holes for closed-loop infields. For text placement, that is already useful, because the geometry needed is simply:

- blocked = track material footprint
- free = everything else on the base plate

You do not need to change the track mesh pipeline to do this.

## Suggested scoring philosophy

Do not rank rectangles by area alone. Rank by the largest readable text layout they support.

### Practical ranking terms

1. **fitted text height** — primary
2. **clearance from track** — secondary
3. **aspect match** between text block and rectangle
4. **line balance** — avoid ugly wraps
5. **placement preference** — mild bias toward visually centered / intentional placements

---

## Suggested staged implementation plan

## Stage 0: Reframe text placement as its own pre-glyph step

Before generating any font contours:

1. compute placement candidates in plate/world XY
2. choose one rectangle
3. fit text lines inside that rectangle
4. only then call font path generation and triangulation

That means text placement becomes a true layout stage, not an incidental step inside glyph extrusion.

### Recommended internal data flow

```text
outlinePoints + basePlate + trackName
  -> build blocked-space representation
  -> find candidate text rectangles
  -> pick best rectangle via text scoring
  -> build multiline text layout
  -> generate glyph paths
  -> triangulate text mesh
```

This is the cleanest long-term architecture.

---

## Stage 1: V1 implementation

### 1. Build a placement mask

Add a helper conceptually like:

```js
computePlacementMask(outlinePoints, basePlate, options)
```

It should:

- choose grid size based on base aspect ratio and target fidelity
  - e.g. long side ~96 cells, short side scaled proportionally
- mark blocked cells if the cell center lies inside track footprint
- optionally expand blocked cells by 1–2 cells for visual breathing room
- optionally reserve a small plate-edge margin too

### 2. Find top candidate rectangles

Run the standard largest-empty-rectangle-in-binary-matrix pass.

Prefer returning not just one rectangle, but the **top N** distinct candidates, for example `N = 10`.

Each candidate should include:

- grid bounds
- world-space bounds in plate XY
- area
- approximate clearance metrics

### 3. Fit multiline text in each candidate

For each candidate rectangle:

- split track name into words
- try line counts `1..4`
- generate balanced wraps
- measure text block using font metrics/path bounds
- compute scale to fit
- reject if final text height is below threshold

### 4. Score and choose

Pick the candidate+layout pair with best score.

### 5. Extrude as today

Once chosen:

- generate final text paths
- flip Y as already needed
- translate and scale contours into the chosen rectangle
- triangulate and extrude

This keeps most of the existing `buildTextMesh()` extrusion logic intact.

---

## Stage 2: Better heuristics after v1 works

### A. Add clearance-map scoring

Compute a distance-to-obstacle value per free cell and reward candidates whose interior sits in high-clearance space.

This helps avoid labels that technically fit but look jammed against the track.

### B. Add candidate refinement

Once the best grid rectangle is found, locally nudge its edges outward/inward in world coordinates while checking emptiness against polygons.

This recovers some precision lost to rasterization without replacing the whole method.

### C. Improve line wrapping

Add small penalties for:

- very uneven line lengths
- widows/orphans
- too many lines

This gives noticeably nicer outcomes on long European circuit names.

---

## Stage 3: Optional rotated placement (v2)

Only do this if real examples show v1 missing obvious good spaces.

### Recommended approach

Try a small angle set, not continuous search:

- `0°` always
- optionally `±10°`, `±20°`

For each angle:

1. transform the occupancy test frame
2. run the same rectangle finder
3. fit text
4. score with a mild penalty for non-zero rotation

### Why only small angles

- cheaper
- deterministic
- enough to capture obvious diagonal voids
- avoids wild label orientations that make prints look messy

---

## Stage 4: Optional exact/polygon refinement if ever needed

If the project later grows into a more advanced CAD-like layout tool, you could replace the coarse candidate generation with polygon-aware maximal-empty-rectangle logic.

But that should be driven by concrete failures, not by theory-first ambition.

---

## Suggested implementation details against current files

## `src/text/placement.ts`

This is the natural home for the placement stage, but it should be split conceptually:

### Current responsibilities mixed together

- font loading/parsing
- contour conversion
- placement rectangle selection
- scaling/translation
- triangulation/extrusion

### Better structure

Consider these logical helpers:

- `findTextPlacementCandidates(outlinePoints, basePlate, scale, options)`
- `fitTextLayout(text, font, rect, options)`
- `chooseBestTextPlacement(text, font, candidates, options)`
- `buildTextMeshFromLayout(layout, options)`

Even if implemented in one file initially, this separation will make the feature much easier to evolve.

## `src/model.js`

No architectural change needed beyond perhaps passing placement options later.

The important thing is that `buildTrackModel()` should continue to treat text as:

> a placement/layout stage in 2D first, then a triangulated embossed mesh stage

## `src/geometry.js`

No required change for v1.

The existing:

- `outlinePoints`
- `basePlate`

are already sufficient inputs for a grid-based placement solver.

---

## Risks / edge cases

## 1. Street circuits with almost no clean infield

Examples like Monaco, Baku, Jeddah, Las Vegas can have little or no central empty block.

### Risk

The mathematically largest empty rectangle may be:

- a shallow strip near an edge
- split awkwardly by the track silhouette
- technically valid but too small for readable embossing

### Mitigation

- allow placements anywhere on the plate, not just in holes
- use multiline fitting
- enforce a minimum readable text height
- if no candidate passes the threshold, skip text gracefully

---

## 2. Bounding-box optimism

A hole’s axis-aligned bounding box can extend into visually bad space even if the hole itself is irregular.

### Mitigation

Use true occupancy/block testing for the rectangle interior, not just hole bounding boxes.

---

## 3. Very long names

Examples:

- `Autodromo Internazionale Enzo e Dino Ferrari`
- `Bahrain International Circuit Grand Prix Layout`

### Risk

Even the best rectangle may not support readable single-line text.

### Mitigation

- multiline fitting is mandatory
- cap lines at 3–4
- abbreviations could be a future optional feature, but not necessary for v1

---

## 4. Safari / mobile performance

### Risk

Too-fine grids or repeated polygon checks could get slow on phones.

### Mitigation

- keep grid modest
- cache world-to-grid conversions
- use cell-center tests first
- only do more expensive scoring on top-N rectangles

A 96×96 grid is only 9,216 cells, which is trivial by modern phone standards.

---

## 5. Non-deterministic visual output

If ties are broken implicitly by iteration order or floating-point noise, two similar runs may choose different rectangles.

### Mitigation

Use explicit tie-breaks, for example:

1. higher text-height score
2. larger area
3. more centered in plate
4. lower `minY`, then lower `minX` or another stable rule

---

## 6. Overly thin rectangles winning by area

### Risk

Large strips can beat more useful blocks if you optimize area only.

### Mitigation

Score by fitted text height and aspect compatibility, not just area.

---

## 7. Clearance margin too small or too large

### Risk

- too small: text looks crowded against the track
- too large: valid placements disappear

### Mitigation

Set margin in **scaled physical terms** or relative to text size / plate size. A good starting point is a small fraction of plate short side or 1–2 grid cells.

---

## Final recommendation

### Best v1

Implement:

> **Adaptive occupancy grid + top-N axis-aligned empty rectangles + multiline text-fit scoring**

This is the best fit for racetrack-3d because it is:

- simple
- browser-friendly
- deterministic
- easy to test
- visually much better than the current hole-bounds heuristic

### Best v2

If needed later, add:

- clearance-map scoring
- local rectangle refinement
- small-angle rotation sweep

### Key architectural recommendation

Treat text placement as a **2D layout stage before glyph triangulation**, not as a side effect of text extrusion.

That keeps the system clean:

- geometry decides where text may go
- layout decides how text should wrap and scale
- triangulation only turns the chosen layout into a mesh

That separation will make future improvements much easier without destabilizing export.

---

*Generated: 2026-03-28. Based on current racetrack-3d geometry/text pipeline and practical browser-side computational geometry tradeoffs.*
