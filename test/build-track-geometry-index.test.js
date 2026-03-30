import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_TRACKS,
  determineExitCode,
  parseArgs,
  resolveSupportedTracks,
} from '../scripts/build-track-geometry-index.mjs';

test('geometry index build defaults to OSM API with Overpass fallback enabled', () => {
  const options = parseArgs([]);

  assert.equal(options.source, 'osm-api');
  assert.equal(options.allowOverpassFallback, true);
  assert.equal(options.validateOnly, false);
  assert.equal(options.track, null);
});

test('geometry index build keeps Overpass as an explicit debug-only source', () => {
  const options = parseArgs(['--overpass-only', '--track', 'spa']);

  assert.equal(options.source, 'overpass');
  assert.equal(options.allowOverpassFallback, false);
  assert.equal(options.track, 'spa');
});

test('geometry index build accepts strict cache options', () => {
  const options = parseArgs(['--strict', '--cache-dir', '/tmp/geometry-cache', '--cache-ttl-hours', '12', '--no-cache']);

  assert.equal(options.strict, true);
  assert.equal(options.cacheDir, '/tmp/geometry-cache');
  assert.equal(options.cacheTtlHours, 12);
  assert.equal(options.noCache, true);
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
  assert.equal(determineExitCode({ builtSuccessfully: [], reusedExisting: [], failed: [{ name: 'Track' }], flaggedForManualReview: [], targetedTrackFailed: false }, { strict: false }), 1);
  assert.equal(determineExitCode({ builtSuccessfully: [{ name: 'Track' }], reusedExisting: [], failed: [], flaggedForManualReview: [{ name: 'Track' }], targetedTrackFailed: false }, { strict: true }), 1);
});
