# GitHub Pages readiness

This repo is configured for project-site deployment under `/racetrack-3d/`.

## What was added

- `vite.config.js` sets Vite's production `base` to `/racetrack-3d/`.
- `.github/workflows/deploy-pages.yml` installs dependencies, runs `npm test`, runs `npm run build`, uploads `dist/`, and deploys with GitHub Pages Actions.
- The debug-only `eruda` CDN script was removed from `index.html` so the app no longer depends on a third-party script at startup.

## Runtime network audit

### Already OK

- `src/search.js` - Wikidata REST API (`https://www.wikidata.org/w/api.php`) is called with `origin=*`. Verified response includes `Access-Control-Allow-Origin: *`.
- `src/search.js` - Wikidata SPARQL (`https://query.wikidata.org/sparql`) is called directly from the browser. Verified response includes `Access-Control-Allow-Origin: *`.
- `src/elevation.js` - Terrarium elevation tiles from `https://s3.amazonaws.com/elevation-tiles-prod/terrarium` are fetched browser-side. Verified tile responses include `Access-Control-Allow-Origin: *` for cross-origin GET requests.

### Risks, but not GitHub Pages blockers

- Wikidata is a public shared service. GitHub Pages can call it directly, but runtime availability still depends on upstream rate limits, temporary outages, and query throttling.
- `src/elevation.js` - Elevation tiles are publicly accessible and CORS-enabled, but the app still depends on a third-party bucket staying available.

### Current blocker status

- No confirmed GitHub Pages-specific runtime blocker was found in the current browser fetch path.
- The app remains fully static-host compatible; it does not require server-side secrets, cookies, or a custom backend for the current flow.

## Notes for deployment

- This workflow assumes the repository default Pages branch is `main` and the site is published as a project page.
- In GitHub repository settings, Pages should be set to use GitHub Actions as the source.
- If the repository name changes, update the Vite `base` in `vite.config.js`.
