/**
 * OSM XML parser and URL builder.
 * Adapted from src/geometry/osm-xml-parser.ts for the standalone geometry-import package.
 */

import type { LatLon } from './types.js';

export interface ParsedOsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: LatLon[];
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

/**
 * Parse OSM XML and extract ways with their node geometries.
 * Returns only ways with >= 2 resolved node coordinates.
 */
export function parseOsmXmlWays(xmlSource: string): ParsedOsmWay[] {
  const xml = String(xmlSource ?? '');
  const nodeIndex = new Map<number, LatLon>();
  const ways: ParsedOsmWay[] = [];
  let currentWay: { id: number; tags: Record<string, string>; nodeRefs: number[] } | null = null;

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
        currentWay = null;
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

    if (tagName === 'tag' && currentWay) {
      const key = attributes.k;
      const value = attributes.v ?? '';
      if (key) {
        currentWay.tags[key] = value;
      }
    }
  }

  return ways;
}

export function buildOsmApiMapUrl(lat: number, lon: number, margin: number = DEFAULT_BBOX_MARGIN): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Track coordinates must be finite to query the OSM API');
  }

  if (!Number.isFinite(margin) || margin <= 0) {
    throw new Error('OSM API bbox margin must be a positive number');
  }

  return buildOsmApiMapUrlForBbox(lat - margin, lon - margin, lat + margin, lon + margin);
}

export function buildOsmApiMapUrlForBbox(south: number, west: number, north: number, east: number): string {
  if (![south, west, north, east].every(Number.isFinite)) {
    throw new Error('OSM API bbox coordinates must be finite');
  }

  if (south >= north || west >= east) {
    throw new Error('OSM API bbox must have south < north and west < east');
  }

  return `${OSM_API_BASE_URL}?bbox=${west},${south},${east},${north}`;
}
