# Elevation API Research for racetrack-3d

> **App context:** Fully client-side, no server proxy, must work from iPhone Safari.  
> **Use case:** ~100–500 elevation points per racetrack load, arbitrary lat/lon, global F1 circuits.  
> **Priorities:** CORS ✅, no signup preferred, free/generous limits, ≥30m accuracy, batch support.

---

## Executive Summary

### Top Recommendations

#### 🥇 1. Open-Meteo Elevation API — Primary Choice

**URL:** `https://api.open-meteo.com/v1/elevation`

The cleanest option for this app. Confirmed `Access-Control-Allow-Origin: *`, no API key, Copernicus DEM GLO-90 (90m resolution), up to 100 coords per request, completely free for open-source/non-commercial use. Handles a 500-point track in 5 batched requests.

#### 🥈 2. Racemap Elevation Service — Best Batch Option

**URL:** `https://elevation.racemap.com/api` (POST)

Confirmed CORS (reflects origin), no API key, batch up to ~10,000 points per POST, free community-hosted service based on Mapzen/SRTM terrain tiles (~30m). Can send all 500 points in a single request. The risk is it's an unofficial third-party service with no SLA.

#### 🥉 3. AWS Terrain Tiles (S3 Terrarium) — Tile-based Fallback

**URL:** `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

Public S3 bucket with confirmed `Access-Control-Allow-Origin: *`. No API key. Requires client-side tile coordinate math and RGB decode, but is extremely robust (no rate limits, no SLA concerns). Best as a fallback when other services are unavailable. ~30m global coverage.

---

## Per-API Evaluation

---

### 1. Open-Meteo Elevation API

**Endpoint:** `https://api.open-meteo.com/v1/elevation?latitude=50.4,43.7&longitude=5.97,7.42`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ `Access-Control-Allow-Origin: *` confirmed via curl |
| **Free tier** | Free for non-commercial / open-source. No stated daily quota for elevation endpoint |
| **API key** | ❌ Not required |
| **Accuracy** | Copernicus DEM 2021 GLO-90, **90m resolution**. Good vertical accuracy (~4m RMSE). Global coverage |
| **Latency / Batch** | Up to **100 coordinates** per request (comma-separated lat/lon arrays). Fast (~200ms) |
| **Coverage** | Global. All F1 circuits covered. Copernicus DEM has no polar gaps relevant to racing |
| **Verdict** | ✅ **Best primary choice.** No key, CORS *, Copernicus quality, free. 90m resolution is fine for elevation variation across a 5km circuit |

**Sample request:**
```
GET https://api.open-meteo.com/v1/elevation?latitude=50.4378,43.7477&longitude=5.9714,7.4206
→ {"elevation":[397.0, 263.0]}
```

**Batching strategy for 500 points:** Split into 5× 100-point requests. Parallelize with `Promise.all`. No rate-limit documented for free use; be courteous and add minimal throttle (200ms between batches).

---

### 2. Racemap Elevation Service

**Endpoint:** `https://elevation.racemap.com/api` (POST JSON array)

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ Reflects `Origin` header (`access-control-allow-origin: <your origin>`). Works from Safari |
| **Free tier** | Free, community-hosted. No stated quota. Max POST payload ~700KB (~10,000 points) |
| **API key** | ❌ Not required |
| **Accuracy** | Mapzen/SRTM terrain tiles, ~**30m resolution**. HGT skadi format data |
| **Latency / Batch** | Single POST with full array. All 500 points in **one request** |
| **Coverage** | Global (Mapzen composite: SRTM + ASTER + GMTED2010). All F1 circuits |
| **Verdict** | ✅ **Best batch option.** Single request for all points. Risk: unofficial service, no uptime guarantee. Use as primary with Open-Meteo as fallback, or vice versa |

**Sample request:**
```javascript
const res = await fetch('https://elevation.racemap.com/api', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify([[50.4378, 5.9714], [43.7477, 7.4206]])
});
const elevations = await res.json(); // [393, 257]
```

**Note:** Open-source self-hostable at [github.com/racemap/elevation-service](https://github.com/racemap/elevation-service). Backed by AWS S3 terrain tiles — if the hosted service goes down, self-hosting is straightforward.

---

### 3. AWS Terrain Tiles (Terrarium PNG, S3)

**Endpoint:** `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET` — confirmed on S3 |
| **Free tier** | Completely free, AWS Open Data. No rate limits, no quota |
| **API key** | ❌ Not required |
| **Accuracy** | Mapzen composite (SRTM, ASTER, GMTED2010, EU-DEM, NED). ~**30m** globally |
| **Latency / Batch** | Not an API — tile-based. Fetch PNG tiles, decode RGB to elevation. One tile covers many points. At zoom 12 (~40m/px), a racetrack fits in 1–4 tiles |
| **Coverage** | Global including bathymetry. All F1 circuits |
| **Verdict** | ✅ **Best fallback / offline approach.** Zero dependency on third-party API reliability. Requires ~50 lines of client-side tile math and PNG decode. See implementation notes below |

**Terrarium decode formula:**
```javascript
// Each pixel: elevation = (R * 256 + G + B / 256) - 32768
const elevation = (r * 256 + g + b / 256) - 32768;
```

**Tile coordinate math:**
```javascript
function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y, z: zoom };
}

function pixelElevation(imageData, px, py, tileSize = 256) {
  const i = (py * tileSize + px) * 4;
  const [r, g, b] = [imageData[i], imageData[i+1], imageData[i+2]];
  return (r * 256 + g + b / 256) - 32768;
}
```

**Note:** The S3 terrarium endpoint has `s3.amazonaws.com` origin — Safari won't block it. Tiles are PNG images, decodable via `<canvas>` (the standard approach). Zoom 12 tiles have ~40m/px resolution, zoom 13 = ~20m/px.

---

### 4. OpenTopoData (api.opentopodata.org)

**Endpoint:** `https://api.opentopodata.org/v1/{dataset}?locations=lat,lon|lat,lon`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ❌ **No `Access-Control-Allow-Origin` header on GET responses.** OPTIONS preflight returns method list but not the critical `allow-origin`. **Cannot be called from browser JS.** |
| **Free tier** | 100 locations/request, 1 req/sec, **1,000 req/day** |
| **API key** | ❌ Not required (for public API) |
| **Accuracy** | Multiple datasets: `srtm30m` (30m), `aster30m` (30m), `eudem25m` (25m Europe), `mapzen` (30m global), `ned10m` (10m US) |
| **Coverage** | Global (via srtm30m/aster30m/mapzen). EU-DEM for Europe at 25m |
| **Verdict** | ❌ **Not usable client-side.** CORS headers are absent on actual responses. Excellent API otherwise — ideal for self-hosting or server-side use. The sister project GPXZ.io does have CORS but requires paid signup |

**Note:** This is the most fully-featured elevation API available. If you ever add a minimal server-side component (even a free Cloudflare Worker proxy), OpenTopoData with `eudem25m` for European circuits and `srtm30m` globally would be the ideal dataset combo.

---

### 5. Open-Elevation (api.open-elevation.com)

**Endpoint:** `https://api.open-elevation.com/api/v1/lookup`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ `Access-Control-Allow-Origin: *` confirmed |
| **Free tier** | **1,000 requests/month** (very restrictive). Paid plans from €10/month |
| **API key** | Not required on free tier |
| **Accuracy** | SRTM data, ~30m resolution |
| **Latency / Batch** | POST with JSON body. Batch supported |
| **Coverage** | Global |
| **Verdict** | ⚠️ **CORS works but quota is prohibitive.** 1,000 req/month allows only ~2–10 racetrack loads/day at 500 points. Not practical for this app without paying. The open-source project can be self-hosted for free |

---

### 6. Mapbox Terrain-RGB

**Endpoint:** `https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token=TOKEN`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ `Access-Control-Allow-Origin: *` confirmed (even on 401 responses) |
| **Free tier** | 50,000 tile requests/month on free tier. Very generous |
| **API key** | ✅ Required (but free tier available, no credit card needed for signup) |
| **Accuracy** | Multi-source: SRTM, NED, proprietary composites. **0.1m height increments** but underlying DEM is ~30m SRTM. Zoom 15 = ~4.8m pixels |
| **Latency / Batch** | Tile-based. At zoom 12–13 a full circuit covered by 2–8 tiles |
| **Coverage** | Global. All F1 circuits |
| **Verdict** | ✅ **Good option if signup acceptable.** CORS works, generous free tier. Same tile-based decode approach as AWS Terrarium but requires a Mapbox token. `height = -10000 + ((R*256*256 + G*256 + B) * 0.1)` |

**Decode formula:**
```javascript
const height = -10000 + ((r * 65536 + g * 256 + b) * 0.1);
```

---

### 7. Google Elevation API

**Endpoint:** `https://maps.googleapis.com/maps/api/elevation/json?locations=...&key=KEY`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ❌ **Not designed for direct browser use.** The REST API doesn't include CORS headers for cross-origin requests. The JavaScript Maps SDK is the intended browser path (but heavier) |
| **Free tier** | $200/month credit (~40,000 requests free). $5 per 1,000 elements after |
| **API key** | ✅ Required. Billing account needed |
| **Accuracy** | Excellent. Multi-source composite, better than SRTM alone |
| **Latency / Batch** | Up to 512 locations per request |
| **Coverage** | Global |
| **Verdict** | ❌ **Not suitable.** CORS blocked for REST, billing required, no anonymous use. Would need a server-side proxy to use the REST API, defeating the client-side architecture |

---

### 8. USGS Elevation Point Query Service (EPQS / 3DEP)

**Endpoint:** `https://epqs.nationalmap.gov/v1/json?x={lon}&y={lat}&units=Meters`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ `Access-Control-Allow-Origin: *` confirmed |
| **Free tier** | Free, US government service |
| **API key** | ❌ Not required |
| **Accuracy** | 3DEP 1/3 arc-second (~10m) for CONUS. Very high quality |
| **Latency / Batch** | **Single point only.** No batch endpoint |
| **Coverage** | ❌ **Continental US + Hawaii + parts of Alaska only.** No Europe, Asia, Middle East |
| **Verdict** | ❌ **Too limited.** US-only (misses Spa, Silverstone, Monza, Suzuka, etc.) and no batch support. Good for COTA/Austin specifically but can't be the primary solution |

---

### 9. Open-Meteo (Weather API with elevation field)

Open-Meteo's **weather** API returns an `elevation` field alongside forecast data, also based on Copernicus DEM GLO-90. This is the same source as the dedicated elevation endpoint above. The dedicated `/v1/elevation` endpoint is the right approach — no need to mix with weather data.

---

### 10. SRTM Direct Tile Access (HGT files)

**Source:** `https://s3.amazonaws.com/elevation-tiles-prod/skadi/{NS}{lat}/{NS}{lat}{EW}{lon}.hgt.gz`

| Criterion | Detail |
|-----------|--------|
| **CORS** | ✅ AWS S3 CORS * |
| **Free tier** | Free |
| **API key** | ❌ Not required |
| **Accuracy** | SRTM 1 arc-second (~30m). NASA data, good global coverage |
| **Latency / Batch** | Manual download of 1°×1° HGT tiles (~25MB each compressed). Need to fetch, gunzip, and parse 16-bit binary |
| **Coverage** | Latitudes -60 to 60 (covers all F1 circuits) |
| **Verdict** | ⚠️ **Complex client-side implementation.** Feasible (gzip + binary parsing in browser) but significantly more code than Terrarium PNG approach. Lower priority fallback |

---

### 11. Copernicus DEM / EU-DEM Direct Access

| Criterion | Detail |
|-----------|--------|
| **CORS** | No direct public REST API with CORS |
| **Direct API** | Copernicus Open Access Hub requires registration and has no point-query REST API |
| **Access via proxy** | Available through **OpenTopoData** (`eudem25m`, 25m resolution for Europe) and **Open-Meteo** (GLO-90, 90m global) |
| **Verdict** | ❌ **No usable direct public endpoint.** Access via Open-Meteo (GLO-90) is the right approach |

---

## Recommended Implementation Approach

### Strategy: Open-Meteo as Primary + Racemap as Fallback

```javascript
// elevation.js

const OPEN_METEO_BATCH = 100;
const RACEMAP_URL = 'https://elevation.racemap.com/api';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';

/**
 * Fetch elevation for an array of {lat, lon} points.
 * Uses Open-Meteo as primary, falls back to Racemap if needed.
 */
async function fetchElevations(points) {
  try {
    return await fetchOpenMeteo(points);
  } catch (err) {
    console.warn('Open-Meteo failed, trying Racemap:', err);
    return await fetchRacemap(points);
  }
}

async function fetchOpenMeteo(points) {
  const results = new Array(points.length);
  const batches = chunkArray(points, OPEN_METEO_BATCH);
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const lats = batch.map(p => p.lat).join(',');
    const lons = batch.map(p => p.lon).join(',');
    const url = `${OPEN_METEO_URL}?latitude=${lats}&longitude=${lons}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
    const data = await resp.json();
    batch.forEach((_, j) => {
      results[i * OPEN_METEO_BATCH + j] = data.elevation[j];
    });
    // Polite throttle between batches (not required but considerate)
    if (i < batches.length - 1) await sleep(200);
  }
  return results;
}

async function fetchRacemap(points) {
  const payload = points.map(p => [p.lat, p.lon]);
  const resp = await fetch(RACEMAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error(`Racemap HTTP ${resp.status}`);
  return resp.json(); // Array of elevation numbers
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

### Implementation Notes

1. **Sample density:** For a typical 5km circuit at 500 points, spacing is ~10m. At 90m DEM resolution (Open-Meteo/Copernicus GLO-90), consecutive points will often share a DEM cell — consider downsampling to 200 points (25m spacing) to reduce requests without losing meaningful detail.

2. **Smoothing:** Raw DEM values on a racetrack path will be noisy. Apply a Gaussian or moving-average smooth after fetching (window ≈ 3–5 points) to get plausible tarmac elevation profiles.

3. **Exaggeration for 3D STL:** Racetrack elevation changes are subtle (Spa's Eau Rouge is ~40m over 1km = 4% grade). Apply a vertical exaggeration factor (e.g., 3×–5×) in STL generation so the relief is visually apparent at model scale.

4. **Error handling:** Both services return numeric arrays aligned to input order. If a point returns `null` or `NaN`, interpolate from neighbors.

5. **iPhone Safari:** Both primary APIs serve `Access-Control-Allow-Origin: *`, which Safari respects. No issues anticipated. Avoid services that return a reflected origin (e.g., `access-control-allow-origin: https://...`) without a wildcard — these require the exact Origin match, which may cause issues in local dev or `file://` contexts.

---

## Fallback Strategy: Tile-Based Client-Side Decode

If both APIs become unavailable or rate-limited, implement a tile-based decode using AWS S3 Terrarium tiles:

```javascript
// Tile-based fallback using AWS S3 Terrarium tiles
// CORS: confirmed * on s3.amazonaws.com

const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ZOOM = 13; // ~20m/px — good balance of resolution vs tile count

function latLonToTileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { x, y };
}

function tilePixelCoords(lat, lon, z, tileSize = 256) {
  const n = 2 ** z;
  const xFrac = (lon + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const yFrac = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const px = Math.floor((xFrac - Math.floor(xFrac)) * tileSize);
  const py = Math.floor((yFrac - Math.floor(yFrac)) * tileSize);
  return { px, py };
}

function terrariumDecode(r, g, b) {
  // Terrarium encoding: elevation = (R * 256 + G + B/256) - 32768
  return (r * 256 + g + b / 256) - 32768;
}

async function fetchTileElevations(points) {
  // Group points by tile
  const tileMap = new Map();
  points.forEach((p, i) => {
    const { x, y } = latLonToTileXY(p.lat, p.lon, ZOOM);
    const key = `${ZOOM}/${x}/${y}`;
    if (!tileMap.has(key)) tileMap.set(key, { x, y, points: [] });
    tileMap.get(key).points.push({ ...p, index: i });
  });

  const results = new Array(points.length);

  await Promise.all([...tileMap.entries()].map(async ([key, tile]) => {
    const url = `${TERRARIUM_BASE}/${key}.png`;
    const imageData = await loadTilePixels(url);
    tile.points.forEach(p => {
      const { px, py } = tilePixelCoords(p.lat, p.lon, ZOOM);
      const i = (py * 256 + px) * 4;
      results[p.index] = terrariumDecode(imageData[i], imageData[i+1], imageData[i+2]);
    });
  }));

  return results;
}

async function loadTilePixels(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, 256, 256).data);
    };
    img.onerror = reject;
    img.src = url;
  });
}
```

**Tile fallback advantages:**
- No rate limits, no third-party reliability dependency
- Tiles are cacheable by browser (S3 serves cache headers)
- A full F1 circuit at zoom 13 fits in 4–12 tiles
- Once tiles are loaded, many points can be sampled per tile synchronously

**Tile fallback disadvantages:**
- ~50–150 lines more code
- Requires canvas access (should be fine in Safari)
- Can't be used in service workers without OffscreenCanvas

---

## Quick Comparison Table

| API | CORS | Key? | Free Limit | Resolution | Batch | Global | Verdict |
|-----|------|------|------------|------------|-------|--------|---------|
| **Open-Meteo** | ✅ `*` | ❌ | Generous | 90m Copernicus | 100/req | ✅ | 🥇 Primary |
| **Racemap** | ✅ reflects | ❌ | ~10k pts | 30m SRTM | ~10k/req | ✅ | 🥈 Fallback |
| **AWS Terrarium** | ✅ `*` | ❌ | Unlimited | 30m | Tile-based | ✅ | 🥉 Last resort |
| **Mapbox RGB** | ✅ `*` | ✅ signup | 50k tiles/mo | 30m SRTM | Tile-based | ✅ | ✅ If signup OK |
| **Open-Elevation** | ✅ `*` | ❌ | 1k req/mo ❌ | 30m SRTM | ✅ POST | ✅ | ⚠️ Too low quota |
| **OpenTopoData** | ❌ No CORS | ❌ | 1k req/day | 30m SRTM | 100/req | ✅ | ❌ No browser CORS |
| **Google Elevation** | ❌ REST CORS | ✅ billing | $200 credit | Best | 512/req | ✅ | ❌ Billing + CORS |
| **USGS EPQS** | ✅ `*` | ❌ | Unlimited | 10m 3DEP | ❌ Single pt | ❌ US only | ❌ US only |

---

## Notes on F1 Circuit Accuracy

At 90m DEM resolution (Open-Meteo/Copernicus GLO-90):

- **Spa-Francorchamps** — ~100m total elevation drop from Raidillon to Bus Stop. Well within DEM resolution; will render clearly with 3× exaggeration.
- **Monaco** — ~40m change over tight geography. Dense sampling (200+ points) needed to capture the Hairpin / Casino gradients.
- **Suzuka** — relatively flat (~20m variation); 90m DEM will capture the figure-8 overpass grade.
- **COTA (Austin)** — ~40m variation; USGS EPQS would give better 10m resolution but Open-Meteo's 90m Copernicus is adequate.
- **Yas Marina, Bahrain, Jeddah** — near sea-level with minimal relief. Any DEM will work; accuracy less critical.
- **Interlagos, Brazil** — ~30m variation. Fine.

**Conclusion:** 90m resolution is adequate for capturing the macro topography of any F1 circuit. The subtle banking and kerb-level changes within a track are not captured by any freely available global DEM and are irrelevant for 3D model purposes.

---

*Generated: 2026-03-28. APIs tested directly via curl; CORS headers verified.*
