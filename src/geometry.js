import * as turf from '@turf/turf';

export function projectNodes(nodes, elevations = null) {
  const latC = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const lonC = nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
  const cosLat = Math.cos((latC * Math.PI) / 180);

  return nodes.map((n, i) => ({
    x: (n.lon - lonC) * cosLat * 111320,
    y: (n.lat - latC) * 111320,
    elevation: elevations ? (elevations[i] ?? 0) : 0,
  }));
}

export function buildTrackOutline(nodes, widthMetres = 12) {
  let pts = [...nodes];

  // Close the loop if needed
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (Math.sqrt(dx * dx + dy * dy) > 5) {
    pts = [...pts, first];
  }

  // Convert XY metres → fake lon/lat (divide by 111320)
  const coords = pts.map(p => [p.x / 111320, p.y / 111320]);
  const line = turf.lineString(coords);

  const bufferKm = widthMetres / 2 / 1000;
  const buffered = turf.buffer(line, bufferKm, { units: 'kilometers' });

  // Outer ring + any inner hole rings (donut shape for closed circuits)
  const toMetres = ring => ring.map(([lon, lat]) => ({ x: lon * 111320, y: lat * 111320 }));
  return {
    outerRing: toMetres(buffered.geometry.coordinates[0]),
    holes: buffered.geometry.coordinates.slice(1).map(toMetres),
  };
}

export function buildBasePlate(outline, margin = 50) {
  // Accept either the full outline object {outerRing, holes} or a plain array
  const outlinePoints = outline?.outerRing ?? outline;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of outlinePoints) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
