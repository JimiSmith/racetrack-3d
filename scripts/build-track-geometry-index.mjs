import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import trackSearchIndex from '../src/generated/track-search-index.json' with { type: 'json' };
import { buildTrackGeometryFromPayload } from '../src/geometry/track-geometry.js';
import { normalizeTrackGeometryResult } from '../src/geometry/normalize.js';
import { extractWays } from '../src/geometry/osm-elements.js';
import { stitchWaysOrdered } from '../src/geometry/way-stitching.js';
import { closeNodeChainIfNearClosed, dedupeSequentialNodes } from '../src/geometry/chain-cleanup.js';
import { measurePolylineLength } from '../src/geometry/geo-math.js';
import {
  fetchAdaptiveOsmApiMapPayload,
  fetchOsmApiMapPayload,
  flattenSuperRelations,
  parseOsmApiMapXml,
  supplementPayloadWithMissingRelationWays,
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
const GEOMETRY_FAILURE_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const GEOMETRY_FAILURE_STALE_JITTER_MS = 1 * 24 * 60 * 60 * 1000;

const TRACK_BUILD_OVERRIDES = new Map([
  ['Q174090', {
    key: 'circuit-de-la-sarthe',
    osmApiMargins: [0.015, 0.025, 0.04, 0.08],
    expectedLayoutNames: ['Circuit des 24 Heures du Mans', 'Circuit Bugatti'],
  }],
  ['Q928721', {
    key: 'bugatti-circuit',
    osmApiMargins: [0.015, 0.025, 0.04, 0.08],
    expectedLayoutNames: ['Circuit des 24 Heures du Mans', 'Circuit Bugatti'],
  }],
  ['Q171402', {
    key: 'silverstone',
    osmApiMargins: [0.02, 0.04, 0.08],
    manualLayoutWays: [
      {
        name: 'Grand Prix',
        // Full GP circuit without pit lane (~5890m).
        // Pit Straight → Copse → Maggotts → Becketts → Chapel → Hangar Straight →
        // Stowe → Vale → Club → Hamilton Straight → Abbey → Farm Curve → Village →
        // The Loop → Aintree → Wellington Straight → Brooklands → Luffield → Woodcote.
        wayIds: [
          3571477, 169730585, 169730587, 169733768, 169730586, 430075118,
          169733766, 169733769, 169733770, 169848880, 169848884, 169848881,
          55224168, 55224167, 169854842, 169800226, 169800223, 169800225,
          169848882, 169800224, 169800222, 169618242, 169618240, 169618241,
          169618245, 169609611, 169730588,
        ],
      },
      {
        name: 'National',
        // Pit Straight → Copse → Maggotts → connector (227820537) → Wellington Straight →
        // Brooklands → Luffield → Woodcote (~2639m).
        // Way 169730586 sliced at junction with connector 227820537 (position 2/6).
        wayIds: [
          3571477, 169730585, 169730587, 169733768,
          { wayId: 169730586, toNode: { lat: 52.0731007, lon: -1.0096291 } },
          227820537,
          169618242, 169618240, 169618241,
          169618245, 169609611, 169730588,
        ],
      },
      {
        name: 'Long National',
        // Pit Straight → Copse → Maggotts → Becketts → partial Chapel →
        // The Link (227820535 + 227820536 reversed) → partial Loop → Aintree →
        // Wellington Straight → Brooklands → Luffield → Woodcote (~3257m).
        // Way 169733766 (Chapel Curve) sliced at the Link junction (position 23/27).
        // Way 227820536 sliced from Loop junction (idx 0) to shared node (idx 19);
        // chainManualWays reverses it to connect from the 227820535 end.
        // Way 169800224 (The Loop) sliced from the Link junction (position 9/35).
        wayIds: [
          3571477, 169730585, 169730587, 169733768, 169730586, 430075118,
          { wayId: 169733766, toNode: { lat: 52.0704519, lon: -1.0097476 } },
          227820535,
          { wayId: 227820536, fromNode: { lat: 52.0714208, lon: -1.0124441 }, toNode: { lat: 52.0706238, lon: -1.0105705 } },
          { wayId: 169800224, fromNode: { lat: 52.0714208, lon: -1.0124441 } },
          169800222, 169618242, 169618240, 169618241,
          169618245, 169609611, 169730588,
        ],
      },
      {
        name: 'International',
        // Village → partial Loop → The Link (227820536 + 227820535 reversed) →
        // partial Chapel → Hangar Straight → Stowe → Vale → Club →
        // Hamilton Straight → Abbey → Farm Curve → Village (~2979m).
        // Way 169800224 (The Loop) sliced to the Link junction (position 9/35).
        // Way 227820536 sliced from Loop junction (idx 0) to shared node (idx 19).
        wayIds: [
          169848882,
          { wayId: 169800224, toNode: { lat: 52.0714208, lon: -1.0124441 } },
          { wayId: 227820536, fromNode: { lat: 52.0714208, lon: -1.0124441 }, toNode: { lat: 52.0706238, lon: -1.0105705 } },
          227820535,
          { wayId: 169733766, fromNode: { lat: 52.0704519, lon: -1.0097476 } },
          169733769, 169733770, 169848880, 169848884, 169848881,
          55224168, 55224167, 169854842, 169800226, 169800223, 169800225,
        ],
      },
    ],
  }],
  ['Q172851', {
    key: 'spa',
    osmApiMargins: [0.03, 0.05, 0.08],
    // The "Moto layout" OSM way (1134119259) is a parallel alternative to Way 126807106
    // "Speaker's Corner" at the Bus Stop chicane. Both circuits are ~7,004m. Using
    // manualLayoutWays to avoid the Rallycross circuit ways being incorrectly detected
    // as a layout variant (they share endpoints with the backbone but are not part of
    // the racing circuit).
    manualLayoutWays: [
      {
        name: 'Main',
        wayIds: [
          175178448, 126807110, 126835639, 126835637, 126835638,
          1430527230, 24449918, 126807113, 175195997, 126807111,
          126807112, 1359025268, 126807106, 1359025267, 126807103,
          126807101, 126807109, 126807116, 175371353, 175371365,
          126807100, 176133746, 126807114, 176133745, 178964809,
          126807105, 637268672, 613486590, 126807099, 175178443,
        ],
      },
      {
        name: 'Moto',
        // Same as Main but with Way 1134119259 "Moto layout" replacing Way 126807106
        // "Speaker's Corner" at the Bus Stop chicane section.
        wayIds: [
          175178448, 126807110, 126835639, 126835637, 126835638,
          1430527230, 24449918, 126807113, 175195997, 126807111,
          126807112, 1359025268, 1134119259, 1359025267, 126807103,
          126807101, 126807109, 126807116, 175371353, 175371365,
          126807100, 176133746, 126807114, 176133745, 178964809,
          126807105, 637268672, 613486590, 126807099, 175178443,
        ],
      },
      {
        name: 'Rallycross',
        // ~992m loop branching off interior nodes of the main circuit.
        // Raidillon (126835637) splits at node ~(50.4411262, 5.9719918); the rallycross
        // returns via the rallycross-exclusive ways and rejoins Way 126807110 at node
        // ~(50.4429533, 5.9698663) before exiting via Eau Rouge (126835639).
        wayIds: [
          { wayId: 126835637, toNode: { lat: 50.4411262, lon: 5.9719918 } },
          689853533,
          1467574854,
          689853534,
          1467574855,
          { wayId: 126807110, fromNode: { lat: 50.4429533, lon: 5.9698663 } },
          126835639,
        ],
      },
    ],
  }],
  ['Q171332', {
    key: 'bahrain',
    osmApiMargins: [0.02, 0.04, 0.08],
    expectedLayoutNames: ['Grand Prix Circuit', 'Endurance Circuit', 'Paddock Layout', 'Outer Circuit', 'Inner Circuit'],
    layoutLengthTargets: {
      'inner': 2550,
      'oval|test': 2500,
    },
  }],
  ['Q171566', {
    key: 'red-bull-ring',
    layoutLengthTargets: {
      's[uü]dschleife|national': 2336,
    },
  }],
  ['Q964148', {
    key: 'road-atlanta',
    manualLayoutWays: [
      { name: 'Grand Prix Circuit', wayIds: [9292566, 1360423184, 1360423185] },
      {
        name: 'Motorcycle Grand Prix Circuit',
        // Two bypasses replacing sections of 9292566:
        // 1. Turn 3-4 bypass (396643998): replaces 9292566[2→16] with wider chicane variant.
        //    Way runs 16→2; chainManualWays reverses it to 2→16.
        // 2. Motorcycle Turn 12 (396643996): replaces 9292566[66→87] with wider outer line.
        //    Way runs 87→66; chainManualWays reverses it to 66→87.
        wayIds: [
          { wayId: 9292566, toNode: { lat: 34.1436808, lon: -83.8136247 } },
          396643998,
          { wayId: 9292566, fromNode: { lat: 34.1449536, lon: -83.8124019 }, toNode: { lat: 34.15073, lon: -83.8149465 } },
          396643996,
          { wayId: 9292566, fromNode: { lat: 34.1497475, lon: -83.8177532 } },
          1360423184,
          1360423185,
        ],
      },
      {
        name: 'Short Course',
        // Uses the back section (9292566) and the start/finish area, cutting across
        // via Short Course Turn 5 (way 109915840) instead of the full infield.
        // 109915840 runs from 1360423185[12] to 1360423184[6]; chainManualWays reverses it.
        wayIds: [
          9292566,
          { wayId: 1360423184, toNode: { lat: 34.1436242, lon: -83.8187567 } },
          109915840,
          { wayId: 1360423185, fromNode: { lat: 34.1416871, lon: -83.815945 } },
        ],
      },
      {
        name: 'Club Course',
        // Tightest configuration: a single loop within 1360423184 via the Club Course
        // bypass (way 109915843) between 1360423184[8] and 1360423184[62].
        wayIds: [
          { wayId: 1360423184, fromNode: { lat: 34.1412977, lon: -83.8183866 }, toNode: { lat: 34.1402094, lon: -83.8165023 } },
          109915843,
        ],
      },
    ],
  }],
  ['Q173766', {
    key: 'killarney',
    osmApiMargins: [0.001875, 0.00375, 0.0075],
    // Way 42125321 is the complete main circuit loop.
    // Ways 577101109 and 577101110 are drag strip access ways that share junction nodes
    // at idx 74 (lat=-33.820469, lon=18.529898) and idx 133 (lat=-33.821229, lon=18.529697)
    // of the main loop — including them creates a spurious triangular "A" shape at the
    // northern start/finish area.
    // Way 552975948 is an 8-node cross-cut connecting idx 73→idx 12 of the main loop,
    // forming the short circuit by skipping the northern start/finish section.
    manualLayoutWays: [
      {
        name: 'Main',
        wayIds: [42125321],
      },
      {
        name: 'Short',
        // 42125321 from idx 12 (lat=-33.820682, lon=18.528707) to
        // idx 73 (lat=-33.820102, lon=18.528738) — the main southern body,
        // skipping the northern start/finish section and drag strip.
        // 552975948 then runs from idx 73 back to idx 12 to close the loop.
        wayIds: [
          { wayId: 42125321, fromNode: { lat: -33.820682, lon: 18.528707 }, toNode: { lat: -33.820102, lon: 18.528738 } },
          552975948,
        ],
      },
    ],
  }],
  ['Q847633', {
    key: 'virginia-international-raceway',
    manualLayoutWays: [
      {
        name: 'Full Course',
        wayIds: [
          20293988, 1315957517, 1315957518, 1315957519, 1315957520,
          1315957521, 1315957522, 1315957523, 1315957524, 1315957525,
          1315957526, 1315957527, 1315957528, 91012202, 1315957529,
          1315957530, 1315957516,
        ],
      },
      { name: 'Patriot Course', wayIds: [20299611, 1315957535] },
    ],
  }],
]);

export const SUPPORTED_TRACKS = trackSearchIndex
  .filter(track => Number.isFinite(track.lat) && Number.isFinite(track.lon) && track.wikidataId)
  .map(track => ({
    ...track,
    ...(TRACK_BUILD_OVERRIDES.get(track.wikidataId) ?? {}),
  }));

function buildGeometryHints(track) {
  const hints = {};
  if (track.layoutLengthTargets) {
    hints.layoutLengthTargets = track.layoutLengthTargets;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
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

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function measurePolylineLengthLocal(nodes) {
  let length = 0;

  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1];
    const next = nodes[i];
    const avgLat = ((prev.lat + next.lat) / 2) * Math.PI / 180;
    const dx = (next.lon - prev.lon) * Math.cos(avgLat) * 111320;
    const dy = (next.lat - prev.lat) * 111320;
    length += Math.hypot(dx, dy);
  }

  return length;
}

const MANUAL_WAY_SNAP_TOLERANCE = 1e-5;

function findNearestNodeIndex(nodes, target, wayId, contextLabel) {
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < nodes.length; i += 1) {
    const dLat = nodes[i].lat - target.lat;
    const dLon = nodes[i].lon - target.lon;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestDist > MANUAL_WAY_SNAP_TOLERANCE) {
    throw new Error(
      `${contextLabel}: way ${wayId} has no node within snap tolerance of ` +
      `(${target.lat}, ${target.lon}) — nearest gap: ${bestDist.toFixed(6)}`,
    );
  }

  return bestIdx;
}

export function sliceWayNodes(nodes, fromNode, toNode, wayId, contextLabel) {
  let startIdx = 0;
  let endIdx = nodes.length - 1;

  if (fromNode != null) {
    startIdx = findNearestNodeIndex(nodes, fromNode, wayId, contextLabel);
  }
  if (toNode != null) {
    endIdx = findNearestNodeIndex(nodes, toNode, wayId, contextLabel);
  }

  if (startIdx > endIdx) {
    throw new Error(
      `${contextLabel}: way ${wayId} partial spec produces an empty or reversed slice ` +
      `(fromNode index ${startIdx} > toNode index ${endIdx})`,
    );
  }

  return nodes.slice(startIdx, endIdx + 1);
}

function chainManualWays(ways, contextLabel) {
  if (ways.length === 0) {
    throw new Error(`${contextLabel}: no ways provided to chain`);
  }

  let nodes = [...ways[0].nodes];

  for (let i = 1; i < ways.length; i += 1) {
    const way = ways[i];
    const chainEnd = nodes[nodes.length - 1];
    const wayStart = way.nodes[0];
    const wayEnd = way.nodes[way.nodes.length - 1];

    const dFLat = chainEnd.lat - wayStart.lat;
    const dFLon = chainEnd.lon - wayStart.lon;
    const forwardDist = Math.sqrt(dFLat * dFLat + dFLon * dFLon);

    const dRLat = chainEnd.lat - wayEnd.lat;
    const dRLon = chainEnd.lon - wayEnd.lon;
    const reverseDist = Math.sqrt(dRLat * dRLat + dRLon * dRLon);

    if (forwardDist <= MANUAL_WAY_SNAP_TOLERANCE) {
      nodes = [...nodes, ...way.nodes.slice(1)];
    } else if (reverseDist <= MANUAL_WAY_SNAP_TOLERANCE) {
      nodes = [...nodes, ...[...way.nodes].reverse().slice(1)];
    } else {
      throw new Error(
        `${contextLabel}: way ${way.id} does not connect to the previous way endpoint ` +
        `(forward gap: ${forwardDist.toFixed(6)}, reverse gap: ${reverseDist.toFixed(6)})`,
      );
    }
  }

  return nodes;
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
    validateOnly: false,
    strict: false,
    force: false,
    cacheDir: defaultCacheDir,
    cacheTtlHours: DEFAULT_CACHE_TTL_HOURS,
    noCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/build-track-geometry-index.mjs [options]

Options:
  --track <id>          Build only the track matching this Wikidata ID or name
  --force               Skip the staleness check and unconditionally re-fetch geometry.
                        Requires exactly one track to be specified via --track.
  --limit <n>           Maximum number of stale tracks to rebuild in one run
  --validate-only       Validate geometry without writing files
  --strict              Exit with error if any track fails or uses cached geometry
  --cache-dir <path>    Local OSM API response cache directory
  --cache-ttl-hours <n> Cache TTL in hours (default: ${DEFAULT_CACHE_TTL_HOURS})
  --no-cache            Disable local OSM API response cache
  --help, -h            Show this help message`);
      process.exit(0);
    }

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

    if (arg === '--force') {
      options.force = true;
    }
  }

  if (options.force && !options.track) {
    throw new Error('--force requires exactly one track to be specified (e.g. --track Q171332)');
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
    payload: parseOsmApiMapXml(cachedEntry.xml, { wikidataId: track.wikidataId }),
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

async function fetchOsmApiPayloadWithCache(track, margin, options) {
  const cachedResponse = await readCachedOsmPayload(track, margin, options);
  const response = cachedResponse ?? await fetchOsmApiMapPayload(track.lat, track.lon, { margin, wikidataId: track.wikidataId });
  if (!cachedResponse) {
    await writeCachedOsmPayload(track, margin, response, options);
  }
  return {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      cacheHit: Boolean(cachedResponse),
    },
  };
}

/**
 * Build a closed-loop polyline from a relation's way members.
 */
function buildSubRelationLoop(relation) {
  const elements = [
    ...relation.members
      .filter(m => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2)
      .map(m => ({ type: 'way', id: m.ref, tags: {}, geometry: m.geometry })),
    { type: 'relation', ...relation },
  ];
  const ways = extractWays(elements);
  if (ways.length === 0) { return []; }
  return closeNodeChainIfNearClosed(dedupeSequentialNodes(stitchWaysOrdered(ways)));
}

/**
 * Find the index of the node on `loop` closest to `target`.
 */
function findClosestLoopIndex(loop, target) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = Math.sqrt((loop[i].lat - target.lat) ** 2 + (loop[i].lon - target.lon) ** 2);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Extract a segment from a closed loop going forward from `startIdx` to `endIdx`
 * (wrapping around if needed). Inclusive of both endpoints.
 */
function extractLoopSegment(loop, startIdx, endIdx) {
  // Skip the duplicate closing node for wrap-around calculations.
  const isClosed = loop.length > 2
    && loop[0].lat === loop[loop.length - 1].lat
    && loop[0].lon === loop[loop.length - 1].lon;
  const n = isClosed ? loop.length - 1 : loop.length;
  const segment = [];
  for (let i = startIdx; ; i = (i + 1) % n) {
    segment.push(loop[i]);
    if (i === endIdx) { break; }
    if (segment.length > n) { break; } // safety
  }
  return segment;
}

/**
 * Build combined layouts from super-relations by splicing individual sub-circuit
 * loops via connecting ways. Unlike greedy stitching (which fails at junctions
 * where 3+ ways meet), this approach builds each sub-circuit's polyline
 * independently, then joins them at the connecting way attachment points.
 *
 * Requires exactly 2 sub-relations and at least 1 connecting way.
 */
function buildCombinedSuperRelationLayouts(preFlattened, flattenedPayload, existingLayouts) {
  const flatElements = flattenedPayload?.elements ?? [];
  const preElements = preFlattened?.elements ?? [];

  // Find super-relations from the pre-flattened payload (still has sub-relation members)
  const preSuperRelations = preElements.filter(
    e => e.type === 'relation' && e.members?.some(m => m.type === 'relation'),
  );
  if (preSuperRelations.length === 0) {
    return [];
  }

  const combinedLayouts = [];
  for (const preSuperRel of preSuperRelations) {
    // Identify sub-relation IDs and connecting way IDs from the pre-flattened structure
    const subRelationIds = preSuperRel.members.filter(m => m.type === 'relation').map(m => m.ref);
    const connectingWayIds = new Set(preSuperRel.members.filter(m => m.type === 'way').map(m => m.ref));

    if (subRelationIds.length !== 2 || connectingWayIds.size === 0) {
      continue; // only handle 2-sub-relation topology for now
    }

    // Build each sub-relation's loop from the supplemented (pre-flatten) payload
    const subRelations = subRelationIds.map(id => preElements.find(e => e.type === 'relation' && e.id === id)).filter(Boolean);
    if (subRelations.length !== 2) { continue; }

    const loops = subRelations.map(buildSubRelationLoop);
    if (loops.some(l => l.length < 4)) { continue; }

    // Get connecting way geometries from the pre-flatten super-relation members
    const connectingWays = [...connectingWayIds]
      .map(id => {
        const m = preSuperRel.members.find(m => m.ref === id && m.type === 'way');
        return { id, geometry: m?.geometry ?? [] };
      })
      .filter(cw => cw.geometry.length >= 2);

    if (connectingWays.length < 2) { continue; }

    // Find which two connecting ways bridge BETWEEN the two loops (not parallel paths).
    // A bridging way has one endpoint near loop A and the other near loop B.
    const ATTACH_THRESHOLD = 2e-3; // ~200m
    const bridgeWays = connectingWays.filter(cw => {
      const start = cw.geometry[0];
      const end = cw.geometry[cw.geometry.length - 1];
      const startNearA = findNearestDist(loops[0], start) < ATTACH_THRESHOLD;
      const startNearB = findNearestDist(loops[1], start) < ATTACH_THRESHOLD;
      const endNearA = findNearestDist(loops[0], end) < ATTACH_THRESHOLD;
      const endNearB = findNearestDist(loops[1], end) < ATTACH_THRESHOLD;
      // One end near A, other near B (or vice versa)
      return (startNearA && endNearB) || (startNearB && endNearA);
    });

    if (bridgeWays.length < 2) { continue; }

    // Select two bridges that connect DIFFERENT junction points on each loop.
    // Parallel bridges (e.g. pit lane + track between the same two junctions)
    // must not be used together — they'd produce a degenerate 0-length segment.
    const SAME_POINT_THRESHOLD = 5e-4;
    let bridge1 = null;
    let bridge2 = null;
    bridgeWays.sort((a, b) => measurePolylineLength(b.geometry) - measurePolylineLength(a.geometry));
    for (let i = 0; i < bridgeWays.length && !bridge2; i++) {
      for (let j = i + 1; j < bridgeWays.length && !bridge2; j++) {
        const bi = bridgeWays[i], bj = bridgeWays[j];
        const biStart = bi.geometry[0], biEnd = bi.geometry[bi.geometry.length - 1];
        const bjStart = bj.geometry[0], bjEnd = bj.geometry[bj.geometry.length - 1];
        // Check that they don't connect the same pair of points
        const sameStartStart = findNearestDist([biStart], bjStart) < SAME_POINT_THRESHOLD;
        const sameEndEnd = findNearestDist([biEnd], bjEnd) < SAME_POINT_THRESHOLD;
        const sameStartEnd = findNearestDist([biStart], bjEnd) < SAME_POINT_THRESHOLD;
        const sameEndStart = findNearestDist([biEnd], bjStart) < SAME_POINT_THRESHOLD;
        if (!(sameStartStart && sameEndEnd) && !(sameStartEnd && sameEndStart)) {
          bridge1 = bi;
          bridge2 = bj;
        }
      }
    }
    if (!bridge1 || !bridge2) { continue; }

    // Orient each bridge: ensure start is on loop[0] (A) and end is on loop[1] (B).
    function orientBridge(bridge) {
      const start = bridge.geometry[0];
      const startDistA = findNearestDist(loops[0], start);
      const startDistB = findNearestDist(loops[1], start);
      if (startDistA <= startDistB) {
        // start is on A, end is on B — correct orientation
        return bridge.geometry;
      }
      // Reverse so start is on A
      return [...bridge.geometry].reverse();
    }

    const bridge1Geo = orientBridge(bridge1);
    const bridge2Geo = orientBridge(bridge2);

    // Find attachment indices on each loop
    const a1 = findClosestLoopIndex(loops[0], bridge1Geo[0]);
    const a2 = findClosestLoopIndex(loops[0], bridge2Geo[0]);
    const b1 = findClosestLoopIndex(loops[1], bridge1Geo[bridge1Geo.length - 1]);
    const b2 = findClosestLoopIndex(loops[1], bridge2Geo[bridge2Geo.length - 1]);

    // Build the combined path:
    // A[a2 → ... → a1] + bridge1 → B[b1 → ... → b2] + bridge2_reversed → back to A[a2]
    // We take the LONG way around each loop (the main circuit, not the shortcut).
    const segA = extractLoopSegment(loops[0], a2, a1);
    const segB = extractLoopSegment(loops[1], b1, b2);
    const bridge2Reversed = [...bridge2Geo].reverse();

    const combined = [
      ...segA,
      ...bridge1Geo.slice(1), // skip first node (same as segA end)
      ...segB.slice(1),       // skip first node (same as bridge1 end)
      ...bridge2Reversed.slice(1), // skip first node (same as segB end)
    ];

    // Close the loop
    if (combined.length > 2) {
      combined.push(combined[0]);
    }

    const nodes = dedupeSequentialNodes(combined);
    const length = measurePolylineLength(nodes);

    // Only add if significantly longer than the longest existing layout
    const longestExisting = Math.max(...(existingLayouts ?? []).map(l => l.stats?.lengthMetres ?? 0), 0);
    if (length < longestExisting * 1.08 || nodes.length < 4) {
      continue;
    }

    // Pick the name from the flattened super-relation (which has the _wasSuperRelation tag)
    const flatSuperRel = flatElements.find(e => e.type === 'relation' && e.id === preSuperRel.id);
    const name = flatSuperRel?.tags?.name ?? preSuperRel.tags?.name ?? 'Combined';

    combinedLayouts.push({
      id: `combined-${preSuperRel.id}`,
      name,
      nodes,
      stats: {
        lengthMetres: length,
        segmentCount: segA.length + segB.length + bridge1Geo.length + bridge2Geo.length,
        variantSectionCount: 0,
      },
    });
  }

  return combinedLayouts;
}

function findNearestDist(loop, target) {
  let best = Infinity;
  for (const node of loop) {
    const d = Math.sqrt((node.lat - target.lat) ** 2 + (node.lon - target.lon) ** 2);
    if (d < best) { best = d; }
  }
  return best;
}

async function fetchPrimaryGeometryFromOsmApi(track, options) {
  const margins = Array.isArray(track.osmApiMargins) && track.osmApiMargins.length > 0
    ? track.osmApiMargins
    : buildDefaultOsmApiMargins(track);

  try {
    const response = await fetchAdaptiveOsmApiMapPayload(track.lat, track.lon, {
      margins,
      fetchForMargin: margin => fetchOsmApiPayloadWithCache(track, margin, options),
      evaluateResponse: resolvedResponse => {
        const geometryResult = sanitizeBuildGeometryResult(normalizeTrackGeometryResult(
          buildTrackGeometryFromPayload(resolvedResponse.payload, track.trackName, buildGeometryHints(track)),
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

    // Supplement the chosen response with any relation member ways that fell outside
    // the bbox (e.g. street circuits like Albert Park whose relation spans roads beyond
    // the node-limit-safe bbox). This runs once on the selected margin's response rather
    // than on every adaptive probe — patching the result we intend to keep, not discards.
    const supplementedPayload = await supplementPayloadWithMissingRelationWays(response.payload, { wikidataId: track.wikidataId });
    const flattenedPayload = flattenSuperRelations(supplementedPayload);

    // Exclude super-relations from the generic geometry pipeline — they contain all
    // sub-relation ways and would produce a near-duplicate of the longest sub-circuit,
    // displacing the sub-circuit's proper name through dedup. Super-relations are
    // handled separately via buildCombinedSuperRelationLayouts below.
    const pipelinePayload = {
      ...flattenedPayload,
      elements: (flattenedPayload?.elements ?? []).filter(
        e => !(e.type === 'relation' && e.tags?._wasSuperRelation),
      ),
    };
    const supplementedGeometryResult = sanitizeBuildGeometryResult(normalizeTrackGeometryResult(
      buildTrackGeometryFromPayload(pipelinePayload, track.trackName, buildGeometryHints(track)),
      track.trackName,
    ));
    const baseGeometryResult = (supplementedGeometryResult?.layouts?.length ?? 0) > 0
      ? supplementedGeometryResult
      : response.evaluation.geometryResult;

    // Add combined layouts from super-relations (e.g. Nürburgring Gesamtstrecke =
    // Nordschleife + GP Strecke connected via linking ways).
    const combinedLayouts = buildCombinedSuperRelationLayouts(supplementedPayload, flattenedPayload, baseGeometryResult?.layouts);
    const geometryResult = combinedLayouts.length > 0
      ? { ...baseGeometryResult, layouts: [...(baseGeometryResult?.layouts ?? []), ...combinedLayouts] }
      : baseGeometryResult;

    return {
      geometryResult,
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
    throw new Error(`OSM API build path failed for ${track.trackName} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
}


async function buildGeometryFromManualWayIds(track, options) {
  const { manualLayoutWays } = track;
  const requiredWayIds = [...new Set(
    manualLayoutWays.flatMap(layout =>
      layout.wayIds.map(entry => (typeof entry === 'number' ? entry : entry.wayId))
    )
  )];
  const margins = Array.isArray(track.osmApiMargins) && track.osmApiMargins.length > 0
    ? track.osmApiMargins
    : buildDefaultOsmApiMargins(track);

  let resolvedResponse = null;
  let resolvedMargin = null;
  let lastError = null;

  for (const margin of margins) {
    let response;

    try {
      response = await fetchOsmApiPayloadWithCache(track, margin, options);
    } catch (error) {
      lastError = error;
      continue;
    }

    const foundIds = new Set(
      (response.payload?.elements ?? [])
        .filter(e => e.type === 'way' && Number.isFinite(e.id))
        .map(e => e.id),
    );
    const missingIds = requiredWayIds.filter(id => !foundIds.has(id));

    if (missingIds.length === 0) {
      resolvedResponse = response;
      resolvedMargin = margin;
      break;
    }

    lastError = new Error(`margin ${margin}: missing way IDs ${missingIds.join(', ')}`);
  }

  if (!resolvedResponse) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${track.trackName}: could not find all manual way IDs in OSM API data (${message})`);
  }

  const wayIndex = new Map(
    (resolvedResponse.payload.elements ?? [])
      .filter(e => e.type === 'way' && Number.isFinite(e.id))
      .map(e => [e.id, e]),
  );

  const layouts = manualLayoutWays.map(layoutDef => {
    const contextLabel = `${track.trackName} / ${layoutDef.name}`;
    const ways = layoutDef.wayIds.map(entry => {
      const id = typeof entry === 'number' ? entry : entry.wayId;
      const element = wayIndex.get(id);
      if (!element || !Array.isArray(element.geometry) || element.geometry.length < 2) {
        throw new Error(`${track.trackName}: way ID ${id} not found or has no geometry`);
      }

      let nodes = element.geometry.map(({ lat, lon }) => ({ lat, lon }));
      if (typeof entry === 'object') {
        nodes = sliceWayNodes(nodes, entry.fromNode ?? null, entry.toNode ?? null, id, contextLabel);
      }

      return { id, nodes };
    });
    const nodes = chainManualWays(ways, contextLabel);
    return {
      name: layoutDef.name,
      nodes,
      stats: {
        lengthMetres: measurePolylineLengthLocal(nodes),
        segmentCount: ways.length,
        variantSectionCount: 0,
      },
    };
  });

  const usedWayIds = new Set(
    manualLayoutWays.flatMap(l =>
      l.wayIds.map(entry => (typeof entry === 'number' ? entry : entry.wayId))
    )
  );
  const osmVenueNames = [...new Set(
    (resolvedResponse.payload.elements ?? [])
      .filter(e => e.type === 'way' && usedWayIds.has(e.id) && e.tags?.name)
      .map(e => e.tags.name),
  )].sort((a, b) => a.localeCompare(b));

  return {
    geometryResult: {
      layouts,
      selectedLayoutIndex: 0,
      osmVenueNames,
    },
    metadata: {
      sourceUsed: 'osm-api',
      margin: resolvedMargin,
      cacheHit: resolvedResponse.metadata.cacheHit,
    },
  };
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

function finalizeGeometryResult(track, rawResult) {
  const sanitized = sanitizeBuildGeometryResult(rawResult);
  const renamed = applyStableLayoutNames(track, sanitized);
  validateGeometryResultForTrack(track, renamed);
  for (const layout of renamed.layouts) {
    validateLayout(layout, track.trackName);
  }
  return renamed;
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
  const layouts = buildStableLayoutIds(geometryResult.layouts).map(layout => ({
    id: layout.id,
    name: layout.name,
    nodes: layout.nodes.map(node => ({ lat: node.lat, lon: node.lon })),
    stats: {
      lengthMetres: layout.stats.lengthMetres,
      segmentCount: layout.stats.segmentCount,
      variantSectionCount: layout.stats.variantSectionCount,
    },
  }));

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

function buildFailureArtifact(track, generatedAt, message) {
  return {
    trackId: track.wikidataId,
    name: track.trackName,
    source: {
      kind: 'osm-prebuilt-failed',
      generatedAt,
      failureMessage: message,
    },
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

export function computeTrackFailureStaleThresholdMs(trackId) {
  const hash = computeStableHash(trackId);
  const normalized = hash / 0xffffffff;
  const jitterMs = Math.round((normalized * 2 * GEOMETRY_FAILURE_STALE_JITTER_MS) - GEOMETRY_FAILURE_STALE_JITTER_MS);
  return GEOMETRY_FAILURE_STALE_AFTER_MS + jitterMs;
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

  if (entry.source?.kind === 'osm-prebuilt-failed') {
    return ageMs < computeTrackFailureStaleThresholdMs(trackId);
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
  const { freshTracks, staleTracks, deferredTracks } = options.force
    ? { freshTracks: [], staleTracks: tracks, deferredTracks: [] }
    : await partitionTracksByStaleness(tracks, options);
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
      let sourceUsed = 'osm-api';
      let sourceDetails = '';

      if (Array.isArray(track.manualLayoutWays) && track.manualLayoutWays.length > 0) {
        const manualResult = await buildGeometryFromManualWayIds(track, options);
        geometryResult = finalizeGeometryResult(track, manualResult.geometryResult);
        sourceUsed = manualResult.metadata.sourceUsed;
        const cacheLabel = manualResult.metadata.cacheHit ? 'cache' : 'live';
        sourceDetails = `osm-api manual-ways margin=${manualResult.metadata.margin} ${cacheLabel}`;
      } else {
        const primaryResult = await fetchPrimaryGeometryFromOsmApi(track, options);
        geometryResult = finalizeGeometryResult(track, primaryResult.geometryResult);
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
        if (!options.validateOnly) {
          const failureArtifact = buildFailureArtifact(track, generatedAt, message);
          await writeArtifactToFile(failureArtifact, path.join(geometryOutputDir, `${track.wikidataId}.json`));
        }
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
