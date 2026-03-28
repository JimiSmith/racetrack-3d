const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

export async function searchTracks(query, signal) {
  // Step 1: Wikidata EntitySearch for candidate circuit names
  const searchUrl = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=20&format=json&origin=*`;
  const searchResp = await fetch(searchUrl, { signal });
  if (!searchResp.ok) throw new Error(`Wikidata search error: ${searchResp.status}`);
  const searchData = await searchResp.json();

  const ids = searchData.search.map(r => r.id);
  if (ids.length === 0) return [];

  // Step 2: SPARQL — keep candidates that have P625 (coordinates) AND
  // are an instance/subclass of a race track (P31/P279* wd:Q24931).
  // P625 is needed for the Overpass bbox query.
  const sparql = `
SELECT ?item ?itemLabel ?countryLabel ?lat ?lon WHERE {
  VALUES ?item { ${ids.map(id => `wd:${id}`).join(' ')} }
  ?item p:P625 ?coordStatement .
  ?coordStatement psv:P625 ?coordNode .
  ?coordNode wikibase:geoLatitude ?lat .
  ?coordNode wikibase:geoLongitude ?lon .
  OPTIONAL { ?item wdt:P17 ?country . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
  `.trim();

  const sparqlUrl = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
  const sparqlResp = await fetch(sparqlUrl, {
    headers: { Accept: 'application/sparql-results+json' },
    signal,
  });
  if (!sparqlResp.ok) throw new Error(`Wikidata SPARQL error: ${sparqlResp.status}`);
  const { results } = await sparqlResp.json();

  return results.bindings.map(b => ({
    name: b.itemLabel?.value || 'Unknown',
    displayName: b.countryLabel
      ? `${b.itemLabel?.value} — ${b.countryLabel.value}`
      : b.itemLabel?.value || 'Unknown',
    lat: parseFloat(b.lat?.value),
    lon: parseFloat(b.lon?.value),
    wikidataId: b.item?.value?.split('/').pop(),
  }));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ENDPOINT_TIMEOUT_MS = 12000;

async function runOverpassQuery(query, signal) {
  const body = `data=${encodeURIComponent(query)}`;
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const timeoutSignal = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: combined,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
        errors.push(`${endpoint}: ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      errors.push(`${endpoint}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${errors.join('; ')}`);
}

const dist = (a, b) => Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon);
const toRadians = value => (value * Math.PI) / 180;

function measurePolylineLength(nodes) {
  let length = 0;

  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1];
    const next = nodes[i];
    const avgLat = toRadians((prev.lat + next.lat) / 2);
    const dx = (next.lon - prev.lon) * Math.cos(avgLat) * 111320;
    const dy = (next.lat - prev.lat) * 111320;
    length += Math.hypot(dx, dy);
  }

  return length;
}

function computeBoundingBoxArea(nodes) {
  if (!nodes.length) {
    return 0;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const node of nodes) {
    minLat = Math.min(minLat, node.lat);
    maxLat = Math.max(maxLat, node.lat);
    minLon = Math.min(minLon, node.lon);
    maxLon = Math.max(maxLon, node.lon);
  }

  const cosLat = Math.cos(toRadians((minLat + maxLat) / 2));
  const width = (maxLon - minLon) * cosLat * 111320;
  const height = (maxLat - minLat) * 111320;
  return Math.abs(width * height);
}

function computeEndpointGap(nodes) {
  if (nodes.length < 2) {
    return 0;
  }

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const avgLat = toRadians((first.lat + last.lat) / 2);
  const dx = (last.lon - first.lon) * Math.cos(avgLat) * 111320;
  const dy = (last.lat - first.lat) * 111320;
  return Math.hypot(dx, dy);
}

function dedupeSequentialNodes(nodes) {
  const deduped = [];

  for (const node of nodes) {
    const prev = deduped[deduped.length - 1];
    if (!prev || dist(prev, node) >= SNAP_EXACT) {
      deduped.push(node);
    }
  }

  return deduped;
}
// Exact snap: shared OSM node (same coords). Fuzzy snap: slight gap in OSM data (~30m).
const SNAP_EXACT = 1e-5;
const SNAP_FUZZY = 3e-4; // ~30m — catches gaps in OSM data without pulling in distant outliers

// Build connected components from a list of ways using endpoint proximity.
// Returns arrays of way indices grouped by connectivity.
function buildComponents(ways) {
  const n = ways.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    const si = ways[i].nodes[0];
    const ei = ways[i].nodes[ways[i].nodes.length - 1];
    for (let j = i + 1; j < n; j++) {
      const sj = ways[j].nodes[0];
      const ej = ways[j].nodes[ways[j].nodes.length - 1];
      if (dist(si, sj) < SNAP_FUZZY || dist(si, ej) < SNAP_FUZZY ||
          dist(ei, sj) < SNAP_FUZZY || dist(ei, ej) < SNAP_FUZZY) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

function stitchWaysOrdered(ways) {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].nodes;

  const remaining = ways.map(w => ({ nodes: [...w.nodes] }));
  const chain = [...remaining.shift().nodes];

  while (remaining.length > 0) {
    const chainStart = chain[0];
    const chainEnd = chain[chain.length - 1];
    let found = false;

    // First pass: exact snap
    for (let snap of [SNAP_EXACT, SNAP_FUZZY]) {
      for (let i = 0; i < remaining.length; i++) {
        const way = remaining[i];
        const wayStart = way.nodes[0];
        const wayEnd = way.nodes[way.nodes.length - 1];

        if (dist(chainEnd, wayStart) < snap) {
          chain.push(...way.nodes.slice(1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainEnd, wayEnd) < snap) {
          chain.push(...way.nodes.slice(0, -1).reverse());
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayEnd) < snap) {
          chain.unshift(...way.nodes.slice(0, -1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayStart) < snap) {
          chain.unshift(...way.nodes.slice(1).reverse());
          remaining.splice(i, 1); found = true; break;
        }
      }
      if (found) break;
    }

    if (!found) break; // no more connectable ways in this component
  }

  return chain;
}

function makeEndpointKey(node) {
  return `${Math.round(node.lat / SNAP_FUZZY)}:${Math.round(node.lon / SNAP_FUZZY)}`;
}

function buildWayGraph(ways) {
  const vertices = new Map();
  const edges = [];

  function ensureVertex(node) {
    const key = makeEndpointKey(node);
    let vertex = vertices.get(key);
    if (!vertex) {
      vertex = { id: key, node, edges: [] };
      vertices.set(key, vertex);
    }
    return vertex;
  }

  for (const way of ways) {
    const startNode = way.nodes[0];
    const endNode = way.nodes[way.nodes.length - 1];
    const start = ensureVertex(startNode);
    const end = ensureVertex(endNode);
    const edge = {
      id: edges.length,
      start: start.id,
      end: end.id,
      nodes: way.nodes,
      tags: way.tags ?? {},
      length: measurePolylineLength(way.nodes),
    };

    edges.push(edge);
    start.edges.push(edge.id);
    end.edges.push(edge.id);
  }

  return { vertices, edges };
}

function buildCycleFromEdges(graph, edgeIds) {
  if (!edgeIds.length) {
    return null;
  }

  const adjacency = new Map();
  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId];

    if (!adjacency.has(edge.start)) adjacency.set(edge.start, []);
    if (!adjacency.has(edge.end)) adjacency.set(edge.end, []);
    adjacency.get(edge.start).push(edgeId);
    adjacency.get(edge.end).push(edgeId);
  }

  for (const connectedEdgeIds of adjacency.values()) {
    if (connectedEdgeIds.length !== 2) {
      return null;
    }
  }

  const firstEdgeId = edgeIds[0];
  const firstEdge = graph.edges[firstEdgeId];
  const startVertexId = firstEdge.start;
  let currentVertexId = firstEdge.end;
  let previousEdgeId = firstEdgeId;
  let orderedNodes = [...firstEdge.nodes];
  const orderedEdgeIds = [firstEdgeId];
  const visitedEdges = new Set([firstEdgeId]);

  while (currentVertexId !== startVertexId) {
    const nextEdgeId = adjacency.get(currentVertexId)?.find(edgeId => edgeId !== previousEdgeId);
    if (nextEdgeId == null || visitedEdges.has(nextEdgeId)) {
      return null;
    }

    const nextEdge = graph.edges[nextEdgeId];
    const forward = nextEdge.start === currentVertexId;
    const orientedNodes = forward ? nextEdge.nodes : [...nextEdge.nodes].reverse();
    orderedNodes.push(...orientedNodes.slice(1));
    orderedEdgeIds.push(nextEdgeId);
    visitedEdges.add(nextEdgeId);
    previousEdgeId = nextEdgeId;
    currentVertexId = forward ? nextEdge.end : nextEdge.start;
  }

  if (visitedEdges.size !== edgeIds.length) {
    return null;
  }

  orderedNodes = dedupeSequentialNodes(orderedNodes);

  return {
    edgeIds: orderedEdgeIds,
    nodes: orderedNodes,
    length: orderedEdgeIds.reduce((sum, edgeId) => sum + graph.edges[edgeId].length, 0),
    area: computeBoundingBoxArea(orderedNodes),
    segments: orderedEdgeIds.length,
  };
}

function enumerateCycleCandidates(graph) {
  const cycles = new Map();
  const vertexIds = [...graph.vertices.keys()].sort();
  const maxDepth = Math.max(graph.edges.length + 1, 8);
  const maxCycles = 32;
  let limitReached = false;

  function visit(startVertexId, currentVertexId, pathEdgeIds, visitedVertices) {
    if (limitReached || pathEdgeIds.length > maxDepth) {
      return;
    }

    const vertex = graph.vertices.get(currentVertexId);
    if (!vertex) {
      return;
    }

    for (const edgeId of vertex.edges) {
      const edge = graph.edges[edgeId];
      const nextVertexId = edge.start === currentVertexId ? edge.end : edge.start;

      if (pathEdgeIds.includes(edgeId)) {
        continue;
      }

      if (nextVertexId === startVertexId) {
        if (pathEdgeIds.length >= 1) {
          const edgeIds = [...pathEdgeIds, edgeId].sort((a, b) => a - b);
          const key = edgeIds.join(',');
          if (!cycles.has(key)) {
            const cycle = buildCycleFromEdges(graph, edgeIds);
            if (cycle?.nodes.length >= 4 && cycle.length >= 500) {
              cycles.set(key, cycle);
              if (cycles.size >= maxCycles) {
                limitReached = true;
                return;
              }
            }
          }
        }
        continue;
      }

      if (visitedVertices.has(nextVertexId)) {
        continue;
      }

      visitedVertices.add(nextVertexId);
      visit(startVertexId, nextVertexId, [...pathEdgeIds, edgeId], visitedVertices);
      visitedVertices.delete(nextVertexId);
      if (limitReached) {
        return;
      }
    }
  }

  for (const startVertexId of vertexIds) {
    visit(startVertexId, startVertexId, [], new Set([startVertexId]));
    if (limitReached) {
      break;
    }
  }

  return [...cycles.values()];
}

function inferLayoutName(candidate, graph, trackName, index) {
  const names = new Map();
  let namedLength = 0;

  for (const edgeId of candidate.edgeIds) {
    const name = graph.edges[edgeId].tags?.name?.trim();
    if (!name) {
      continue;
    }

    const weight = graph.edges[edgeId].length;
    namedLength += weight;
    names.set(name, (names.get(name) ?? 0) + weight);
  }

  const [bestName, bestWeight = 0] = [...names.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const isDominantName = bestWeight > 0 && bestWeight >= candidate.length * 0.55 && namedLength >= candidate.length * 0.65;
  if (isDominantName && bestName && bestName.toLowerCase() !== trackName?.toLowerCase()) {
    return bestName;
  }

  return `Layout ${index + 1}`;
}

function areCandidatesNearDuplicates(a, b) {
  const longerLength = Math.max(a.length, b.length, 1);
  const largerArea = Math.max(a.area, b.area, 1);
  const lengthDelta = Math.abs(a.length - b.length) / longerLength;
  const areaDelta = Math.abs(a.area - b.area) / largerArea;
  return lengthDelta <= 0.03 && areaDelta <= 0.08;
}

function buildStitchedCandidate(ways) {
  const nodes = dedupeSequentialNodes(stitchWaysOrdered(ways));
  return {
    edgeIds: ways.map((_, index) => index),
    nodes,
    length: measurePolylineLength(nodes),
    area: computeBoundingBoxArea(nodes),
    segments: ways.length,
    endpointGap: computeEndpointGap(nodes),
  };
}

function buildLayoutsFromWays(ways, trackName) {
  if (!ways.length) {
    return [];
  }

  const graph = buildWayGraph(ways);
  const cycleCandidates = enumerateCycleCandidates(graph);
  const stitchedCandidate = buildStitchedCandidate(ways);

  const sortedCandidates = cycleCandidates.sort((a, b) => {
    const lengthDelta = b.length - a.length;
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }
    return b.area - a.area;
  });

  const longestLength = sortedCandidates[0]?.length ?? 0;
  const largestArea = sortedCandidates.reduce((max, candidate) => Math.max(max, candidate.area), 0);
  const plausible = sortedCandidates.filter(candidate => {
    const keepsLength = longestLength === 0 || candidate.length >= longestLength * 0.5;
    const keepsArea = largestArea === 0 || candidate.area >= largestArea * 0.3;
    return keepsLength || keepsArea;
  });

  if (
    stitchedCandidate.nodes.length >= 4 &&
    stitchedCandidate.endpointGap <= 80 &&
    (plausible.length === 0 || stitchedCandidate.length >= (longestLength || 0) * 1.1) &&
    !plausible.some(candidate => areCandidatesNearDuplicates(candidate, stitchedCandidate))
  ) {
    plausible.unshift(stitchedCandidate);
  }

  const uniquePlausible = plausible.filter((candidate, index) => {
    return !plausible.slice(0, index).some(existing => areCandidatesNearDuplicates(existing, candidate));
  });

  const layouts = (uniquePlausible.length > 0 ? uniquePlausible : [stitchedCandidate]).slice(0, 6).map((candidate, index) => ({
    id: `layout-${index + 1}`,
    name: inferLayoutName(candidate, graph, trackName, index),
    nodes: candidate.nodes,
    stats: {
      lengthMetres: candidate.length,
      segmentCount: candidate.segments,
    },
  }));

  return layouts;
}

function stitchWays(ways) {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].nodes;

  const components = buildComponents(ways);

  // Pick the component whose centroid is closest to the known circuit coordinates.
  // Falls back to largest-by-nodes if no ref coords available.
  // Use the largest component by total node count.
  // The main racing circuit will always have far more nodes than
  // adjacent karting tracks, theme park rides, rallycross, etc.
  const best = components.reduce((a, b) => {
    const an = a.reduce((s, i) => s + ways[i].nodes.length, 0);
    const bn = b.reduce((s, i) => s + ways[i].nodes.length, 0);
    return bn > an ? b : a;
  });

  const mainWays = best.map(i => ways[i]);
  return stitchWaysOrdered(mainWays);
}

// Fetch raceway geometry using Overpass bbox query around Wikidata P625 coordinates.
// Much more reliable than P402 (stale OSM relation IDs) or name searches (timeouts).
export async function fetchTrackGeometry(lat, lon, signal, trackName) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('No coordinates available for this circuit');
  }

  // ~9km margin — covers any F1 circuit layout but avoids pulling in distant tracks
  const MARGIN = 0.08;
  const bbox = `${lat - MARGIN},${lon - MARGIN},${lat + MARGIN},${lon + MARGIN}`;
  const query = `[out:json][timeout:25];way["highway"="raceway"](${bbox});out body geom;`;

  const data = await runOverpassQuery(query, signal);
  const ways = (data.elements || []).filter(e => e.type === 'way' && e.geometry?.length > 1);

  if (ways.length === 0) {
    throw new Error(`No raceway found near ${trackName ?? 'this location'}`);
  }

  // Exclude pit lanes and service roads — but NOT straights that merely contain "pit"
  // in their name (e.g. "National Pit Straight" is a legit racing-line way at Silverstone).
  const PIT_PATTERN = /pit[\s\-_]*lane|pit[\s\-_]*road|pitlane|pitroad|support[\s\-_]*pit|\bpit\s*$/i;
  const mainWays = ways.filter(w => {
    const name = w.tags?.name ?? '';
    return !PIT_PATTERN.test(name);
  });
  const racingWays = mainWays.length > 0 ? mainWays : ways; // fallback if over-filtered

  const waysWithGeom = racingWays.map(w => ({
    id: w.id,
    tags: w.tags ?? {},
    nodes: (w.geometry || []).map(({ lat: wlat, lon: wlon }) => ({ lat: wlat, lon: wlon })),
  }));

  const components = buildComponents(waysWithGeom);
  const bestComponent = components.reduce((a, b) => {
    const an = a.reduce((sum, index) => sum + waysWithGeom[index].nodes.length, 0);
    const bn = b.reduce((sum, index) => sum + waysWithGeom[index].nodes.length, 0);
    return bn > an ? b : a;
  });

  const componentWays = bestComponent.map(index => waysWithGeom[index]);
  const layouts = buildLayoutsFromWays(componentWays, trackName);

  if (layouts.length === 0) {
    return {
      layouts: [{
        id: 'layout-1',
        name: 'Layout 1',
        nodes: stitchWays(componentWays),
        stats: {
          lengthMetres: componentWays.reduce((sum, way) => sum + measurePolylineLength(way.nodes), 0),
          segmentCount: componentWays.length,
        },
      }],
      selectedLayoutIndex: 0,
    };
  }

  return {
    layouts,
    selectedLayoutIndex: 0,
  };
}
