import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED_TRACKS, parseArgs, resolveSupportedTracks } from '../scripts/build-track-geometry-index.mjs';

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

test('geometry index build rejects the removed fixture source mode', () => {
  assert.throws(
    () => parseArgs(['--source', 'fixture']),
    /Fixture source mode has been removed/,
  );
});

test('geometry index build only resolves the explicit supported prebuild track list', () => {
  assert.deepEqual(
    SUPPORTED_TRACKS.map(track => track.key),
    ['silverstone', 'spa', 'bahrain'],
  );

  const resolved = resolveSupportedTracks('spa');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].key, 'spa');

  assert.throws(
    () => resolveSupportedTracks('brands hatch'),
    /This prototype only supports Silverstone Circuit, Circuit de Spa-Francorchamps, Bahrain International Circuit/,
  );
});
