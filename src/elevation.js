const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;
const ZOOM = 13;
const MAX_LATITUDE = 85.05112878;
const SMOOTHING_BLEND = 0.35;

const tileCache = new Map();

export async function fetchElevations(nodes, exaggeration = 1) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }

  const tileGroups = new Map();

  nodes.forEach((node, index) => {
    const { lat, lon } = normalizeNode(node, index);
    const { x, y } = latLonToTileXY(lat, lon, ZOOM);
    const key = `${ZOOM}/${x}/${y}`;
    const point = { index, lat, lon };

    if (!tileGroups.has(key)) {
      tileGroups.set(key, { x, y, points: [point] });
      return;
    }

    tileGroups.get(key).points.push(point);
  });

  const sampledElevations = new Array(nodes.length);

  await Promise.all(
    [...tileGroups.values()].map(async (tile) => {
      const pixels = await loadTilePixels(tile.x, tile.y, ZOOM);

      tile.points.forEach((point) => {
        const { px, py } = tilePixelCoords(point.lat, point.lon, ZOOM);
        const offset = (py * TILE_SIZE + px) * 4;

        sampledElevations[point.index] = terrariumDecode(
          pixels[offset],
          pixels[offset + 1],
          pixels[offset + 2],
        );
      });
    }),
  );

  return buildElevationProfile(sampledElevations, exaggeration);
}

export function buildElevationProfile(elevations, exaggeration = 1) {
  return smoothElevationProfile(applyExaggeration(elevations, exaggeration));
}

function normalizeNode(node, index) {
  const lat = Number(node?.lat);
  const lon = Number(node?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Invalid node at index ${index}`);
  }

  return {
    lat: clamp(lat, -MAX_LATITUDE, MAX_LATITUDE),
    lon: normalizeLongitude(lon),
  };
}

function latLonToTileXY(lat, lon, zoom) {
  const n = 2 ** zoom;
  const lonFraction = (lon + 180) / 360;
  const latRadians = (lat * Math.PI) / 180;
  const x = Math.floor(lonFraction * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * n,
  );

  return {
    x: clamp(x, 0, n - 1),
    y: clamp(y, 0, n - 1),
  };
}

function tilePixelCoords(lat, lon, zoom) {
  const n = 2 ** zoom;
  const xFraction = ((lon + 180) / 360) * n;
  const latRadians = (lat * Math.PI) / 180;
  const yFraction = ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * n;
  const px = Math.min(TILE_SIZE - 1, Math.floor((xFraction - Math.floor(xFraction)) * TILE_SIZE));
  const py = Math.min(TILE_SIZE - 1, Math.floor((yFraction - Math.floor(yFraction)) * TILE_SIZE));

  return { px, py };
}

function terrariumDecode(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

async function loadTilePixels(x, y, zoom) {
  const key = `${zoom}/${x}/${y}`;

  if (!tileCache.has(key)) {
    tileCache.set(key, fetchTilePixels(x, y, zoom));
  }

  try {
    return await tileCache.get(key);
  } catch (error) {
    tileCache.delete(key);
    throw error;
  }
}

async function fetchTilePixels(x, y, zoom) {
  const url = `${TERRARIUM_BASE}/${zoom}/${x}/${y}.png`;
  const response = await fetch(url, { mode: 'cors' });

  if (!response.ok) {
    throw new Error(`Failed to fetch elevation tile ${zoom}/${x}/${y}: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Unable to create elevation tile canvas context');
  }

  const image = await decodeTileImage(blob);
  context.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);

  return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

async function decodeTileImage(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode elevation tile image'));
    };

    image.src = url;
  });
}

export function applyExaggeration(elevations, exaggeration) {
  if (!Array.isArray(elevations) || elevations.length === 0) {
    return [];
  }

  const scale = Number.isFinite(exaggeration) ? exaggeration : 1;
  const minElevation = Math.min(...elevations);

  return elevations.map((elevation) => (elevation - minElevation) * scale);
}

export function smoothElevationProfile(elevations) {
  if (!Array.isArray(elevations) || elevations.length < 3) {
    return Array.isArray(elevations) ? [...elevations] : [];
  }

  const length = elevations.length;

  return elevations.map((elevation, index) => {
    const previous = elevations[(index - 1 + length) % length];
    const next = elevations[(index + 1) % length];
    const weightedAverage = (previous + elevation * 2 + next) / 4;

    return elevation + (weightedAverage - elevation) * SMOOTHING_BLEND;
  });
}

function normalizeLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
