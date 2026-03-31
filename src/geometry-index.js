const geometryCache = new Map();

function getGeometryAssetBaseUrl() {
  return typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? import.meta.env.BASE_URL
    : '/';
}

function cloneLayout(layout) {
  return {
    ...layout,
    nodes: Array.isArray(layout?.nodes)
      ? layout.nodes.map(node => ({ lat: node.lat, lon: node.lon }))
      : [],
    stats: layout?.stats
      ? { ...layout.stats }
      : { lengthMetres: 0, segmentCount: 0, variantSectionCount: 0 },
  };
}

function cloneTrackGeometry(entry) {
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

export function getTrackGeometry(wikidataId) {
  if (!wikidataId) {
    return Promise.resolve(null);
  }

  if (geometryCache.has(wikidataId)) {
    return geometryCache.get(wikidataId);
  }

  const promise = (async () => {
    try {
      const response = await fetch(`${getGeometryAssetBaseUrl()}generated/geometry/${encodeURIComponent(wikidataId)}.json`);
      if (!response.ok) {
        return null;
      }

      const entry = await response.json();
      return cloneTrackGeometry(entry);
    } catch {
      return null;
    }
  })();

  geometryCache.set(wikidataId, promise);
  return promise;
}
