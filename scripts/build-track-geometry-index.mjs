import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import trackSearchIndex from '../src/generated/track-search-index.json' with { type: 'json' };
import {
  buildTrackGeometryFromOverpassPayload,
  fetchTrackGeometry,
  normalizeTrackGeometryResult,
} from '../src/search.js';
import {
  fetchAdaptiveOsmApiMapPayload,
  fetchOsmApiMapPayload,
  parseOsmApiMapXml,
} from './lib/osm-api-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const geometryOutputDir = path.join(projectRoot, 'src', 'generated', 'geometry');
const defaultCacheDir = path.join(projectRoot, '.cache', 'track-geometry', 'osm-api');

const MIN_LAYOUT_LENGTH_METRES = 500;
const MAX_LAYOUT_LENGTH_METRES = 100000;
const MIN_LAYOUT_NODE_COUNT = 2;
const DEFAULT_OSM_API_MARGINS = [0.015, 0.025, 0.04, 0.08];
const DEFAULT_CACHE_TTL_HOURS = 24 * 14;
const GEOMETRY_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const GEOMETRY_STALE_JITTER_MS = 3 * 24 * 60 * 60 * 1000;
const BUILD_SOURCES = new Set(['osm-api', 'overpass']);

const TRACK_BUILD_OVERRIDES = new Map([
  ['Q171402', {
    key: 'silverstone',
    osmApiMargins: [0.02, 0.04, 0.08],
    expectedLayoutNames: ['Main', 'Alternate'],
  }],
  ['Q172851', {
    key: 'spa',
    osmApiMargins: [0.03, 0.05, 0.08],
    expectedLayoutNames: ['Main', 'Moto'],
  }],
  ['Q171332', {
    key: 'bahrain',
    osmApiMargins: [0.02, 0.04, 0.08],
    expectedLayoutNames: ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit'],
  }],
]);

export const SUPPORTED_TRACKS = trackSearchIndex
  .filter(track => Number.isFinite(track.lat) && Number.isFinite(track.lon) && track.wikidataId)
  .map(track => ({
    ...track,
    ...(TRACK_BUILD_OVERRIDES.get(track.wikidataId) ?? {}),
  }));

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

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildDefaultOsmApiMargins(track) {
  const type = normalizeText(track.type);
  if (type.includes('street')) {
    return [0.02, 0.04, 0.08];
  }

  return DEFAULT_OSM_API_MARGINS;
}

function formatDelayMs(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return null;
  }

  if (delayMs < 1000) {
    return `${Math.round(delayMs)}ms`;
  }

  const seconds = delayMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function buildTrackQueryCandidates(track) {
  return [
    track.key,
    track.wikidataId,
    track.label,
    track.trackName,
    track.wikidataShortName,
    ...(track.aliases ?? []),
  ]
    .filter(Boolean)
    .map(normalizeText);
}

export function parseArgs(argv) {
  const options = {
    track: null,
    limit: Number.POSITIVE_INFINITY,
    source: 'osm-api',
    allowOverpassFallback: true,
    validateOnly: false,
    strict: false,
    cacheDir: defaultCacheDir,
    cacheTtlHours: DEFAULT_CACHE_TTL_HOURS,
    noCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--track') {
      options.track = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      options.limit = parseNumber(argv[index + 1], options.limit);
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
      continue;
    }

    if (arg === '--strict') {
      options.strict = true;
      continue;
    }

    if (arg === '--cache-dir') {
      options.cacheDir = argv[index + 1] ?? options.cacheDir;
      index += 1;
      continue;
    }

    if (arg === '--cache-ttl-hours') {
      options.cacheTtlHours = parseNumber(argv[index + 1], options.cacheTtlHours);
      index += 1;
      continue;
    }

    if (arg === '--no-cache') {
      options.noCache = true;
    }
  }

  if (options.source === 'fixture') {
    throw new Error('Fixture source mode has been removed; use the default OSM API build path or --overpass-only for debug');
  }

  if (!BUILD_SOURCES.has(options.source)) {
    throw new Error(`Unsupported build source "${options.source}"; expected one of ${[...BUILD_SOURCES].join(', ')}`);
  }

  if (!Number.isInteger(options.limit) && options.limit !== Number.POSITIVE_INFINITY) {
    throw new Error(`Expected --limit to be an integer, received ${String(options.limit)}`);
  }

  if (options.limit < 0) {
    throw new Error(`Expected --limit to be non-negative, received ${options.limit}`);
  }

  return options;
}

export function resolveSupportedTracks(requestedTrack, searchIndex = SUPPORTED_TRACKS) {
  const supportedTracks = searchIndex
    .filter(track => Number.isFinite(track.lat) && Number.isFinite(track.lon) && track.wikidataId)
    .map(track => ({
      ...track,
      trackName: track.trackName ?? track.label,
      key: track.key ?? slugify(track.label),
      osmApiMargins: track.osmApiMargins ?? buildDefaultOsmApiMargins(track),
      expectedLayoutNames: track.expectedLayoutNames ?? [],
    }));

  if (!requestedTrack) {
    return supportedTracks;
  }

  const requestedKey = normalizeText(requestedTrack);
  const matchingTrack = supportedTracks.find(track => buildTrackQueryCandidates(track).includes(requestedKey));

  if (!matchingTrack) {
    throw new Error(`Could not find a supported track matching "${requestedTrack}" in the local track search index`);
  }

  return [matchingTrack];
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const source = await readFile(filePath, 'utf8');
    return JSON.parse(source);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

export async function loadExistingTrackEntry(wikidataId) {
  const filePath = path.join(geometryOutputDir, `${wikidataId}.json`);
  return readJsonFile(filePath, null);
}

async function readCachedOsmPayload(track, margin, options) {
  if (options.noCache || !options.cacheDir) {
    return null;
  }

  const cacheFilePath = path.join(options.cacheDir, `${track.wikidataId}-${String(margin).replace(/[^0-9.]+/g, '_')}.json`);
  const cachedEntry = await readJsonFile(cacheFilePath, null);
  if (!cachedEntry?.xml || !cachedEntry.cachedAt) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(cachedEntry.cachedAt);
  if (!Number.isFinite(ageMs) || ageMs > options.cacheTtlHours * 60 * 60 * 1000) {
    return null;
  }

  return {
    cacheHit: true,
    url: cachedEntry.url,
    xml: cachedEntry.xml,
    payload: parseOsmApiMapXml(cachedEntry.xml),
  };
}

async function writeCachedOsmPayload(track, margin, response, options) {
  if (options.noCache || !options.cacheDir || !response?.xml) {
    return;
  }

  await mkdir(options.cacheDir, { recursive: true });
  const cacheFilePath = path.join(options.cacheDir, `${track.wikidataId}-${String(margin).replace(/[^0-9.]+/g, '_')}.json`);
  await writeFile(cacheFilePath, `${JSON.stringify({
    trackId: track.wikidataId,
    margin,
    url: response.url,
    cachedAt: new Date().toISOString(),
    xml: response.xml,
  }, null, 2)}\n`);
}

async function fetchPrimaryGeometryFromOsmApi(track, options) {
  const margins = Array.isArray(track.osmApiMargins) && track.osmApiMargins.length > 0
    ? track.osmApiMargins
    : buildDefaultOsmApiMargins(track);

  try {
    const response = await fetchAdaptiveOsmApiMapPayload(track.lat, track.lon, {
      margins,
      fetchForMargin: async margin => {
        const cachedResponse = await readCachedOsmPayload(track, margin, options);
        const resolvedResponse = cachedResponse ?? await fetchOsmApiMapPayload(track.lat, track.lon, { margin });
        if (!cachedResponse) {
          await writeCachedOsmPayload(track, margin, resolvedResponse, options);
        }

        return {
          ...resolvedResponse,
          metadata: {
            ...(resolvedResponse.metadata ?? {}),
            cacheHit: Boolean(cachedResponse),
          },
        };
      },
      evaluateResponse: resolvedResponse => {
        const geometryResult = sanitizeBuildGeometryResult(normalizeTrackGeometryResult(
          buildTrackGeometryFromOverpassPayload(resolvedResponse.payload, track.trackName),
          track.trackName,
        ));

        if (!geometryResult?.layouts?.length) {
          return {
            usable: false,
            reason: 'did not yield geometry',
          };
        }

        return {
          usable: true,
          geometryResult,
        };
      },
    });

    return {
      geometryResult: response.evaluation.geometryResult,
      metadata: {
        sourceUsed: 'osm-api',
        margin: response.metadata.margin,
        cacheHit: Boolean(response.metadata.cacheHit),
        stopReason: response.metadata.stopReason,
        attempts: response.metadata.attempts,
        requestAttempts: response.metadata.requestAttempts,
        retryCount: response.metadata.retryCount,
        pacingDelayMs: response.metadata.pacingDelayMs,
        retryDelayMs: response.metadata.retryDelayMs,
      },
    };
  } catch (error) {
    throw new Error(`OSM API build path failed for ${track.trackName} (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function fetchFallbackGeometryFromOverpass(track) {
  return sanitizeBuildGeometryResult(normalizeTrackGeometryResult(
    await fetchTrackGeometry(track.lat, track.lon, undefined, track.trackName, {
      wikidataId: track.wikidataId,
      skipLocal: true,
    }),
    track.trackName,
  ));
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

export function sanitizeBuildGeometryResult(geometryResult) {
  if (!geometryResult || !Array.isArray(geometryResult.layouts)) {
    return geometryResult;
  }

  const layouts = geometryResult.layouts.filter(layout => Array.isArray(layout?.nodes) && layout.nodes.length >= 2);
  if (layouts.length === geometryResult.layouts.length) {
    return geometryResult;
  }

  return {
    ...geometryResult,
    layouts,
    selectedLayoutIndex: Math.min(geometryResult.selectedLayoutIndex ?? 0, Math.max(layouts.length - 1, 0)),
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

function buildTrackArtifact(track, geometryResult, generatedAt, sourceUsed) {
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
    trackId: track.wikidataId,
    name: track.trackName,
    source: {
      kind: 'osm-prebuilt',
      generatedAt,
      osmQueryVersion: 1,
      buildSource: sourceUsed,
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
  };
}

function computeStableHash(value) {
  let hash = 0;

  for (const char of String(value ?? '')) {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}

export function computeTrackStaleThresholdMs(trackId) {
  const hash = computeStableHash(trackId);
  const normalized = hash / 0xffffffff;
  const jitterMs = Math.round((normalized * 2 * GEOMETRY_STALE_JITTER_MS) - GEOMETRY_STALE_JITTER_MS);
  return GEOMETRY_STALE_AFTER_MS + jitterMs;
}

export function isTrackGeometryEntryFresh(entry, now = Date.now()) {
  const generatedAt = entry?.source?.generatedAt;
  const generatedAtMs = Date.parse(generatedAt);
  const trackId = entry?.trackId;

  if (!trackId || !Number.isFinite(generatedAtMs)) {
    return false;
  }

  const ageMs = now - generatedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return false;
  }

  return ageMs < computeTrackStaleThresholdMs(trackId);
}

export async function partitionTracksByStaleness(tracks, options = {}) {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const loadExistingTrackEntryFn = options.loadExistingTrackEntry ?? loadExistingTrackEntry;
  const freshTracks = [];
  const staleTracks = [];
  const deferredTracks = [];

  for (const track of tracks) {
    const existingEntry = await loadExistingTrackEntryFn(track.wikidataId);
    if (existingEntry && isTrackGeometryEntryFresh(existingEntry, now)) {
      freshTracks.push(track);
      continue;
    }

    if (staleTracks.length < limit) {
      staleTracks.push(track);
      continue;
    }

    deferredTracks.push(track);
  }

  return {
    freshTracks,
    staleTracks,
    deferredTracks,
  };
}

export function determineExitCode(report, options) {
  const skippedCount = report.skipped?.length ?? 0;

  if (report.targetedTrackFailed) {
    return 1;
  }

  if (options.strict && (report.failed.length > 0 || report.reusedExisting.length > 0 || report.flaggedForManualReview.length > 0)) {
    return 1;
  }

  if (report.builtSuccessfully.length === 0 && report.reusedExisting.length === 0 && skippedCount === 0) {
    return 1;
  }

  return 0;
}

async function writeArtifactToFile(artifact, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const tracks = resolveSupportedTracks(options.track);
  const { freshTracks, staleTracks, deferredTracks } = await partitionTracksByStaleness(tracks, options);
  const generatedAt = new Date().toISOString();
  const report = {
    builtSuccessfully: [],
    reusedExisting: [],
    skipped: [],
    flaggedForManualReview: [],
    failed: [],
    targetedTrackFailed: false,
  };
  console.log(`Building geometry index for ${tracks.length} track${tracks.length === 1 ? '' : 's'} from the local search index`);

  for (const track of freshTracks) {
    report.skipped.push({
      wikidataId: track.wikidataId,
      name: track.trackName,
      reason: 'fresh',
    });
    console.log(`${track.trackName} (${track.wikidataId}) - skipped (fresh)`);
  }

  for (const track of deferredTracks) {
    report.skipped.push({
      wikidataId: track.wikidataId,
      name: track.trackName,
      reason: 'limit',
    });
    console.log(`${track.trackName} (${track.wikidataId}) - skipped (limit reached)`);
  }

  for (const [index, track] of staleTracks.entries()) {
    const progressLabel = `[${index + 1}/${staleTracks.length}] ${track.trackName} (${track.wikidataId})`;
    const existingEntry = await loadExistingTrackEntry(track.wikidataId);
    console.log(`${progressLabel} - start`);

    try {
      let geometryResult;
      let sourceUsed = options.source;
      let sourceDetails = '';

      if (options.source === 'overpass') {
        geometryResult = await fetchFallbackGeometryFromOverpass(track);
        geometryResult = applyStableLayoutNames(track, geometryResult);
        validateGeometryResultForTrack(track, geometryResult);
        report.flaggedForManualReview.push({
          wikidataId: track.wikidataId,
          name: track.trackName,
          message: 'Built from the Overpass debug path',
        });
        sourceDetails = 'debug overpass';
      } else {
        try {
          const primaryResult = await fetchPrimaryGeometryFromOsmApi(track, options);
          geometryResult = applyStableLayoutNames(track, primaryResult.geometryResult);
          validateGeometryResultForTrack(track, geometryResult);
          sourceUsed = primaryResult.metadata.sourceUsed;
          sourceDetails = primaryResult.metadata.cacheHit
            ? `osm-api cache margin=${primaryResult.metadata.margin}`
            : `osm-api live margin=${primaryResult.metadata.margin}`;
          if (primaryResult.metadata.retryCount > 0) {
            const retryDelay = formatDelayMs(primaryResult.metadata.retryDelayMs);
            sourceDetails += ` retries=${primaryResult.metadata.retryCount}`;
            if (retryDelay) {
              sourceDetails += ` backoff=${retryDelay}`;
            }
          }
          if (primaryResult.metadata.pacingDelayMs > 0 && !primaryResult.metadata.cacheHit) {
            const pacingDelay = formatDelayMs(primaryResult.metadata.pacingDelayMs);
            if (pacingDelay) {
              sourceDetails += ` paced=${pacingDelay}`;
            }
          }
          if (primaryResult.metadata.stopReason === 'node-limit') {
            sourceDetails += ' (stopped at node limit)';
          }
        } catch (error) {
          const primaryError = error;

          if (options.allowOverpassFallback) {
            try {
              geometryResult = await fetchFallbackGeometryFromOverpass(track);
              geometryResult = applyStableLayoutNames(track, geometryResult);
              validateGeometryResultForTrack(track, geometryResult);
              sourceUsed = 'overpass-fallback';
              sourceDetails = 'overpass fallback';
              report.flaggedForManualReview.push({
                wikidataId: track.wikidataId,
                name: track.trackName,
                message: `OSM API build path failed validation; used Overpass fallback (${primaryError instanceof Error ? primaryError.message : String(primaryError)})`,
              });
            } catch (fallbackError) {
              throw new Error(`OSM API and Overpass build paths failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`);
            }
          } else {
            throw primaryError;
          }
        }
      }

      const trackArtifact = buildTrackArtifact(track, geometryResult, generatedAt, sourceUsed);
      if (!options.validateOnly) {
        await writeArtifactToFile(trackArtifact, path.join(geometryOutputDir, `${track.wikidataId}.json`));
      }
      report.builtSuccessfully.push({
        wikidataId: track.wikidataId,
        name: track.trackName,
        layoutCount: trackArtifact.layouts.length,
        sourceUsed,
      });
      console.log(`${progressLabel} - built successfully (${trackArtifact.layouts.length} layouts, ${sourceDetails || sourceUsed})`);
    } catch (error) {

      const message = error instanceof Error ? error.message : String(error);
      if (existingEntry) {
        report.reusedExisting.push({
          wikidataId: track.wikidataId,
          name: track.trackName,
          message,
        });
        report.flaggedForManualReview.push({
          wikidataId: track.wikidataId,
          name: track.trackName,
          message: `Reused existing generated geometry after build failure (${message})`,
        });
        console.log(`${progressLabel} - reused existing geometry (${message})`);
      } else {
        report.failed.push({
          wikidataId: track.wikidataId,
          name: track.trackName,
          message,
        });
        console.log(`${progressLabel} - failed (${message})`);
      }

      if (options.track) {
        report.targetedTrackFailed = true;
      }
    }

  }

  console.log('');
  console.log(`Built successfully: ${report.builtSuccessfully.length}`);
  for (const item of report.builtSuccessfully) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.layoutCount} layouts via ${item.sourceUsed}`);
  }

  console.log(`Reused existing: ${report.reusedExisting.length}`);
  for (const item of report.reusedExisting) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.message}`);
  }

  console.log(`Skipped: ${report.skipped.length}`);
  for (const item of report.skipped) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.reason}`);
  }
  console.log(`Flagged for manual review: ${report.flaggedForManualReview.length}`);
  for (const item of report.flaggedForManualReview) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.message}`);
  }

  console.log(`Failed: ${report.failed.length}`);
  for (const item of report.failed) {
    console.log(`- ${item.name} (${item.wikidataId}) -> ${item.message}`);
  }

  process.exitCode = determineExitCode(report, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
