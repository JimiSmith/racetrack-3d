import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPrintedTrackName } from '../src/search/track-name.js';

test('prefers label over short name when label is canonical', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Silverstone Circuit',
    wikidataAliases: ['Silverstone'],
    wikidataShortName: 'Silverstone',
  });

  assert.equal(result.baseVenueName, 'Silverstone Circuit');
  assert.equal(result.printedName, 'Silverstone Circuit');
});

test('prefers alias over label when alias is clearly better', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Spa-Francochamps Circuit',
    wikidataAliases: ['Circuit de Spa-Francorchamps', 'Spa-Francochamps'],
    wikidataShortName: 'Spa',
  });

  assert.equal(result.baseVenueName, 'Circuit de Spa-Francorchamps');
  assert.equal(result.printedName, 'Circuit de Spa-Francorchamps');
});

test('rejects description as printed name', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'street circuit in Melbourne, Victoria, Australia',
    wikidataAliases: ['Albert Park Circuit'],
    description: 'street circuit in Melbourne, Victoria, Australia',
  });

  assert.equal(result.baseVenueName, 'Albert Park Circuit');
  assert.notEqual(result.printedName, 'street circuit in Melbourne, Victoria, Australia');
});

test('does not use event-style alias when venue name exists', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Albert Park Circuit',
    wikidataAliases: [
      'Australian Grand Prix Circuit',
      'Melbourne Grand Prix Circuit',
      'Melbourne',
    ],
    wikidataShortName: 'Melbourne',
  });

  assert.equal(result.baseVenueName, 'Albert Park Circuit');
  assert.equal(result.printedName, 'Albert Park Circuit');
});

test('appends meaningful layout suffix with compact venue handling', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Bahrain International Circuit',
    wikidataAliases: ['Bahrain'],
    wikidataShortName: 'Bahrain',
    selectedLayoutName: 'Inner Circuit',
  });

  assert.equal(result.baseVenueName, 'Bahrain International Circuit');
  assert.equal(result.layoutSuffix, 'Inner Circuit');
  assert.equal(result.printedName, 'Bahrain Inner Circuit');
});

test('ignores generic layout names', () => {
  for (const selectedLayoutName of ['Main', 'Alternate', 'Layout 1']) {
    const result = selectPrintedTrackName({
      wikidataLabel: 'Silverstone Circuit',
      wikidataShortName: 'Silverstone',
      selectedLayoutName,
    });

    assert.equal(result.layoutSuffix, null);
    assert.equal(result.printedName, 'Silverstone Circuit');
  }
});

test('result is deterministic and independent of placement', () => {
  const baseInput = {
    wikidataLabel: 'Bahrain International Circuit',
    wikidataAliases: ['Bahrain'],
    wikidataShortName: 'Bahrain',
    selectedLayoutName: 'Grand Prix Circuit',
    osmVenueNames: ['Bahrain International Circuit', 'Grand Prix Circuit'],
  };

  const first = selectPrintedTrackName({
    ...baseInput,
    availablePlacementArea: 10,
    textFitScore: 0.1,
  });
  const second = selectPrintedTrackName({
    ...baseInput,
    availablePlacementArea: 1000,
    textFitScore: 999,
    multilineFitQuality: 'great',
  });

  assert.deepEqual(second, first);
  assert.equal(first.printedName, 'Bahrain Grand Prix Circuit');
});

test('suppresses redundant venue-alias layout names for Le Mans', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Circuit de la Sarthe',
    wikidataAliases: ['Circuit des 24 Heures du Mans', 'Circuit des 24 Heures'],
    description: 'race course in Le Mans',
    osmVenueNames: ['Circuit de la Sarthe', 'Circuit des 24 Heures du Mans'],
    selectedLayoutName: 'Circuit des 24 Heures du Mans',
  });

  assert.equal(result.baseVenueName, 'Circuit de la Sarthe');
  assert.equal(result.layoutSuffix, null);
  assert.equal(result.printedName, 'Circuit de la Sarthe');
});

test('deduping equivalent venue names keeps the strongest candidate source', () => {
  const result = selectPrintedTrackName({
    wikidataLabel: 'Circuit de la Sarthe',
    osmVenueNames: ['Circuit de la Sarthe'],
  });

  assert.equal(result.baseVenueName, 'Circuit de la Sarthe');
  assert.equal(result.reason, 'selected best label venue candidate');
});
