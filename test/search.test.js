import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  buildTrackGeometryFromOverpassPayload,
  buildTrackSearchEntry,
  buildCycleFromEdges,
  buildLayoutsFromWays,
  buildVariantLayouts,
  buildWayGraph,
  detectForkSections,
  fetchTrackGeometry,
  normalizeTrackGeometryResult,
  normalizeSearchText,
  searchLocalTrackIndex,
  searchTracks,
  stitchWaysOrdered,
  tokenizeNormalizedText,
} from '../src/search.js';
import { getTrackGeometry } from '../src/geometry-index.js';
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

function makeIndexedTrack(record) {
  const entry = buildTrackSearchEntry(record);
  assert.ok(entry, `expected valid search entry for ${record.wikidataId}`);
  return entry;
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

test('normalizeSearchText removes diacritics and punctuation for search', () => {
  assert.equal(
    normalizeSearchText('  Autodromo Hermanos-Rodriguez, Mexico City  '),
    'autodromo hermanos rodriguez mexico city',
  );
  assert.equal(normalizeSearchText('Circuit de Spa-Francorchamps'), 'circuit de spa francorchamps');
});

test('tokenizeNormalizedText splits normalized phrases into deduped tokens', () => {
  assert.deepEqual(
    tokenizeNormalizedText('mexico city mexico'),
    ['mexico', 'city'],
  );
});

test('buildTrackSearchEntry keeps normalized label alias city and country material', () => {
  const entry = makeIndexedTrack({
    wikidataId: 'Q173099',
    label: 'Autodromo Hermanos Rodriguez',
    aliases: ['Rodriguez Brothers Autodrome'],
    wikidataShortName: 'Mexico GP',
    description: 'motorsport track in Mexico',
    type: 'motorsport racing track',
    country: 'Mexico',
    city: 'Mexico City',
    lat: 19.4042,
    lon: -99.0907,
  });

  assert.equal(entry.normalized.label, 'autodromo hermanos rodriguez');
  assert.deepEqual(entry.normalized.aliases, ['rodriguez brothers autodrome']);
  assert.equal(entry.normalized.shortName, 'mexico gp');
  assert.equal(entry.normalized.city, 'mexico city');
  assert.equal(entry.normalized.country, 'mexico');
  assert.ok(entry.tokens.includes('mexico'));
  assert.ok(entry.tokens.includes('city'));
  assert.ok(entry.phrases.includes('mexico city'));
});

test('searchLocalTrackIndex prefers direct venue-name matches over layout-like variants', () => {
  const index = [
    makeIndexedTrack({
      wikidataId: 'QTRACK',
      label: 'Circuit de Spa-Francorchamps',
      aliases: ['Spa'],
      description: 'motorsport racing track in Belgium',
      type: 'motorsport racing track',
      country: 'Belgium',
      city: 'Stavelot',
      lat: 50.4372,
      lon: 5.9714,
    }),
    makeIndexedTrack({
      wikidataId: 'QLAYOUT',
      label: 'Spa-Francorchamps 2021 Grand Prix layout',
      aliases: ['Spa GP layout'],
      description: 'Grand Prix layout',
      type: 'motorsport racing track',
      country: 'Belgium',
      city: 'Stavelot',
      lat: 50.4370,
      lon: 5.9720,
    }),
  ];

  const results = searchLocalTrackIndex('spa', index);

  assert.equal(results.length, 2);
  assert.equal(results[0].wikidataId, 'QTRACK');
  assert.equal(results[0].matchCategory, 'exact-alias');
  assert.ok(results[0].rankScore > results[1].rankScore);
});

test('searchLocalTrackIndex uses city and country phrases for recall', () => {
  const index = [
    makeIndexedTrack({
      wikidataId: 'QMEXICO',
      label: 'Autodromo Hermanos Rodriguez',
      aliases: ['Rodriguez Brothers Autodrome'],
      description: 'motorsport track in Mexico',
      type: 'motorsport racing track',
      country: 'Mexico',
      city: 'Mexico City',
      lat: 19.4042,
      lon: -99.0907,
    }),
    makeIndexedTrack({
      wikidataId: 'QMONZA',
      label: 'Autodromo Nazionale Monza',
      aliases: ['Monza Circuit'],
      description: 'motorsport track in Italy',
      type: 'motorsport racing track',
      country: 'Italy',
      city: 'Monza',
      lat: 45.6156,
      lon: 9.2811,
    }),
  ];

  const cityResults = searchLocalTrackIndex('mexico city', index);
  const countryResults = searchLocalTrackIndex('mexico', index);

  assert.equal(cityResults[0].wikidataId, 'QMEXICO');
  assert.equal(cityResults[0].matchCategory, 'exact-city');
  assert.equal(countryResults[0].wikidataId, 'QMEXICO');
  assert.equal(countryResults[0].displayName, 'Autodromo Hermanos Rodriguez - Mexico City, Mexico');
});

test('searchLocalTrackIndex promotes short names, city venue matches, and street-circuit ties for current F1 venues', () => {
  const index = [
    makeIndexedTrack({
      wikidataId: 'QSHANGHAI',
      label: 'Shanghai International Circuit',
      aliases: [],
      wikidataShortName: 'Shanghai',
      description: 'motorsport racing track in China',
      type: 'motorsport racing track',
      country: 'People\'s Republic of China',
      city: 'Jiading',
      lat: 31.3389,
      lon: 121.2197,
    }),
    makeIndexedTrack({
      wikidataId: 'QSHANGHAI_STREET',
      label: 'Shanghai Street Circuit',
      aliases: [],
      description: 'street circuit in China',
      type: 'street circuit',
      country: 'People\'s Republic of China',
      city: null,
      lat: 31.23,
      lon: 121.47,
    }),
    makeIndexedTrack({
      wikidataId: 'QBARCELONA',
      label: 'Circuit de Barcelona-Catalunya',
      aliases: ['Circuit de Barcelona'],
      wikidataShortName: 'Barcelona-Catalunya',
      description: 'motorsport racing track in Spain',
      type: 'motorsport racing track',
      country: 'Spain',
      city: 'Montmelo',
      lat: 41.57,
      lon: 2.261,
    }),
    makeIndexedTrack({
      wikidataId: 'QMONTJUIC',
      label: 'Montjuic circuit',
      aliases: [],
      description: 'street circuit in Spain',
      type: 'street circuit',
      country: 'Spain',
      city: 'Barcelona',
      lat: 41.36,
      lon: 2.15,
    }),
    makeIndexedTrack({
      wikidataId: 'QAUSTIN_F1',
      label: 'Circuit of the Americas',
      aliases: ['COTA'],
      description: 'motorsport racing track in the United States',
      type: 'motorsport racing track',
      country: 'United States',
      city: 'Austin',
      lat: 30.1328,
      lon: -97.6411,
    }),
    makeIndexedTrack({
      wikidataId: 'QDRIVEWAY',
      label: 'Driveway Austin',
      aliases: ['The Driveway'],
      description: 'motorsport racing track in the United States',
      type: 'motorsport racing track',
      country: 'United States',
      city: 'Austin',
      lat: 30.37,
      lon: -97.72,
    }),
    makeIndexedTrack({
      wikidataId: 'QLV_STRIP',
      label: 'Las Vegas Strip Circuit',
      aliases: [],
      description: 'street circuit in the United States',
      type: 'street circuit',
      country: 'United States',
      city: 'Paradise',
      lat: 36.1162,
      lon: -115.1741,
    }),
    makeIndexedTrack({
      wikidataId: 'QLV_PARK',
      label: 'Las Vegas Park Speedway',
      aliases: [],
      description: 'motorsport racing track in the United States',
      type: 'motorsport racing track',
      country: 'United States',
      city: 'Nevada',
      lat: 36.17,
      lon: -115.14,
    }),
  ];

  assert.equal(searchLocalTrackIndex('Shanghai', index)[0].wikidataId, 'QSHANGHAI');
  assert.equal(searchLocalTrackIndex('Barcelona', index)[0].wikidataId, 'QBARCELONA');
  assert.equal(searchLocalTrackIndex('Austin', index)[0].wikidataId, 'QAUSTIN_F1');
  assert.equal(searchLocalTrackIndex('Las Vegas', index)[0].wikidataId, 'QLV_STRIP');
});

test('searchTracks uses the shipped local search index and returns compatible fields', async () => {
  const results = await searchTracks('monaco');

  assert.ok(results.length >= 1);
  assert.equal(typeof results[0].name, 'string');
  assert.equal(typeof results[0].displayName, 'string');
  assert.equal(typeof results[0].wikidataId, 'string');
  assert.equal(typeof results[0].lat, 'number');
  assert.equal(typeof results[0].lon, 'number');
});

test('getTrackGeometry lazily loads and caches the prebuilt supported track layouts', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    if (url === '/generated/geometry/Q171402.json') {
      return {
        ok: true,
        async json() {
          return {
            trackId: 'Q171402',
            name: 'Silverstone Circuit',
            source: { kind: 'prebuilt' },
            layouts: [
              {
                name: 'Main',
                nodes: [
                  { lat: 1, lon: 2 },
                  { lat: 3, lon: 4 },
                  { lat: 5, lon: 6 },
                  { lat: 1, lon: 2 },
                ],
                stats: { lengthMetres: 1000, segmentCount: 1, variantSectionCount: 0 },
              },
              {
                name: 'Alternate',
                nodes: [
                  { lat: 5, lon: 6 },
                  { lat: 7, lon: 8 },
                  { lat: 9, lon: 10 },
                  { lat: 5, lon: 6 },
                ],
                stats: { lengthMetres: 1100, segmentCount: 1, variantSectionCount: 0 },
              },
            ],
          };
        },
      };
    }

    return { ok: false, status: 404 };
  };

  try {
    const result = await getTrackGeometry('Q171402');

    assert.ok(result);
    assert.equal(result.trackId, 'Q171402');
    assert.equal(result.name, 'Silverstone Circuit');
    assertLayoutNames(result.layouts, ['Main', 'Alternate']);
    result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
    assert.equal(calls.length, 1);

    const cached = await getTrackGeometry('Q171402');
    assert.equal(cached?.trackId, 'Q171402');
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getTrackGeometry returns null when the per-track file is missing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });

  try {
    assert.equal(await getTrackGeometry('QDOES_NOT_EXIST'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchTrackGeometry uses lazy-loaded local geometry when a known wikidata id is available', async () => {
  const originalFetch = globalThis.fetch;
  const localGeometryResponse = {
    ok: true,
    async json() {
      return {
        trackId: 'Q172851',
        name: 'Circuit de Spa-Francorchamps',
        source: { kind: 'prebuilt' },
        layouts: [
          {
            name: 'Main',
            nodes: [
              { lat: 1, lon: 2 },
              { lat: 3, lon: 4 },
              { lat: 5, lon: 6 },
              { lat: 1, lon: 2 },
            ],
            stats: { lengthMetres: 1000, segmentCount: 1, variantSectionCount: 0 },
          },
          {
            name: 'Alternate',
            nodes: [
              { lat: 5, lon: 6 },
              { lat: 7, lon: 8 },
              { lat: 9, lon: 10 },
              { lat: 5, lon: 6 },
            ],
            stats: { lengthMetres: 1100, segmentCount: 1, variantSectionCount: 0 },
          },
        ],
      };
    },
  };

  globalThis.fetch = async url => {
    if (url === '/generated/geometry/Q172851.json') {
      return localGeometryResponse;
    }

    throw new Error(`fetch should not run for ${url}`);
  };

  try {
    const result = await fetchTrackGeometry(Number.NaN, Number.NaN, undefined, 'Circuit de Spa-Francorchamps', {
      wikidataId: 'Q172851',
    });

    assert.equal(result.trackId, 'Q172851');
    assertLayoutNames(result.layouts, ['Main', 'Alternate']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('build-only geometry cleanup is not applied to runtime payload parsing by default', () => {
  const payload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Synthetic Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0, 0), n(0, 0.01), n(0.01, 0.01), n(0, 0.01), n(0.01, 0), n(0, 0)],
      },
    ],
  };

  const runtimeResult = buildTrackGeometryFromOverpassPayload(payload, 'Synthetic Circuit');
  const buildResult = normalizeTrackGeometryResult(runtimeResult, 'Synthetic Circuit');

  assert.ok(runtimeResult);
  assert.ok(buildResult);
  assert.equal(runtimeResult.layouts.length, 1);
  assert.equal(buildResult.layouts.length, 1);
  assert.equal(runtimeResult.layouts[0].nodes.length, 6);
  assert.equal(buildResult.layouts[0].nodes.length, 4);
  assert.deepEqual(runtimeResult.layouts[0].nodes[2], n(0.01, 0.01));
  assert.deepEqual(buildResult.layouts[0].nodes, [n(0, 0), n(0, 0.01), n(0.01, 0), n(0, 0)]);
});

test('fetchTrackGeometry leaves Silverstone fixture cleanup to the build path', async () => {
  const fixture = loadFixture('silverstone.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.0786, -1.0169, undefined, 'Silverstone Circuit'));
  const normalized = normalizeTrackGeometryResult(result, 'Silverstone Circuit');

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Main', 'Alternate']);
  expectDistinctLayouts(result.layouts[0], result.layouts[1]);
  assertLayoutNames(normalized.layouts, ['Main', 'Alternate']);
  normalized.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  assert.ok(result.layouts.some((layout, index) => JSON.stringify(layout.nodes) !== JSON.stringify(normalized.layouts[index]?.nodes)));
});

test('buildTrackGeometryFromOverpassPayload prefers a large near-closed unnamed circuit over a small open named fragment', () => {
  // Regression for Albert Park (Q171288): a short section of track is named
  // "Albert Park Circuit" in OSM, but the full public-road loop carries street names.
  // The named fragment is open (high endpoint gap); the full loop is near-closed.
  // The fix ensures near-closed + much longer wins over open + name match.

  // Component A: ~2 km open arc, named "Albert Park Circuit"
  const payload = {
    elements: [
      {
        type: 'way', id: 1,
        tags: { name: 'Albert Park Circuit', highway: 'raceway' },
        geometry: [n(0, 0), n(0.009, 0.005), n(0.018, 0)],
      },
      {
        type: 'way', id: 2,
        tags: { name: 'Albert Park Circuit', highway: 'raceway' },
        geometry: [n(0.018, 0), n(0.015, -0.004)],
      },
      // Component B: ~4.9 km closed loop, roads named after local streets
      {
        type: 'way', id: 3,
        tags: { name: 'Aughtie Drive', highway: 'raceway' },
        geometry: [n(0.1, 0.1), n(0.1, 0.111)],
      },
      {
        type: 'way', id: 4,
        tags: { name: 'Albert Road Drive', highway: 'raceway' },
        geometry: [n(0.1, 0.111), n(0.111, 0.111)],
      },
      {
        type: 'way', id: 5,
        tags: { name: 'Ross Gregory Drive', highway: 'raceway' },
        geometry: [n(0.111, 0.111), n(0.111, 0.1)],
      },
      {
        type: 'way', id: 6,
        tags: { name: 'Lakeside Drive', highway: 'raceway' },
        geometry: [n(0.111, 0.1), n(0.1, 0.1)],
      },
    ],
  };

  const result = buildTrackGeometryFromOverpassPayload(payload, 'Albert Park Circuit');

  assert.ok(result !== null, 'should return a result');
  assert.ok(result.layouts.length > 0, 'should have at least one layout');
  assert.ok(
    result.layouts[0].stats.lengthMetres > 4000,
    `expected the large near-closed loop (>4000 m) but got ${result.layouts[0].stats.lengthMetres.toFixed(0)} m — named open fragment should not win`,
  );
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
  assertLayoutNames(result.layouts, ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 1 }));
  for (let index = 0; index < result.layouts.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < result.layouts.length; otherIndex += 1) {
      expectDistinctLayouts(result.layouts[index], result.layouts[otherIndex]);
    }
  }
});

test('fetchTrackGeometry resolves Brands Hatch to the grand prix and indy layouts', async () => {
  const fixture = loadFixture('brands-hatch.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(51.3562, 0.2631, undefined, 'Brands Hatch'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Brands Hatch Grand Prix', 'Brands Hatch Indy']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  expectDistinctLayouts(result.layouts[0], result.layouts[1]);
  expectApproxLength(result.layouts[0].nodes, 3.9, 0.3);
  expectApproxLength(result.layouts[1].nodes, 1.9, 0.2);
});

test('fetchTrackGeometry restores Mexico City grand prix geometry from frozen fixture data', async () => {
  const fixture = loadFixture('mexico-city.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(19.4042, -99.0907, undefined, 'Autódromo Hermanos Rodríguez'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Mexican Grand Prix', 'Mexico City E-Prix']);
  assertLayoutInvariants(result.layouts[0], { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0].nodes, 4.3, 0.4);
  assert.ok(result.osmVenueNames.includes('Autódromo Hermanos Rodríguez'));
  assert.ok(result.osmVenueNames.includes('Mexican Grand Prix'));
});

test('fetchTrackGeometry avoids Monaco mini-loops and keeps the full street circuit', async () => {
  const fixture = loadFixture('monaco.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(43.7347, 7.4206, undefined, 'Circuit de Monaco'));

  assert.equal(result.selectedLayoutIndex, 0);
  assert.equal(result.layouts[0].name, 'Main');
  assertLayoutInvariants(result.layouts[0], { maxGapMeters: 400 });
  expectApproxLength(result.layouts[0].nodes, 3.3, 0.3);
});

test('fetchTrackGeometry keeps the current Monza road course from frozen fixture data', async () => {
  const fixture = loadFixture('monza.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(45.6213, 9.2812, undefined, 'Autodromo Nazionale Monza'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutInvariants(result.layouts[0], { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0].nodes, 5.8, 0.3);
});

test('fetchTrackGeometry keeps the current Zandvoort grand prix circuit from frozen fixture data', async () => {
  const fixture = loadFixture('zandvoort.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.3888, 4.5409, undefined, 'Circuit Zandvoort'));

  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutInvariants(result.layouts[0], { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0].nodes, 4.3, 0.3);
  assert.ok(/Grand Prix|Circuit Zandvoort|Main/.test(result.layouts[0].name));
});

test('named-circuit detection distinguishes Bahrain standalone layouts from Spa branch alternates', async () => {
  const bahrain = loadFixture('bahrain.json');
  const spa = loadFixture('spa.json');

  const bahrainResult = await withMockedFetch(bahrain, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));
  const spaResult = await withMockedFetch(spa, () =>
    fetchTrackGeometry(50.4372, 5.9714, undefined, 'Circuit de Spa-Francorchamps'));

  assertLayoutNames(bahrainResult.layouts, ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']);
  assertLayoutNames(spaResult.layouts, ['Main', 'Moto']);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Grand Prix Circuit')?.stats.variantSectionCount, 0);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Endurance Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Outer Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Inner Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Paddock Layout')?.stats.variantSectionCount, 1);
  assert.equal(spaResult.layouts[0].stats.variantSectionCount, 0);
  assert.equal(spaResult.layouts[1].stats.variantSectionCount, 1);
});

test('Bahrain named layouts keep distinct approximate circuit lengths', async () => {
  const fixture = loadFixture('bahrain.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  const byName = new Map(result.layouts.map(layout => [layout.name, layout]));
  expectApproxLength(byName.get('Grand Prix Circuit').nodes, 5.4, 0.2);
  expectApproxLength(byName.get('Endurance Circuit').nodes, 6.3, 0.2);
  expectApproxLength(byName.get('Paddock Layout').nodes, 3.8, 0.2);
  expectApproxLength(byName.get('Outer Circuit').nodes, 3.5, 0.2);
  expectApproxLength(byName.get('Inner Circuit').nodes, 2.55, 0.15);
  assert.equal(byName.has('Test Oval'), false);
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

  assert.equal(result.layouts.length, 4);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit').length, 1);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit Alternate').length, 0);
});

test('multi-layout fixtures keep their expected layout counts', async () => {
  const cases = [
    ['brands-hatch.json', 51.3562, 0.2631, 'Brands Hatch', ['Brands Hatch Grand Prix', 'Brands Hatch Indy']],
    ['silverstone.json', 52.0786, -1.0169, 'Silverstone Circuit', ['Main', 'Alternate']],
    ['spa.json', 50.4372, 5.9714, 'Circuit de Spa-Francorchamps', ['Main', 'Moto']],
    ['bahrain.json', 26.0325, 50.5106, 'Bahrain International Circuit', ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']],
    ['mexico-city.json', 19.4042, -99.0907, 'Autódromo Hermanos Rodríguez', ['Mexican Grand Prix', 'Mexico City E-Prix']],
  ];

  for (const [fixtureName, lat, lon, trackName, expectedNames] of cases) {
    const fixture = loadFixture(fixtureName);
    const result = await withMockedFetch(fixture, () => fetchTrackGeometry(lat, lon, undefined, trackName));

    assertLayoutNames(result.layouts, expectedNames);
  }
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

    assert.equal(calls.length, 3);
    assert.match(calls[0], /overpass-api\.de/);
    assert.match(calls[1], /overpass\.kumi\.systems/);
    assert.match(calls[2], /overpass\.private\.coffee/);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.layouts[0].name, 'Main');
  });
});

test('fetchTrackGeometry compares successful Overpass responses and keeps the stronger geometry', async () => {
  const shortPayload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Endpoint Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0, 0), n(0, 0.02), n(0.02, 0), n(0, 0)],
      },
    ],
  };
  const longPayload = {
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { name: 'Endpoint Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0, 0), n(0, 0.02)],
      },
      {
        type: 'way',
        id: 2,
        tags: { name: 'Endpoint Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0, 0.02), n(0.02, 0.02)],
      },
      {
        type: 'way',
        id: 3,
        tags: { name: 'Endpoint Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0.02, 0.02), n(0.02, 0)],
      },
      {
        type: 'way',
        id: 4,
        tags: { name: 'Endpoint Circuit', highway: 'raceway', sport: 'motor' },
        geometry: [n(0.02, 0), n(0, 0)],
      },
    ],
  };
  const payloads = [shortPayload, longPayload, shortPayload];
  let callIndex = 0;

  await withFetchMock(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json() {
      return payloads[callIndex++] ?? shortPayload;
    },
  }), async () => {
    const result = await fetchTrackGeometry(0, 0, undefined, 'Endpoint Circuit');

    assert.equal(result.layouts.length, 1);
    assert.ok(result.layouts[0].stats.lengthMetres > 8000);
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
