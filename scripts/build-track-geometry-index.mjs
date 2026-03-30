import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import trackSearchIndex from '../src/generated/track-search-index.json' with { type: 'json' };
import { buildTrackGeometryFromOverpassPayload, fetchTrackGeometry, normalizeTrackGeometryResult } from '../src/search.js';
import { fetchOsmApiMapPayload } from './lib/osm-api-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'src', 'generated');
const outputPath = path.join(outputDir, 'track-geometry-index.json');
const MIN_LAYOUT_LENGTH_METRES = 500;
const MAX_LAYOUT_LENGTH_METRES = 100000;
const MIN_LAYOUT_NODE_COUNT = 2;

export const SUPPORTED_TRACKS = [
  {
    key: 'silverstone',
    trackName: 'Silverstone Circuit',
    searchLabel: 'Silverstone Circuit',
    osmApiMargin: 0.02,
    expectedLayoutNames: ['Main', 'Alternate'],
  },
  {
    key: 'spa',
    trackName: 'Circuit de Spa-Francorchamps',
    searchLabel: 'Spa-Francochamps Circuit',
    osmApiMargin: 0.03,
    expectedLayoutNames: ['Main', 'Moto'],
  },
  {
    key: 'bahrain',
    trackName: 'Bahrain International Circuit',
    searchLabel: 'Bahrain International Circuit',
    osmApiMargin: 0.02,
    expectedLayoutNames: ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit'],
  },
];

const BUILD_SOURCES = new Set(['osm-api', 'overpass']);

export function parseArgs(argv) {
  const options = {
    track: null,
    source: 'osm-api',
    allowOverpassFallback: true,
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--track') {
      options.track = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--validate-only') {
      options.validateOnly = true;
      continue;
    }

    if (arg === '--source') {
      options.source = argv[index + 1] ?? options.source;
      index += 1;
      continue;
    }

    if (arg === '--live') {
      options.source = 'osm-api';
      continue;
    }

    if (arg === '--overpass-only') {
      options.source = 'overpass';
      options.allowOverpassFallback = false;
      continue;
    }

    if (arg === '--no-overpass-fallback') {
      options.allowOverpassFallback = false;
    }
  }

  if (options.source === 'fixture') {
    throw new Error('Fixture source mode has been removed; use the default OSM API build path or --overpass-only for debug');
  }

  if (!BUILD_SOURCES.has(options.source)) {
    throw new Error(`Unsupported build source "${options.source}"; expected one of ${[...BUILD_SOURCES].join(', ')}`);
  }

  return options;
}

async function fetchPrimaryGeometryFromOsmApi(track) {
  const { payload } = await fetchOsmApiMapPayload(track.lat, track.lon, {
    margin: track.osmApiMargin,
  });
  const geometryResult = normalizeTrackGeometryResult(
    buildTrackGeometryFromOverpassPayload(payload, track.trackName),
    track.trackName,
  );
  if (!geometryResult) {
    throw new Error(`OSM API payload did not yield geometry for ${track.trackName}`);
  }

  return geometryResult;
}

async function fetchFallbackGeometryFromOverpass(track) {
  return normalizeTrackGeometryResult(
    await fetchTrackGeometry(track.lat, track.lon, undefined, track.trackName, {
      wikidataId: track.wikidataId,
      skipLocal: true,
    }),
    track.trackName,
  );
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'layout';
}

export function resolveSupportedTracks(requestedTrack) {
  const supportedTracks = SUPPORTED_TRACKS.map(config => {
    const searchTrack = trackSearchIndex.find(entry => entry.label === config.searchLabel);
    if (!searchTrack) {
      throw new Error(`Could not find ${config.searchLabel} in the local track search index`);
    }

    return {
      ...searchTrack,
      ...config,
    };
  });

  if (!requestedTrack) {
    return supportedTracks;
  }

  const requestedKey = normalizeText(requestedTrack);
  const matchingTrack = supportedTracks.find(track => [
    track.key,
    track.wikidataId,
    track.trackName,
    track.searchLabel,
    track.wikidataShortName,
    ...(track.aliases ?? []),
  ].some(value => normalizeText(value) === requestedKey));

  if (!matchingTrack) {
    throw new Error(`This prototype only supports ${SUPPORTED_TRACKS.map(track => track.trackName).join(', ')}; received ${requestedTrack}`);
  }

  return [matchingTrack];
}

function validateNode(node, trackName, layoutName, nodeIndex) {
  if (!node || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) {
    throw new Error(`${trackName} / ${layoutName}: node ${nodeIndex} has invalid coordinates`);
  }
}

function validateLayout(layout, trackName) {
  if (!layout?.name?.trim()) {
    throw new Error(`${trackName}: layout is missing a name`);
  }

  if (!Array.isArray(layout.nodes) || layout.nodes.length < 2) {
    throw new Error(`${trackName} / ${layout.name}: expected at least 2 nodes`);
  }

  if (layout.nodes.length < MIN_LAYOUT_NODE_COUNT) {
    throw new Error(`${trackName} / ${layout.name}: expected at least ${MIN_LAYOUT_NODE_COUNT} nodes, received ${layout.nodes.length}`);
  }

  layout.nodes.forEach((node, index) => validateNode(node, trackName, layout.name, index));

  const lengthMetres = layout?.stats?.lengthMetres;
  if (!Number.isFinite(lengthMetres) || lengthMetres <= 0) {
    throw new Error(`${trackName} / ${layout.name}: expected positive length`);
  }

  if (lengthMetres < MIN_LAYOUT_LENGTH_METRES || lengthMetres > MAX_LAYOUT_LENGTH_METRES) {
    throw new Error(`${trackName} / ${layout.name}: length ${lengthMetres}m is outside sane circuit bounds`);
  }

  if (!Number.isInteger(layout?.stats?.segmentCount) || layout.stats.segmentCount <= 0) {
    throw new Error(`${trackName} / ${layout.name}: expected positive segmentCount`);
  }

  if (!Number.isInteger(layout?.stats?.variantSectionCount) || layout.stats.variantSectionCount < 0) {
    throw new Error(`${trackName} / ${layout.name}: expected non-negative variantSectionCount`);
  }
}

function validateGeometryResultForTrack(track, geometryResult) {
  const actualLayoutNames = Array.isArray(geometryResult?.layouts)
    ? geometryResult.layouts.map(layout => layout.name)
    : [];

  if (actualLayoutNames.length === 0) {
    throw new Error(`${track.trackName}: expected at least one layout`);
  }

  const expectedLayoutNames = track.expectedLayoutNames ?? [];
  if (expectedLayoutNames.length > 0) {
    const matchesExpectedLayouts = expectedLayoutNames.length === actualLayoutNames.length
      && expectedLayoutNames.every((layoutName, index) => actualLayoutNames[index] === layoutName);

    if (!matchesExpectedLayouts) {
      throw new Error(`${track.trackName}: expected layouts ${expectedLayoutNames.join(', ')} but received ${actualLayoutNames.join(', ')}`);
    }
  }
}

function applyStableLayoutNames(track, geometryResult) {
  if (!geometryResult || !Array.isArray(geometryResult.layouts)) {
    return geometryResult;
  }

  const expectedLayoutNames = track.expectedLayoutNames ?? [];
  if (expectedLayoutNames.length === 0 || geometryResult.layouts.length !== expectedLayoutNames.length) {
    return geometryResult;
  }

  const alreadyMatches = geometryResult.layouts.every((layout, index) => layout.name === expectedLayoutNames[index]);
  if (alreadyMatches) {
    return geometryResult;
  }

  return {
    ...geometryResult,
    layouts: geometryResult.layouts.map((layout, index) => ({
      ...layout,
      name: expectedLayoutNames[index],
    })),
  };
}

function buildStableLayoutIds(layouts) {
  const counts = new Map();

  return layouts.map(layout => {
    const baseId = slugify(layout.name);
    const occurrence = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, occurrence);
    return {
      ...layout,
      id: occurrence === 1 ? baseId : `${baseId}-${occurrence}`,
    };
  });
}

function buildTrackArtifact(track, geometryResult, generatedAt) {
  const layouts = buildStableLayoutIds(geometryResult.layouts).map(layout => {
    validateLayout(layout, track.trackName);
    return {
      id: layout.id,
      name: layout.name,
      nodes: layout.nodes.map(node => ({ lat: node.lat, lon: node.lon })),
      stats: {
        lengthMetres: layout.stats.lengthMetres,
        segmentCount: layout.stats.segmentCount,
        variantSectionCount: layout.stats.variantSectionCount,
      },
    };
  });

  return {
    [track.wikidataId]: {
      trackId: track.wikidataId,
      name: track.trackName,
      source: {
        kind: 'osm-prebuilt',
        generatedAt,
        osmQueryVersion: 1,
      },
      center: {
        lat: track.lat,
        lon: track.lon,
      },
      names: {
        searchLabel: track.label,
        shortName: track.wikidataShortName ?? null,
        osmVenueNames: [...(geometryResult.osmVenueNames ?? [])],
      },
      layouts,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const tracks = resolveSupportedTracks(options.track);
  const generatedAt = new Date().toISOString();
  const report = {
    builtSuccessfully: [],
    skipped: [],
    flaggedForManualReview: [],
    failed: [],
  };
  const artifact = {};

  for (const track of tracks) {
    try {
      let geometryResult;
      let sourceUsed = options.source;

      if (options.source === 'overpass') {
        geometryResult = await fetchFallbackGeometryFromOverpass(track);
        geometryResult = applyStableLayoutNames(track, geometryResult);
        validateGeometryResultForTrack(track, geometryResult);
        report.flaggedForManualReview.push({
          wikidataId: track.wikidataId,
          name: track.trackName,
          message: 'Built from the Overpass debug path',
        });
      } else {
        try {
          geometryResult = await fetchPrimaryGeometryFromOsmApi(track);
          geometryResult = applyStableLayoutNames(track, geometryResult);
          validateGeometryResultForTrack(track, geometryResult);
        } catch (error) {
          const primaryError = error;

          if (options.allowOverpassFallback) {
            try {
              geometryResult = await fetchFallbackGeometryFromOverpass(track);
              geometryResult = applyStableLayoutNames(track, geometryResult);
              validateGeometryResultForTrack(track, geometryResult);
              sourceUsed = 'overpass-fallback';
              report.flaggedForManualReview.push({
                wikidataId: track.wikidataId,
                name: track.trackName,
                message: `OSM API build path failed validation; used Overpass fallback (${primaryError instanceof Error ? primaryError.message : String(primaryError)})`,
              });
            } catch (fallbackError) {
              throw new Error(`OSM API and Overpass build paths failed validation (${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`);
            }
          } else {
            throw primaryError;
          }
        }
      }

      const trackArtifact = buildTrackArtifact(track, geometryResult, generatedAt);
      trackArtifact[track.wikidataId].source.buildSource = sourceUsed;
      Object.assign(artifact, trackArtifact);
      report.builtSuccessfully.push({
        wikidataId: track.wikidataId,
        name: track.trackName,
        layoutCount: trackArtifact[track.wikidataId].layouts.length,
      });
    } catch (error) {
      report.failed.push({
        wikidataId: track.wikidataId,
        name: track.trackName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!options.validateOnly && report.failed.length === 0) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  console.log(`Built successfully: ${report.builtSuccessfully.length}`);
  for (const item of report.builtSuccessfully) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.layoutCount} layouts`);
  }

  console.log(`Skipped: ${report.skipped.length}`);
  console.log(`Flagged for manual review: ${report.flaggedForManualReview.length}`);
  for (const item of report.flaggedForManualReview) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.message}`);
  }
  console.log(`Failed: ${report.failed.length}`);
  for (const item of report.failed) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.message}`);
  }

  if (report.failed.length > 0) {
    process.exitCode = 1;
  }

  if (!options.validateOnly && report.failed.length === 0 && report.builtSuccessfully.length > 0) {
    console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
