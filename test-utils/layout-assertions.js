import assert from 'node:assert/strict';

const toRadians = value => (value * Math.PI) / 180;

function measureDistanceMetres(a, b) {
  const avgLat = toRadians((a.lat + b.lat) / 2);
  const dx = (b.lon - a.lon) * Math.cos(avgLat) * 111320;
  const dy = (b.lat - a.lat) * 111320;
  return Math.hypot(dx, dy);
}

function measurePolylineLength(nodes) {
  let length = 0;

  for (let index = 1; index < nodes.length; index += 1) {
    length += measureDistanceMetres(nodes[index - 1], nodes[index]);
  }

  return length;
}

function baseChain(nodes) {
  if (nodes.length > 1) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first.lat === last.lat && first.lon === last.lon) {
      return nodes.slice(0, -1);
    }
  }

  return nodes;
}

function sampleChain(nodes, sampleCount = 24) {
  const chain = baseChain(nodes);
  if (chain.length <= sampleCount) {
    return chain;
  }

  return Array.from({ length: sampleCount }, (_, index) => {
    const sampleIndex = Math.floor((index * chain.length) / sampleCount);
    return chain[sampleIndex];
  });
}

function areNearIdenticalChains(a, b, maxNodeDistanceMeters = 35, maxLengthDeltaMeters = 250) {
  const lengthA = measurePolylineLength(a);
  const lengthB = measurePolylineLength(b);

  if (Math.abs(lengthA - lengthB) > maxLengthDeltaMeters) {
    return false;
  }

  const samplesA = sampleChain(a);
  const samplesB = sampleChain(b);
  const hasCloseMatch = (node, otherSamples) => otherSamples.some(other => measureDistanceMetres(node, other) <= maxNodeDistanceMeters);

  return samplesA.every(node => hasCloseMatch(node, samplesB))
    && samplesB.every(node => hasCloseMatch(node, samplesA));
}

export function expectNoImmediateBacktrack(nodes) {
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const prev = nodes[index - 1];
    const current = nodes[index];
    const next = nodes[index + 1];
    const lenA = measureDistanceMetres(prev, current);
    const lenB = measureDistanceMetres(current, next);

    if (lenA < 0.01 || lenB < 0.01) {
      continue;
    }

    const d1x = current.lon - prev.lon;
    const d1y = current.lat - prev.lat;
    const d2x = next.lon - current.lon;
    const d2y = next.lat - current.lat;
    const dot = (d1x * d2x + d1y * d2y) / (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y));
    const returnGap = measureDistanceMetres(prev, next);

    assert.ok(
      !(dot < -0.98 && returnGap <= Math.max(lenA, lenB) * 0.25),
      `found immediate backtrack near node ${index}`,
    );
  }
}

export function expectClosedish(nodes, maxGapMeters) {
  assert.ok(nodes.length >= 2, 'layout should have at least two nodes');
  const gap = measureDistanceMetres(nodes[0], nodes[nodes.length - 1]);
  assert.ok(gap <= maxGapMeters, `endpoint gap ${gap.toFixed(1)}m exceeds ${maxGapMeters}m`);
}

export function expectDistinctLayouts(a, b) {
  assert.ok(!areNearIdenticalChains(a.nodes ?? a, b.nodes ?? b), 'layouts should not be identical');
}

export function expectApproxLength(nodes, expectedKm, toleranceKm) {
  const lengthKm = measurePolylineLength(nodes) / 1000;
  assert.ok(
    Math.abs(lengthKm - expectedKm) <= toleranceKm,
    `expected length near ${expectedKm}km (+/- ${toleranceKm}km), got ${lengthKm.toFixed(3)}km`,
  );
}

export function expectNoDuplicateSequentialNodes(nodes) {
  for (let index = 1; index < nodes.length; index += 1) {
    const prev = nodes[index - 1];
    const current = nodes[index];
    assert.ok(
      !(prev.lat === current.lat && prev.lon === current.lon),
      `duplicate sequential nodes at index ${index - 1} and ${index}`,
    );
  }
}
