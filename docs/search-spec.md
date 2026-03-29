# Search Spec

## Goal
Improve racetrack search quality by increasing recall for shorthand/place-name queries while filtering out non-track entities.

The search system must:
- recover likely circuit results for ambiguous inputs like `spa`, `monaco`, `shanghai`
- suppress obvious non-track junk
- remain browser-friendly and responsive
- prefer actual circuit venues over events, layouts, cities, or unrelated entities

---

## Core strategy

Use **parallel expanded queries** against Wikidata search, then apply a **SPARQL-based P31 type filter** on each branch, merge the surviving candidates, and rank them.

This is a retrieval-and-ranking improvement, not a single-query hard filter.

---

# Retrieval pipeline

## Step 1 — Build parallel query set

For a user input `q`, construct a small query set.

### Required branches
Always include:
1. `q`
2. `q + " circuit"`
3. `q + " track"`
4. `q + " street circuit"`
5. `q + " international circuit"`

### Notes
- Keep the set small and fixed-size for performance.
- Terms are generic motorsport retrieval aids, not F1-specific hacks.
- Future additions are allowed, but the default set should stay compact.

---

## Step 2 — Run Wikidata EntitySearch in parallel

For each query branch, run `wbsearchentities`.

### Requirements
- use English search
- request item results only
- keep per-branch limits modest (for example 10–20)
- dedupe repeated raw item IDs later

The purpose of parallel branches is to improve candidate recall, especially for queries where the circuit is not returned in the raw search for the unmodified query.

---

## Step 3 — Apply a SPARQL P31 filter on each branch

For each query branch, use SPARQL to filter the branch candidate set returned by `wbsearchentities`.

This SPARQL step must operate on the branch's candidate IDs (for example via `VALUES ?item { ... }`) and keep only candidates whose `P31` is one of:

- `Q2338524` — **motorsport racing track**
- `Q926439` — **street circuit**

### Important
This SPARQL filter must be applied **per branch**, not only after a single raw query.

That is the whole point of the expanded-query design:
- raw query may miss the circuit
- expanded branch may retrieve it
- then the P31 filter becomes useful rather than destructive

---

## Step 4 — Require coordinates

Candidates must still have coordinates (`P625`) so the rest of the app can continue using the geometry pipeline.

---

# Merge rules

## Step 5 — Merge branch results by Wikidata item ID

After filtering, merge all surviving candidates from all branches.

### Dedupe key
- `wikidataId`

### Preserve branch provenance
For each merged candidate, keep:
- which query branches matched it
- whether the base query matched it directly
- whether the match came from a suffix-expanded branch only

This provenance is important for ranking.

---

# Ranking rules

## Goal of ranking
Prefer the most likely **primary circuit venue** for the user query.

The system should prefer:
- actual circuit venues
- direct or near-direct query matches
- stronger venue phrasing

over:
- layout variants
- event-specific entries
- odd or over-specific historical layout items

---

## Rule 1 — Prefer stronger branch/query quality

Branch provenance should influence ranking.

If a good circuit candidate is returned from the raw query `q`, it should generally outrank a candidate found only via a suffix-expanded branch.

Suffix-only matches are still valuable as fallback recovery, but branch quality should guide ordering.

Example rough preference order:
1. raw query exact good circuit match
2. `q + " circuit"`
3. `q + " street circuit"`
4. `q + " international circuit"`
5. `q + " track"`

This ordering is heuristic, but the idea is that some suffixes are more venue-specific than others.

---

## Rule 2 — Prefer cleaner venue names

Prefer candidates whose label looks like the actual circuit venue, for example:
- `Silverstone Circuit`
- `Suzuka Circuit`
- `Bahrain International Circuit`
- `Circuit de Monaco`
- `Shanghai International Circuit`

Signals of good venue naming include terms like:
- `Circuit`
- `International Circuit`
- `Autodrome`
- `Autódromo`
- `Raceway`
- `Speedway`
- `Ring`

This rule is only about search ranking, not final printed naming.

---

## Rule 3 — Prefer broad venue entries over layout-like variants

If both appear, prefer the main circuit venue over entries that appear to be:
- yearly layout snapshots
- Grand Prix layout variants
- historical sub-layouts
- highly specific alternate-layout items

Examples to downrank:
- `... 1997 Grand Prix layout`
- `... original Grand Prix circuit`
- `... modified Grand Prix circuit`

These may still be useful later in layout logic, but should not dominate top-level search results.

---


---

# Output contract

The search output should still provide the same core information used downstream:
- `name`
- `displayName`
- `lat`
- `lon`
- `wikidataId`
- naming metadata already used elsewhere

Additionally, internal ranking metadata may be included if useful, such as:
- matchedBranches
- primaryMatchType
- rankScore

But the UI should not expose internal scoring unless explicitly desired.

---

# Performance constraints

## Browser constraints
This must remain browser-friendly.

### Requirements
- keep branch count small and fixed
- keep per-branch result limit modest
- dedupe aggressively before enrichment
- avoid excessive follow-up network calls per candidate

### Practical target
The search should still feel interactive rather than batch/offline.

---

# Failure behavior

## If all filtered branches are empty
Return no results rather than falling back to raw non-track junk.

That is preferable to showing clearly irrelevant results.

A later fallback strategy may be added, but this spec does not require it.

---

# Test requirements

At minimum, manual or automated verification should cover the following shorthand queries:
- `spa`
- `monaco`
- `shanghai`
- `silverstone`
- `monza`
- `suzuka`
- `interlagos`
- `daytona`
- `hungaroring`
- `red bull ring`

The system should also be checked against current F1 venue-style inputs such as:
- `melbourne`
- `jeddah`
- `bahrain`
- `zandvoort`
- `abu dhabi`
- `baku`
- `singapore`
- `austin`
- `montreal`
- `barcelona`
- `mexico city`
- `miami`
- `lusail`
- `las vegas`

---

# Non-goals

This spec does **not** require:
- hardcoded F1 venue mapping
- server-side search infrastructure
- replacing Wikidata with another provider
- printed-name logic changes
- layout-selection logic changes

---

# Recommended first implementation

1. Build the parallel query branch set.
2. Run `wbsearchentities` in parallel.
3. Merge raw candidate IDs per branch.
4. Use SPARQL on each branch candidate set to apply `P31 in {Q2338524, Q926439}` and coordinate filtering.
5. Merge surviving candidates by item ID.
6. Rank by branch/query quality + venue cleanliness.
7. Return ranked results.

This keeps the implementation focused and testable while materially improving search precision and recall.