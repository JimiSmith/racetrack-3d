# Circuit Name Selection Spec

## Goal
Choose the **correct canonical printed name** for the racetrack model.

This choice must be made **before** any text placement or fitting logic.
Placement must adapt to the chosen name — the name must never adapt to placement.

---

## Inputs

For a selected track/layout, the naming layer may use:

### From Wikidata
- `label` — English item label
- `aliases[]` — English aliases
- `shortName` — `P1813` if present
- `description` — available for diagnostics only, not for final naming

### From app state
- `selectedLayout.name`

### From OSM/layout logic
- venue-level relation/way names if already available in the geometry pipeline

---

## Output
A single string:

- `printedName`

Optionally:
- `baseVenueName`
- `layoutSuffix`

---

# Core Rule

## Rule 1 — Name selection is independent of placement
The naming system must choose the final printed string **without using**:
- available placement area
- text fit score
- multiline fit quality
- text scaling score

Those concerns come later.

---

# Candidate Generation

## Step 1 — Build candidate venue names

Generate candidate venue names in this order:

1. Wikidata English `label`
2. Wikidata English `aliases`
3. OSM venue-level names, if available and clearly venue-level
4. Wikidata `shortName` (`P1813`) — **only as fallback candidate**, not preferred by default

Do **not** use:
- description
- country
- displayName (`name — country`) for printed text
- generic layout-only names as base venue names

---

# Candidate Filtering

## Rule 2 — Reject obviously invalid candidates

A candidate must be rejected if any of the following is true:

### 2.1 Descriptive sentence, not a name
Reject if it looks like:
- `street circuit in Melbourne, Victoria, Australia`
- `motor racing circuit on the Buckinghamshire and Northamptonshire border, UK`

### 2.2 Pure event name rather than venue name
Reject if it names the race/event, not the circuit/venue.

Examples to reject:
- `Australian Grand Prix Circuit` if `Albert Park Circuit` exists
- `Melbourne Grand Prix Circuit` if venue name exists

### 2.3 Overly generic / ambiguous
Reject if it is too generic and a better venue-form candidate exists.

Examples:
- `Monaco`
- `Bahrain`
- `Melbourne`
- `Silverstone`

These are not invalid in absolute terms, but they lose to canonical venue names if such names exist.

### 2.4 Layout-only names used as venue names
Reject as base names:
- `Grand Prix Circuit`
- `Inner Circuit`
- `National Circuit`
- `Main`
- `Alternate`

These may still be valid as layout suffixes later.

---

# Candidate Ranking

After filtering, rank remaining candidates with this priority order.

## Rule 3 — Prefer canonical venue-form names

### Tier A — Strong venue-form names
Prefer candidates containing strong venue keywords, such as:
- `Circuit`
- `Autodrome`
- `Autodromo`
- `Raceway`
- `Speedway`
- `International Circuit`
- `Motor Speedway`
- `Ring`
- `Park Circuit`

### Tier B — Canonical phrasing
Among Tier A candidates, prefer the one that looks most like the real venue name:
- official/common venue wording
- not event-branded
- not needlessly promotional
- not awkwardly translated if a more natural alias exists

### Tier C — Brevity, but only after correctness
If two candidates are equally canonical, prefer the shorter/cleaner one.

### Tier D — Fallback to short name only if no good venue-form candidate exists
`P1813` may be used only if:
- no strong venue-form candidate exists, or
- every venue-form candidate is obviously worse

---

# Alias Preference Rules

## Rule 4 — Alias may beat label, but only if clearly better

An alias can override the label only if at least one of these is true:

### 4.1 Alias fixes a clearly worse label
Example:
- label: `Spa-Francochamps Circuit`
- alias: `Circuit de Spa-Francorchamps`

Pick alias.

### 4.2 Alias is canonical venue wording and label is awkward/non-canonical
Example:
- alias contains a standard circuit form while label is malformed or awkward

### 4.3 Alias is equally canonical but clearly better formatted
Examples:
- corrected punctuation
- corrected spelling
- more standard casing / naming form

An alias must **not** override the label just because it is shorter.

---

# Short Name Rules

## Rule 5 — `P1813` is not the default printed name

Short name is a fallback only.

Use `P1813` only if:
- no strong venue-form candidate exists, or
- all venue-form candidates are materially worse / malformed

Examples:
- `Silverstone` loses to `Silverstone Circuit`
- `Monaco` loses to `Circuit de Monaco`
- `Bahrain` loses to `Bahrain International Circuit`

---

# Layout Suffix Rules

After choosing `baseVenueName`, decide whether to append a layout suffix.

## Rule 6 — Append layout suffix only when meaningful

Append `selectedLayout.name` only if:

### 6.1 It is non-generic
Allowed examples:
- `National Circuit`
- `Inner Circuit`
- `Grand Prix Circuit`
- `Moto`
- `Outer Circuit`

Rejected examples:
- `Main`
- `Alternate`
- `Layout 1`

### 6.2 It does not duplicate the base venue name
Do not produce:
- `Grand Prix Circuit Grand Prix Circuit`
- `Bahrain International Circuit Bahrain`

### 6.3 It adds real disambiguating value
If the selected layout is effectively the canonical main venue, no suffix needed.

---

# Final Output Rules

## Rule 7 — Final printed name format

### 7.1 If no suffix:
`printedName = baseVenueName`

### 7.2 If meaningful suffix exists:
`printedName = <baseVenueName with sensible suffix handling>`

Prefer compact compositional forms, for example:
- `Silverstone National Circuit`
- `Bahrain Inner Circuit`
- `Bahrain Grand Prix Circuit`

Avoid awkward duplication.

---

# Deterministic Examples

## Silverstone
Candidates:
- `Silverstone Circuit`
- `Silverstone`

Result:
- **`Silverstone Circuit`**

## Albert Park
Candidates:
- `Albert Park Circuit`
- `Melbourne Grand Prix Circuit`
- `Australian Grand Prix Circuit`
- `Melbourne`

Result:
- **`Albert Park Circuit`**

## Monaco
Candidates:
- `Circuit de Monaco`
- `Monaco`

Result:
- **`Circuit de Monaco`**

## Spa
Candidates:
- `Spa-Francochamps Circuit`
- `Spa-Francochamps`
- `Circuit de Spa-Francorchamps`

Result:
- **`Circuit de Spa-Francorchamps`**

## Bahrain, main layout
Candidates:
- `Bahrain International Circuit`
- `Bahrain`

Result:
- **`Bahrain International Circuit`**

## Bahrain, inner layout
Base:
- `Bahrain International Circuit`

Layout:
- `Inner Circuit`

Result:
- **`Bahrain Inner Circuit`**
or, if you want stricter venue preservation:
- **`Bahrain International Circuit — Inner Circuit`**

---

# Recommended Implementation Shape

## Phase 1 — Pure naming helper
Add a pure function, e.g.:

```js
selectPrintedTrackName({
  wikidataLabel,
  wikidataAliases,
  wikidataShortName,
  description,
  osmVenueNames,
  selectedLayoutName,
})
```

Returns:
```js
{
  baseVenueName,
  layoutSuffix: string | null,
  printedName,
  reason,
}
```

`reason` is useful for debugging/tests.

---

# Test Requirements

Minimum tests:

1. prefers label over short name when label is canonical
2. prefers alias over label when alias is clearly better
3. rejects description as printed name
4. does not use event-style alias when venue name exists
5. appends meaningful layout suffix
6. ignores generic layout names (`Main`, `Alternate`, `Layout 1`)
7. preserves deterministic result independent of placement

---

# Recommended Default Policy

If you want the most conservative version:

1. Use **best venue-form candidate** from label/aliases
2. Ignore `P1813` unless no venue-form candidate exists
3. Append layout suffix only when meaningful
4. Never let placement influence naming
