import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOsmApiMapUrl, parseOsmApiMapXml } from '../scripts/lib/osm-api-source.mjs';

test('buildOsmApiMapUrl uses the main OSM map endpoint and bbox order', () => {
  const url = new URL(buildOsmApiMapUrl(52.075, -1.0166666666667, 0.02));

  assert.equal(url.origin, 'https://api.openstreetmap.org');
  assert.equal(url.pathname, '/api/0.6/map');
  const [minLon, minLat, maxLon, maxLat] = url.searchParams.get('bbox').split(',').map(Number);
  assert.ok(Math.abs(minLon - (-1.0366666666667)) < 1e-12);
  assert.ok(Math.abs(minLat - 52.055) < 1e-12);
  assert.ok(Math.abs(maxLon - (-0.9966666666667)) < 1e-12);
  assert.ok(Math.abs(maxLat - 52.095) < 1e-12);
});

test('parseOsmApiMapXml hydrates way geometry and relation member geometry', () => {
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <node id="3" lat="52.2" lon="-1.2" />
  <way id="10">
    <nd ref="1" />
    <nd ref="2" />
    <tag k="highway" v="raceway" />
    <tag k="name" v="Main &amp; Fast" />
  </way>
  <way id="11">
    <nd ref="2" />
    <nd ref="3" />
    <tag k="highway" v="raceway" />
  </way>
  <relation id="20">
    <member type="way" ref="10" role="outer" />
    <member type="way" ref="11" role="outer" />
    <tag k="type" v="circuit" />
    <tag k="name" v="Example Circuit" />
  </relation>
</osm>`);

  const way = payload.elements.find(element => element.type === 'way' && element.id === 10);
  const relation = payload.elements.find(element => element.type === 'relation' && element.id === 20);

  assert.ok(way);
  assert.equal(way.tags.name, 'Main & Fast');
  assert.deepEqual(way.geometry, [
    { lat: 52.0, lon: -1.0 },
    { lat: 52.1, lon: -1.1 },
  ]);

  assert.ok(relation);
  assert.equal(relation.tags.name, 'Example Circuit');
  assert.equal(relation.members.length, 2);
  assert.deepEqual(relation.members[0], {
    type: 'way',
    ref: 10,
    role: 'outer',
    geometry: [
      { lat: 52.0, lon: -1.0 },
      { lat: 52.1, lon: -1.1 },
    ],
  });
});
