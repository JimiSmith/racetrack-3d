import geometryIndex from './generated/track-geometry-index.json' with { type: 'json' };

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

export function getLocalTrackGeometry(wikidataId) {
  if (!wikidataId) {
    return null;
  }

  const entry = geometryIndex[wikidataId];
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

export function hasLocalTrackGeometry(wikidataId) {
  return Boolean(wikidataId && geometryIndex[wikidataId]);
}
