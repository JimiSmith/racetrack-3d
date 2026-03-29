import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  buildCycleFromEdges,
  buildLayoutsFromWays,
  buildVariantLayouts,
  buildWayGraph,
  detectForkSections,
  fetchTrackGeometry,
  stitchWaysOrdered,
} from '../src/search.js';
import {
  expectApproxLength,
  expectClosedish,
  expectDistinctLayouts,
  expectNoDuplicateSequentialNodes,
  expectNoImmediateBacktrack,
} from '../test-utils/layout-assertions.js';

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function assertLayoutNames(layouts, expectedNames) {
  assert.deepEqual(layouts.map(layout => layout.name), expectedNames);
}

function assertClosedLayout(layout) {
  assert.ok(layout.nodes.length >= 4, `${layout.name} should have enough nodes`);
  assert.deepEqual(layout.nodes[0], layout.nodes[layout.nodes.length - 1], `${layout.name} should be closed`);
}

function assertLayoutInvariants(layout, { maxGapMeters = 15_000 } = {}) {
  assertClosedLayout(layout);
  expectClosedish(layout.nodes, maxGapMeters);
  expectNoDuplicateSequentialNodes(layout.nodes);
  expectNoImmediateBacktrack(layout.nodes);
}

function fixtureWays(name) {
  const fixture = loadFixture(name);
  return fixture.elements.map(element => ({
    id: element.id,
    tags: element.tags,
    nodes: element.geometry,
  }));
}

function renamedWays(ways, renameMap) {
  return ways.map(way => ({
    ...way,
    tags: {
      ...way.tags,
      name: renameMap[way.tags?.name] ?? way.tags?.name,
    },
  }));
}

function duplicateNamedWays(ways, sourceName, duplicateName, coordinateOffset = 0.000005) {
  const nextIdBase = Math.max(...ways.map(way => way.id)) + 1;
  const duplicates = ways
    .filter(way => way.tags?.name === sourceName)
    .map((way, index) => ({
      ...way,
      id: nextIdBase + index,
      tags: {
        ...way.tags,
        name: duplicateName,
      },
      nodes: way.nodes.map((node, nodeIndex) => ({
        lat: node.lat + (nodeIndex % 2 === 0 ? coordinateOffset : -coordinateOffset),
        lon: node.lon + (nodeIndex % 2 === 0 ? -coordinateOffset : coordinateOffset),
      })),
    }));

  return [...ways, ...duplicates];
}

function withMockedFetch(payload, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() {
      return payload;
    },
  });

  return Promise.resolve(callback()).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function withFetchMock(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  return Promise.resolve(callback()).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function n(lat, lon) {
  return { lat, lon };
}

function syntheticForkWays() {
  const a = n(0.0, 0.0);
  const b = n(0.0, 0.02);
  const c = n(0.02, 0.02);
  const d = n(0.02, 0.0);

  return [
    { id: 1, tags: { name: 'Test Circuit' }, nodes: [a, b] },
    { id: 2, tags: { name: 'Test Circuit' }, nodes: [b, n(0.01, 0.024), c] },
    { id: 3, tags: { name: 'Club' }, nodes: [b, n(0.01, 0.03), c] },
    { id: 4, tags: { name: 'Test Circuit' }, nodes: [c, d] },
    { id: 5, tags: { name: 'Test Circuit' }, nodes: [d, a] },
    { id: 6, tags: { name: 'Service Spur' }, nodes: [a, n(-0.006, -0.004)] },
  ];
}

test('stitchWaysOrdered joins out-of-order and reversed way segments', () => {
  const a = n(0, 0);
  const b = n(0, 0.01);
  const c = n(0.01, 0.01);
  const d = n(0.01, 0.02);

  const stitched = stitchWaysOrdered([
    { nodes: [c, d] },
    { nodes: [b, c] },
    { nodes: [b, a] },
  ]);

  assert.deepEqual(stitched, [a, b, c, d]);
});

test('buildCycleFromEdges returns an ordered closed cycle and rejects non-cycles', () => {
  const a = n(0, 0);
  const b = n(0, 0.02);
  const c = n(0.02, 0.02);
  const d = n(0.02, 0);
  const squareWays = [
    { nodes: [a, b] },
    { nodes: [c, d] },
    { nodes: [b, c] },
    { nodes: [d, a] },
  ];

  const squareGraph = buildWayGraph(squareWays);
  const cycle = buildCycleFromEdges(squareGraph, [2, 0, 3, 1]);

  assert.ok(cycle);
  assert.deepEqual(cycle.edgeIds, [2, 1, 3, 0]);
  assert.deepEqual(cycle.nodes[0], cycle.nodes[cycle.nodes.length - 1]);

  const nonCycleGraph = buildWayGraph([
    { nodes: [a, b] },
    { nodes: [b, c] },
    { nodes: [b, d] },
  ]);

  assert.equal(buildCycleFromEdges(nonCycleGraph, [0, 1, 2]), null);
});

test('detectForkSections finds backbone-aligned fork sections', () => {
  const ways = syntheticForkWays();
  const graph = buildWayGraph(ways);
  const sections = detectForkSections(graph, new Set([0, 1, 3, 4]));

  assert.equal(sections.length, 1);
  assert.deepEqual(new Set([sections[0].forkVertexId, sections[0].mergeVertexId]), new Set([graph.edges[1].start, graph.edges[1].end]));
  assert.equal(sections[0].branches.length, 2);
  assert.deepEqual(sections[0].branches[0].edgeIds, [1]);
  assert.equal(sections[0].branches[0].onBackbone, true);
  assert.deepEqual(sections[0].branches[1].edgeIds, [2]);
});

test('buildVariantLayouts creates main and alternate layouts from one fork section', () => {
  const ways = syntheticForkWays();
  const graph = buildWayGraph(ways);
  const backboneCycle = buildCycleFromEdges(graph, [0, 1, 3, 4]);
  const sections = detectForkSections(graph, new Set(backboneCycle.edgeIds));
  const layouts = buildVariantLayouts(ways, graph, sections, 'Test Circuit', backboneCycle);

  assertLayoutNames(layouts, ['Main', 'Club']);
  assert.equal(layouts[0].stats.variantSectionCount, 0);
  assert.equal(layouts[1].stats.variantSectionCount, 1);
  assert.ok(layouts[1].stats.lengthMetres > layouts[0].stats.lengthMetres);
  layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 1 }));
  expectDistinctLayouts(layouts[0], layouts[1]);
});

test('buildLayoutsFromWays keeps the same two fork-based layouts for a Spa-style fixture', () => {
  const ways = fixtureWays('spa.json');

  const layouts = buildLayoutsFromWays(ways, 'Circuit de Spa-Francorchamps');

  assertLayoutNames(layouts, ['Main', 'Moto']);
  layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  expectDistinctLayouts(layouts[0], layouts[1]);
});

test('fetchTrackGeometry keeps Silverstone branch layouts from a frozen fixture', async () => {
  const fixture = loadFixture('silverstone.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.0786, -1.0169, undefined, 'Silverstone Circuit'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Main', 'National Circuit']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  expectDistinctLayouts(result.layouts[0], result.layouts[1]);
});

test('fetchTrackGeometry prefers the named Shanghai circuit over a denser stray component', async () => {
  const fixture = loadFixture('shanghai.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(31.3389, 121.2197, undefined, 'Shanghai International Circuit'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Main']);
  assert.deepEqual(result.osmVenueNames, ['Shanghai International Circuit']);
  assertLayoutInvariants(result.layouts[0], { maxGapMeters: 1 });
  expectApproxLength(result.layouts[0].nodes, 5.5, 0.2);
  assert.ok(result.layouts[0].stats.lengthMetres > 5000);
});

test('fetchTrackGeometry returns named Bahrain layouts from frozen fixture data', async () => {
  const fixture = loadFixture('bahrain.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Endurance Circuit', 'Grand Prix Circuit', 'Inner Circuit']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 1 }));
  expectDistinctLayouts(result.layouts[0], result.layouts[1]);
  expectDistinctLayouts(result.layouts[0], result.layouts[2]);
  expectDistinctLayouts(result.layouts[1], result.layouts[2]);
});

test('named-circuit detection distinguishes Bahrain standalone layouts from Spa branch alternates', async () => {
  const bahrain = loadFixture('bahrain.json');
  const spa = loadFixture('spa.json');

  const [bahrainResult, spaResult] = await Promise.all([
    withMockedFetch(bahrain, () =>
      fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit')),
    withMockedFetch(spa, () =>
      fetchTrackGeometry(50.4372, 5.9714, undefined, 'Circuit de Spa-Francorchamps')),
  ]);

  assertLayoutNames(bahrainResult.layouts, ['Endurance Circuit', 'Grand Prix Circuit', 'Inner Circuit']);
  assertLayoutNames(spaResult.layouts, ['Main', 'Moto']);
  bahrainResult.layouts.forEach(layout => assert.equal(layout.stats.variantSectionCount, 0));
  assert.equal(spaResult.layouts[0].stats.variantSectionCount, 0);
  assert.equal(spaResult.layouts[1].stats.variantSectionCount, 1);
});

test('Bahrain named layouts keep distinct approximate circuit lengths', async () => {
  const fixture = loadFixture('bahrain.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  const byName = new Map(result.layouts.map(layout => [layout.name, layout]));
  expectApproxLength(byName.get('Grand Prix Circuit').nodes, 6.9, 0.2);
  expectApproxLength(byName.get('Inner Circuit').nodes, 4.5, 0.2);
  expectApproxLength(byName.get('Endurance Circuit').nodes, 8.8, 0.2);
});

test('Spa branch-only alternates are not promoted to standalone named circuits', async () => {
  const ways = renamedWays(fixtureWays('spa.json'), {
    Moto: 'Moto layout',
  });
  ways.push({
    id: 999001,
    tags: { name: 'Rallycross circuit' },
    nodes: [
      { lat: 50.432, lon: 5.965 },
      { lat: 50.4324, lon: 5.9654 },
      { lat: 50.4328, lon: 5.9659 },
    ],
  });
  const payload = {
    elements: ways.map(way => ({
      type: 'way',
      id: way.id,
      tags: way.tags,
      geometry: way.nodes,
    })),
  };

  const result = await withMockedFetch(payload, () =>
    fetchTrackGeometry(50.4372, 5.9714, undefined, 'Circuit de Spa-Francorchamps'));

  assertLayoutNames(result.layouts, ['Circuit de Spa-Francorchamps', 'Moto layout']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  assert.equal(result.layouts.some(layout => layout.name === 'Rallycross circuit'), false);
});

test('near-identical duplicate named layouts are filtered out', async () => {
  const ways = duplicateNamedWays(
    fixtureWays('bahrain.json'),
    'Grand Prix Circuit',
    'Grand Prix Circuit Alternate',
  );
  const payload = {
    elements: ways.map(way => ({
      type: 'way',
      id: way.id,
      tags: way.tags,
      geometry: way.nodes,
    })),
  };

  const result = await withMockedFetch(payload, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  assert.equal(result.layouts.length, 3);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit').length, 1);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit Alternate').length, 0);
});

test('fetchTrackGeometry throws a useful error when no raceways are found in the bbox', async () => {
  await withMockedFetch({ elements: [] }, async () => {
    await assert.rejects(
      fetchTrackGeometry(51.5, -0.1, undefined, 'Missing Circuit'),
      /No raceway found near Missing Circuit/,
    );
  });
});

test('fetchTrackGeometry throws when coordinates are not finite', async () => {
  await assert.rejects(
    fetchTrackGeometry(Number.NaN, Infinity, undefined, 'Broken Circuit'),
    /No coordinates available for this circuit/,
  );
});

test('fetchTrackGeometry falls back to the next Overpass endpoint when the first response is not JSON', async () => {
  const calls = [];
  const payload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Fallback Circuit' },
        geometry: [n(0, 0), n(0, 0.02), n(0.02, 0.02), n(0.02, 0), n(0, 0)],
      },
    ],
  };

  await withFetchMock(async url => {
    calls.push(url);
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return payload;
      },
    };
  }, async () => {
    const result = await fetchTrackGeometry(0, 0, undefined, 'Fallback Circuit');

    assert.equal(calls.length, 2);
    assert.match(calls[0], /overpass-api\.de/);
    assert.match(calls[1], /overpass\.kumi\.systems/);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.layouts[0].name, 'Main');
  });
});

test('fetchTrackGeometry excludes pit lane ways from the main circuit', async () => {
  const payload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Example Circuit' },
        geometry: [n(0, 0), n(0, 0.02)],
      },
      {
        type: 'way',
        id: 2,
        tags: { name: 'Example Circuit' },
        geometry: [n(0, 0.02), n(0.02, 0.02)],
      },
      {
        type: 'way',
        id: 3,
        tags: { name: 'Example Circuit' },
        geometry: [n(0.02, 0.02), n(0.02, 0)],
      },
      {
        type: 'way',
        id: 4,
        tags: { name: 'Example Circuit' },
        geometry: [n(0.02, 0), n(0, 0)],
      },
      {
        type: 'way',
        id: 5,
        tags: { name: 'Example Pit Lane' },
        geometry: [n(0, 0.02), n(-0.005, 0.025), n(0.005, 0.02)],
      },
    ],
  };

  await withMockedFetch(payload, async () => {
    const result = await fetchTrackGeometry(0, 0, undefined, 'Example Circuit');

    assert.equal(result.layouts.length, 1);
    assert.equal(result.layouts[0].stats.segmentCount, 4);
    result.layouts[0].nodes.forEach(node => {
      assert.notDeepEqual(node, n(-0.005, 0.025));
    });
  });
});

test('fetchTrackGeometry keeps National Pit Straight in the main circuit', async () => {
  const payload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Example Circuit' },
        geometry: [n(0, 0), n(0, 0.02)],
      },
      {
        type: 'way',
        id: 2,
        tags: { name: 'National Pit Straight' },
        geometry: [n(0, 0.02), n(0.02, 0.02)],
      },
      {
        type: 'way',
        id: 3,
        tags: { name: 'Example Circuit' },
        geometry: [n(0.02, 0.02), n(0.02, 0)],
      },
      {
        type: 'way',
        id: 4,
        tags: { name: 'Example Circuit' },
        geometry: [n(0.02, 0), n(0, 0)],
      },
    ],
  };

  await withMockedFetch(payload, async () => {
    const result = await fetchTrackGeometry(0, 0, undefined, 'Example Circuit');

    assert.equal(result.layouts.length, 1);
    assert.equal(result.layouts[0].stats.segmentCount, 4);
    assert.ok(result.layouts[0].nodes.some(node => node.lat === 0.02 && node.lon === 0.02));
  });
});
