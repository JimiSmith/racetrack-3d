import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { fetchTrackGeometry } from '../src/search.js';
import {
  buildLayoutPickerState,
  getSelectedLayout,
  normalizeSelectedLayoutIndex,
} from '../src/layout-picker.js';
import { expectDistinctLayouts } from '../test-utils/layout-assertions.js';

function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
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

test('picker state is hidden when only one layout is available', () => {
  const layouts = [{
    id: 'layout-1',
    name: 'Main',
    nodes: [n(0, 0), n(0, 0.01), n(0.01, 0.01), n(0, 0)],
    stats: { lengthMetres: 3000, segmentCount: 3, variantSectionCount: 0 },
  }];

  const pickerState = buildLayoutPickerState(layouts, 0);

  assert.equal(pickerState.hidden, true);
  assert.equal(pickerState.hint, '');
  assert.deepEqual(pickerState.options, []);
  assert.equal(pickerState.selectedLayout?.name, 'Main');
});

test('picker state is shown when multiple layouts are available', async () => {
  const fixture = loadFixture('silverstone.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.0786, -1.0169, undefined, 'Silverstone Circuit'));
  const pickerState = buildLayoutPickerState(result.layouts, result.selectedLayoutIndex);

  assert.equal(pickerState.hidden, false);
  assert.equal(pickerState.options.length, 2);
  assert.equal(pickerState.options[0].selected, true);
  assert.match(pickerState.options[0].label, /^Main - /);
  assert.match(pickerState.options[1].label, /^National Circuit - /);
});

test('changing selected layout index yields different nodes', async () => {
  const fixture = loadFixture('silverstone.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(52.0786, -1.0169, undefined, 'Silverstone Circuit'));

  const firstLayout = getSelectedLayout(result.layouts, normalizeSelectedLayoutIndex(result.layouts, 0));
  const secondLayout = getSelectedLayout(result.layouts, normalizeSelectedLayoutIndex(result.layouts, 1));

  assert.notDeepEqual(firstLayout.nodes, secondLayout.nodes);
  expectDistinctLayouts(firstLayout, secondLayout);
});

test('picker data never exposes identical returned layouts', async () => {
  const fixture = loadFixture('bahrain.json');

  const result = await withMockedFetch(fixture, () =>
    fetchTrackGeometry(26.0325, 50.5106, undefined, 'Bahrain International Circuit'));

  for (let index = 0; index < result.layouts.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < result.layouts.length; otherIndex += 1) {
      expectDistinctLayouts(result.layouts[index], result.layouts[otherIndex]);
    }
  }
});
