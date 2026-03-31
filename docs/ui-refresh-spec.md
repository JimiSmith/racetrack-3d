# UI Refresh Spec

## Status
Approved for implementation.

## Canonical visual reference
The approved mockup is here and must be inspected before implementation:

- `docs/mockups/ui-mockup-v1.png`

This image is the primary visual reference for the layout direction.

---

## Goal
Refactor the app UI so it feels like a polished mobile-first product rather than a debug/control panel.

The 3D preview is the primary output and should be visually prioritized.

---

## Core layout changes

### 1. Move the preview much higher
Current problem:
- too much dead space before the preview
- the preview feels secondary

Required change:
- place the preview near the top of the experience, immediately after the selected-track summary

Desired order:
1. App title
2. Search bar
3. Selected track summary
4. 3D preview
5. Options card
6. Export bar

---

### 2. Add a selected-track summary block
Add a compact summary card under the search input.

It should show current context clearly, such as:
- Track name
- Selected layout
- Label/printed name
- Orientation mode
- Text placement selection

This block should reduce ambiguity about what the user is editing/exporting.

---

### 3. Group controls into a single "Options" card
Current problem:
- controls feel fragmented
- advanced controls are too visually prominent

Required change:
- group the main controls into a single options section/card

This should include:
- Layout selector
- Model orientation selector
- Label placement selector
- Elevation exaggeration control

The visual treatment should be denser and more cohesive than the current stacked-debug look.

---

### 4. Improve control labels
Rename labels to feel more product-like and less internal.

Preferred labels:
- `Primary orientation` → `Model orientation`
- `Text position` → `Label placement`

For the label placement selector, options should be user-facing rather than cryptic internal ranking.

Preferred options:
- `Best fit`
- `Alternate 1`
- `Alternate 2`

If existing code internally uses 1/2/3, that is fine, but the visible UI should be clearer.

---

### 5. Elevation exaggeration remains in options
Keep elevation exaggeration available, but visually integrate it into the options card rather than making it feel like a separate debug control.

A slider is fine.

---

### 6. Add a sticky export bar at the bottom
The export actions are primary tasks, especially on mobile.

Required change:
- add a sticky bottom export bar once a model is loaded

Buttons:
- `Download 3MF (recommended)`
- `Download STL`

3MF should be visually emphasized as the recommended option.

Both buttons should feel like first-class actions.

---

## Preview behavior

### 7. Keep preview large and prominent
The preview area should be visually dominant in the loaded state.

### 8. Improve empty/loading state if needed
If there is no model loaded yet, add a more intentional empty state such as:
- helper text
- subtle placeholder messaging

If a model is loading, show a loading message/spinner that feels intentional.

---

## Mobile-first constraints

### 9. Preserve mobile usability
The redesigned UI must work well on iPhone Safari.

Important:
- no tiny tap targets
- no cramped select controls
- sticky export bar should not obscure core controls
- layout should remain readable without excessive scrolling

---

## Functional constraints

### 10. No feature regressions
This is a UI/layout refresh, not a feature rewrite.

The following must continue working:
- search and selection
- layout choice
- model orientation
- label placement selection
- elevation exaggeration
- preview updates
- STL export
- 3MF export

### 11. Keep preview/export behavior aligned
The UI refactor must not introduce discrepancies between what the preview shows and what the exported model contains.

---

## Implementation guidance

### 12. Follow the mockup direction, not necessarily pixel-perfect reproduction
The mockup is the approved direction. The implementation does not need to be a literal pixel match, but it should clearly follow:
- summary card near top
- big preview high on the page
- grouped options card
- sticky export bar
- stronger 3MF emphasis

### 13. Prefer simple DOM/CSS changes over heavy framework-like complexity
Keep the implementation maintainable.

---

## Acceptance criteria

Implementation is successful if:
1. The page visually resembles the approved mockup direction
2. The preview is much higher and more prominent
3. Current track/layout/orientation state is clearly visible
4. Controls are grouped and easier to understand
5. Export actions are sticky and obvious on mobile
6. Existing behavior still works
7. `npm test` passes
8. `npm run build` passes

---

## Required files to inspect before coding
The implementation agent must inspect:
- `docs/ui-refresh-spec.md`
- `docs/mockups/ui-mockup-v1.png`
- `src/main.js`
- `src/style.css`
- `index.html`
- any small UI helper files already present
