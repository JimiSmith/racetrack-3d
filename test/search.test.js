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
  layouts.forEach(assertClosedLayout);
});

test('buildLayoutsFromWays keeps the same two fork-based layouts for a Spa-style fixture', () => {
  const fixture = loadFixture('spa.json');
  const ways = fixture.elements.map(element => ({
    id: element.id,
    tags: element.tags,
    nodes: element.geometry,
  }));

  const layouts = buildLayoutsFromWays(ways, 'Circuit de Spa-Francorchamps');

  assertLayoutNames(layouts, ['Main', 'Moto']);
  layouts.forEach(assertClosedLayout);
});

test('fetchTrackGeometry keeps Silverstone branch layouts from a frozen fixture', async () => {
  const fixture = loadFixture('silverstone.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.0786, -1.0169, undefined, 'Silverstone Circuit'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Main', 'National Circuit']);
  result.layouts.forEach(assertClosedLayout);
});

test('fetchTrackGeometry returns named Bahrain layouts from frozen fixture data', async () => {
  const fixture = loadFixture('bahrain.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Endurance Circuit', 'Grand Prix Circuit', 'Inner Circuit']);
  result.layouts.forEach(assertClosedLayout);
});
