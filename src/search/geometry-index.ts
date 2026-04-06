import type { Layout, LayoutStats } from '../types/geometry.js';

interface TrackGeometryEntry {
  trackId?: unknown;
  name?: unknown;
  source?: Record<string, unknown> | null;
  center?: Record<string, unknown> | null;
  names?: {
    osmVenueNames?: string[];
    [key: string]: unknown;
  } | null;
  layouts?: Layout[];
  [key: string]: unknown;
}

interface ClonedTrackGeometry {
  trackId: unknown;
  name: unknown;
  source: Record<string, unknown> | null;
  center: Record<string, unknown> | null;
  names: {
    osmVenueNames: string[];
    [key: string]: unknown;
  } | null;
  layouts: Layout[];
  selectedLayoutIndex: number;
  osmVenueNames: string[];
}

const geometryCache = new Map<string, Promise<ClonedTrackGeometry | null>>();

function getGeometryAssetBaseUrl(): string {
  return typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? import.meta.env.BASE_URL
    : '/';
}

function cloneLayout(layout: Layout): Layout {
  const stats: LayoutStats = layout?.stats
    ? { ...layout.stats }
    : { lengthMetres: 0, segmentCount: 0, variantSectionCount: 0 };

  return {
    ...layout,
    nodes: Array.isArray(layout?.nodes)
      ? layout.nodes.map(node => ({ lat: node.lat, lon: node.lon }))
      : [],
    stats,
  };
}

function cloneTrackGeometry(entry: TrackGeometryEntry | null): ClonedTrackGeometry | null {
  if (!entry) {
    return null;
  }

  return {
    trackId: entry.trackId,
    name: entry.name,
    source: entry.source ? { ...entry.source } : null,
    center: entry.center ? { ...entry.center } : null,
    names: entry.names
      ? {
          ...entry.names,
          osmVenueNames: [...(entry.names.osmVenueNames ?? [])],
        }
      : null,
    layouts: Array.isArray(entry.layouts) ? entry.layouts.map(cloneLayout) : [],
    selectedLayoutIndex: 0,
    osmVenueNames: [...(entry.names?.osmVenueNames ?? [])],
  };
}

export function getTrackGeometry(
  wikidataId: string | undefined | null,
): Promise<ClonedTrackGeometry | null> {
  if (!wikidataId) {
    return Promise.resolve(null);
  }

  if (geometryCache.has(wikidataId)) {
    return geometryCache.get(wikidataId)!;
  }

  const promise = (async () => {
    try {
      const response = await fetch(
        `${getGeometryAssetBaseUrl()}generated/geometry/${encodeURIComponent(wikidataId)}.json`,
      );
      if (!response.ok) {
        return null;
      }

      const entry = (await response.json()) as TrackGeometryEntry;
      return cloneTrackGeometry(entry);
    } catch {
      return null;
    }
  })();

  geometryCache.set(wikidataId, promise);
  return promise;
}
