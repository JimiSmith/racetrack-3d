/**
 * OSM XML parser and URL builder.
 * Shared by the geometry import pipeline and the debug layout view.
 */

import type { LatLonNode as LatLon } from '../types/geometry.js';

export interface ParsedOsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: LatLon[];
}

export interface ParsedOsmRelationMember {
  type: string;
  ref: number;
  role: string;
  geometry?: LatLon[] | null;
}

export interface ParsedOsmRelation {
  id: number;
  tags: Record<string, string>;
  members: ParsedOsmRelationMember[];
}

export interface ParsedOsmElements {
  ways: ParsedOsmWay[];
  relations: ParsedOsmRelation[];
}

const OSM_API_BASE_URL = 'https://api.openstreetmap.org/api/0.6/map';
const DEFAULT_BBOX_MARGIN = 0.02;

function decodeXmlEntities(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(tagSource: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const match of tagSource.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attributes[match[1]!] = decodeXmlEntities(match[2]);
  }

  return attributes;
}

// Base XML parser shared by parseOsmApiMapXml and parseOsmXmlWayGeometries.
//
// Returns:
//   ways      – [{ id, tags, geometry }]  ways with >= 2 resolved node coords
//   relations – [{ id, tags, members }]   members hydrated from complete way index;
//               geometry: null for ways that fell outside the bbox
//               (only populated when includeRelations !== false)
export function parseOsmXmlElements(xmlSource: string | null | undefined, options: { includeRelations?: boolean } = {}): ParsedOsmElements {
  const includeRelations = options.includeRelations !== false;
  const xml = String(xmlSource ?? '');
  const nodeIndex = new Map<number, LatLon>();
  const ways: ParsedOsmWay[] = [];
  const relations: ParsedOsmRelation[] = [];
  let currentWay: { id: number; tags: Record<string, string>; nodeRefs: number[] } | null = null;
  let currentRelation: { id: number; tags: Record<string, string>; members: ParsedOsmRelationMember[] } | null = null;

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
            .filter((node): node is LatLon => Number.isFinite(node?.lat) && Number.isFinite(node?.lon));
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
            members: currentRelation.members.filter(m => m.type === 'way' || m.type === 'relation'),
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
        currentWay = null; // no nodeRefs -> geometry impossible; skip
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
      currentRelation.members.push({ type: attributes.type ?? '', ref, role: attributes.role ?? '' });
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
  const wayIndex = new Map<number, ParsedOsmWay>(ways.map(way => [way.id, way]));
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

export function buildOsmApiMapUrl(lat: number, lon: number, margin: number = DEFAULT_BBOX_MARGIN): string {
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
