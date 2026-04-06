import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdaptiveOsmApiMargins,
  buildOsmApiMapUrl,
  fetchAdaptiveOsmApiMapPayload,
  fetchOsmApiMapPayload,
  isOsmApiNodeLimitError,
  isOsmApiRateLimitError,
  parseOsmApiMapXml,
  supplementPayloadWithMissingRelationWays,
} from '../scripts/lib/osm-api-source.mjs';

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

test('parseOsmApiMapXml preserves relation members with null geometry when their way is outside the bbox', () => {
  // Way 99 is referenced by the relation but not present in the XML (out-of-bbox).
  // After the finalizeRelation change it should be kept with geometry: null so that
  // supplementPayloadWithMissingRelationWays can discover and fetch it.
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10">
    <nd ref="1" />
    <nd ref="2" />
    <tag k="highway" v="raceway" />
  </way>
  <relation id="20">
    <member type="way" ref="10" role="outer" />
    <member type="way" ref="99" role="outer" />
    <tag k="type" v="circuit" />
    <tag k="name" v="Example Circuit" />
  </relation>
</osm>`);

  const relation = payload.elements.find(e => e.type === 'relation' && e.id === 20);
  assert.ok(relation);
  assert.equal(relation.members.length, 2);

  const presentMember = relation.members.find(m => m.ref === 10);
  assert.ok(Array.isArray(presentMember?.geometry), 'present way should have geometry');

  const missingMember = relation.members.find(m => m.ref === 99);
  assert.equal(missingMember?.geometry, null, 'out-of-bbox way should have null geometry');
});

test('supplementPayloadWithMissingRelationWays fetches and fills in out-of-bbox relation members', async () => {
  // Simulate an Albert-Park-style scenario: a circuit relation references a way
  // (id 99) that fell outside the initial bbox and so is absent from the payload.
  const initialPayload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10">
    <nd ref="1" />
    <nd ref="2" />
    <tag k="highway" v="raceway" />
    <tag k="name" v="Test Circuit" />
  </way>
  <relation id="20">
    <member type="way" ref="10" role="outer" />
    <tag k="type" v="circuit" />
    <tag k="name" v="Test Circuit" />
  </relation>
</osm>`);

  // The full relation (fetched by ID) reveals an additional member: way 99.
  const fullRelationXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <relation id="20">
    <member type="way" ref="10" role="outer" />
    <member type="way" ref="99" role="outer" />
    <tag k="type" v="circuit" />
    <tag k="name" v="Test Circuit" />
  </relation>
</osm>`;

  // Way 99's geometry (node refs come from the /ways endpoint, coords from /nodes).
  const missingWaysXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <way id="99">
    <nd ref="3" />
    <nd ref="4" />
    <tag k="highway" v="unclassified" />
    <tag k="name" v="Outer Road" />
  </way>
</osm>`;
  const missingNodesXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="3" lat="52.2" lon="-1.2" />
  <node id="4" lat="52.3" lon="-1.3" />
</osm>`;

  const fetchCalls = [];
  const mockFetch = async url => {
    fetchCalls.push(String(url));
    if (String(url).includes('/relation/20')) return new Response(fullRelationXml, { status: 200 });
    if (String(url).includes('/ways?ways=')) return new Response(missingWaysXml, { status: 200 });
    if (String(url).includes('/nodes?nodes=')) return new Response(missingNodesXml, { status: 200 });
    return new Response('not found', { status: 404 });
  };

  const result = await supplementPayloadWithMissingRelationWays(initialPayload, { fetch: mockFetch });

  // Should have made exactly 3 requests: relation, ways, nodes
  assert.equal(fetchCalls.length, 3);
  assert.ok(fetchCalls[0].includes('/relation/20'));
  assert.ok(fetchCalls[1].includes('/ways?ways=99'));
  assert.ok(fetchCalls[2].includes('/nodes?nodes='));

  // The relation should now have both members with geometry
  const relation = result.elements.find(e => e.type === 'relation' && e.id === 20);
  assert.equal(relation.members.length, 2);
  assert.ok(Array.isArray(relation.members.find(m => m.ref === 10)?.geometry));
  assert.ok(Array.isArray(relation.members.find(m => m.ref === 99)?.geometry));

  // Way 99 should be added as a bare element
  const way99 = result.elements.find(e => e.type === 'way' && e.id === 99);
  assert.ok(way99);
  assert.deepEqual(way99.geometry, [{ lat: 52.2, lon: -1.2 }, { lat: 52.3, lon: -1.3 }]);
});

test('supplementPayloadWithMissingRelationWays returns original payload if no relevant relations', async () => {
  const payload = { elements: [{ type: 'way', id: 1, tags: {}, geometry: [] }] };
  const result = await supplementPayloadWithMissingRelationWays(payload, {
    fetch: () => { throw new Error('should not be called'); },
  });
  assert.equal(result, payload);
});

test('supplementPayloadWithMissingRelationWays falls back gracefully on network error', async () => {
  const initialPayload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="raceway"/></way>
  <relation id="20">
    <member type="way" ref="10" role="outer" />
    <tag k="type" v="circuit" />
  </relation>
</osm>`);

  const result = await supplementPayloadWithMissingRelationWays(initialPayload, {
    fetch: async () => { throw new Error('network failure'); },
  });

  // Should return the original payload unchanged
  assert.equal(result, initialPayload);
});

test('parseOsmApiMapXml selects all circuit route relations regardless of wikidataId', () => {
  // Both relations pass isCircuitRoute — both should be selected whether or not wikidataId is provided.
  // Venues with multiple layout relations (e.g. Bahrain, Silverstone) need all of them included.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="raceway"/></way>
  <relation id="20">
    <member type="way" ref="10" role=""/>
    <tag k="wikidata" v="Q999"/>
    <tag k="type" v="circuit"/>
    <tag k="name" v="Wikidata Circuit"/>
  </relation>
  <relation id="21">
    <member type="way" ref="10" role=""/>
    <tag k="highway" v="raceway"/>
    <tag k="name" v="Other Raceway"/>
  </relation>
</osm>`;

  for (const wikidataArg of ['Q999', 'Q000', undefined]) {
    const payload = parseOsmApiMapXml(xml, wikidataArg);
    const relations = payload.elements.filter(e => e.type === 'relation');
    assert.equal(relations.length, 2, `expected 2 relations with wikidataId=${wikidataArg}`);
    assert.ok(relations.some(r => r.id === 20));
    assert.ok(relations.some(r => r.id === 21));
  }
});

test('parseOsmApiMapXml excludes facility multipolygons even when they carry a wikidata tag', () => {
  // Relation 20 has wikidata=Q999 but type=multipolygon (facility area, not a circuit route).
  // isCircuitRoute must exclude it so that only the actual circuit relation (21) is returned.
  // This guards against the Hungaroring case where the venue area has the wikidata tag.
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <relation id="20">
    <member type="way" ref="10" role="outer"/>
    <tag k="wikidata" v="Q999"/>
    <tag k="type" v="multipolygon"/>
    <tag k="name" v="Circuit Facility Area"/>
  </relation>
  <relation id="21">
    <member type="way" ref="10" role=""/>
    <tag k="type" v="circuit"/>
    <tag k="name" v="Circuit Route"/>
  </relation>
</osm>`, 'Q999');

  const relations = payload.elements.filter(e => e.type === 'relation');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].id, 21);
});

test('parseOsmApiMapXml uses highway/type filter regardless of wikidataId argument', () => {
  // Both relations pass isCircuitRoute and are always selected, regardless of wikidataId.
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="raceway"/></way>
  <relation id="20">
    <member type="way" ref="10" role=""/>
    <tag k="wikidata" v="Q999"/>
    <tag k="type" v="circuit"/>
    <tag k="name" v="Wikidata Circuit"/>
  </relation>
  <relation id="21">
    <member type="way" ref="10" role=""/>
    <tag k="highway" v="raceway"/>
    <tag k="name" v="Other Raceway"/>
  </relation>
</osm>`, 'Q000');

  const relations = payload.elements.filter(e => e.type === 'relation');
  assert.equal(relations.length, 2);
  assert.ok(relations.some(r => r.id === 20));
  assert.ok(relations.some(r => r.id === 21));
});

test('parseOsmApiMapXml selects relations tagged route=raceway', () => {
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <relation id="20">
    <member type="way" ref="10" role=""/>
    <tag k="route" v="raceway"/>
    <tag k="name" v="Route Raceway Circuit"/>
  </relation>
</osm>`);

  const relations = payload.elements.filter(e => e.type === 'relation');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].id, 20);
});

test('parseOsmApiMapXml excludes relations without standard circuit tags', () => {
  // Relation 20 has only a wikidata tag — no highway/type/route tag — so isCircuitRoute rejects it.
  // Relation 21 has highway=raceway and is selected.
  const payload = parseOsmApiMapXml(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="raceway"/></way>
  <relation id="20">
    <member type="way" ref="10" role=""/>
    <tag k="wikidata" v="Q999"/>
    <tag k="name" v="Wikidata Only Circuit"/>
  </relation>
  <relation id="21">
    <member type="way" ref="10" role=""/>
    <tag k="highway" v="raceway"/>
    <tag k="name" v="Raceway Circuit"/>
  </relation>
</osm>`);

  const relations = payload.elements.filter(e => e.type === 'relation');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].id, 21);
});

test('supplementPayloadWithMissingRelationWays uses wikidata-first selection when wikidataId is provided', async () => {
  // Build a synthetic payload directly (bypassing parseOsmApiMapXml) so this test exercises
  // supplementPayloadWithMissingRelationWays's own wikidata logic in isolation.
  // Both relations are present: relation 20 has wikidata=Q999 + type=circuit,
  // relation 21 has highway=raceway but no wikidata tag.
  // With wikidataId='Q999', only relation 20 should be treated as relevant.
  const syntheticPayload = {
    version: 0.6,
    generator: 'test',
    elements: [
      {
        type: 'way', id: 10,
        tags: { highway: 'raceway' },
        geometry: [{ lat: 52.0, lon: -1.0 }, { lat: 52.1, lon: -1.1 }],
      },
      {
        type: 'relation', id: 20,
        tags: { wikidata: 'Q999', type: 'circuit', name: 'Wikidata Circuit' },
        members: [{ type: 'way', ref: 10, role: '' }],
      },
      {
        type: 'relation', id: 21,
        tags: { highway: 'raceway', name: 'Other Raceway' },
        members: [{ type: 'way', ref: 10, role: '' }],
      },
    ],
  };

  const fetchedUrls = [];
  const result = await supplementPayloadWithMissingRelationWays(syntheticPayload, {
    wikidataId: 'Q999',
    fetch: async (url) => {
      fetchedUrls.push(url);
      return { ok: true, text: async () => '<osm><relation id="20"></relation></osm>' };
    },
  });

  // Should have fetched only relation 20 (the wikidata match), not relation 21
  assert.equal(fetchedUrls.length, 1, 'should fetch exactly one relation');
  assert.ok(fetchedUrls[0]?.includes('/relation/20'), 'should have fetched relation 20');
  assert.equal(result, syntheticPayload); // no missing members, so payload unchanged
});

test('supplementPayloadWithMissingRelationWays appends missing ways via wikidata-selected relation', async () => {
  // Relation 20 (wikidata=Q999) references way 10 (present) and way 99 (absent).
  // Relation 21 (highway=raceway, no wikidata) references only way 10.
  // With wikidataId='Q999', only relation 20 is relevant, so way 99 should be fetched and appended.
  const syntheticPayload = {
    version: 0.6,
    generator: 'test',
    elements: [
      {
        type: 'way', id: 10,
        tags: { highway: 'raceway' },
        geometry: [{ lat: 52.0, lon: -1.0 }, { lat: 52.1, lon: -1.1 }],
      },
      {
        type: 'relation', id: 20,
        tags: { wikidata: 'Q999', type: 'circuit', name: 'Wikidata Circuit' },
        members: [{ type: 'way', ref: 10, role: '' }, { type: 'way', ref: 99, role: '' }],
      },
      {
        type: 'relation', id: 21,
        tags: { highway: 'raceway', name: 'Other Raceway' },
        members: [{ type: 'way', ref: 10, role: '' }],
      },
    ],
  };

  const result = await supplementPayloadWithMissingRelationWays(syntheticPayload, {
    wikidataId: 'Q999',
    fetch: async (url) => {
      if (url.includes('/relation/20')) {
        return {
          ok: true,
          text: async () => `<?xml version="1.0"?>
<osm version="0.6">
  <relation id="20">
    <member type="way" ref="10" role=""/>
    <member type="way" ref="99" role=""/>
  </relation>
</osm>`,
        };
      }
      if (url.includes('/ways?ways=99')) {
        return {
          ok: true,
          text: async () => `<?xml version="1.0"?>
<osm version="0.6">
  <node id="3" lat="52.2" lon="-1.2"/>
  <node id="4" lat="52.3" lon="-1.3"/>
  <way id="99"><nd ref="3"/><nd ref="4"/></way>
</osm>`,
        };
      }
      if (url.includes('/nodes?nodes=')) {
        return {
          ok: true,
          text: async () => `<?xml version="1.0"?>
<osm version="0.6">
  <node id="3" lat="52.2" lon="-1.2"/>
  <node id="4" lat="52.3" lon="-1.3"/>
</osm>`,
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  assert.notEqual(result, syntheticPayload, 'payload should be augmented');
  const way99 = result.elements.find(e => e.type === 'way' && e.id === 99);
  assert.ok(way99, 'way 99 should be appended to the payload');
  assert.deepEqual(way99.geometry, [{ lat: 52.2, lon: -1.2 }, { lat: 52.3, lon: -1.3 }]);
});

test('buildAdaptiveOsmApiMargins grows from a smaller starting bbox up to the requested cap', () => {
  assert.deepEqual(buildAdaptiveOsmApiMargins([0.02, 0.04, 0.08]), [0.0025, 0.005, 0.01, 0.02, 0.04, 0.08]);
  assert.deepEqual(buildAdaptiveOsmApiMargins([0.015, 0.03, 0.06]), [0.001875, 0.00375, 0.0075, 0.015, 0.03, 0.06]);
});

test('isOsmApiNodeLimitError matches the OSM API 50k node failure', () => {
  assert.equal(isOsmApiNodeLimitError(new Error('OSM API map request failed (400): You requested too many nodes (limit is 50000). Either request a smaller area, or use planet.osm')), true);
  assert.equal(isOsmApiNodeLimitError(new Error('OSM API map request failed (504): timed out')), false);
});

test('isOsmApiRateLimitError matches OSM quota and throttling failures', () => {
  assert.equal(isOsmApiRateLimitError(new Error('OSM API map request rate-limited (509): You have downloaded too much data. Please wait 12 seconds and try again.; retry after 12s')), true);
  assert.equal(isOsmApiRateLimitError(new Error('OSM API map request failed (429): Too Many Requests')), true);
  assert.equal(isOsmApiRateLimitError(new Error('OSM API map request failed (400): You requested too many nodes (limit is 50000). Either request a smaller area, or use planet.osm')), false);
});

test('fetchOsmApiMapPayload retries rate-limited responses, respects retry-after, and paces requests', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  const sleeps = [];
  let now = 1000;

  globalThis.fetch = async url => {
    fetchCalls.push(String(url));
    if (fetchCalls.length === 1) {
      return new Response('You have downloaded too much data. Please wait 7 seconds and try again.', {
        status: 509,
        headers: {
          'Retry-After': '7',
        },
      });
    }

    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="52.0" lon="-1.0" />
  <node id="2" lat="52.1" lon="-1.1" />
  <way id="10">
    <nd ref="1" />
    <nd ref="2" />
    <tag k="highway" v="raceway" />
  </way>
</osm>`, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
      },
    });
  };

  try {
    const result = await fetchOsmApiMapPayload(52.075, -1.0166666666667, {
      paceMs: 1500,
      maxRateLimitRetries: 2,
      sleep: async delayMs => {
        sleeps.push(delayMs);
        now += delayMs;
      },
      now: () => now,
      pacingState: {
        nextRequestAt: now + 500,
      },
    });

    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(sleeps, [500, 7000]);
    assert.equal(result.metadata.requestAttempts, 2);
    assert.equal(result.metadata.retryCount, 1);
    assert.equal(result.metadata.pacingDelayMs, 500);
    assert.equal(result.metadata.retryDelayMs, 7000);
    assert.equal(result.payload.elements.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchAdaptiveOsmApiMapPayload returns the last usable response when a larger bbox hits the node limit', async () => {
  const attemptedMargins = [];
  const response = await fetchAdaptiveOsmApiMapPayload(-34.930466, 138.620609, {
    margins: [0.02, 0.04, 0.08],
    fetchForMargin: async margin => {
      attemptedMargins.push(margin);
      if (margin >= 0.02) {
        throw new Error('OSM API map request failed (400): You requested too many nodes (limit is 50000). Either request a smaller area, or use planet.osm');
      }

      return {
        url: `https://example.test/${margin}`,
        xml: `<osm margin="${margin}" />`,
        payload: { margin },
      };
    },
    evaluateResponse: resolvedResponse => ({
      usable: resolvedResponse.payload.margin >= 0.01,
      geometryResult: { margin: resolvedResponse.payload.margin },
    }),
  });

  assert.deepEqual(attemptedMargins, [0.0025, 0.005, 0.01, 0.02]);
  assert.equal(response.metadata.margin, 0.01);
  assert.equal(response.metadata.stopReason, 'node-limit');
  assert.deepEqual(response.metadata.attempts, [0.0025, 0.005, 0.01, 0.02, 0.04, 0.08]);
  assert.deepEqual(response.evaluation.geometryResult, { margin: 0.01 });
});

test('fetchAdaptiveOsmApiMapPayload throws when no bbox yields usable geometry', async () => {
  await assert.rejects(
    () => fetchAdaptiveOsmApiMapPayload(52, -1, {
      margins: [0.02],
      fetchForMargin: async margin => ({
        url: `https://example.test/${margin}`,
        xml: '<osm />',
        payload: { margin },
      }),
      evaluateResponse: () => ({
        usable: false,
        reason: 'did not yield geometry',
      }),
    }),
    /Adaptive OSM API map request failed \(margin 0\.0025: did not yield geometry; margin 0\.005: did not yield geometry; margin 0\.01: did not yield geometry; margin 0\.02: did not yield geometry\)/,
  );
});
