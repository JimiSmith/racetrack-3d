import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  buildTrackSearchEntry,
  fetchTrackGeometry,
  normalizeSearchText,
  searchLocalTrackIndex,
  searchTracks,
  tokenizeNormalizedText,
} from '../src/search/index.js';
import { getTrackGeometry } from '../src/search/geometry-index.js';
import { buildWayGraph, buildCycleFromEdges } from '../src/geometry/way-graph.js';
import { stitchWaysOrdered } from '../src/geometry/way-stitching.js';
import { detectForkSections } from '../src/geometry/fork-detection.js';
import { buildVariantLayouts, buildLayoutsFromWays } from '../src/geometry/layout-builder.js';
import type { GeometryHints } from '../src/geometry/layout-builder.js';
import { normalizeTrackGeometryResult } from '../src/geometry/normalize.js';
import { buildTrackGeometryFromPayload } from '../src/geometry/track-geometry.js';
import { NAMED_LAYOUT_KEYWORD_PATTERN } from '../src/geometry/osm-elements.js';
import type { LatLonNode, Way } from '../src/types/geometry.js';

import {
  expectApproxLength,
  expectClosedish,
  expectDistinctLayouts,
  expectNoDuplicateSequentialNodes,
  expectNoImmediateBacktrack,
} from '../test-utils/layout-assertions.js';

/** Geometry hints matching TRACK_BUILD_OVERRIDES in build-track-geometry-index.mjs.
 *  SYNC: keep in sync with layoutLengthTargets in scripts/build-track-geometry-index.mjs */
const GEOMETRY_HINTS: Record<string, GeometryHints> = {
  'Bahrain International Circuit': {
    layoutLengthTargets: { 'inner': 2550, 'oval|test': 2500 },
  },
  'Red Bull Ring': {
    layoutLengthTargets: { 's[uü]dschleife|national': 2336 },
  },
};

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function assertLayoutNames(layouts: { name: string }[], expectedNames: string[]) {
  assert.deepEqual(layouts.map((layout: { name: string }) => layout.name), expectedNames);
}

function assertClosedLayout(layout: { name: string; nodes: LatLonNode[] }) {
  assert.ok(layout.nodes.length >= 4, `${layout.name} should have enough nodes`);
  assert.deepEqual(layout.nodes[0], layout.nodes[layout.nodes.length - 1], `${layout.name} should be closed`);
}

function assertLayoutInvariants(layout: { name: string; nodes: LatLonNode[] }, { maxGapMeters = 15_000 } = {}) {
  assertClosedLayout(layout);
  expectClosedish(layout.nodes, maxGapMeters);
  expectNoDuplicateSequentialNodes(layout.nodes);
  expectNoImmediateBacktrack(layout.nodes);
}

function fixtureWays(name: string): Way[] {
  const fixture = loadFixture(name);
  return fixture.elements.map((element: any) => ({
    id: element.id,
    tags: element.tags,
    nodes: element.geometry,
  }));
}

function renamedWays(ways: Way[], renameMap: Record<string, string>): Way[] {
  return ways.map((way: Way) => ({
    ...way,
    tags: {
      ...way.tags,
      name: renameMap[way.tags?.name as string] ?? way.tags?.name,
    },
  }));
}

function duplicateNamedWays(ways: Way[], sourceName: string, duplicateName: string, coordinateOffset = 0.000005): Way[] {
  const nextIdBase = Math.max(...ways.map((way: Way) => way.id)) + 1;
  const duplicates = ways
    .filter((way: Way) => way.tags?.name === sourceName)
    .map((way: Way, index: number) => ({
      ...way,
      id: nextIdBase + index,
      tags: {
        ...way.tags,
        name: duplicateName,
      },
      nodes: way.nodes.map((node: LatLonNode, nodeIndex: number) => ({
        lat: node.lat + (nodeIndex % 2 === 0 ? coordinateOffset : -coordinateOffset),
        lon: node.lon + (nodeIndex % 2 === 0 ? -coordinateOffset : coordinateOffset),
      })),
    }));

  return [...ways, ...duplicates];
}


function n(lat: number, lon: number): LatLonNode {
  return { lat, lon };
}

function makeIndexedTrack(record: Record<string, unknown>) {
  const entry = buildTrackSearchEntry(record as any);
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
  ] as Way[]);

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
  ] as Way[];

  const squareGraph = buildWayGraph(squareWays);
  const cycle = buildCycleFromEdges(squareGraph, [2, 0, 3, 1]);

  assert.ok(cycle);
  assert.deepEqual(cycle.edgeIds, [2, 1, 3, 0]);
  assert.deepEqual(cycle.nodes[0], cycle.nodes[cycle.nodes.length - 1]);

  const nonCycleGraph = buildWayGraph([
    { nodes: [a, b] },
    { nodes: [b, c] },
    { nodes: [b, d] },
  ] as Way[]);

  assert.equal(buildCycleFromEdges(nonCycleGraph, [0, 1, 2]), null);
});

test('detectForkSections finds backbone-aligned fork sections', () => {
  const ways = syntheticForkWays();
  const graph = buildWayGraph(ways);
  const sections = detectForkSections(graph, new Set([0, 1, 3, 4]));

  assert.equal(sections.length, 1);
  assert.deepEqual(new Set([sections[0]!.forkVertexId, sections[0]!.mergeVertexId]), new Set([graph.edges[1]!.start, graph.edges[1]!.end]));
  assert.equal(sections[0]!.branches.length, 2);
  assert.deepEqual(sections[0]!.branches[0]!.edgeIds, [1]);
  assert.equal(sections[0]!.branches[0]!.onBackbone, true);
  assert.deepEqual(sections[0]!.branches[1]!.edgeIds, [2]);
});

test('buildVariantLayouts creates main and alternate layouts from one fork section', () => {
  const ways = syntheticForkWays();
  const graph = buildWayGraph(ways);
  const backboneCycle = buildCycleFromEdges(graph, [0, 1, 3, 4]);
  const sections = detectForkSections(graph, new Set(backboneCycle!.edgeIds));
  const layouts = buildVariantLayouts(ways, graph, sections, 'Test Circuit', backboneCycle);

  assertLayoutNames(layouts, ['Main', 'Club']);
  assert.equal(layouts[0]!.stats.variantSectionCount, 0);
  assert.equal(layouts[1]!.stats.variantSectionCount, 1);
  assert.ok(layouts[1]!.stats.lengthMetres > layouts[0]!.stats.lengthMetres);
  layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 1 }));
  expectDistinctLayouts(layouts[0]!, layouts[1]!);
});

test('buildLayoutsFromWays keeps the same two fork-based layouts for a Spa-style fixture', () => {
  const ways = fixtureWays('spa.json');

  const layouts = buildLayoutsFromWays(ways, 'Circuit de Spa-Francorchamps');

  assertLayoutNames(layouts, ['Main', 'Moto']);
  layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  expectDistinctLayouts(layouts[0]!, layouts[1]!);
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
  assert.equal(results[0]!.wikidataId, 'QTRACK');
  assert.equal(results[0]!.matchCategory, 'exact-alias');
  assert.ok(results[0]!.rankScore > results[1]!.rankScore);
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

  assert.equal(cityResults[0]!.wikidataId, 'QMEXICO');
  assert.equal(cityResults[0]!.matchCategory, 'exact-city');
  assert.equal(countryResults[0]!.wikidataId, 'QMEXICO');
  assert.equal(countryResults[0]!.displayName, 'Autodromo Hermanos Rodriguez - Mexico City, Mexico');
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

  assert.equal(searchLocalTrackIndex('Shanghai', index)[0]!.wikidataId, 'QSHANGHAI');
  assert.equal(searchLocalTrackIndex('Barcelona', index)[0]!.wikidataId, 'QBARCELONA');
  assert.equal(searchLocalTrackIndex('Austin', index)[0]!.wikidataId, 'QAUSTIN_F1');
  assert.equal(searchLocalTrackIndex('Las Vegas', index)[0]!.wikidataId, 'QLV_STRIP');
});

test('searchTracks uses the shipped local search index and returns compatible fields', async () => {
  const results = await searchTracks('monaco');

  assert.ok(results.length >= 1);
  assert.equal(typeof results[0]!.name, 'string');
  assert.equal(typeof results[0]!.displayName, 'string');
  assert.equal(typeof results[0]!.wikidataId, 'string');
  assert.equal(typeof results[0]!.lat, 'number');
  assert.equal(typeof results[0]!.lon, 'number');
});

test('getTrackGeometry lazily loads and caches the prebuilt supported track layouts', async () => {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = (async (url: any) => {
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
  }) as unknown as typeof fetch;

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
  globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;

  try {
    assert.equal(await getTrackGeometry('QDOES_NOT_EXIST'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchTrackGeometry returns prebuilt local geometry when available', async () => {
  const prebuiltEntry = {
    trackId: 'Q172851',
    name: 'Circuit de Spa-Francorchamps',
    source: { kind: 'prebuilt' },
    layouts: [
      {
        name: 'Main',
        nodes: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 6 }, { lat: 1, lon: 2 }],
        stats: { lengthMetres: 1000, segmentCount: 1, variantSectionCount: 0 },
      },
      {
        name: 'Alternate',
        nodes: [{ lat: 5, lon: 6 }, { lat: 7, lon: 8 }, { lat: 9, lon: 10 }, { lat: 5, lon: 6 }],
        stats: { lengthMetres: 1100, segmentCount: 1, variantSectionCount: 0 },
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/generated/geometry/Q172851.json')) {
      return { ok: true, async json() { return prebuiltEntry; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const result = await fetchTrackGeometry('Circuit de Spa-Francorchamps', { wikidataId: 'Q172851' }) as any;
    assert.equal(result.trackId, 'Q172851');
    assertLayoutNames(result.layouts, ['Main', 'Alternate']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchTrackGeometry throws when no prebuilt geometry is available', async () => {
  await assert.rejects(
    fetchTrackGeometry('Unknown Circuit', { wikidataId: null }),
    /No prebuilt geometry available for Unknown Circuit/,
  );
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

  const runtimeResult = buildTrackGeometryFromPayload(payload, 'Synthetic Circuit');
  const buildResult = normalizeTrackGeometryResult(runtimeResult as any, 'Synthetic Circuit');

  assert.ok(runtimeResult);
  assert.ok(buildResult);
  assert.equal(runtimeResult.layouts.length, 1);
  assert.equal(buildResult!.layouts.length, 1);
  assert.equal(runtimeResult.layouts[0]!.nodes.length, 6);
  assert.equal(buildResult!.layouts[0]!.nodes.length, 4);
  assert.deepEqual(runtimeResult.layouts[0]!.nodes[2], n(0.01, 0.01));
  assert.deepEqual(buildResult!.layouts[0]!.nodes, [n(0, 0), n(0, 0.01), n(0.01, 0), n(0, 0)]);
});

test('buildTrackGeometryFromPayload produces named Silverstone layouts from high-overlap relations', () => {
  const fixture = loadFixture('silverstone.json');

  const result = buildTrackGeometryFromPayload(fixture, 'Silverstone Circuit');
  const normalized = normalizeTrackGeometryResult(result as any, 'Silverstone Circuit');

  assert.ok(result);
  assert.ok(normalized);
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Silverstone Grand Prix', 'Silverstone International']);
  expectDistinctLayouts(result.layouts[0]!, result.layouts[1]!);
  assertLayoutNames(normalized.layouts, ['Silverstone Grand Prix', 'Silverstone International']);
  normalized.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
});

test('buildTrackGeometryFromPayload prefers a large near-closed unnamed circuit over a small open named fragment', () => {
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

  const result = buildTrackGeometryFromPayload(payload, 'Albert Park Circuit');

  assert.ok(result !== null, 'should return a result');
  assert.ok(result!.layouts.length > 0, 'should have at least one layout');
  assert.ok(
    result!.layouts[0]!.stats.lengthMetres > 4000,
    `expected the large near-closed loop (>4000 m) but got ${result!.layouts[0]!.stats.lengthMetres.toFixed(0)} m — named open fragment should not win`,
  );
});

test('buildTrackGeometryFromPayload prefers the named Shanghai circuit over a denser stray component', () => {
  const fixture = loadFixture('shanghai.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Shanghai International Circuit')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Main']);
  assert.deepEqual(result.osmVenueNames, ['Shanghai International Circuit']);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 1 });
  expectApproxLength(result.layouts[0]!.nodes, 5.5, 0.2);
  assert.ok(result.layouts[0]!.stats.lengthMetres > 5000);
});

test('buildTrackGeometryFromPayload returns named Bahrain layouts from frozen fixture data', () => {
  const fixture = loadFixture('bahrain.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Bahrain International Circuit', GEOMETRY_HINTS['Bahrain International Circuit'])!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 1 }));
  for (let index = 0; index < result.layouts.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < result.layouts.length; otherIndex += 1) {
      expectDistinctLayouts(result.layouts[index]!, result.layouts[otherIndex]!);
    }
  }
});

test('buildTrackGeometryFromPayload resolves Brands Hatch to the grand prix and indy layouts', () => {
  const fixture = loadFixture('brands-hatch.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Brands Hatch')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Brands Hatch Grand Prix', 'Brands Hatch Indy']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  expectDistinctLayouts(result.layouts[0]!, result.layouts[1]!);
  expectApproxLength(result.layouts[0]!.nodes, 3.9, 0.3);
  expectApproxLength(result.layouts[1]!.nodes, 1.9, 0.2);
});

test('buildTrackGeometryFromPayload restores Mexico City grand prix geometry from frozen fixture data', () => {
  const fixture = loadFixture('mexico-city.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Autódromo Hermanos Rodríguez')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutNames(result.layouts, ['Mexican Grand Prix', 'Mexico City E-Prix']);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0]!.nodes, 4.3, 0.4);
  assert.ok(result.osmVenueNames.includes('Autódromo Hermanos Rodríguez'));
  assert.ok(result.osmVenueNames.includes('Mexican Grand Prix'));
});

test('buildTrackGeometryFromPayload avoids Monaco mini-loops and keeps the full street circuit', () => {
  const fixture = loadFixture('monaco.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Circuit de Monaco')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assert.equal(result.layouts[0]!.name, 'Main');
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 400 });
  expectApproxLength(result.layouts[0]!.nodes, 3.3, 0.3);
});

test('buildTrackGeometryFromPayload keeps the current Monza road course from frozen fixture data', () => {
  const fixture = loadFixture('monza.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Autodromo Nazionale Monza')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0]!.nodes, 5.8, 0.3);
});

test('buildTrackGeometryFromPayload keeps the current Zandvoort grand prix circuit from frozen fixture data', () => {
  const fixture = loadFixture('zandvoort.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Circuit Zandvoort')!;
  assert.equal(result.selectedLayoutIndex, 0);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0]!.nodes, 4.3, 0.3);
  assert.ok(/Grand Prix|Circuit Zandvoort|Main/.test(result.layouts[0]!.name));
});

test('named-circuit detection distinguishes Bahrain standalone layouts from Spa branch alternates', () => {
  const bahrainResult = buildTrackGeometryFromPayload(loadFixture('bahrain.json'), 'Bahrain International Circuit', GEOMETRY_HINTS['Bahrain International Circuit'])!;
  const spaResult = buildTrackGeometryFromPayload(loadFixture('spa.json'), 'Circuit de Spa-Francorchamps')!;
  assertLayoutNames(bahrainResult.layouts, ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']);
  assertLayoutNames(spaResult.layouts, ['Main', 'Moto']);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Grand Prix Circuit')?.stats.variantSectionCount, 0);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Endurance Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Outer Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Inner Circuit')?.stats.variantSectionCount, 1);
  assert.equal(bahrainResult.layouts.find(layout => layout.name === 'Paddock Layout')?.stats.variantSectionCount, 1);
  assert.equal(spaResult.layouts[0]!.stats.variantSectionCount, 0);
  assert.equal(spaResult.layouts[1]!.stats.variantSectionCount, 1);
});

test('Bahrain named layouts keep distinct approximate circuit lengths', () => {
  const result = buildTrackGeometryFromPayload(loadFixture('bahrain.json'), 'Bahrain International Circuit', GEOMETRY_HINTS['Bahrain International Circuit'])!;
  const byName = new Map(result.layouts.map(layout => [layout.name, layout]));
  expectApproxLength(byName.get('Grand Prix Circuit')!.nodes, 5.4, 0.2);
  expectApproxLength(byName.get('Endurance Circuit')!.nodes, 6.3, 0.2);
  expectApproxLength(byName.get('Paddock Layout')!.nodes, 3.8, 0.2);
  expectApproxLength(byName.get('Outer Circuit')!.nodes, 3.5, 0.2);
  expectApproxLength(byName.get('Inner Circuit')!.nodes, 2.55, 0.15);
  assert.equal(byName.has('Test Oval'), false);
});

test('Spa branch-only alternates are not promoted to standalone named circuits', () => {
  const ways = renamedWays(fixtureWays('spa.json'), { Moto: 'Moto layout' });
  ways.push({
    id: 999001,
    tags: { name: 'Rallycross circuit' },
    nodes: [{ lat: 50.432, lon: 5.965 }, { lat: 50.4324, lon: 5.9654 }, { lat: 50.4328, lon: 5.9659 }],
  });
  const payload = {
    elements: ways.map((way: Way) => ({ type: 'way', id: way.id, tags: way.tags, geometry: way.nodes })),
  };
  const result = buildTrackGeometryFromPayload(payload, 'Circuit de Spa-Francorchamps')!;
  assertLayoutNames(result.layouts, ['Circuit de Spa-Francorchamps', 'Moto layout']);
  result.layouts.forEach(layout => assertLayoutInvariants(layout, { maxGapMeters: 20 }));
  assert.equal(result.layouts.some(layout => layout.name === 'Rallycross circuit'), false);
});

test('near-identical duplicate named layouts are filtered out', () => {
  const ways = duplicateNamedWays(fixtureWays('bahrain.json'), 'Grand Prix Circuit', 'Grand Prix Circuit Alternate');
  const payload = {
    elements: ways.map((way: Way) => ({ type: 'way', id: way.id, tags: way.tags, geometry: way.nodes })),
  };
  const result = buildTrackGeometryFromPayload(payload, 'Bahrain International Circuit', GEOMETRY_HINTS['Bahrain International Circuit'])!;
  assert.equal(result.layouts.length, 4);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit').length, 1);
  assert.equal(result.layouts.filter(layout => layout.name === 'Grand Prix Circuit Alternate').length, 0);
});

test('multi-layout fixtures keep their expected layout counts', () => {
  const cases = [
    ['brands-hatch.json', 'Brands Hatch', ['Brands Hatch Grand Prix', 'Brands Hatch Indy']],
    ['silverstone.json', 'Silverstone Circuit', ['Silverstone Grand Prix', 'Silverstone International']],
    ['spa.json', 'Circuit de Spa-Francorchamps', ['Main', 'Moto']],
    ['bahrain.json', 'Bahrain International Circuit', ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit']],
    ['mexico-city.json', 'Autódromo Hermanos Rodríguez', ['Mexican Grand Prix', 'Mexico City E-Prix']],
    ['red-bull-ring.json', 'Red Bull Ring', ['Main', 'MotoGP Long Lap Penalty', 'Red Bull Ring Südschleife National Circuit', 'Moto GP chicane']],
    ['barcelona.json', 'Circuit de Barcelona-Catalunya', ['Circuit de Barcelona-Catalunya', 'Rallycross']],
  ];

  for (const [fixtureName, trackName, expectedNames] of cases) {
    const result = buildTrackGeometryFromPayload(loadFixture(fixtureName as string), trackName as string, GEOMETRY_HINTS[trackName as string])!;
    assertLayoutNames(result.layouts, expectedNames as string[]);
  }
});

test('buildTrackGeometryFromPayload excludes pit lane ways from the main circuit', () => {
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

  const result = buildTrackGeometryFromPayload(payload, 'Example Circuit')!;

  assert.equal(result.layouts.length, 1);
  assert.equal(result.layouts[0]!.stats.segmentCount, 4);
  result.layouts[0]!.nodes.forEach(node => {
    assert.notDeepEqual(node, n(-0.005, 0.025));
  });
});

test('buildTrackGeometryFromPayload keeps National Pit Straight in the main circuit', () => {
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

  const result = buildTrackGeometryFromPayload(payload, 'Example Circuit')!;

  assert.equal(result.layouts.length, 1);
  assert.equal(result.layouts[0]!.stats.segmentCount, 4);
  assert.ok(result.layouts[0]!.nodes.some(node => node.lat === 0.02 && node.lon === 0.02));
});

test('NAMED_LAYOUT_KEYWORD_PATTERN matches variant way names', () => {
  const shouldMatch = [
    'Grand Prix Circuit',
    'Inner Circuit',
    'MotoGP chicane',
    'Moto GP Long Lap Penalty',
    'Rallycross',
    'Club Circuit',
    'Bypass section',
    'Alternate layout',
    'National Circuit',
    'Endurance Circuit',
  ];
  const shouldNotMatch = [
    'Curva Biassono',
    'Rettifilo di partenza',
    'Pit Lane',
    'Turn 1',
    'Straight',
    'Sector 3',
    'Club',
  ];

  for (const name of shouldMatch) {
    assert.ok(NAMED_LAYOUT_KEYWORD_PATTERN.test(name), `Expected "${name}" to match`);
  }
  for (const name of shouldNotMatch) {
    assert.ok(!NAMED_LAYOUT_KEYWORD_PATTERN.test(name), `Expected "${name}" NOT to match`);
  }
});

test('Red Bull Ring fixture produces multiple layouts via variant substitution', () => {
  const fixture = loadFixture('red-bull-ring.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Red Bull Ring', GEOMETRY_HINTS['Red Bull Ring'])!;
  assert.ok(result.layouts.length >= 2, `Expected >= 2 layouts, got ${result.layouts.length}`);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0]!.nodes, 4.6, 0.5);
  // Südschleife must use the southern arc (~2.3km), not the northern (~2.3km but wrong side)
  const sudschleife = result.layouts.find(l => l.name.includes('Südschleife'))!;
  assert.ok(sudschleife, 'Expected a Südschleife layout');
  expectApproxLength(sudschleife.nodes, 2.3, 0.15);
});

test('Barcelona fixture produces multiple layouts from high-overlap relations', () => {
  const fixture = loadFixture('barcelona.json');
  const result = buildTrackGeometryFromPayload(fixture, 'Circuit de Barcelona-Catalunya')!;
  assert.ok(result.layouts.length >= 2, `Expected >= 2 layouts, got ${result.layouts.length}`);
  assertLayoutInvariants(result.layouts[0]!, { maxGapMeters: 120 });
  expectApproxLength(result.layouts[0]!.nodes, 4.7, 0.5);
});
