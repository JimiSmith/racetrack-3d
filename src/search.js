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

// Fix "spikes" in a node chain where a section is traversed backwards.
// A spike shows up as two near-180° reversals — the chain goes forward, then
// abruptly backward (reversal 1), then forward again (reversal 2).
// Reversing the section between the two reversal points fixes the winding.
// Genuine sharp corners (hairpins) don't create paired reversals like this.
function fixChainReversals(nodes) {
  if (nodes.length < 6) return nodes;

  const reversals = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const d1lat = nodes[i].lat - nodes[i - 1].lat;
    const d1lon = nodes[i].lon - nodes[i - 1].lon;
    const d2lat = nodes[i + 1].lat - nodes[i].lat;
    const d2lon = nodes[i + 1].lon - nodes[i].lon;
    const m1 = Math.sqrt(d1lat * d1lat + d1lon * d1lon);
    const m2 = Math.sqrt(d2lat * d2lat + d2lon * d2lon);
    if (m1 > 1e-10 && m2 > 1e-10) {
      const dot = (d1lat * d2lat + d1lon * d2lon) / (m1 * m2);
      if (dot < -0.9) reversals.push(i);
    }
  }

  if (reversals.length < 2) return nodes;

  // Fix in pairs: reverse the section between each consecutive pair of reversals
  const result = [...nodes];
  for (let i = 0; i + 1 < reversals.length; i += 2) {
    const start = reversals[i];
    const end = reversals[i + 1];
    const section = result.slice(start + 1, end + 1).reverse();
    result.splice(start + 1, end - start, ...section);
  }
  return result;
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

function selectBackboneCycle(graph) {
  const cycleCandidates = enumerateCycleCandidates(graph);
  return cycleCandidates.sort((a, b) => {
    const lengthDelta = b.length - a.length;
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }
    return b.area - a.area;
  })[0] ?? null;
}

function measureWaySetLength(ways) {
  return ways.reduce((sum, way) => sum + measurePolylineLength(way.nodes), 0);
}

function buildCandidateFromWays(ways) {
  if (!ways.length) {
    return null;
  }

  const graph = buildWayGraph(ways);
  const edgeIds = graph.edges.map(edge => edge.id);
  const isSimpleLoop = graph.edges.length > 0 && [...graph.vertices.values()].every(vertex => vertex.edges.length === 2);
  const cycleCandidate = isSimpleLoop ? buildCycleFromEdges(graph, edgeIds) : null;
  const nodes = cycleCandidate?.nodes ?? dedupeSequentialNodes(stitchWaysOrdered(ways));

  return {
    nodes,
    length: cycleCandidate?.length ?? measurePolylineLength(nodes),
    area: computeBoundingBoxArea(nodes),
    segments: ways.length,
    endpointGap: computeEndpointGap(nodes),
  };
}

function buildWeightedNames(edgeIds, graph, trackName) {
  const names = new Map();
  let namedLength = 0;

  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId];
    const name = edge?.tags?.name?.trim();
    if (!name || name.toLowerCase() === trackName?.toLowerCase()) {
      continue;
    }

    namedLength += edge.length;
    names.set(name, (names.get(name) ?? 0) + edge.length);
  }

  return { names, namedLength };
}

function inferBranchName(branch, graph, trackName) {
  const { names, namedLength } = buildWeightedNames(branch.edgeIds, graph, trackName);
  const [bestName, bestWeight = 0] = [...names.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const isDominantName = bestName && bestWeight >= branch.length * 0.35 && namedLength >= branch.length * 0.35;
  return isDominantName ? bestName : null;
}

function makeFallbackBranchLabels(branches) {
  if (branches.length === 2) {
    const [first, second] = [...branches].sort((a, b) => Number(b.onBackbone) - Number(a.onBackbone) || b.length - a.length);
    if (first.onBackbone || (first.length > 0 && second.length / first.length <= 0.92)) {
      return new Map([
        [first.edgeIds.join(','), 'Main'],
        [second.edgeIds.join(','), 'Alternate'],
      ]);
    }
  }

  return new Map(branches.map((branch, index) => [branch.edgeIds.join(','), `Layout ${String.fromCharCode(65 + index)}`]));
}

function orientEdgeNodes(edge, fromVertexId) {
  return edge.start === fromVertexId ? edge.nodes : [...edge.nodes].reverse();
}

function walkBranchToJunction(graph, startVertexId, initialEdgeId) {
  const startVertex = graph.vertices.get(startVertexId);
  if (!startVertex || !startVertex.edges.includes(initialEdgeId)) {
    return null;
  }

  const traversedEdgeIds = [];
  const visitedEdgeIds = new Set();
  const visitedVertexIds = new Set([startVertexId]);
  let currentVertexId = startVertexId;
  let edgeId = initialEdgeId;
  let nodes = [];

  while (edgeId != null) {
    if (visitedEdgeIds.has(edgeId)) {
      return null;
    }

    visitedEdgeIds.add(edgeId);
    traversedEdgeIds.push(edgeId);
    const edge = graph.edges[edgeId];
    const orientedNodes = orientEdgeNodes(edge, currentVertexId);
    nodes = nodes.length === 0 ? [...orientedNodes] : [...nodes, ...orientedNodes.slice(1)];

    const nextVertexId = edge.start === currentVertexId ? edge.end : edge.start;
    if (nextVertexId === startVertexId || visitedVertexIds.has(nextVertexId)) {
      return null;
    }

    const nextVertex = graph.vertices.get(nextVertexId);
    if (!nextVertex) {
      return null;
    }

    visitedVertexIds.add(nextVertexId);
    if (nextVertex.edges.length !== 2) {
      return {
        startVertexId,
        endVertexId: nextVertexId,
        edgeIds: traversedEdgeIds,
        nodes: dedupeSequentialNodes(nodes),
        length: traversedEdgeIds.reduce((sum, traversedEdgeId) => sum + graph.edges[traversedEdgeId].length, 0),
      };
    }

    edgeId = nextVertex.edges.find(candidateEdgeId => candidateEdgeId !== edge.id);
    currentVertexId = nextVertexId;
  }

  return null;
}

function detectForkSections(graph, backboneEdgeIds = null) {
  const sectionCandidates = [];

  for (const [vertexId, vertex] of graph.vertices.entries()) {
    if (vertex.edges.length < 3) {
      continue;
    }

    const groupedBranches = new Map();
    for (const edgeId of vertex.edges) {
      const branch = walkBranchToJunction(graph, vertexId, edgeId);
      if (!branch || branch.endVertexId === vertexId) {
        continue;
      }

      const mergeVertex = graph.vertices.get(branch.endVertexId);
      if (!mergeVertex || mergeVertex.edges.length < 3) {
        continue;
      }

      if (!groupedBranches.has(branch.endVertexId)) {
        groupedBranches.set(branch.endVertexId, []);
      }
      groupedBranches.get(branch.endVertexId).push(branch);
    }

    for (const [mergeVertexId, branches] of groupedBranches.entries()) {
      if (branches.length < 2) {
        continue;
      }

      const forkTouchesBackbone = !backboneEdgeIds || vertex.edges.some(edgeId => backboneEdgeIds.has(edgeId));
      const mergeVertex = graph.vertices.get(mergeVertexId);
      const mergeTouchesBackbone = !backboneEdgeIds || mergeVertex?.edges.some(edgeId => backboneEdgeIds.has(edgeId));
      const backboneBranches = !backboneEdgeIds
        ? branches
        : branches.filter(branch => branch.edgeIds.some(edgeId => backboneEdgeIds.has(edgeId)));

      if (!forkTouchesBackbone || !mergeTouchesBackbone || backboneBranches.length === 0) {
        continue;
      }

      const orderedBranches = branches
        .map(branch => ({ ...branch, onBackbone: branch.edgeIds.some(edgeId => backboneEdgeIds?.has(edgeId)) }))
        .sort((a, b) => Number(b.onBackbone) - Number(a.onBackbone) || b.length - a.length);

      const branchKeys = orderedBranches
        .map(branch => [...branch.edgeIds].sort((a, b) => a - b).join(','))
        .sort();
      sectionCandidates.push({
        key: `${[vertexId, mergeVertexId].sort().join('::')}|${branchKeys.join('|')}`,
        forkVertexId: vertexId,
        mergeVertexId,
        branches: orderedBranches,
        totalLength: orderedBranches.reduce((sum, branch) => sum + branch.length, 0),
      });
    }
  }

  const uniqueSections = [...new Map(sectionCandidates.map(section => [section.key, section])).values()]
    .sort((a, b) => b.totalLength - a.totalLength);
  const usedEdgeIds = new Set();
  const acceptedSections = [];

  for (const section of uniqueSections) {
    const overlapsExistingSection = section.branches.some(branch => branch.edgeIds.some(edgeId => usedEdgeIds.has(edgeId)));
    if (overlapsExistingSection) {
      continue;
    }

    section.branches.forEach(branch => branch.edgeIds.forEach(edgeId => usedEdgeIds.add(edgeId)));
    acceptedSections.push(section);
  }

  return acceptedSections;
}

function enumerateBranchCombinations(sections, maxCombinations = 8) {
  if (!sections.length) {
    return [[]];
  }

  const combinations = [];

  function visit(sectionIndex, selectedBranches) {
    if (combinations.length >= maxCombinations) {
      return;
    }

    if (sectionIndex >= sections.length) {
      combinations.push(selectedBranches);
      return;
    }

    for (const branch of sections[sectionIndex].branches) {
      visit(sectionIndex + 1, [...selectedBranches, branch]);
      if (combinations.length >= maxCombinations) {
        return;
      }
    }
  }

  visit(0, []);
  return combinations;
}

function buildVariantLayouts(ways, graph, sections, trackName) {
  const sectionEdgeIds = new Set(sections.flatMap(section => section.branches.flatMap(branch => branch.edgeIds)));
  const sharedWayIds = ways
    .map((_, index) => index)
    .filter(index => !sectionEdgeIds.has(index));
  const branchFallbackLabels = new Map();

  for (const section of sections) {
    const fallbacks = makeFallbackBranchLabels(section.branches);
    for (const branch of section.branches) {
      const branchKey = branch.edgeIds.join(',');
      branchFallbackLabels.set(branchKey, inferBranchName(branch, graph, trackName) ?? fallbacks.get(branchKey) ?? 'Alternate');
    }
  }

  const combinations = enumerateBranchCombinations(sections);
  const layouts = [];

  for (const selectedBranches of combinations) {
    const selectedWayIds = [...sharedWayIds];
    const nameParts = [];

    for (const branch of selectedBranches) {
      selectedWayIds.push(...branch.edgeIds);
      nameParts.push(branchFallbackLabels.get(branch.edgeIds.join(',')) ?? 'Alternate');
    }

    const uniqueWayIds = [...new Set(selectedWayIds)].sort((a, b) => a - b);
    const selectedWays = uniqueWayIds.map(index => ways[index]);
    const candidate = buildCandidateFromWays(selectedWays);

    if (!candidate || candidate.nodes.length < 4 || candidate.endpointGap > 80) {
      continue;
    }

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: sections.length === 1 ? (nameParts[0] ?? `Layout ${layouts.length + 1}`) : nameParts.join(' + '),
      nodes: fixChainReversals(candidate.nodes),
      area: candidate.area,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: selectedWays.length,
        variantSectionCount: sections.length,
      },
    });
  }

  return layouts;
}

function buildOrderedCycleMetadata(graph, edgeIds) {
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
  const orderedEdges = [];
  const orderedNodes = [...firstEdge.nodes];
  const visitedEdges = new Set([firstEdgeId]);
  let currentVertexId = firstEdge.end;
  let previousEdgeId = firstEdgeId;

  orderedEdges.push({
    edgeId: firstEdgeId,
  });

  while (currentVertexId !== firstEdge.start) {
    const nextEdgeId = adjacency.get(currentVertexId)?.find(edgeId => edgeId !== previousEdgeId);
    if (nextEdgeId == null || visitedEdges.has(nextEdgeId)) {
      return null;
    }

    const nextEdge = graph.edges[nextEdgeId];
    const forward = nextEdge.start === currentVertexId;
    const orientedNodes = forward ? nextEdge.nodes : [...nextEdge.nodes].reverse();
    orderedNodes.push(...orientedNodes.slice(1));
    orderedEdges.push({
      edgeId: nextEdgeId,
    });
    visitedEdges.add(nextEdgeId);
    previousEdgeId = nextEdgeId;
    currentVertexId = forward ? nextEdge.end : nextEdge.start;
  }

  if (visitedEdges.size !== edgeIds.length) {
    return null;
  }

  return {
    nodes: dedupeSequentialNodes(orderedNodes),
    orderedEdges,
  };
}

function findClosestNodePositions(nodes, targetNode, maxDistance, limit = 8) {
  const searchNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  const matches = searchNodes
    .map((node, index) => ({ index, distance: dist(node, targetNode) }))
    .filter(match => match.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.index - b.index);

  return matches.slice(0, limit);
}

function sliceClosedNodeChain(nodes, startIndex, endIndex) {
  const baseNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  if (!baseNodes.length) {
    return [];
  }

  if (startIndex <= endIndex) {
    return baseNodes.slice(startIndex, endIndex + 1);
  }

  return [...baseNodes.slice(startIndex), ...baseNodes.slice(0, endIndex + 1)];
}

function orientVariantNodes(variantNodes, startNode, endNode) {
  const forwardScore = dist(variantNodes[0], startNode) + dist(variantNodes[variantNodes.length - 1], endNode);
  const reverseScore = dist(variantNodes[0], endNode) + dist(variantNodes[variantNodes.length - 1], startNode);
  return reverseScore < forwardScore ? [...variantNodes].reverse() : variantNodes;
}

function buildNamedGroupChain(namedWays) {
  return dedupeSequentialNodes(stitchWaysOrdered(namedWays));
}

function buildSubstitutionLayouts(nameGroups, backboneGroupName, backboneWays, backboneCandidate) {
  const backboneGraph = buildWayGraph(backboneWays);
  const cycleMetadata = buildOrderedCycleMetadata(backboneGraph, backboneGraph.edges.map(edge => edge.id));
  if (!cycleMetadata || cycleMetadata.orderedEdges.length !== backboneWays.length) {
    return [];
  }

  const MAX_ENDPOINT_MATCH_DISTANCE = SNAP_FUZZY * 8;
  const MIN_LENGTH = 1000;
  const MAX_GAP_FRACTION = 0.2;
  const layouts = [{
    id: 'layout-1',
    name: backboneGroupName,
    nodes: backboneCandidate.nodes,
    stats: {
      lengthMetres: backboneCandidate.length,
      segmentCount: backboneWays.length,
      variantSectionCount: 0,
    },
  }];

  for (const [groupName, namedWays] of nameGroups) {
    if (groupName === backboneGroupName) {
      continue;
    }

    const variantNodes = buildNamedGroupChain(namedWays);
    if (variantNodes.length < 2) {
      continue;
    }

    const startMatches = findClosestNodePositions(
      cycleMetadata.nodes,
      variantNodes[0],
      MAX_ENDPOINT_MATCH_DISTANCE,
    );
    const endMatches = findClosestNodePositions(
      cycleMetadata.nodes,
      variantNodes[variantNodes.length - 1],
      MAX_ENDPOINT_MATCH_DISTANCE,
    );

    if (!startMatches.length || !endMatches.length) {
      continue;
    }

    const variantLength = measureWaySetLength(namedWays);
    let bestLayout = null;

    for (const startMatch of startMatches) {
      for (const endMatch of endMatches) {
        if (startMatch.index === endMatch.index) {
          continue;
        }

        const forwardReplacementNodes = sliceClosedNodeChain(cycleMetadata.nodes, startMatch.index, endMatch.index);
        const reverseReplacementNodes = sliceClosedNodeChain(cycleMetadata.nodes, endMatch.index, startMatch.index);
        const replacementCandidates = [
          {
            replacementNodes: forwardReplacementNodes,
            preservedNodes: reverseReplacementNodes,
            variantNodes: orientVariantNodes(variantNodes, forwardReplacementNodes[0], forwardReplacementNodes[forwardReplacementNodes.length - 1]),
          },
          {
            replacementNodes: reverseReplacementNodes,
            preservedNodes: forwardReplacementNodes,
            variantNodes: orientVariantNodes(variantNodes, reverseReplacementNodes[0], reverseReplacementNodes[reverseReplacementNodes.length - 1]),
          },
        ].map(option => ({
          ...option,
          replacementLength: measurePolylineLength(option.replacementNodes),
        })).sort((a, b) => {
          const delta = Math.abs(a.replacementLength - variantLength) - Math.abs(b.replacementLength - variantLength);
          if (Math.abs(delta) > 1) {
            return delta;
          }
          return a.replacementLength - b.replacementLength;
        });

        const replacement = replacementCandidates[0];
        if (!replacement?.preservedNodes?.length || replacement.preservedNodes.length < 2) {
          continue;
        }

        const selectedWays = [
          { nodes: replacement.preservedNodes, tags: { name: backboneGroupName } },
          { nodes: replacement.variantNodes, tags: { name: groupName } },
        ];

        const candidate = buildCandidateFromWays(selectedWays);
        if (!candidate || candidate.nodes.length < 4) {
          continue;
        }
        if (candidate.length < MIN_LENGTH) {
          continue;
        }
        if (candidate.endpointGap > candidate.length * MAX_GAP_FRACTION) {
          continue;
        }

        const score = (startMatch.distance + endMatch.distance) * 1000000
          + Math.abs(candidate.length - backboneCandidate.length)
          + Math.abs(replacement.replacementLength - variantLength);
        if (!bestLayout || score < bestLayout.score) {
          bestLayout = {
            score,
            candidate,
            selectedWays,
          };
        }
      }
    }

    if (!bestLayout) {
      continue;
    }

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: groupName,
      nodes: bestLayout.candidate.nodes,
      stats: {
        lengthMetres: bestLayout.candidate.length,
        segmentCount: bestLayout.selectedWays.length,
        variantSectionCount: 1,
      },
    });
  }

  return layouts.length >= 2 ? layouts : [];
}

// Detect layouts from ways that carry distinct "circuit-level" names.
// E.g. Bahrain: "Grand Prix Circuit", "Inner Circuit", "Endurance Circuit" — each
// group of named ways forms a COMPLETE standalone circuit on its own.
//
// This is different from Spa-style forks (short branches like "Moto layout" that
// are not complete circuits by themselves).  The key filter: a named group must be
// able to stitch into a near-closed loop on its own (endpointGap < 15% of length).
// Short stubs / rallycross / theme-park branches fail this test and are ignored here;
// the fork-based detector handles them downstream.
//
// Returns [] if no two named groups independently form valid closed circuits.
function buildNamedCircuitLayouts(ways, trackName) {
  const CIRCUIT_KEYWORD = /\b(circuit|layout|oval|grand[\s_-]*prix|national|endurance|inner|outer|short)\b/i;
  const MIN_LENGTH = 1500; // metres — ignore sub-km stubs
  const MAX_GAP_FRACTION = 0.15; // endpoint gap must be < 15% of total length

  const nameGroups = new Map();
  for (const way of ways) {
    const name = (way.tags?.name ?? '').trim();
    if (!name || !CIRCUIT_KEYWORD.test(name)) continue;
    if (!nameGroups.has(name)) nameGroups.set(name, []);
    nameGroups.get(name).push(way);
  }

  if (nameGroups.size < 2) return [];

  const standaloneLayouts = [];
  for (const [groupName, namedWays] of nameGroups) {
    // Only use the named ways — no shared backbone mixing
    const candidate = buildCandidateFromWays(namedWays);
    if (!candidate || candidate.nodes.length < 4) continue;
    if (candidate.length < MIN_LENGTH) continue;
    // Must form a near-closed loop on its own
    if (candidate.endpointGap > candidate.length * MAX_GAP_FRACTION) continue;

    standaloneLayouts.push({
      id: `layout-${standaloneLayouts.length + 1}`,
      name: groupName,
      nodes: candidate.nodes,
      candidate,
      ways: namedWays,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: namedWays.length,
        variantSectionCount: 0,
      },
    });
  }

  // Need at least 2 valid standalone circuits to show a picker
  if (standaloneLayouts.length >= 2) {
    standaloneLayouts.sort((a, b) => b.stats.lengthMetres - a.stats.lengthMetres);
    return standaloneLayouts.map(({ candidate, ways: groupedWays, ...layout }) => layout);
  }

  if (standaloneLayouts.length !== 1) {
    return [];
  }

  const backboneLayout = standaloneLayouts[0];
  const substitutionLayouts = buildSubstitutionLayouts(
    nameGroups,
    backboneLayout.name,
    backboneLayout.ways,
    backboneLayout.candidate,
  );
  if (substitutionLayouts.length >= 2) {
    substitutionLayouts.sort((a, b) => b.stats.lengthMetres - a.stats.lengthMetres);
    return substitutionLayouts;
  }

  return [];
}

function buildLayoutsFromWays(ways, trackName) {
  if (!ways.length) {
    return [];
  }

  const graph = buildWayGraph(ways);
  const backboneCycle = selectBackboneCycle(graph);
  const sections = detectForkSections(graph, new Set(backboneCycle?.edgeIds ?? []));
  const variantLayouts = buildVariantLayouts(ways, graph, sections, trackName);

  if (variantLayouts.length > 1) {
    return variantLayouts.slice(0, 8).map(({ area, ...layout }) => layout);
  }

  const singleLayout = buildCandidateFromWays(ways);
  if (!singleLayout || singleLayout.nodes.length < 4) {
    return [];
  }

  return [{
    id: 'layout-1',
    name: 'Main',
    nodes: singleLayout.nodes,
    stats: {
      lengthMetres: singleLayout.length || measureWaySetLength(ways),
      segmentCount: ways.length,
      variantSectionCount: 0,
    },
  }];
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

  // Pre-pass: if the component contains multiple explicitly-named distinct circuits
  // (e.g. Bahrain's "Grand Prix Circuit", "Inner Circuit", "Endurance Circuit"),
  // offer each as a named layout before falling through to fork-based detection.
  const namedLayouts = buildNamedCircuitLayouts(componentWays, trackName);
  if (namedLayouts.length > 1) {
    return { layouts: namedLayouts, selectedLayoutIndex: 0 };
  }

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
