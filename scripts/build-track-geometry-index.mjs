import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import trackSearchIndex from '../src/generated/track-search-index.json' with { type: 'json' };
import { buildTrackGeometryFromOverpassPayload, fetchTrackGeometry } from '../src/search.js';
import { fetchOsmApiMapPayload } from './lib/osm-api-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'src', 'generated');
const outputPath = path.join(outputDir, 'track-geometry-index.json');
const silverstoneFixturePath = path.join(projectRoot, 'test', 'fixtures', 'silverstone.json');
const TARGET_TRACK_LABEL = 'Silverstone Circuit';
const MIN_LAYOUT_LENGTH_METRES = 500;
const MAX_LAYOUT_LENGTH_METRES = 100000;
const MIN_LAYOUT_NODE_COUNT = 50;

function parseArgs(argv) {
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

    if (arg === '--fixture') {
      options.source = 'fixture';
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

  return options;
}

async function loadFixtureGeometry(track) {
  const fixturePayload = JSON.parse(await readFile(silverstoneFixturePath, 'utf8'));
  const geometryResult = buildTrackGeometryFromOverpassPayload(fixturePayload, track.label);
  if (!geometryResult) {
    throw new Error(`Fixture source did not yield geometry for ${track.label}`);
  }

  return geometryResult;
}

async function fetchPrimaryGeometryFromOsmApi(track) {
  const { payload } = await fetchOsmApiMapPayload(track.lat, track.lon);
  const geometryResult = buildTrackGeometryFromOverpassPayload(payload, track.label);
  if (!geometryResult) {
    throw new Error(`OSM API payload did not yield geometry for ${track.label}`);
  }

  return geometryResult;
}

async function fetchFallbackGeometryFromOverpass(track) {
  return fetchTrackGeometry(track.lat, track.lon, undefined, track.label, {
    wikidataId: track.wikidataId,
    skipLocal: true,
  });
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

function resolveTargetTrack(requestedTrack) {
  const silverstone = trackSearchIndex.find(entry => entry.label === TARGET_TRACK_LABEL);
  if (!silverstone) {
    throw new Error(`Could not find ${TARGET_TRACK_LABEL} in the local track search index`);
  }

  if (!requestedTrack) {
    return silverstone;
  }

  const requestedKey = normalizeText(requestedTrack);
  const matchesSilverstone = [
    silverstone.wikidataId,
    silverstone.label,
    silverstone.wikidataShortName,
  ].some(value => normalizeText(value) === requestedKey);

  if (!matchesSilverstone) {
    throw new Error(`This prototype only supports ${TARGET_TRACK_LABEL}; received ${requestedTrack}`);
  }

  return silverstone;
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
    throw new Error(`${trackName} / ${layout.name}: expected at least ${MIN_LAYOUT_NODE_COUNT} real geometry nodes, received ${layout.nodes.length}`);
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
    validateLayout(layout, track.label);
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
      name: track.label,
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const track = resolveTargetTrack(options.track);
  const generatedAt = new Date().toISOString();
  const report = {
    builtSuccessfully: [],
    skipped: [],
    flaggedForManualReview: [],
    failed: [],
  };

  try {
    let geometryResult;
    let sourceUsed = options.source;

    if (options.source === 'fixture') {
      geometryResult = await loadFixtureGeometry(track);
      report.flaggedForManualReview.push({
        wikidataId: track.wikidataId,
        name: track.label,
        message: 'Built from the frozen Silverstone fixture debug path',
      });
    } else if (options.source === 'overpass') {
      geometryResult = await fetchFallbackGeometryFromOverpass(track);
      report.flaggedForManualReview.push({
        wikidataId: track.wikidataId,
        name: track.label,
        message: 'Built from the Overpass debug path',
      });
    } else {
      try {
        geometryResult = await fetchPrimaryGeometryFromOsmApi(track);
      } catch (error) {
        if (!options.allowOverpassFallback) {
          throw error;
        }

        geometryResult = await fetchFallbackGeometryFromOverpass(track);
        sourceUsed = 'overpass-fallback';
        report.flaggedForManualReview.push({
          wikidataId: track.wikidataId,
          name: track.label,
          message: `OSM API build path failed; used Overpass fallback (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }

    const artifact = buildTrackArtifact(track, geometryResult, generatedAt);
    artifact[track.wikidataId].source.buildSource = sourceUsed;
    report.builtSuccessfully.push({
      wikidataId: track.wikidataId,
      name: track.label,
      layoutCount: artifact[track.wikidataId].layouts.length,
    });

    if (!options.validateOnly) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }
  } catch (error) {
    report.failed.push({
      wikidataId: track.wikidataId,
      name: track.label,
      message: error instanceof Error ? error.message : String(error),
    });
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

  if (!options.validateOnly && report.builtSuccessfully.length > 0) {
    console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
  }
}

await main();
