import { buildOsmApiMapUrl } from './osm-xml-parser.js';

const REQUEST_PACE_MS = 1200;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ADAPTIVE_ATTEMPTS = 6;
const MIN_MARGIN = 0.001;
const NODE_LIMIT_PATTERN = /too many nodes/i;
const RATE_LIMIT_STATUS_CODES = new Set([429, 509]);
const RATE_LIMIT_BODY_PATTERN = /(downloaded too much data|rate limit|quota exceeded|too many requests|bandwidth limit exceeded|please wait)/i;
const RETRY_AFTER_PATTERN = /(?:please\s+)?wait\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i;
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_FALLBACK_DELAYS_MS = [5_000, 15_000];

export interface FetchResult {
  xml: string;
  url: string;
  margin: number;
}

export class RateLimitExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExhaustedError';
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
 * Fetch raw OSM XML for a single margin value, with rate-limit retry.
 * Throws on node-limit errors (with a `.nodeLimitExceeded` flag) so the
 * adaptive caller can reduce the margin and retry.
 */
async function fetchSingleMargin(lat: number, lon: number, margin: number): Promise<{ xml: string; url: string }> {
  const url = buildOsmApiMapUrl(lat, lon, margin);

  for (let retry = 0; retry <= MAX_RATE_LIMIT_RETRIES; retry++) {
    await waitForPacingSlot();

    const response = await fetch(url, {
      headers: { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const xml = await response.text();
      return { xml, url };
    }

    const body = (await response.text()).trim();

    if (isNodeLimitError(body)) {
      const err = new Error(`OSM API node limit exceeded (margin ${margin})`);
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

/**
 * Fetch OSM map XML with adaptive margin shrinking.
 * Starts at the given margin and halves on node-limit errors until MIN_MARGIN.
 * Same pattern as the debug webview (src/debug/entry.ts).
 */
export async function fetchOsmMapXml(lat: number, lon: number, startMargin: number): Promise<FetchResult> {
  let margin = startMargin;

  for (let attempt = 0; attempt < MAX_ADAPTIVE_ATTEMPTS; attempt++) {
    try {
      const { xml, url } = await fetchSingleMargin(lat, lon, margin);
      return { xml, url, margin };
    } catch (err) {
      if (!(err as any).nodeLimitExceeded || margin <= MIN_MARGIN) {
        throw err;
      }
      margin = Math.max(MIN_MARGIN, margin / 2);
      console.log(`  Too many nodes, retrying with smaller area (margin ${margin.toFixed(4)})...`);
    }
  }

  throw new Error(`Could not fetch OSM data: area too dense even at minimum margin (${MIN_MARGIN})`);
}
