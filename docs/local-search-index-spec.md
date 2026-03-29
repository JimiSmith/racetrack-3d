# Local Search Index Spec

## Goal
Replace live-first generic entity search with a **build-time generated local search index** of racetrack venues.

The local index should provide:
- fast, deterministic search in the browser
- better recall for shorthand queries such as `spa`, `monaco`, `mexico city`
- support for label, alias, city, and country matching
- reduced dependence on live Wikidata text-search quirks

Live Wikidata/Overpass should still be used later for geometry and metadata lookup as needed, but **primary search retrieval** should come from the local index.

---

# High-level architecture

## Build-time pipeline
At build time:
1. fetch a broad set of racetrack items from Wikidata
2. normalize and enrich each item
3. generate search tokens and searchable fields
4. write a compact static JSON index into the app

## Runtime query pipeline
At runtime:
1. load the local index
2. normalize the user query
3. score matching entries against the local tokenized fields
4. return ranked results immediately in-browser

---

# Scope of indexed items

## Required Wikidata item types
The source set must include at least items whose `P31` is one of:
- `Q2338524` — **motorsport racing track**
- `Q926439` — **street circuit**

## Required geographic data
Indexed items should have coordinates where possible.

## Preferred additional metadata
Where available, include:
- label
- aliases
- description
- country
- city / locality
- coordinates
- Wikidata ID

---

# Build-time data extraction

## Source query requirements
The build-time extractor should fetch enough metadata to support search and display.

### Required fields per item
- `wikidataId`
- `label`
- `aliases[]`
- `description`
- `lat`
- `lon`
- `type`
- `country`
- `city`

### City field
The index should include a best-effort `city` or locality field wherever possible.

This may come from available Wikidata location relationships or other directly queryable locality metadata.

If city cannot be determined reliably, it may be left null — but the builder should attempt to populate it wherever possible.

---

# Build-time filtering

## Goal
Exclude entries that are technically in-scope by type but unusable or low quality for search.

## Required filtering rules
An entry should be excluded if:
- it has no usable label and no usable aliases
- it has no coordinates
- its searchable text is effectively empty or only a raw Q-id-style fallback

## Quality rule
If an item has only a raw identifier-like label (for example `Q12345678`) and no useful aliases, it should be excluded from the shipped search index.

---

# Normalization rules

All searchable text fields must be normalized at build time.

## Required normalization
For label, aliases, city, and country values:
- lowercase
- Unicode normalize
- remove diacritics / accent differences for search purposes
- normalize punctuation
- convert repeated separators to single spaces
- trim outer whitespace

### Examples
- `Autódromo Hermanos Rodríguez` → searchable normalized form equivalent to `autodromo hermanos rodriguez`
- `Spa-Francorchamps` → searchable normalized form equivalent to `spa francorchamps`
- `Circuit de Monaco` → searchable normalized form equivalent to `circuit de monaco`

## Separator handling
Hyphens, slashes, apostrophes, commas, and similar separators should not block matching.

The normalized search layer should make these equivalent where practical.

---

# Token generation

## Goal
Generate a token set that supports robust shorthand and location-aware matching.

## Source fields for token generation
Tokens should be generated from:
- primary label
- aliases
- city
- country

## Required inclusion of city and country
The track city and country should be included in the search tokens **wherever possible**.

This is important for queries such as:
- `mexico city`
- `monaco`
- `baku`
- `montreal`
- `singapore`
- `abu dhabi`

## Tokenization rules
The token builder should:
- split normalized strings on spaces and punctuation
- keep meaningful whole normalized phrases as well as individual tokens
- dedupe tokens
- drop empty tokens

## Phrase preservation
The system should preserve full normalized field strings in addition to token arrays.

This allows ranking to distinguish:
- exact whole-label matches
- exact alias matches
- phrase-prefix matches
- token-only matches

## Example token set
For a hypothetical entry:
- label: `Autódromo Hermanos Rodríguez`
- alias: `Rodriguez Brothers Autodrome`
- city: `Mexico City`
- country: `Mexico`

The generated searchable material should support matches on:
- `autodromo`
- `hermanos`
- `rodriguez`
- `rodriguez brothers autodrome`
- `mexico`
- `mexico city`

---

# Index schema

## Required structure per entry
Each indexed track entry should contain something like:

```json
{
  "wikidataId": "Q173099",
  "label": "Autódromo Hermanos Rodríguez",
  "aliases": ["Autodromo Hermanos Rodriguez", "Rodriguez Brothers Autodrome"],
  "description": "motorsport track in Mexico",
  "type": "motorsport racing track",
  "country": "Mexico",
  "city": "Mexico City",
  "lat": 19.4042,
  "lon": -99.0907,
  "normalized": {
    "label": "autodromo hermanos rodriguez",
    "aliases": ["autodromo hermanos rodriguez", "rodriguez brothers autodrome"],
    "country": "mexico",
    "city": "mexico city"
  },
  "tokens": [
    "autodromo",
    "hermanos",
    "rodriguez",
    "mexico",
    "city"
  ],
  "phrases": [
    "autodromo hermanos rodriguez",
    "rodriguez brothers autodrome",
    "mexico city",
    "mexico"
  ]
}
```

## Optional build-time helper fields
If useful, the build can also include precomputed ranking helpers such as:
- tokenCount
- aliasCount
- labelWordCount
- normalizedDisplayName

These are optional as long as runtime query quality remains good.

---

# Querying the local index

## Runtime query normalization
At query time, normalize the user query using the same normalization rules used at build time.

### Required normalization
- lowercase
- Unicode normalize
- strip diacritics
- normalize punctuation/hyphens to spaces
- collapse whitespace
- trim

## Query tokenization
The runtime query should be converted into:
- a normalized full query string
- token array

---

# Query matching model

## Goal
Use simple, deterministic ranking with no server dependency.

## Required match categories
The search should distinguish at least these match classes:

1. exact normalized label match
2. exact normalized alias match
3. exact normalized city match
4. exact normalized phrase match (including city/country phrases)
5. prefix label match
6. prefix alias match
7. prefix phrase match
8. token subset / token overlap match
9. weak substring fallback

## Important
City and country matches should contribute to score, but should not overpower a strong direct venue-name match.

For example:
- query `mexico city` should help retrieve `Autódromo Hermanos Rodríguez`
- but query `mexico` should not blindly outrank a more direct venue match for another specific query

---

# Ranking rules

## Rule 1 — Prefer direct venue-name matches
Strong label/alias matches should rank above city/country-only matches.

## Rule 2 — Prefer exact phrase matches over token-only matches
If the query matches a full normalized label or alias phrase, that should outrank a loose token overlap.

## Rule 3 — Prefer label matches over alias matches when otherwise equal
The canonical label should generally outrank an alias-only match when both are equally strong.

## Rule 4 — Use city/country as recall support, not as sole ranking dominance
City and country should help recover the right circuit, especially for shorthand place queries, but should not dominate over stronger venue-name matches.

## Rule 5 — Prefer cleaner venue labels over overly specific layout-like names
If the local index later includes over-specific entries, ranking should prefer broad venue names over highly specific layout/event-like names.

---

# Returned result shape

The runtime search result shape should remain compatible with the rest of the app as much as practical.

### Required result fields
- `name`
- `displayName`
- `lat`
- `lon`
- `wikidataId`

### Display name recommendation
A good display format may include:
- label
- city and/or country when available

Example:
- `Autódromo Hermanos Rodríguez — Mexico City, Mexico`

---

# Build artifacts

## Required generated artifact
Generate a static JSON file in the repo/app, for example:
- `src/generated/track-search-index.json`

Or another clearly named generated path.

## Build script
A build/update script should exist to regenerate the index from Wikidata.

Example shape:
- `scripts/build-track-search-index.mjs`

The spec does not require a specific filename, but the process should be explicit and reproducible.

---

# Performance expectations

## Build time
Build-time generation can be slower and more thorough.
That is acceptable.

## Runtime
Runtime search should be:
- fully local
- low-latency
- suitable for interactive typing

A local index of roughly ~1k items is expected to be small enough for this use case.

---

# Failure behavior

## Build-time failures
If some items are incomplete or malformed, the builder should skip unusable entries rather than fail the entire generation process, unless a catastrophic fetch/parsing error occurs.

## Runtime no-match behavior
If the local index yields no good matches, return no results rather than fall back immediately to noisy generic entity search.

A later hybrid fallback may be added separately if desired.

---

# Non-goals

This spec does **not** require:
- immediate removal of all live Wikidata usage elsewhere in the app
- geometry caching
- Overpass caching
- layout precomputation
- a server backend

---

# Recommended first implementation

1. Write a build script that fetches the Wikidata track set.
2. Extract label, aliases, description, coordinates, type, country, and city where available.
3. Normalize fields.
4. Generate tokens and phrases from label, aliases, city, and country.
5. Exclude unusable entries.
6. Write the generated JSON index.
7. Implement runtime local search against that index.
8. Rank matches using direct venue-name strength first, with city/country helping recall.

This should provide a cleaner and more reliable primary search experience than live generic entity search.