const OSM_API_BASE_URL = 'https://api.openstreetmap.org/api/0.6/map';
const OSM_API_TIMEOUT_MS = 20000;
const DEFAULT_BBOX_MARGIN = 0.02;
const OSM_API_NODE_LIMIT_PATTERN = /too many nodes \(limit is 50000\)/i;
const OSM_API_RATE_LIMIT_PATTERN = /(downloaded too much data|rate limit|quota exceeded|too many requests|bandwidth limit exceeded|please wait)/i;
const OSM_API_RETRY_AFTER_PATTERN = /(?:please\s+)?wait\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i;
const OSM_API_RATE_LIMIT_STATUS_CODES = new Set([429, 509]);
const DEFAULT_OSM_API_REQUEST_PACE_MS = 1200;
const DEFAULT_OSM_API_RATE_LIMIT_RETRY_DELAYS_MS = [5000, 15000];
const sharedOsmApiPacingState = {
  nextRequestAt: 0,
};
const DEFAULT_ADAPTIVE_START_DIVISOR = 8;
const DEFAULT_ADAPTIVE_GROWTH_FACTOR = 2;
const DEFAULT_ADAPTIVE_MIN_MARGIN = 0.001;
const DEFAULT_ADAPTIVE_MAX_ATTEMPTS = 8;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNow(options = {}) {
  return typeof options.now === 'function' ? options.now() : Date.now();
}

function parseRetryAfterHeader(retryAfterValue, now) {
  if (!retryAfterValue) {
    return null;
  }

  const seconds = Number(retryAfterValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(retryAfterValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }

  return null;
}

function parseRetryDelayFromText(details) {
  const match = String(details ?? '').match(OSM_API_RETRY_AFTER_PATTERN);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const unit = match[2].toLowerCase();
  if (unit.startsWith('hour')) {
    return amount * 60 * 60 * 1000;
  }

  if (unit.startsWith('minute')) {
    return amount * 60 * 1000;
  }

  return amount * 1000;
}

function resolveRateLimitRetryDelayMs(response, details, attemptIndex, options = {}) {
  const now = getNow(options);
  const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'), now)
    ?? parseRetryDelayFromText(details);
  if (Number.isFinite(retryAfterMs)) {
    return retryAfterMs;
  }

  const fallbackDelays = Array.isArray(options.rateLimitRetryDelaysMs) && options.rateLimitRetryDelaysMs.length > 0
    ? options.rateLimitRetryDelaysMs
    : DEFAULT_OSM_API_RATE_LIMIT_RETRY_DELAYS_MS;
  return fallbackDelays[Math.min(attemptIndex, fallbackDelays.length - 1)];
}

async function waitForOsmApiRequestSlot(options = {}) {
  const paceMs = Number.isFinite(options.paceMs) && options.paceMs >= 0
    ? options.paceMs
    : DEFAULT_OSM_API_REQUEST_PACE_MS;
  if (paceMs === 0) {
    return 0;
  }

  const pacingState = options.pacingState ?? sharedOsmApiPacingState;
  const now = getNow(options);
  const waitMs = Math.max(0, (pacingState.nextRequestAt ?? 0) - now);
  pacingState.nextRequestAt = Math.max(pacingState.nextRequestAt ?? 0, now) + paceMs;

  if (waitMs > 0) {
    await (options.sleep ?? sleep)(waitMs);
  }

  return waitMs;
}

function createOsmApiRateLimitError(status, details, options = {}) {
  const retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
  const retryAfterText = retryAfterMs != null ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : '';
  const error = new Error(`OSM API map request rate-limited (${status}): ${(details || 'rate limited by upstream').trim()}${retryAfterText}`);
  error.name = 'OsmApiRateLimitError';
  error.status = status;
  error.retryAfterMs = retryAfterMs;
  error.rateLimited = true;
  return error;
}

function roundMargin(value) {
  return Number(value.toFixed(6));
}

function normalizeMarginList(margins) {
  return [...new Set((Array.isArray(margins) ? margins : [margins])
    .map(Number)
    .filter(margin => Number.isFinite(margin) && margin > 0)
    .map(roundMargin))]
    .sort((a, b) => a - b);
}

export function isOsmApiNodeLimitError(error) {
  return OSM_API_NODE_LIMIT_PATTERN.test(String(error instanceof Error ? error.message : error));
}

export function isOsmApiRateLimitError(error) {
  if (error && typeof error === 'object' && error.rateLimited === true) {
    return true;
  }

  const message = String(error instanceof Error ? error.message : error);
  const statusMatch = message.match(/\((\d{3})\)/);
  const status = Number(statusMatch?.[1]);
  return OSM_API_RATE_LIMIT_STATUS_CODES.has(status) || OSM_API_RATE_LIMIT_PATTERN.test(message);
}

export function buildAdaptiveOsmApiMargins(margins, options = {}) {
  const requestedMargins = normalizeMarginList(margins);
  if (requestedMargins.length === 0) {
    throw new Error('Adaptive OSM API margins require at least one positive bbox margin');
  }

  const startDivisor = Number.isFinite(options.startDivisor) && options.startDivisor > 1
    ? options.startDivisor
    : DEFAULT_ADAPTIVE_START_DIVISOR;
  const growthFactor = Number.isFinite(options.growthFactor) && options.growthFactor > 1
    ? options.growthFactor
    : DEFAULT_ADAPTIVE_GROWTH_FACTOR;
  const minMargin = Number.isFinite(options.minMargin) && options.minMargin > 0
    ? options.minMargin
    : DEFAULT_ADAPTIVE_MIN_MARGIN;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_ADAPTIVE_MAX_ATTEMPTS;
  const smallestRequestedMargin = requestedMargins[0];
  const largestRequestedMargin = requestedMargins[requestedMargins.length - 1];
  const expandedMargins = new Set(requestedMargins);
  let adaptiveMargin = roundMargin(Math.max(minMargin, smallestRequestedMargin / startDivisor));

  while (adaptiveMargin < largestRequestedMargin && expandedMargins.size < maxAttempts) {
    expandedMargins.add(adaptiveMargin);
    adaptiveMargin = roundMargin(adaptiveMargin * growthFactor);
  }

  if (expandedMargins.size < maxAttempts) {
    expandedMargins.add(largestRequestedMargin);
  }

  return [...expandedMargins]
    .filter(margin => margin <= largestRequestedMargin)
    .sort((a, b) => a - b)
    .slice(0, maxAttempts);
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(tagSource) {
  const attributes = {};

  for (const match of tagSource.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }

  return attributes;
}

// Base XML parser shared by parseOsmApiMapXml and parseOsmXmlWayGeometries.
//
// Returns:
//   ways      – [{ id, tags, geometry }]  ways with ≥ 2 resolved node coords
//   relations – [{ id, tags, members }]   members hydrated from complete way index;
//               geometry: null for ways that fell outside the bbox
//               (only populated when includeRelations !== false)
function parseOsmXmlElements(xmlSource, options = {}) {
  const includeRelations = options.includeRelations !== false;
  const xml = String(xmlSource ?? '');
  const nodeIndex = new Map();
  const ways = [];
  const relations = [];
  let currentWay = null;
  let currentRelation = null;

  for (const match of xml.matchAll(/<[^>]+>/g)) {
    const tagSource = match[0];

    if (tagSource.startsWith('<?') || tagSource.startsWith('<!--') || tagSource.startsWith('<!DOCTYPE')) {
      continue;
    }

    if (tagSource.startsWith('</')) {
      const tagName = tagSource.slice(2, -1).trim();
      if (tagName === 'way') {
        if (currentWay && Number.isFinite(currentWay.id)) {
          const geometry = currentWay.nodeRefs
            .map(ref => nodeIndex.get(ref))
            .filter(node => Number.isFinite(node?.lat) && Number.isFinite(node?.lon));
          if (geometry.length >= 2) {
            ways.push({ id: currentWay.id, tags: currentWay.tags, geometry });
          }
        }
        currentWay = null;
      } else if (tagName === 'relation' && includeRelations) {
        if (currentRelation && Number.isFinite(currentRelation.id)) {
          relations.push({
            id: currentRelation.id,
            tags: currentRelation.tags,
            members: currentRelation.members.filter(m => m.type === 'way'),
          });
        }
        currentRelation = null;
      }
      continue;
    }

    const tagName = tagSource.match(/^<\s*([^\s/>]+)/)?.[1];
    if (!tagName) {
      continue;
    }

    const selfClosing = /\/\s*>$/.test(tagSource);
    const attributes = parseAttributes(tagSource);

    if (tagName === 'node') {
      const id = Number(attributes.id);
      const lat = Number(attributes.lat);
      const lon = Number(attributes.lon);
      if (Number.isFinite(id) && Number.isFinite(lat) && Number.isFinite(lon)) {
        nodeIndex.set(id, { lat, lon });
      }
      continue;
    }

    if (tagName === 'way') {
      currentWay = { id: Number(attributes.id), tags: {}, nodeRefs: [] };
      if (selfClosing) {
        currentWay = null; // no nodeRefs → geometry impossible; skip
      }
      continue;
    }

    if (tagName === 'relation' && includeRelations) {
      currentRelation = { id: Number(attributes.id), tags: {}, members: [] };
      if (selfClosing) {
        if (Number.isFinite(currentRelation.id)) {
          relations.push({ id: currentRelation.id, tags: currentRelation.tags, members: [] });
        }
        currentRelation = null;
      }
      continue;
    }

    if (tagName === 'nd' && currentWay) {
      const ref = Number(attributes.ref);
      if (Number.isFinite(ref)) {
        currentWay.nodeRefs.push(ref);
      }
      continue;
    }

    if (tagName === 'member' && currentRelation) {
      const ref = Number(attributes.ref);
      currentRelation.members.push({ type: attributes.type, ref, role: attributes.role ?? '' });
      continue;
    }

    if (tagName === 'tag') {
      const key = attributes.k;
      const value = attributes.v ?? '';
      if (!key) {
        continue;
      }
      if (currentWay) {
        currentWay.tags[key] = value;
      } else if (currentRelation) {
        currentRelation.tags[key] = value;
      }
    }
  }

  if (!includeRelations) {
    return { ways, relations: [] };
  }

  // Hydrate relation member geometries from the complete way index. A second pass is
  // needed because ways may appear after their referencing relation in the XML stream.
  const wayIndex = new Map(ways.map(way => [way.id, way]));
  const hydratedRelations = relations.map(relation => ({
    ...relation,
    members: relation.members.map(member => ({
      ...member,
      // Keep null geometry so callers can identify ways that fall outside the bbox
      // and fetch them separately. Downstream consumers guard against null geometry.
      geometry: wayIndex.get(member.ref)?.geometry ?? null,
    })),
  }));

  return { ways, relations: hydratedRelations };
}

export function buildOsmApiMapUrl(lat, lon, margin = DEFAULT_BBOX_MARGIN) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Track coordinates must be finite to query the OSM API');
  }

  if (!Number.isFinite(margin) || margin <= 0) {
    throw new Error('OSM API bbox margin must be a positive number');
  }

  const minLon = lon - margin;
  const minLat = lat - margin;
  const maxLon = lon + margin;
  const maxLat = lat + margin;
  return `${OSM_API_BASE_URL}?bbox=${minLon},${minLat},${maxLon},${maxLat}`;
}

export function parseOsmApiMapXml(xmlSource) {
  const { ways, relations } = parseOsmXmlElements(xmlSource, { includeRelations: true });

  const relevantRelations = relations.filter(relation => {
    const highway = String(relation.tags?.highway ?? '').trim().toLowerCase();
    const type = String(relation.tags?.type ?? '').trim().toLowerCase();
    const route = String(relation.tags?.route ?? '').trim().toLowerCase();
    const circuit = String(relation.tags?.circuit ?? '').trim().toLowerCase();
    return (highway === 'raceway' || type === 'circuit' || route === 'raceway') && circuit !== 'kart';
  });
  const relevantWayIds = new Set([
    ...ways
      .filter(way => String(way.tags?.highway ?? '').trim().toLowerCase() === 'raceway')
      .map(way => way.id),
    ...relevantRelations.flatMap(relation => relation.members.map(member => member.ref)),
  ]);
  const relevantWays = ways.filter(way => relevantWayIds.has(way.id));

  return {
    version: 0.6,
    generator: 'osm-api-map',
    elements: [
      ...relevantWays.map(way => ({ type: 'way', ...way })),
      ...relevantRelations.map(relation => ({ type: 'relation', ...relation })),
    ],
  };
}

// Parses a combined nodes+ways OSM XML string and returns a Map<wayId, geometry>.
// Used to resolve geometries for ways that were outside the original bbox query.
function parseOsmXmlWayGeometries(xmlSource) {
  const { ways } = parseOsmXmlElements(xmlSource, { includeRelations: false });
  return new Map(ways.map(way => [way.id, way.geometry]));
}

// Parses all way member refs from a single relation XML element.
// The bbox response only includes members that fall within the bbox, so we
// separately fetch the full relation to discover out-of-bbox member IDs.
function parseRelationMemberWayIds(xmlSource) {
  const ids = [];
  for (const m of String(xmlSource ?? '').matchAll(/<member\s[^>]*type="way"[^>]*ref="(\d+)"[^>]*/g)) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

// Fetches way geometries for relation members that were outside the initial bbox.
//
// The OSM bbox API truncates relation members to only those within the queried area.
// For circuits that span beyond the bbox (e.g. temporary street circuits where larger
// margins hit the 50k-node limit), this means part of the circuit goes missing.
//
// Strategy:
//   1. For each circuit/raceway relation in the payload, fetch the full relation by ID
//      to discover the complete member list.
//   2. Identify any member way IDs not already present in the payload.
//   3. Fetch those missing ways' node-refs (one batch request).
//   4. Fetch the required node coordinates (one batch request).
//   5. Merge the resolved geometries into the payload.
//
// Falls back to the original payload on any network error.
export async function supplementPayloadWithMissingRelationWays(payload, options = {}) {
  const relevantRelations = (payload?.elements ?? []).filter(e => {
    if (e.type !== 'relation') return false;
    const hw = String(e.tags?.highway ?? '').trim().toLowerCase();
    const type = String(e.tags?.type ?? '').trim().toLowerCase();
    const route = String(e.tags?.route ?? '').trim().toLowerCase();
    const circuit = String(e.tags?.circuit ?? '').trim().toLowerCase();
    return (hw === 'raceway' || type === 'circuit' || route === 'raceway') && circuit !== 'kart';
  });

  if (relevantRelations.length === 0) {
    return payload;
  }

  const timeout = options.timeoutMs ?? OSM_API_TIMEOUT_MS;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const osmApiBase = 'https://api.openstreetmap.org/api/0.6';

  const existingWayIds = new Set(
    (payload.elements ?? []).filter(e => e.type === 'way').map(e => e.id),
  );

  try {
    // Step 1: fetch the full relation objects to get all member way IDs (not just
    // those that fell within the bbox)
    const missingWayIds = new Set();
    const fullMembersByRelId = new Map();

    for (const rel of relevantRelations) {
      const relResponse = await fetchFn(
        `${osmApiBase}/relation/${rel.id}`,
        { headers: { Accept: 'application/xml, text/xml;q=0.9' }, signal: AbortSignal.timeout(timeout) },
      );
      if (!relResponse.ok) continue;

      const allMemberIds = parseRelationMemberWayIds(await relResponse.text());
      fullMembersByRelId.set(rel.id, allMemberIds);

      for (const id of allMemberIds) {
        if (!existingWayIds.has(id)) {
          missingWayIds.add(id);
        }
      }
    }

    if (missingWayIds.size === 0) {
      return payload;
    }

    // Step 2: fetch way node-refs for all missing ways in one request
    const waysResponse = await fetchFn(
      `${osmApiBase}/ways?ways=${[...missingWayIds].join(',')}`,
      { headers: { Accept: 'application/xml, text/xml;q=0.9' }, signal: AbortSignal.timeout(timeout) },
    );
    if (!waysResponse.ok) {
      return payload;
    }
    const waysXml = await waysResponse.text();

    // Step 3: collect all node IDs referenced by the fetched ways
    const ndRefs = new Set();
    for (const m of waysXml.matchAll(/<nd\s+ref="(\d+)"/g)) {
      ndRefs.add(m[1]);
    }
    if (ndRefs.size === 0) {
      return payload;
    }

    // Step 4: fetch node coordinates in one request
    const nodesResponse = await fetchFn(
      `${osmApiBase}/nodes?nodes=${[...ndRefs].join(',')}`,
      { headers: { Accept: 'application/xml, text/xml;q=0.9' }, signal: AbortSignal.timeout(timeout) },
    );
    if (!nodesResponse.ok) {
      return payload;
    }
    const nodesXml = await nodesResponse.text();

    // Step 5: parse geometries from the combined nodes + ways XML
    const newGeometries = parseOsmXmlWayGeometries(nodesXml + waysXml);
    if (newGeometries.size === 0) {
      return payload;
    }

    // Expand relation member lists with the previously-missing ways, preserving
    // role information from the full relation fetch (all missing members get role '').
    const updatedElements = payload.elements.map(e => {
      if (e.type !== 'relation') {
        return e;
      }
      const fullMemberIds = fullMembersByRelId.get(e.id);
      if (!fullMemberIds) {
        return e;
      }
      // Build a complete member list: existing members (with their geometry) + newly fetched ones
      const existingMemberRefs = new Set(e.members.map(m => m.ref));
      const addedMembers = fullMemberIds
        .filter(id => !existingMemberRefs.has(id) && newGeometries.has(id))
        .map(id => ({ type: 'way', ref: id, role: '', geometry: newGeometries.get(id) }));
      return {
        ...e,
        members: [...e.members, ...addedMembers],
      };
    });

    // Append newly fetched ways as bare way elements so extractOverpassWays can
    // include them; the relation merge will supply their tags.
    const additionalWays = [...newGeometries.entries()]
      .filter(([id]) => !existingWayIds.has(id))
      .map(([id, geometry]) => ({ type: 'way', id, tags: {}, geometry }));

    return {
      ...payload,
      elements: [...updatedElements, ...additionalWays],
    };
  } catch {
    return payload; // fail gracefully
  }
}

export async function fetchOsmApiMapPayload(lat, lon, options = {}) {
  const margin = options.margin ?? DEFAULT_BBOX_MARGIN;
  const url = buildOsmApiMapUrl(lat, lon, margin);
  const maxRateLimitRetries = Number.isInteger(options.maxRateLimitRetries) && options.maxRateLimitRetries >= 0
    ? options.maxRateLimitRetries
    : DEFAULT_OSM_API_RATE_LIMIT_RETRY_DELAYS_MS.length;
  let retryCount = 0;
  let totalRetryDelayMs = 0;
  let totalPacingDelayMs = 0;

  while (true) {
    totalPacingDelayMs += await waitForOsmApiRequestSlot(options);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? OSM_API_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
      },
      signal,
    });

    if (!response.ok) {
      const details = (await response.text()).trim();

      if (!isOsmApiNodeLimitError(details) && (OSM_API_RATE_LIMIT_STATUS_CODES.has(response.status) || OSM_API_RATE_LIMIT_PATTERN.test(details))) {
        const retryAfterMs = resolveRateLimitRetryDelayMs(response, details, retryCount, options);
        if (retryCount < maxRateLimitRetries) {
          totalRetryDelayMs += retryAfterMs;
          retryCount += 1;
          await (options.sleep ?? sleep)(retryAfterMs);
          continue;
        }

        throw createOsmApiRateLimitError(response.status, details || response.statusText, { retryAfterMs });
      }

      throw new Error(`OSM API map request failed (${response.status}): ${details || response.statusText}`);
    }

    const xml = await response.text();
    return {
      url,
      xml,
      payload: parseOsmApiMapXml(xml),
      metadata: {
        requestAttempts: retryCount + 1,
        retryCount,
        pacingDelayMs: totalPacingDelayMs,
        retryDelayMs: totalRetryDelayMs,
      },
    };
  }
}

export async function fetchAdaptiveOsmApiMapPayload(lat, lon, options = {}) {
  const margins = buildAdaptiveOsmApiMargins(options.margins ?? options.margin ?? DEFAULT_BBOX_MARGIN, options);
  const fetchForMargin = options.fetchForMargin
    ?? (margin => fetchOsmApiMapPayload(lat, lon, { ...options, margin }));
  const evaluateResponse = options.evaluateResponse
    ?? (() => ({ usable: true }));
  const errors = [];
  let lastUsableResponse = null;
  let lastUsableEvaluation = null;
  let lastUsableMargin = null;

  for (const [attemptIndex, margin] of margins.entries()) {
    try {
      const response = await fetchForMargin(margin, {
        attemptIndex,
        margins,
      });
      const evaluation = await evaluateResponse(response, {
        margin,
        attemptIndex,
        margins,
        previousUsableResponse: lastUsableResponse,
        previousUsableEvaluation: lastUsableEvaluation,
      });

      if (!evaluation?.usable) {
        errors.push(`margin ${margin}: ${evaluation?.reason ?? 'did not yield usable geometry'}`);
        continue;
      }

      lastUsableResponse = response;
      lastUsableEvaluation = evaluation;
      lastUsableMargin = margin;
    } catch (error) {
      if (isOsmApiNodeLimitError(error)) {
        if (lastUsableResponse) {
          return {
            ...lastUsableResponse,
            evaluation: lastUsableEvaluation,
            metadata: {
              ...(lastUsableResponse.metadata ?? {}),
              margin: lastUsableMargin,
              attempts: margins,
              stopReason: 'node-limit',
            },
          };
        }

        errors.push(`margin ${margin}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }

      errors.push(`margin ${margin}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (lastUsableResponse) {
    return {
      ...lastUsableResponse,
      evaluation: lastUsableEvaluation,
      metadata: {
        ...(lastUsableResponse.metadata ?? {}),
        margin: lastUsableMargin,
        attempts: margins,
        stopReason: 'max-margin',
      },
    };
  }

  throw new Error(`Adaptive OSM API map request failed (${errors.join('; ')})`);
}
