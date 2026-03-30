const OSM_API_BASE_URL = 'https://api.openstreetmap.org/api/0.6/map';
const OSM_API_TIMEOUT_MS = 20000;
const DEFAULT_BBOX_MARGIN = 0.02;
const OSM_API_NODE_LIMIT_PATTERN = /too many nodes \(limit is 50000\)/i;
const DEFAULT_ADAPTIVE_START_DIVISOR = 8;
const DEFAULT_ADAPTIVE_GROWTH_FACTOR = 2;
const DEFAULT_ADAPTIVE_MIN_MARGIN = 0.001;
const DEFAULT_ADAPTIVE_MAX_ATTEMPTS = 8;

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

function finalizeWay(way, nodeIndex, ways) {
  if (!way || !Number.isFinite(way.id)) {
    return;
  }

  const geometry = way.nodeRefs
    .map(nodeRef => nodeIndex.get(nodeRef))
    .filter(node => Number.isFinite(node?.lat) && Number.isFinite(node?.lon));

  if (geometry.length < 2) {
    return;
  }

  ways.push({
    type: 'way',
    id: way.id,
    tags: way.tags,
    geometry,
  });
}

function finalizeRelation(relation, wayIndex, relations) {
  if (!relation || !Number.isFinite(relation.id)) {
    return;
  }

  relations.push({
    type: 'relation',
    id: relation.id,
    tags: relation.tags,
    members: relation.members
      .filter(member => member.type === 'way')
      .map(member => ({
        type: member.type,
        ref: member.ref,
        role: member.role,
        geometry: wayIndex.get(member.ref)?.geometry,
      }))
      .filter(member => Array.isArray(member.geometry) && member.geometry.length >= 2),
  });
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
        finalizeWay(currentWay, nodeIndex, ways);
        currentWay = null;
      } else if (tagName === 'relation') {
        finalizeRelation(currentRelation, new Map(ways.map(way => [way.id, way])), relations);
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
      currentWay = {
        id: Number(attributes.id),
        tags: {},
        nodeRefs: [],
      };
      if (selfClosing) {
        finalizeWay(currentWay, nodeIndex, ways);
        currentWay = null;
      }
      continue;
    }

    if (tagName === 'relation') {
      currentRelation = {
        id: Number(attributes.id),
        tags: {},
        members: [],
      };
      if (selfClosing) {
        finalizeRelation(currentRelation, new Map(ways.map(way => [way.id, way])), relations);
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
      currentRelation.members.push({
        type: attributes.type,
        ref,
        role: attributes.role ?? '',
      });
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

  const wayIndex = new Map(ways.map(way => [way.id, way]));
  const hydratedRelations = relations.map(relation => ({
    ...relation,
    members: relation.members
      .map(member => ({
        ...member,
        geometry: wayIndex.get(member.ref)?.geometry,
      }))
      .filter(member => Array.isArray(member.geometry) && member.geometry.length >= 2),
  }));
  const relevantRelations = hydratedRelations.filter(relation => {
    const highway = String(relation.tags?.highway ?? '').trim().toLowerCase();
    const type = String(relation.tags?.type ?? '').trim().toLowerCase();
    return highway === 'raceway' || type === 'circuit';
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
    elements: [...relevantWays, ...relevantRelations],
  };
}

export async function fetchOsmApiMapPayload(lat, lon, options = {}) {
  const margin = options.margin ?? DEFAULT_BBOX_MARGIN;
  const url = buildOsmApiMapUrl(lat, lon, margin);
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
    throw new Error(`OSM API map request failed (${response.status}): ${details || response.statusText}`);
  }

  const xml = await response.text();
  return {
    url,
    xml,
    payload: parseOsmApiMapXml(xml),
  };
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
