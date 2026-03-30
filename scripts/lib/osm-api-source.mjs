const OSM_API_BASE_URL = 'https://api.openstreetmap.org/api/0.6/map';
const OSM_API_TIMEOUT_MS = 20000;
const DEFAULT_BBOX_MARGIN = 0.02;

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
