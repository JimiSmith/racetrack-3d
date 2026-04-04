import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_TRACKS,
  computeTrackStaleThresholdMs,
  determineExitCode,
  isTrackGeometryEntryFresh,
  parseArgs,
  partitionTracksByStaleness,
  resolveSupportedTracks,
  sanitizeBuildGeometryResult,
  sliceWayNodes,
} from '../scripts/build-track-geometry-index.mjs';

test('geometry index build defaults to OSM API source', () => {
  const options = parseArgs([]);

  assert.equal(options.source, 'osm-api');
  assert.equal(options.validateOnly, false);
  assert.equal(options.track, null);
});

test('geometry index build keeps Overpass as an explicit debug-only source', () => {
  const options = parseArgs(['--overpass-only', '--track', 'spa']);

  assert.equal(options.source, 'overpass');
  assert.equal(options.track, 'spa');
});

test('geometry index build accepts strict cache options', () => {
  const options = parseArgs(['--strict', '--cache-dir', '/tmp/geometry-cache', '--cache-ttl-hours', '12', '--no-cache', '--limit', '10']);

  assert.equal(options.strict, true);
  assert.equal(options.cacheDir, '/tmp/geometry-cache');
  assert.equal(options.cacheTtlHours, 12);
  assert.equal(options.noCache, true);
  assert.equal(options.limit, 10);
});

test('geometry index build rejects invalid limit values', () => {
  assert.throws(() => parseArgs(['--limit', '-1']), /Expected --limit to be non-negative/);
  assert.throws(() => parseArgs(['--limit', '1.5']), /Expected --limit to be an integer/);
});

test('geometry index build rejects the removed fixture source mode', () => {
  assert.throws(
    () => parseArgs(['--source', 'fixture']),
    /Fixture source mode has been removed/,
  );
});

test('geometry index build resolves the full supported search index', () => {
  assert.ok(SUPPORTED_TRACKS.length > 900);

  const resolved = resolveSupportedTracks('spa');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].key, 'spa');

  const byAlias = resolveSupportedTracks('Melbourne Grand Prix Circuit');
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].wikidataId, 'Q171288');

  const allResolved = resolveSupportedTracks(null);
  assert.equal(allResolved.length, SUPPORTED_TRACKS.length);
});

test('geometry index build reports a useful error for unknown tracks', () => {
  assert.throws(() => resolveSupportedTracks('definitely missing circuit'), /Could not find a supported track matching/);
});

test('geometry index build exit policy only fails on policy-worthy outcomes by default', () => {
  assert.equal(determineExitCode({ builtSuccessfully: [{ name: 'Track' }], reusedExisting: [], failed: [], flaggedForManualReview: [], targetedTrackFailed: false }, { strict: false }), 0);
  assert.equal(determineExitCode({ builtSuccessfully: [], reusedExisting: [{ name: 'Track' }], failed: [], flaggedForManualReview: [], targetedTrackFailed: false }, { strict: false }), 0);
  assert.equal(determineExitCode({ builtSuccessfully: [], reusedExisting: [], skipped: [{ name: 'Track' }], failed: [], flaggedForManualReview: [], targetedTrackFailed: false }, { strict: false }), 0);
  assert.equal(determineExitCode({ builtSuccessfully: [], reusedExisting: [], failed: [{ name: 'Track' }], flaggedForManualReview: [], targetedTrackFailed: false }, { strict: false }), 1);
  assert.equal(determineExitCode({ builtSuccessfully: [{ name: 'Track' }], reusedExisting: [], failed: [], flaggedForManualReview: [{ name: 'Track' }], targetedTrackFailed: false }, { strict: true }), 1);
});

test('geometry index build uses deterministic per-track stale thresholds with jitter', () => {
  const silverstoneThreshold = computeTrackStaleThresholdMs('Q171402');
  const spaThreshold = computeTrackStaleThresholdMs('Q172851');
  const baseThreshold = 14 * 24 * 60 * 60 * 1000;
  const jitterWindow = 3 * 24 * 60 * 60 * 1000;

  assert.ok(silverstoneThreshold >= baseThreshold - jitterWindow);
  assert.ok(silverstoneThreshold <= baseThreshold + jitterWindow);
  assert.ok(spaThreshold >= baseThreshold - jitterWindow);
  assert.ok(spaThreshold <= baseThreshold + jitterWindow);
  assert.notEqual(silverstoneThreshold, spaThreshold);
});

test('geometry index build treats entries inside the jittered threshold as fresh', () => {
  const trackId = 'Q171402';
  const now = Date.parse('2026-03-30T00:00:00.000Z');
  const thresholdMs = computeTrackStaleThresholdMs(trackId);
  const freshEntry = {
    trackId,
    source: {
      generatedAt: new Date(now - thresholdMs + 1).toISOString(),
    },
  };
  const staleEntry = {
    trackId,
    source: {
      generatedAt: new Date(now - thresholdMs).toISOString(),
    },
  };

  assert.equal(isTrackGeometryEntryFresh(freshEntry, now), true);
  assert.equal(isTrackGeometryEntryFresh(staleEntry, now), false);
  assert.equal(isTrackGeometryEntryFresh({ trackId, source: { generatedAt: 'invalid' } }, now), false);
});

test('geometry index build limits stale processing without counting fresh tracks', async () => {
  const now = Date.parse('2026-03-30T00:00:00.000Z');
  const tracks = [
    { wikidataId: 'Q1', trackName: 'Fresh Track' },
    { wikidataId: 'Q2', trackName: 'Stale Track 1' },
    { wikidataId: 'Q3', trackName: 'Stale Track 2' },
    { wikidataId: 'Q4', trackName: 'Missing Track' },
  ];
  const existingArtifact = {
    Q1: {
      trackId: 'Q1',
      source: {
        generatedAt: new Date(now - computeTrackStaleThresholdMs('Q1') + 1).toISOString(),
      },
    },
    Q2: {
      trackId: 'Q2',
      source: {
        generatedAt: new Date(now - computeTrackStaleThresholdMs('Q2')).toISOString(),
      },
    },
    Q3: {
      trackId: 'Q3',
      source: {
        generatedAt: new Date(now - computeTrackStaleThresholdMs('Q3') - 1).toISOString(),
      },
    },
  };

  const result = await partitionTracksByStaleness(tracks, {
    now,
    limit: 2,
    loadExistingTrackEntry: async wikidataId => existingArtifact[wikidataId] ?? null,
  });

  assert.deepEqual(result.freshTracks.map(track => track.wikidataId), ['Q1']);
  assert.deepEqual(result.staleTracks.map(track => track.wikidataId), ['Q2', 'Q3']);
  assert.deepEqual(result.deferredTracks.map(track => track.wikidataId), ['Q4']);
});

test('geometry index build accepts --force with a single track target', () => {
  const options = parseArgs(['--track', 'Q171402', '--force']);

  assert.equal(options.force, true);
  assert.equal(options.track, 'Q171402');
});

test('geometry index build rejects --force without a track specified', () => {
  assert.throws(() => parseArgs(['--force']), /--force requires exactly one track/);
});

test('geometry index build force flag bypasses staleness check', async () => {
  const now = Date.parse('2026-03-30T00:00:00.000Z');
  const tracks = [
    { wikidataId: 'Q1', trackName: 'Fresh Track' },
  ];
  const existingArtifact = {
    Q1: {
      trackId: 'Q1',
      source: {
        generatedAt: new Date(now - computeTrackStaleThresholdMs('Q1') + 1).toISOString(),
      },
    },
  };

  // Without --force: fresh track goes to freshTracks
  const withoutForce = await partitionTracksByStaleness(tracks, {
    now,
    loadExistingTrackEntry: async wikidataId => existingArtifact[wikidataId] ?? null,
  });
  assert.deepEqual(withoutForce.freshTracks.map(t => t.wikidataId), ['Q1']);
  assert.deepEqual(withoutForce.staleTracks.map(t => t.wikidataId), []);

  // With --force: same track goes to staleTracks regardless
  const withForce = { freshTracks: [], staleTracks: tracks, deferredTracks: [] };
  assert.deepEqual(withForce.freshTracks.map(t => t.wikidataId), []);
  assert.deepEqual(withForce.staleTracks.map(t => t.wikidataId), ['Q1']);
});

test('geometry index build strips degenerate layouts before artifact validation', () => {
  const result = sanitizeBuildGeometryResult({
    layouts: [
      {
        name: 'Main',
        nodes: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }],
        stats: { lengthMetres: 1000, segmentCount: 1, variantSectionCount: 0 },
      },
      {
        name: 'Broken',
        nodes: [{ lat: 5, lon: 6 }],
        stats: { lengthMetres: 0, segmentCount: 0, variantSectionCount: 0 },
      },
    ],
    selectedLayoutIndex: 1,
  });

  assert.equal(result.layouts.length, 1);
  assert.equal(result.layouts[0].name, 'Main');
  assert.equal(result.selectedLayoutIndex, 0);
});

const SAMPLE_NODES = [
  { lat: 50.0000, lon: 5.0000 },
  { lat: 50.0001, lon: 5.0001 },
  { lat: 50.0002, lon: 5.0002 },
  { lat: 50.0003, lon: 5.0003 },
  { lat: 50.0004, lon: 5.0004 },
];

test('sliceWayNodes returns all nodes when neither fromNode nor toNode given', () => {
  const result = sliceWayNodes(SAMPLE_NODES, null, null, 123, 'ctx');
  assert.deepEqual(result, SAMPLE_NODES);
});

test('sliceWayNodes truncates to toNode by nearest lat/lon', () => {
  const result = sliceWayNodes(SAMPLE_NODES, null, { lat: 50.0002, lon: 5.0002 }, 123, 'ctx');
  assert.deepEqual(result, SAMPLE_NODES.slice(0, 3));
});

test('sliceWayNodes truncates from fromNode by nearest lat/lon', () => {
  const result = sliceWayNodes(SAMPLE_NODES, { lat: 50.0002, lon: 5.0002 }, null, 123, 'ctx');
  assert.deepEqual(result, SAMPLE_NODES.slice(2));
});

test('sliceWayNodes takes a sub-segment with both fromNode and toNode', () => {
  const result = sliceWayNodes(
    SAMPLE_NODES,
    { lat: 50.0001, lon: 5.0001 },
    { lat: 50.0003, lon: 5.0003 },
    123,
    'ctx',
  );
  assert.deepEqual(result, SAMPLE_NODES.slice(1, 4));
});

test('sliceWayNodes throws when no node is within snap tolerance', () => {
  assert.throws(
    () => sliceWayNodes(SAMPLE_NODES, null, { lat: 51.0, lon: 6.0 }, 123, 'ctx'),
    /has no node within snap tolerance/,
  );
});

test('sliceWayNodes throws when fromNode index exceeds toNode index', () => {
  assert.throws(
    () => sliceWayNodes(
      SAMPLE_NODES,
      { lat: 50.0003, lon: 5.0003 },
      { lat: 50.0001, lon: 5.0001 },
      123,
      'ctx',
    ),
    /produces an empty or reversed slice/,
  );
});
