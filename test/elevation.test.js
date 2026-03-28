import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure helper functions extracted for testing (replicated here to avoid DOM deps)

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
