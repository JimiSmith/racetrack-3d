import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyExaggeration,
  buildElevationProfile,
  fetchElevations,
  smoothElevationProfile,
} from '../src/elevation.js';

function latLonToTileXY(lat, lon, zoom) {
  const n = 2 ** zoom;
  const lonFraction = (lon + 180) / 360;
  const latRadians = (lat * Math.PI) / 180;
  const x = Math.floor(lonFraction * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.min(Math.max(x, 0), n - 1),
    y: Math.min(Math.max(y, 0), n - 1),
  };
}

function tilePixelCoords(lat, lon, zoom, tileSize = 256) {
  const n = 2 ** zoom;
  const xFraction = ((lon + 180) / 360) * n;
  const latRadians = (lat * Math.PI) / 180;
  const yFraction = ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * n;
  const px = Math.min(tileSize - 1, Math.floor((xFraction - Math.floor(xFraction)) * tileSize));
  const py = Math.min(tileSize - 1, Math.floor((yFraction - Math.floor(yFraction)) * tileSize));
  return { px, py };
}

function terrariumDecode(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

function maxAdjacentDelta(values) {
  let maxDelta = 0;

  for (let index = 0; index < values.length; index += 1) {
    const nextIndex = (index + 1) % values.length;
    maxDelta = Math.max(maxDelta, Math.abs(values[index] - values[nextIndex]));
  }

  return maxDelta;
}

// --- Tests ---

test('latLonToTileXY returns expected tile for Spa at zoom 13', () => {
  // Spa-Francorchamps: 50.4372, 5.9714
  const { x, y } = latLonToTileXY(50.4372, 5.9714, 13);
  // Values computed from the formula: x=4231, y=2762
  assert.ok(x >= 4229 && x <= 4233, `x=${x} out of expected range`);
  assert.ok(y >= 2760 && y <= 2764, `y=${y} out of expected range`);
});

test('latLonToTileXY returns expected tile for Bahrain at zoom 13', () => {
  const { x, y } = latLonToTileXY(26.0325, 50.5106, 13);
  // Values computed from the formula: x=5245, y=3482
  assert.ok(x >= 5243 && x <= 5247, `x=${x} out of expected range`);
  assert.ok(y >= 3480 && y <= 3484, `y=${y} out of expected range`);
});

test('latLonToTileXY handles negative lat/lon (Interlagos)', () => {
  const { x, y } = latLonToTileXY(-23.7036, -46.6997, 13);
  assert.ok(x >= 0, 'x should be non-negative');
  assert.ok(y >= 0, 'y should be non-negative');
  assert.ok(x < 2 ** 13, 'x should be within zoom bounds');
  assert.ok(y < 2 ** 13, 'y should be within zoom bounds');
});

test('tilePixelCoords returns values within tile bounds', () => {
  const { px, py } = tilePixelCoords(50.4372, 5.9714, 13);
  assert.ok(px >= 0 && px < 256, `px=${px} out of range`);
  assert.ok(py >= 0 && py < 256, `py=${py} out of range`);
});

test('terrariumDecode: all zeros → -32768m (ocean floor reference)', () => {
  assert.equal(terrariumDecode(0, 0, 0), -32768);
});

test('terrariumDecode: R=128 G=0 B=0 → (128*256) - 32768 = 0m', () => {
  const result = terrariumDecode(128, 0, 0);
  assert.ok(Math.abs(result - 0) < 0.01, `Expected ~0, got ${result}`);
});

test('terrariumDecode: R=128 G=0 B=128 → 0.5m above reference', () => {
  const result = terrariumDecode(128, 0, 128);
  assert.ok(Math.abs(result - 0.5) < 0.01, `Expected ~0.5, got ${result}`);
});

test('terrariumDecode: known Spa elevation (~400m)', () => {
  // Spa is at ~400m. At 400m: (R*256 + G + B/256) = 400+32768 = 33168
  // R=129, G=144, B=0 → 129*256 + 144 = 33168 → 33168-32768 = 400
  const result = terrariumDecode(129, 144, 0);
  assert.ok(Math.abs(result - 400) < 1, `Expected ~400m, got ${result}`);
});

test('latLonToTileXY: same point returns same tile on repeated calls', () => {
  const a = latLonToTileXY(43.7338, 7.4211, 13); // Monaco
  const b = latLonToTileXY(43.7338, 7.4211, 13);
  assert.deepEqual(a, b);
});

test('latLonToTileXY: different circuits fall in different tiles at zoom 13', () => {
  const spa = latLonToTileXY(50.4372, 5.9714, 13);
  const monaco = latLonToTileXY(43.7338, 7.4211, 13);
  assert.ok(spa.x !== monaco.x || spa.y !== monaco.y, 'Spa and Monaco should be in different tiles');
});

test('buildElevationProfile smooths after exaggeration instead of before it', () => {
  const raw = [10, 10, 14, 10, 10];
  const exaggeration = 5;

  const exaggeratedThenSmoothed = smoothElevationProfile(applyExaggeration(raw, exaggeration));
  const smoothedThenExaggerated = applyExaggeration(smoothElevationProfile(raw), exaggeration);

  assert.deepEqual(buildElevationProfile(raw, exaggeration), exaggeratedThenSmoothed);
  assert.notDeepEqual(buildElevationProfile(raw, exaggeration), smoothedThenExaggerated);
});

test('smoothElevationProfile reduces sharp step changes conservatively', () => {
  const stepped = [0, 0, 0, 60, 60, 60];
  const smoothed = smoothElevationProfile(stepped);

  assert.ok(maxAdjacentDelta(smoothed) < maxAdjacentDelta(stepped));
  assert.equal(smoothed[0], 5.25);
  assert.equal(smoothed[3], 54.75);
  assert.equal(smoothed[4], 60);
});

test('smoothElevationProfile keeps flat elevation flat', () => {
  assert.deepEqual(smoothElevationProfile([12, 12, 12, 12]), [12, 12, 12, 12]);
  assert.deepEqual(buildElevationProfile([42, 42, 42, 42], 7), [0, 0, 0, 0]);
});

test('smoothElevationProfile wraps around loop ends', () => {
  const loop = [40, 0, 0, 0];
  const smoothed = smoothElevationProfile(loop);

  assert.equal(smoothed[0], 33);
  assert.equal(smoothed[3], 3.5);
  assert.ok(smoothed[3] > 0, 'expected wrap-around smoothing at the loop seam');
});

test('fetchElevations returns a hardcoded flat profile for 0x exaggeration', async () => {
  const profile = await fetchElevations([
    { lat: 50.4372, lon: 5.9714 },
    { lat: 50.4373, lon: 5.9715 },
    { lat: 50.4374, lon: 5.9716 },
  ], 0);

  assert.deepEqual(profile, [1, 1, 1]);
});
