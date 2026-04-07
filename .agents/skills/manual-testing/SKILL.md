---
name: manual-testing
description: Manual UI testing for racetrack-3d using playwright-cli. Use when diagnosing visual or interaction bugs, validating UI fixes, checking rendering output, or verifying that a change looks and behaves correctly in the browser. Triggers on: "check the UI", "validate the fix in the browser", "test this visually", "take a screenshot", "does it look right", "open the app", "navigate to the app", "check rendering", "inspect the page", "UI regression", or any task requiring a human-style walkthrough of the app.
---

# Manual UI Testing

Use `playwright-cli` to open and interact with the running app. Relies on the `playwright-cli` skill for the full command reference.

## Prerequisites

The dev server must be running before opening the browser. The default port is **5173**. If Vite picks 5174, it means a stale server is already occupying 5173 — having two servers running is unreliable, so always kill any existing process first and start fresh:

```bash
pkill -f "vite" ; npm run dev
# App is available at http://localhost:5173/
```

Wait a moment for Vite to finish starting before opening the browser.

## Opening the app

```bash
playwright-cli open http://localhost:5173/
playwright-cli snapshot
```

## Core UI workflows

### Search for a track

```bash
playwright-cli snapshot         # find the search input ref
playwright-cli fill e3 "Silverstone"
playwright-cli snapshot         # check results appear
playwright-cli click e7         # click the first result
playwright-cli snapshot         # verify track loads
```

### Check 3D render

After selecting a track, the 3D canvas should populate. Take a screenshot to visually verify:

```bash
playwright-cli screenshot --filename=render-check.png
```

### Switch layout

```bash
playwright-cli snapshot         # find the LayoutPicker refs
playwright-cli click e12        # click a different layout option
playwright-cli screenshot --filename=layout-check.png
```

### Open options panel

```bash
playwright-cli snapshot
playwright-cli click e9         # options toggle button
playwright-cli snapshot         # verify panel is open
```

### Trigger export

```bash
playwright-cli snapshot
playwright-cli click e20        # export button (ref will vary)
playwright-cli snapshot         # check export dialog/progress
```

## Diagnosing UI issues

### Check browser console for errors

```bash
playwright-cli console
playwright-cli console error    # errors only
```

### Check network requests

```bash
playwright-cli network
```

### Inspect an element's attributes

```bash
playwright-cli eval "el => el.className" e5
playwright-cli eval "el => el.getBoundingClientRect()" e5
```

### Compare before/after a change

```bash
playwright-cli --raw snapshot > before.yml
# make the change or trigger the action
playwright-cli --raw snapshot > after.yml
diff before.yml after.yml
```

## Typical validation workflow

1. `pkill -f "vite" ; npm run dev` — kill any stale server and start fresh
2. `playwright-cli open http://localhost:5173/` — open the app
3. `playwright-cli snapshot` — get element refs
4. Reproduce the scenario (search, select track, interact)
5. `playwright-cli screenshot` — capture visual state
6. `playwright-cli console error` — check for JS errors
7. `playwright-cli close` — clean up

## Key components and what to look for

| Component | What to check |
|---|---|
| `SearchBar` | Input responds, results appear, selecting loads a track |
| `LayoutPicker` | Layout options shown, clicking switches the render |
| `PreviewCanvas` | 3D canvas renders without blank/broken state |
| `TrackSummary` | Track name and metadata displayed correctly |
| `OptionsPanel` | Opens/closes, settings take effect on render |
| `ElevationSlider` | Slider moves, elevation updates in the 3D view |
| `ExportBar` | Export button triggers download or progress indicator |

## Notes

- Screenshots save to `.playwright-cli/` by default
- Console logs also go to `.playwright-cli/console-<timestamp>.log`
- The app uses a Web Worker for heavy computation — errors there won't always surface in the main console; use `playwright-cli network` to check if worker fetches failed
- For production build testing, use `npm run preview` (serves on `http://localhost:4173/`)
