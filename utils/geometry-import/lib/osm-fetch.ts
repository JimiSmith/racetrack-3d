import {
  buildOsmApiMapUrlForBbox,
  buildOsmApiWayFullUrl,
  parseOsmXmlRelations,
  parseOsmXmlWays,
  type ParsedOsmWay,
} from './osm-xml-parser.js';

const REQUEST_PACE_MS = 1200;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SPLIT_DEPTH = 6;
const NODE_LIMIT_PATTERN = /too many nodes/i;
const RATE_LIMIT_STATUS_CODES = new Set([429, 509]);
const RATE_LIMIT_BODY_PATTERN = /(downloaded too much data|rate limit|quota exceeded|too many requests|bandwidth limit exceeded|please wait)/i;
const RETRY_AFTER_PATTERN = /(?:please\s+)?wait\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i;
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_FALLBACK_DELAYS_MS = [5_000, 15_000];

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface FetchResult {
  ways: ParsedOsmWay[];
  bbox: Bbox;
  requestCount: number;
  relationMemberIds: Set<number>;
}

export class RateLimitExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExhaustedError';
  }
}

export class NodeLimitExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeLimitExhaustedError';
  }
}

let nextRequestAt = 0;

async function waitForPacingSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(nextRequestAt, now) + REQUEST_PACE_MS;

  if (waitMs > 0) {
    await new Promise<void>(resolve => { setTimeout(resolve, waitMs); });
  }
}

function parseRetryDelayFromBody(body: string): number | null {
  const match = body.match(RETRY_AFTER_PATTERN);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]!);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const unit = match[2]!.toLowerCase();
  if (unit.startsWith('hour')) { return amount * 60 * 60 * 1000; }
  if (unit.startsWith('minute')) { return amount * 60 * 1000; }
  return amount * 1000;
}

function resolveRetryDelay(response: Response, body: string, retryIndex: number): number {
  const headerValue = response.headers.get('retry-after');
  if (headerValue) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }

  const bodyDelay = parseRetryDelayFromBody(body);
  if (bodyDelay != null) {
    return bodyDelay;
  }

  return RATE_LIMIT_FALLBACK_DELAYS_MS[Math.min(retryIndex, RATE_LIMIT_FALLBACK_DELAYS_MS.length - 1)]!;
}

function isNodeLimitError(body: string): boolean {
  return NODE_LIMIT_PATTERN.test(body);
}

function isRateLimitResponse(status: number, body: string): boolean {
  return RATE_LIMIT_STATUS_CODES.has(status) || RATE_LIMIT_BODY_PATTERN.test(body);
}

export interface HttpFailure {
  status: number;
  body: string;
  statusText: string;
}

/**
 * Execute an OSM API GET with pacing, rate-limit retry, and timeout.
 * Resolves to the response body on success. On non-rate-limit errors
 * (including 404, 410, 5xx) resolves with `{ status, body, statusText }`
 * so callers can decide whether to throw or skip. Rate-limit exhaustion
 * always throws `RateLimitExhaustedError`.
 */
async function fetchWithRateLimitRetry(url: string): Promise<string | HttpFailure> {
  for (let retry = 0; retry <= MAX_RATE_LIMIT_RETRIES; retry++) {
    await waitForPacingSlot();

    const response = await fetch(url, {
      headers: { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return await response.text();
    }

    const body = (await response.text()).trim();

    if (isRateLimitResponse(response.status, body)) {
      if (retry < MAX_RATE_LIMIT_RETRIES) {
        const delayMs = resolveRetryDelay(response, body, retry);
        console.log(`  Rate limited, retrying in ${Math.ceil(delayMs / 1000)}s...`);
        await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
        continue;
      }
      throw new RateLimitExhaustedError(
        `OSM API rate limit exhausted after ${MAX_RATE_LIMIT_RETRIES + 1} attempts: ${body || response.statusText}`,
      );
    }

    return { status: response.status, body, statusText: response.statusText };
  }

  throw new Error('Unreachable');
}

/**
 * Fetch raw OSM XML for a single bbox, with rate-limit retry.
 * Throws with `.nodeLimitExceeded = true` on node-cap errors so the
 * caller can subdivide the bbox and retry.
 */
async function fetchSingleBbox(bbox: Bbox): Promise<string> {
  const url = buildOsmApiMapUrlForBbox(bbox.south, bbox.west, bbox.north, bbox.east);
  const result = await fetchWithRateLimitRetry(url);

  if (typeof result === 'string') {
    return result;
  }

  if (isNodeLimitError(result.body)) {
    const err = new Error(`OSM API node limit exceeded for bbox ${JSON.stringify(bbox)}`);
    (err as any).nodeLimitExceeded = true;
    throw err;
  }

  throw new Error(`OSM API request failed (${result.status}): ${result.body || result.statusText}`);
}

/**
 * Fetch a single way with all its nodes via /api/0.6/way/<id>/full.
 * Returns null on non-rate-limit failures (e.g. 404, deleted way) — the
 * caller can log and skip. Rate-limit exhaustion throws as usual.
 */
async function fetchWayFull(wayId: number): Promise<string | null> {
  const url = buildOsmApiWayFullUrl(wayId);
  const result = await fetchWithRateLimitRetry(url);

  if (typeof result === 'string') {
    return result;
  }

  console.warn(`  Warning: failed to fetch way ${wayId} (${result.status} ${result.statusText})`);
  return null;
}

function splitBbox(bbox: Bbox): [Bbox, Bbox, Bbox, Bbox] {
  const midLat = (bbox.south + bbox.north) / 2;
  const midLon = (bbox.west + bbox.east) / 2;
  return [
    { south: bbox.south, west: bbox.west, north: midLat, east: midLon },
    { south: bbox.south, west: midLon, north: midLat, east: bbox.east },
    { south: midLat, west: bbox.west, north: bbox.north, east: midLon },
    { south: midLat, west: midLon, north: bbox.north, east: bbox.east },
  ];
}

interface FetchBboxResult {
  xmls: string[];
  requestCount: number;
}

async function fetchBbox(bbox: Bbox, depth: number): Promise<FetchBboxResult> {
  try {
    const xml = await fetchSingleBbox(bbox);
    return { xmls: [xml], requestCount: 1 };
  } catch (err) {
    if (!(err as any).nodeLimitExceeded) {
      throw err;
    }

    if (depth >= MAX_SPLIT_DEPTH) {
      throw new NodeLimitExhaustedError(
        `OSM API node limit exceeded at max split depth ${MAX_SPLIT_DEPTH} for bbox ${JSON.stringify(bbox)}`,
      );
    }

    console.log(`  Too many nodes, splitting bbox into 4 quadrants (depth ${depth + 1})...`);
    const quadrants = splitBbox(bbox);
    const results = await Promise.all(quadrants.map(q => fetchBbox(q, depth + 1)));

    return {
      xmls: results.flatMap(r => r.xmls),
      requestCount: results.reduce((sum, r) => sum + r.requestCount, 0),
    };
  }
}

/**
 * Fetch OSM ways for an area centred on (lat, lon) with the given margin.
 * If the request hits the OSM node cap, the bbox is recursively split into
 * quadrants and fetched in parallel. Ways that straddle quadrant boundaries
 * are returned whole by at least one request (OSM returns the full way
 * whenever any of its nodes is in-bbox) and deduped here by way id.
 *
 * Additionally, any circuit relation in the bbox responses whose tags match
 * `type=circuit` and `wikidata=trackWikidataId` contributes its member ways.
 * Members not already present in the bbox data are fetched individually via
 * /way/<id>/full so the caller can pick them up regardless of their own
 * OSM tags (useful for public-road sections of circuits like Le Mans).
 */
export async function fetchOsmWays(
  lat: number,
  lon: number,
  margin: number,
  trackWikidataId: string,
): Promise<FetchResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Track coordinates must be finite to query the OSM API');
  }
  if (!Number.isFinite(margin) || margin <= 0) {
    throw new Error('OSM API bbox margin must be a positive number');
  }
  if (!trackWikidataId) {
    throw new Error('Track wikidata id is required to match circuit relations');
  }

  const bbox: Bbox = {
    south: lat - margin,
    west: lon - margin,
    north: lat + margin,
    east: lon + margin,
  };

  const { xmls, requestCount: bboxRequestCount } = await fetchBbox(bbox, 0);

  const wayById = new Map<number, ParsedOsmWay>();
  for (const xml of xmls) {
    for (const way of parseOsmXmlWays(xml)) {
      if (!wayById.has(way.id)) {
        wayById.set(way.id, way);
      }
    }
  }

  const relationMemberIds = new Set<number>();
  for (const xml of xmls) {
    for (const relation of parseOsmXmlRelations(xml)) {
      if (relation.tags.type === 'circuit' && relation.tags.wikidata === trackWikidataId) {
        for (const wayId of relation.memberWayIds) {
          relationMemberIds.add(wayId);
        }
      }
    }
  }

  let extraRequestCount = 0;
  const missingIds = Array.from(relationMemberIds).filter(id => !wayById.has(id));
  if (missingIds.length > 0) {
    console.log(`  Fetching ${missingIds.length} relation member way${missingIds.length === 1 ? '' : 's'} outside bbox...`);
    for (const wayId of missingIds) {
      const xml = await fetchWayFull(wayId);
      extraRequestCount += 1;
      if (xml == null) {
        continue;
      }
      for (const way of parseOsmXmlWays(xml)) {
        if (!wayById.has(way.id)) {
          wayById.set(way.id, way);
        }
      }
    }
  }

  return {
    ways: Array.from(wayById.values()),
    bbox,
    requestCount: bboxRequestCount + extraRequestCount,
    relationMemberIds,
  };
}
