import * as turf from '@turf/turf';

export function projectNodes(nodes) {
  const latC = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const lonC = nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
  const cosLat = Math.cos((latC * Math.PI) / 180);

  return nodes.map(n => ({
    x: (n.lon - lonC) * cosLat * 111320,
    y: (n.lat - latC) * 111320,
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

  // Outer ring of the buffer polygon → back to metres
  const ring = buffered.geometry.coordinates[0];
  return ring.map(([lon, lat]) => ({ x: lon * 111320, y: lat * 111320 }));
}

export function buildBasePlate(outlinePoints, margin = 50) {
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
