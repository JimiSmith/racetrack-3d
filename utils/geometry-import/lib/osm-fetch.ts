import { buildOsmApiMapUrlForBbox, parseOsmXmlWays, type ParsedOsmWay } from './osm-xml-parser.js';

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

/**
 * Fetch raw OSM XML for a single bbox, with rate-limit retry.
 * Throws with `.nodeLimitExceeded = true` on node-cap errors so the
 * caller can subdivide the bbox and retry.
 */
async function fetchSingleBbox(bbox: Bbox): Promise<string> {
  const url = buildOsmApiMapUrlForBbox(bbox.south, bbox.west, bbox.north, bbox.east);

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

    if (isNodeLimitError(body)) {
      const err = new Error(`OSM API node limit exceeded for bbox ${JSON.stringify(bbox)}`);
      (err as any).nodeLimitExceeded = true;
      throw err;
    }

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

    throw new Error(`OSM API request failed (${response.status}): ${body || response.statusText}`);
  }

  throw new Error('Unreachable');
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
 */
export async function fetchOsmWays(lat: number, lon: number, margin: number): Promise<FetchResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Track coordinates must be finite to query the OSM API');
  }
  if (!Number.isFinite(margin) || margin <= 0) {
    throw new Error('OSM API bbox margin must be a positive number');
  }

  const bbox: Bbox = {
    south: lat - margin,
    west: lon - margin,
    north: lat + margin,
    east: lon + margin,
  };

  const { xmls, requestCount } = await fetchBbox(bbox, 0);

  const wayById = new Map<number, ParsedOsmWay>();
  for (const xml of xmls) {
    for (const way of parseOsmXmlWays(xml)) {
      if (!wayById.has(way.id)) {
        wayById.set(way.id, way);
      }
    }
  }

  return {
    ways: Array.from(wayById.values()),
    bbox,
    requestCount,
  };
}
