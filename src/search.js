import trackSearchIndex from './generated/track-search-index.json' with { type: 'json' };
import { getTrackGeometry } from './geometry-index.js';

export {
  buildTrackDisplayName,
  buildTrackSearchEntry,
  normalizeSearchText,
  searchLocalTrackIndex,
  tokenizeNormalizedText,
} from './search-index.js';

import { searchLocalTrackIndex } from './search-index.js';

export async function searchTracks(query, signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return searchLocalTrackIndex(query, trackSearchIndex);
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ENDPOINT_TIMEOUT_MS = 12000;

async function runOverpassQueries(query, signal) {
  const body = `data=${encodeURIComponent(query)}`;
  const errors = [];
  const results = [];

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
      results.push({ endpoint, data: await response.json() });
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      errors.push(`${endpoint}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
  }
  if (results.length > 0) {
    return results;
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

function measureDistanceMetres(a, b) {
  return measurePolylineLength([a, b]);
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

function closeNodeChainIfNearClosed(nodes, maxGapMetres = 80) {
  if (nodes.length < 2) {
    return nodes;
  }

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) {
    return nodes;
  }

  return computeEndpointGap(nodes) <= maxGapMetres
    ? [...nodes, first]
    : nodes;
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

function isImmediateBacktrack(prev, current, next) {
  const lenA = measureDistanceMetres(prev, current);
  const lenB = measureDistanceMetres(current, next);
  if (lenA < 0.01 || lenB < 0.01) {
    return false;
  }

  const d1x = current.lon - prev.lon;
  const d1y = current.lat - prev.lat;
  const d2x = next.lon - current.lon;
  const d2y = next.lat - current.lat;
  const dot = (d1x * d2x + d1y * d2y) / (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y));
  const returnGap = measureDistanceMetres(prev, next);
  if (dot < -0.98 && returnGap <= Math.max(lenA, lenB) * 0.25) {
    return true;
  }

  return Math.max(lenA, lenB) <= 10
    && dot < -0.8
    && returnGap <= Math.max(lenA, lenB) * 0.75;
}

function collapseImmediateBacktracks(nodes) {
  let result = [...nodes];
  let changed = true;

  while (changed && result.length >= 3) {
    changed = false;
    const collapsed = [result[0]];

    for (let index = 1; index < result.length - 1; index += 1) {
      const prev = collapsed[collapsed.length - 1];
      const current = result[index];
      const next = result[index + 1];

      if (isImmediateBacktrack(prev, current, next)) {
        changed = true;
        continue;
      }

      collapsed.push(current);
    }

    collapsed.push(result[result.length - 1]);
    result = dedupeSequentialNodes(collapsed);
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

export function stitchWaysOrdered(ways) {
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

export function buildWayGraph(ways) {
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

export function buildCycleFromEdges(graph, edgeIds) {
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
  const stitchedNodes = cycleCandidate?.nodes ?? dedupeSequentialNodes(stitchWaysOrdered(ways));
  const nodes = closeNodeChainIfNearClosed(stitchedNodes);

  return {
    nodes,
    length: cycleCandidate?.length ?? measurePolylineLength(nodes),
    area: computeBoundingBoxArea(nodes),
    segments: ways.length,
    endpointGap: computeEndpointGap(nodes),
  };
}

function normalizeCircuitName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function namesLikelyMatchCircuit(candidateName, trackName) {
  const candidateKey = normalizeCircuitName(candidateName);
  const trackKey = normalizeCircuitName(trackName);

  if (!candidateKey || !trackKey) {
    return false;
  }

  return candidateKey === trackKey
    || candidateKey.includes(trackKey)
    || trackKey.includes(candidateKey);
}

const NAMED_LAYOUT_KEYWORD_PATTERN = /\b(circuit|course|layout|oval|grand[\s_-]*prix|indy|national|endurance|inner|outer|short)\b/i;

function getWayCandidateNameEntries(way) {
  const entries = [];
  const seenNames = new Set();

  const wayName = way?.tags?.name?.trim();
  if (wayName) {
    seenNames.add(wayName);
    entries.push({ name: wayName, source: 'way' });
  }

  const relationNames = Array.isArray(way?.tags?.relationNames)
    ? way.tags.relationNames
    : [];
  for (const relationName of relationNames) {
    const trimmedName = relationName?.trim();
    if (!trimmedName || seenNames.has(trimmedName)) {
      continue;
    }

    seenNames.add(trimmedName);
    entries.push({ name: trimmedName, source: 'relation' });
  }

  return entries;
}

function getWayCandidateNames(way) {
  return getWayCandidateNameEntries(way).map(({ name }) => name);
}

function wayLikelyMatchesCircuit(way, trackName) {
  return getWayCandidateNames(way).some(name => namesLikelyMatchCircuit(name, trackName));
}

function selectBestComponentWays(ways, trackName = null) {
  if (ways.length <= 1) {
    return ways;
  }

  const components = buildComponents(ways);
  if (components.length <= 1) {
    return ways;
  }

  const rankedComponents = components.map(component => {
    const componentWays = component.map(index => ways[index]);
    const candidate = buildCandidateFromWays(componentWays);
    const matchedWays = componentWays.filter(way => wayLikelyMatchesCircuit(way, trackName));
    const matchedLength = measureWaySetLength(matchedWays);
    const gapRatio = candidate?.length > 0
      ? candidate.endpointGap / candidate.length
      : Infinity;
    const candidateLength = candidate?.length ?? 0;
    const strongTrackNameMatch = matchedLength >= Math.max(250, Math.min(1500, candidateLength * 0.18));
    const nearClosed = gapRatio <= 0.16;

    return {
      componentWays,
      candidate,
      matchedLength,
      hasTrackNameMatch: matchedWays.length > 0,
      strongTrackNameMatch,
      gapRatio,
      nearClosed,
      candidateLength,
      totalLength: measureWaySetLength(componentWays),
      totalNodes: componentWays.reduce((sum, way) => sum + way.nodes.length, 0),
      area: candidate?.area ?? 0,
    };
  });

  rankedComponents.sort((a, b) => {
    if (a.strongTrackNameMatch !== b.strongTrackNameMatch) {
      const namedComp = b.strongTrackNameMatch ? b : a;
      const otherComp = b.strongTrackNameMatch ? a : b;
      // Only give name-match absolute priority when the named component itself forms
      // a closed circuit, or neither does, or the size difference is negligible.
      // Otherwise a small open named fragment would beat a much larger closed circuit
      // (e.g. a pit straight named after the venue vs. the full public-road loop).
      const namedWins =
        namedComp.nearClosed ||
        !otherComp.nearClosed ||
        otherComp.candidateLength - namedComp.candidateLength <= 500;
      if (namedWins) {
        return Number(b.strongTrackNameMatch) - Number(a.strongTrackNameMatch);
      }
      // Fall through to length comparison
    }

    const candidateLengthDelta = b.candidateLength - a.candidateLength;
    if (Math.abs(candidateLengthDelta) > 500) {
      return candidateLengthDelta;
    }

    if (a.nearClosed !== b.nearClosed) {
      return Number(b.nearClosed) - Number(a.nearClosed);
    }

    if (a.hasTrackNameMatch !== b.hasTrackNameMatch) {
      return Number(b.hasTrackNameMatch) - Number(a.hasTrackNameMatch);
    }

    const gapRatioDelta = a.gapRatio - b.gapRatio;
    if (Math.abs(gapRatioDelta) > 0.08) {
      return gapRatioDelta;
    }

    const matchedLengthDelta = b.matchedLength - a.matchedLength;
    if (Math.abs(matchedLengthDelta) > 1) {
      return matchedLengthDelta;
    }

    const lengthDelta = b.totalLength - a.totalLength;
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }

    const areaDelta = b.area - a.area;
    if (Math.abs(areaDelta) > 1) {
      return areaDelta;
    }

    return b.totalNodes - a.totalNodes;
  });

  return rankedComponents[0]?.componentWays ?? ways;
}

function buildWeightedNames(edgeIds, graph, trackName) {
  const names = new Map();
  let namedLength = 0;

  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId];
    for (const name of getWayCandidateNames(edge)) {
      if (name.toLowerCase() === trackName?.toLowerCase()) {
        continue;
      }

      namedLength += edge.length;
      names.set(name, (names.get(name) ?? 0) + edge.length);
    }
  }

  return { names, namedLength };
}

const PRIMARY_LAYOUT_PATTERN = /\b(main|grand[\s_-]*prix)\b/i;
const SECONDARY_LAYOUT_PATTERN = /\b(alternate|alternative|club|corkscrew|endurance|formula\s*e|e[\s_-]*prix|flat|inner|joker|kart|moto|national|outer|oval|paddock|rallycross|short|test)\b/i;
const SHORTCUT_LAYOUT_PATTERN = /\b(inner|oasis|oval|test)\b/i;

function canonicalizeLayoutName(name) {
  const normalizedName = normalizeCircuitName(name);

  if (normalizedName === 'flat oval layout' || normalizedName === 'bahrain oval gp') {
    return 'Test Oval';
  }

  return name;
}

function getKnownLayoutLengthTarget(trackName, label) {
  const normalizedTrackName = normalizeCircuitName(trackName);
  const normalizedLabel = normalizeCircuitName(label);

  if (normalizedTrackName === 'bahrain international circuit') {
    if (normalizedLabel === 'inner circuit') {
      return 2550;
    }

    if (normalizedLabel === 'flat oval layout' || normalizedLabel === 'bahrain oval gp' || normalizedLabel === 'test oval') {
      return 2500;
    }
  }

  return null;
}

function scoreLayoutChoice(layout, trackName) {
  const name = layout?.name?.trim() ?? '';
  let score = 0;

  if (namesLikelyMatchCircuit(name, trackName)) {
    score += 420;
  }
  if (PRIMARY_LAYOUT_PATTERN.test(name)) {
    score += 520;
  }
  if (name === 'Main') {
    score += 260;
  }
  if (SECONDARY_LAYOUT_PATTERN.test(name)) {
    score -= 360;
  }

  score += Math.min(layout?.stats?.lengthMetres ?? 0, 9000) / 20;
  return score;
}

function rankLayoutsForTrack(layouts, trackName) {
  return [...layouts].sort((a, b) => {
    const sourceRankDelta = (b?.nameSourceRank ?? 0) - (a?.nameSourceRank ?? 0);
    if (sourceRankDelta !== 0) {
      return sourceRankDelta;
    }

    const scoreDelta = scoreLayoutChoice(b, trackName) - scoreLayoutChoice(a, trackName);
    if (Math.abs(scoreDelta) > 1) {
      return scoreDelta;
    }

    const lengthDelta = (b?.stats?.lengthMetres ?? 0) - (a?.stats?.lengthMetres ?? 0);
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }

    return a.name.localeCompare(b.name);
  });
}

function compareLayoutsForTrack(trackName, a, b) {
  const sourceRankDelta = (b?.nameSourceRank ?? 0) - (a?.nameSourceRank ?? 0);
  if (sourceRankDelta !== 0) {
    return sourceRankDelta;
  }

  const scoreDelta = scoreLayoutChoice(b, trackName) - scoreLayoutChoice(a, trackName);
  if (Math.abs(scoreDelta) > 1) {
    return scoreDelta;
  }

  const lengthDelta = (b?.stats?.lengthMetres ?? 0) - (a?.stats?.lengthMetres ?? 0);
  if (Math.abs(lengthDelta) > 1) {
    return lengthDelta;
  }

  return a.name.localeCompare(b.name);
}

function scoreGeometryResult(result, trackName) {
  const selectedLayout = result.layouts[result.selectedLayoutIndex] ?? result.layouts[0];
  const bestVenueNameScore = result.osmVenueNames.reduce((bestScore, name) => {
    if (namesLikelyMatchCircuit(name, trackName)) {
      return Math.max(bestScore, 600);
    }

    return bestScore;
  }, 0);

  return bestVenueNameScore
    + scoreLayoutChoice(selectedLayout, trackName)
    + (selectedLayout?.stats?.lengthMetres ?? 0) / 10
    + result.layouts.length * 20;
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

export function detectForkSections(graph, backboneEdgeIds = null) {
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

export function buildVariantLayouts(ways, graph, sections, trackName, backboneCycle) {
  if (!backboneCycle?.nodes?.length) {
    return [];
  }

  const MAX_ENDPOINT_MATCH_DISTANCE = SNAP_FUZZY * 8;
  const MIN_LAYOUT_LENGTH = 1000;
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
    const substitutedSections = [];
    const nameParts = [];

    for (let sectionIndex = 0; sectionIndex < selectedBranches.length; sectionIndex += 1) {
      const branch = selectedBranches[sectionIndex];
      const section = sections[sectionIndex];
      const backboneBranch = section.branches[0];
      selectedWayIds.push(...branch.edgeIds);
      const branchLabel = branchFallbackLabels.get(branch.edgeIds.join(',')) ?? 'Alternate';

      if (branch === backboneBranch) {
        nameParts.push(branchLabel);
        continue;
      }

      substitutedSections.push({ section, branch });
      nameParts.push(branchLabel);
    }

    let layoutNodes = backboneCycle.nodes;

    if (substitutedSections.length > 0) {
      let isValid = true;

      for (const { section, branch } of substitutedSections) {
        const forkNode = graph.vertices.get(section.forkVertexId)?.node;
        const mergeNode = graph.vertices.get(section.mergeVertexId)?.node;
        const backboneBranch = section.branches[0];
        if (!forkNode || !mergeNode || !branch.nodes?.length) {
          isValid = false;
          break;
        }

        const forkMatches = findClosestNodePositions(layoutNodes, forkNode, MAX_ENDPOINT_MATCH_DISTANCE);
        const mergeMatches = findClosestNodePositions(layoutNodes, mergeNode, MAX_ENDPOINT_MATCH_DISTANCE);
        if (!forkMatches.length || !mergeMatches.length) {
          isValid = false;
          break;
        }

        let bestNodes = null;
        let bestScore = Infinity;

        for (const forkMatch of forkMatches) {
          for (const mergeMatch of mergeMatches) {
            if (forkMatch.index === mergeMatch.index) {
              continue;
            }

            const forwardPreservedSection = sliceClosedNodeChain(layoutNodes, mergeMatch.index, forkMatch.index);
            const reversePreservedSection = sliceClosedNodeChain(layoutNodes, forkMatch.index, mergeMatch.index);
            const replacementCandidates = [
              {
                preservedNodes: forwardPreservedSection,
                replacementLength: measurePolylineLength(reversePreservedSection),
                variantNodes: orientVariantNodes(branch.nodes, forkNode, mergeNode),
              },
              {
                preservedNodes: reversePreservedSection,
                replacementLength: measurePolylineLength(forwardPreservedSection),
                variantNodes: orientVariantNodes(branch.nodes, mergeNode, forkNode),
              },
            ];

            for (const replacement of replacementCandidates) {
              if (!replacement.preservedNodes?.length || replacement.preservedNodes.length < 2) {
                continue;
              }

              const candidateNodes = dedupeSequentialNodes([
                ...replacement.preservedNodes,
                ...replacement.variantNodes,
              ]);
              if (candidateNodes.length < 4) {
                continue;
              }

              const endpointGap = computeEndpointGap(candidateNodes);
              const score = Math.abs(replacement.replacementLength - backboneBranch.length)
                + endpointGap * 10
                + forkMatch.distance
                + mergeMatch.distance;
              if (score < bestScore) {
                bestScore = score;
                bestNodes = candidateNodes;
              }
            }
          }
        }

        if (!bestNodes) {
          isValid = false;
          break;
        }

        layoutNodes = bestNodes;
      }

      if (!isValid) {
        continue;
      }
    }

    const candidateNodes = closeNodeChainIfNearClosed(layoutNodes);
    const candidate = {
      nodes: candidateNodes,
      length: measurePolylineLength(candidateNodes),
      area: computeBoundingBoxArea(candidateNodes),
      endpointGap: computeEndpointGap(candidateNodes),
    };

    if (candidate.nodes.length < 4 || candidate.length < MIN_LAYOUT_LENGTH || candidate.endpointGap > 80) {
      continue;
    }

    const uniqueWayIds = [...new Set(selectedWayIds)].sort((a, b) => a - b);

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: substitutedSections.length === 0
        ? 'Main'
        : (sections.length === 1 ? (nameParts[0] ?? `Layout ${layouts.length + 1}`) : nameParts.join(' + ')),
      nodes: candidate.nodes,
      area: candidate.area,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: uniqueWayIds.length,
        variantSectionCount: substitutedSections.length,
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

function isWaySetNearReference(namedWays, referenceNodes, maxDistance = SNAP_FUZZY * 8) {
  if (!namedWays.length || !referenceNodes?.length) {
    return false;
  }

  const candidate = buildCandidateFromWays(namedWays);
  if (!candidate?.nodes?.length) {
    return false;
  }

  return sampleChainNodes(candidate.nodes, 12)
    .some(node => findClosestNodePositions(referenceNodes, node, maxDistance, 1).length > 0);
}

function sampleChainNodes(nodes, sampleCount = 24) {
  const baseNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  if (baseNodes.length <= sampleCount) {
    return baseNodes;
  }

  return Array.from({ length: sampleCount }, (_, index) => {
    const sampleIndex = Math.floor((index * baseNodes.length) / sampleCount);
    return baseNodes[sampleIndex];
  });
}

function isNearDuplicateLayoutCandidate(candidate, existingCandidates) {
  const MAX_LENGTH_DELTA = 250;
  const MAX_NODE_DISTANCE = SNAP_FUZZY * 4;

  return existingCandidates.findIndex(existing => {
    if (Math.abs(existing.length - candidate.length) > MAX_LENGTH_DELTA) {
      return false;
    }

    const candidateSamples = sampleChainNodes(candidate.nodes);
    const existingSamples = sampleChainNodes(existing.nodes);
    return candidateSamples.every(node => findClosestNodePositions(existing.nodes, node, MAX_NODE_DISTANCE, 1).length > 0)
      && existingSamples.every(node => findClosestNodePositions(candidate.nodes, node, MAX_NODE_DISTANCE, 1).length > 0);
  });
}

function dedupeLayoutsByGeometry(layouts, trackName) {
  const rankedLayouts = rankLayoutsForTrack(layouts, trackName);
  const dedupedLayouts = [];
  const seenCandidates = [];

  for (const layout of rankedLayouts) {
    const candidate = {
      nodes: layout.nodes,
      length: layout?.stats?.lengthMetres ?? measurePolylineLength(layout.nodes ?? []),
    };

    if (isNearDuplicateLayoutCandidate(candidate, seenCandidates) >= 0) {
      continue;
    }

    seenCandidates.push(candidate);
    dedupedLayouts.push(layout);
  }

  return dedupedLayouts;
}

function canonicalizeLayoutNames(layouts) {
  return layouts.map(layout => ({
    ...layout,
    name: canonicalizeLayoutName(layout.name),
  }));
}

function normalizeLayoutGeometry(layouts) {
  return layouts.map(layout => {
    const nodes = closeNodeChainIfNearClosed(collapseImmediateBacktracks(dedupeSequentialNodes(fixChainReversals(layout.nodes ?? []))));
    return {
      ...layout,
      nodes,
      stats: layout.stats
        ? {
            ...layout.stats,
            lengthMetres: measurePolylineLength(nodes),
          }
        : layout.stats,
    };
  });
}

export function normalizeTrackGeometryResult(result, trackName = null) {
  if (!result || !Array.isArray(result.layouts)) {
    return result;
  }

  const normalizedLayouts = dedupeLayoutsByName(
    normalizeLayoutGeometry(canonicalizeLayoutNames(result.layouts)),
    trackName,
  );

  return {
    ...result,
    layouts: dedupeLayoutsByGeometry(normalizedLayouts, trackName),
    selectedLayoutIndex: Math.min(result.selectedLayoutIndex ?? 0, Math.max(normalizedLayouts.length - 1, 0)),
  };
}

function dedupeLayoutsByName(layouts, trackName) {
  const bestLayoutsByName = new Map();

  for (const layout of layouts) {
    const key = normalizeCircuitName(layout.name);
    const existing = bestLayoutsByName.get(key);
    if (!existing || compareLayoutsForTrack(trackName, layout, existing) < 0) {
      bestLayoutsByName.set(key, layout);
    }
  }

  return [...bestLayoutsByName.values()];
}

function resolveGenericRelationLayoutNames(layouts, trackName) {
  const seenLayoutNames = new Set(layouts.map(layout => normalizeCircuitName(layout.name)));

  return layouts.map(layout => {
    if ((layout?.nameSourceRank ?? 0) > 0 || !namesLikelyMatchCircuit(layout?.name, trackName)) {
      return layout;
    }

    const candidateWayNames = [...new Set((layout.groupWayNames ?? [])
      .filter(name => NAMED_LAYOUT_KEYWORD_PATTERN.test(name))
      .filter(name => normalizeCircuitName(name) !== normalizeCircuitName(layout.name)))];
    const missingWayNames = candidateWayNames.filter(name => !seenLayoutNames.has(normalizeCircuitName(name)));
    if (missingWayNames.length !== 1) {
      return layout;
    }

    return {
      ...layout,
      name: missingWayNames[0],
      nameSourceRank: 1,
    };
  });
}

function buildImplicitRelationLayouts(nameGroups, eligibleNameGroups, existingLayouts, trackName, minLength, maxGapFraction) {
  const existingNames = new Set(existingLayouts.map(layout => normalizeCircuitName(layout.name)));
  const implicitLayouts = [];

  for (const [groupName, group] of nameGroups) {
    if (eligibleNameGroups.has(groupName) || group.sourceRank > 0 || !namesLikelyMatchCircuit(groupName, trackName)) {
      continue;
    }

    const layoutLikeWayNames = [...new Set(group.ways
      .map(way => way.tags?.name?.trim())
      .filter(name => name && NAMED_LAYOUT_KEYWORD_PATTERN.test(name)))];
    const missingWayNames = layoutLikeWayNames
      .filter(name => normalizeCircuitName(name) !== normalizeCircuitName(groupName))
      .filter(name => !existingNames.has(normalizeCircuitName(name)));
    if (missingWayNames.length !== 1) {
      continue;
    }

    const candidate = buildCandidateFromWays(group.ways);
    if (!candidate || candidate.nodes.length < 4 || candidate.length < minLength) {
      continue;
    }
    if (candidate.endpointGap > candidate.length * maxGapFraction) {
      continue;
    }

    implicitLayouts.push({
      id: `layout-${existingLayouts.length + implicitLayouts.length + 1}`,
      name: missingWayNames[0],
      nameSourceRank: 1,
      groupWayNames: layoutLikeWayNames,
      nodes: candidate.nodes,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: group.ways.length,
        variantSectionCount: 1,
      },
    });
    existingNames.add(normalizeCircuitName(missingWayNames[0]));
  }

  return implicitLayouts;
}

function substituteVariantIntoLayout(baseNodes, variantNodes, variantLength, label, backboneLength, trackName = null) {
  const MAX_ENDPOINT_MATCH_DISTANCE = SNAP_FUZZY * 8;
  const MIN_LENGTH = 1000;
  const MAX_GAP_FRACTION = 0.2;
  const startMatches = findClosestNodePositions(baseNodes, variantNodes[0], MAX_ENDPOINT_MATCH_DISTANCE);
  const endMatches = findClosestNodePositions(baseNodes, variantNodes[variantNodes.length - 1], MAX_ENDPOINT_MATCH_DISTANCE);

  if (!startMatches.length || !endMatches.length) {
    return null;
  }

  let bestLayout = null;

  for (const startMatch of startMatches) {
    for (const endMatch of endMatches) {
      if (startMatch.index === endMatch.index) {
        continue;
      }

      const forwardReplacementNodes = sliceClosedNodeChain(baseNodes, startMatch.index, endMatch.index);
      const reverseReplacementNodes = sliceClosedNodeChain(baseNodes, endMatch.index, startMatch.index);
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
      }));

      for (const replacement of replacementCandidates) {
        if (!replacement?.preservedNodes?.length || replacement.preservedNodes.length < 2) {
          continue;
        }

        const selectedWays = [
          { nodes: replacement.preservedNodes, tags: { name: 'Main' } },
          { nodes: replacement.variantNodes, tags: { name: label } },
        ];
        const candidate = buildCandidateFromWays(selectedWays);
        if (!candidate || candidate.nodes.length < 4) {
          continue;
        }
        if (candidate.length < MIN_LENGTH) {
          continue;
        }
        const maxEndpointGap = SHORTCUT_LAYOUT_PATTERN.test(label)
          ? Math.min(80, candidate.length * MAX_GAP_FRACTION)
          : candidate.length * MAX_GAP_FRACTION;
        if (candidate.endpointGap > maxEndpointGap) {
          continue;
        }

        const knownTargetLength = getKnownLayoutLengthTarget(trackName, label);
        if (knownTargetLength != null && Math.abs(candidate.length - knownTargetLength) > 250) {
          continue;
        }
        const prefersShortcutLength = knownTargetLength == null && SHORTCUT_LAYOUT_PATTERN.test(label);
        const score = (startMatch.distance + endMatch.distance) * 1000000
          + (knownTargetLength != null
              ? Math.abs(candidate.length - knownTargetLength)
              : prefersShortcutLength
              ? candidate.length
              : Math.abs(candidate.length - backboneLength) + Math.abs(replacement.replacementLength - variantLength));
        if (!bestLayout || score < bestLayout.score) {
          bestLayout = {
            score,
            candidate,
            selectedWays,
          };
        }
      }
    }
  }

  return bestLayout;
}

function buildSubstitutionLayouts(nameGroups, backboneGroupName, backboneWays, backboneCandidate, trackName) {
  const backboneGraph = buildWayGraph(backboneWays);
  const cycleMetadata = buildOrderedCycleMetadata(backboneGraph, backboneGraph.edges.map(edge => edge.id));
  if (!cycleMetadata || cycleMetadata.orderedEdges.length !== backboneWays.length) {
    return [];
  }

  const layouts = [{
    id: 'layout-1',
    name: backboneGroupName,
    nameSourceRank: nameGroups.get(backboneGroupName)?.sourceRank ?? 0,
    groupWayNames: [...new Set(backboneWays.map(way => way.tags?.name?.trim()).filter(Boolean))],
    nodes: backboneCandidate.nodes,
    stats: {
      lengthMetres: backboneCandidate.length,
      segmentCount: backboneWays.length,
      variantSectionCount: 0,
    },
  }];

  for (const [groupName, group] of nameGroups) {
    if (groupName === backboneGroupName) {
      continue;
    }

    const namedWays = group.ways;
    const variantNodes = buildNamedGroupChain(namedWays);
    if (variantNodes.length < 2) {
      continue;
    }
    const bestLayout = substituteVariantIntoLayout(
      cycleMetadata.nodes,
      variantNodes,
      measureWaySetLength(namedWays),
      groupName,
      backboneCandidate.length,
      trackName,
    );

    if (!bestLayout) {
      continue;
    }

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: groupName,
      nameSourceRank: nameGroups.get(groupName)?.sourceRank ?? 0,
      groupWayNames: [...new Set(namedWays.map(way => way.tags?.name?.trim()).filter(Boolean))],
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
function buildNamedCircuitLayouts(ways, trackName, referenceWays = ways) {
  const MIN_LENGTH = 1500; // metres — ignore sub-km stubs
  const MAX_GAP_FRACTION = 0.15; // endpoint gap must be < 15% of total length
  const referenceNodes = buildCandidateFromWays(referenceWays)?.nodes ?? [];

  const nameGroups = new Map();
  for (const way of ways) {
    for (const { name, source } of getWayCandidateNameEntries(way)) {
      if (!NAMED_LAYOUT_KEYWORD_PATTERN.test(name)) continue;
      if (!nameGroups.has(name)) {
        nameGroups.set(name, { ways: [], sourceRank: source === 'way' ? 1 : 0 });
      }

      const group = nameGroups.get(name);
      group.ways.push(way);
      group.sourceRank = Math.max(group.sourceRank, source === 'way' ? 1 : 0);
    }
  }

  if (nameGroups.size < 2) return [];

  const eligibleNameGroups = new Map();
  const standaloneLayouts = [];
  for (const [groupName, group] of nameGroups) {
    const namedWays = group.ways;
    const wayNames = new Set(namedWays.map(way => way.tags?.name?.trim()).filter(Boolean));
    const competingLayoutWayNames = [...wayNames].filter(name =>
      NAMED_LAYOUT_KEYWORD_PATTERN.test(name)
      && normalizeCircuitName(name) !== normalizeCircuitName(groupName)
    );
    if (group.sourceRank === 0 && competingLayoutWayNames.length > 1) {
      continue;
    }
    if (!isWaySetNearReference(namedWays, referenceNodes)) {
      continue;
    }

    eligibleNameGroups.set(groupName, group);

    // Only use the named ways — no shared backbone mixing
    const candidate = buildCandidateFromWays(namedWays);
    if (!candidate || candidate.nodes.length < 4) continue;
    if (candidate.length < MIN_LENGTH) continue;
    // Must form a near-closed loop on its own
    if (candidate.endpointGap > candidate.length * MAX_GAP_FRACTION) continue;

    standaloneLayouts.push({
      id: `layout-${standaloneLayouts.length + 1}`,
      name: groupName,
      nameSourceRank: group.sourceRank,
      groupWayNames: [...wayNames],
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

  if (eligibleNameGroups.size < 2 || standaloneLayouts.length === 0) {
    return [];
  }

  const backboneLayout = rankLayoutsForTrack(standaloneLayouts, trackName)[0];
  const substitutionLayouts = backboneLayout
      ? buildSubstitutionLayouts(
          eligibleNameGroups,
          backboneLayout.name,
          backboneLayout.ways,
          backboneLayout.candidate,
          trackName,
        )
      : [];

  const publicLayouts = standaloneLayouts.map(({ candidate, ways: groupedWays, ...publicLayout }) => publicLayout);
  const dedupedCombinedLayouts = dedupeLayoutsByGeometry([...publicLayouts, ...substitutionLayouts], trackName);
  const implicitRelationLayouts = buildImplicitRelationLayouts(
    nameGroups,
    eligibleNameGroups,
    dedupedCombinedLayouts,
    trackName,
    MIN_LENGTH,
    MAX_GAP_FRACTION,
  );
  const combinedLayouts = resolveGenericRelationLayoutNames(
    dedupeLayoutsByGeometry([...dedupedCombinedLayouts, ...implicitRelationLayouts], trackName),
    trackName,
  );

  if (combinedLayouts.length >= 2) {
    return combinedLayouts;
  }

  return [];
}

export function buildLayoutsFromWays(ways, trackName) {
  if (!ways.length) {
    return [];
  }

  const graph = buildWayGraph(ways);
  const backboneCycle = selectBackboneCycle(graph);
  const stitchedCandidate = buildCandidateFromWays(ways);
  const variantBackbone = stitchedCandidate
    && stitchedCandidate.endpointGap <= 80
    && stitchedCandidate.length > (backboneCycle?.length ?? 0) + 400
    ? {
        ...backboneCycle,
        nodes: stitchedCandidate.nodes,
        length: stitchedCandidate.length,
        area: stitchedCandidate.area,
      }
    : backboneCycle;
  const sections = detectForkSections(graph, new Set(backboneCycle?.edgeIds ?? []));
  const variantLayouts = buildVariantLayouts(ways, graph, sections, trackName, variantBackbone);

  if (variantLayouts.length > 1) {
    return dedupeLayoutsByGeometry(variantLayouts.slice(0, 8), trackName).map(({ area, ...layout }) => layout);
  }

  const singleLayout = variantBackbone
    ? {
        nodes: variantBackbone.nodes,
        length: variantBackbone.length,
      }
    : stitchedCandidate;
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

  return stitchWaysOrdered(selectBestComponentWays(ways));
}

const PIT_PATTERN = /pit[\s\-_]*lane|pit[\s\-_]*road|pitlane|pitroad|support[\s\-_]*pit|\bpit\s*$/i;

function extractOverpassWays(elements) {
  const waysById = new Map();

  function mergeRelationTags(existingTags, relationTags) {
    const relationNames = [...new Set([
      ...(Array.isArray(existingTags?.relationNames) ? existingTags.relationNames : []),
      relationTags?.name,
    ].map(name => name?.trim()).filter(Boolean))];

    return {
      ...(relationTags ?? {}),
      ...(existingTags ?? {}),
      ...(relationNames.length > 0 ? { relationNames } : {}),
    };
  }

  function addWay(id, tags, geometry, overwrite = false) {
    if (!Number.isFinite(id) || !Array.isArray(geometry) || geometry.length < 2) {
      return;
    }

    const existing = waysById.get(id);
    if (existing && !overwrite) {
      return;
    }

    waysById.set(id, {
      id,
      tags: overwrite ? mergeRelationTags(existing?.tags, tags) : (tags ?? {}),
      nodes: geometry.map(({ lat: wayLat, lon: wayLon }) => ({ lat: wayLat, lon: wayLon })),
    });
  }

  for (const element of elements || []) {
    if (element.type === 'way') {
      addWay(element.id, element.tags, element.geometry);
    }
  }

  for (const element of elements || []) {
    if (element.type !== 'relation') {
      continue;
    }

    for (const member of element.members || []) {
      if (member.type !== 'way' || member.role === 'pit_lane') {
        continue;
      }

      addWay(member.ref, element.tags, member.geometry, true);
    }
  }

  return [...waysById.values()];
}

function collectOsmVenueNames(ways) {
  return [...new Set(
    ways
      .flatMap(way => getWayCandidateNames(way))
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

function collectNamedLayoutWays(filteredWays, componentWays) {
  const componentWayIds = new Set(componentWays.map(way => way.id));
  const referenceNodes = buildCandidateFromWays(componentWays)?.nodes ?? [];

  const extraWays = filteredWays.filter(way => {
    if (componentWayIds.has(way.id)) {
      return false;
    }

    const hasLayoutLikeName = getWayCandidateNames(way)
      .some(name => NAMED_LAYOUT_KEYWORD_PATTERN.test(name));
    if (!hasLayoutLikeName) {
      return false;
    }

    if (way.nodes.length < 2 || referenceNodes.length === 0) {
      return false;
    }

    const firstNodeNearReference = findClosestNodePositions(referenceNodes, way.nodes[0], SNAP_FUZZY * 8, 1).length > 0;
    const lastNodeNearReference = findClosestNodePositions(referenceNodes, way.nodes[way.nodes.length - 1], SNAP_FUZZY * 8, 1).length > 0;
    return firstNodeNearReference && lastNodeNearReference;
  });

  return [...componentWays, ...extraWays];
}

function buildTrackGeometryResult(elements, trackName) {
  const allElements = elements || [];
  const ways = extractOverpassWays(allElements);

  if (ways.length === 0) {
    return null;
  }

  // Exclude pit lanes and service roads — but NOT straights that merely contain "pit"
  // in their name (e.g. "National Pit Straight" is a legit racing-line way at Silverstone).
  const mainWays = ways.filter(w => {
    const name = w.tags?.name ?? '';
    return !PIT_PATTERN.test(name);
  });
  const racingWays = mainWays.length > 0 ? mainWays : ways; // fallback if over-filtered
  const motorWays = racingWays.filter(way => {
    const sport = String(way.tags?.sport ?? '').trim().toLowerCase();
    return !sport || sport === 'motor';
  });
  const filteredWays = motorWays.length > 0 ? motorWays : racingWays;

  const componentWays = selectBestComponentWays(filteredWays, trackName);
  const namedLayoutWays = collectNamedLayoutWays(filteredWays, componentWays);
  const osmVenueNames = collectOsmVenueNames(componentWays);

  const namedLayouts = buildNamedCircuitLayouts(namedLayoutWays, trackName, componentWays);
  if (namedLayouts.length > 0) {
    return {
      layouts: dedupeLayoutsByGeometry(dedupeLayoutsByName(canonicalizeLayoutNames(namedLayouts), trackName), trackName),
      selectedLayoutIndex: 0,
      osmVenueNames,
    };
  }

  // Named layout detection failed. When multiple circuit relations exist at the same venue
  // (e.g. Mexican Grand Prix + Mexico City E-Prix), merging all their ways produces an
  // incorrect superset geometry. Try each relation independently and return the best result.
  const circuitRelations = allElements.filter(e => {
    if (e.type !== 'relation') return false;
    const hw = String(e.tags?.highway ?? '').trim().toLowerCase();
    const type = String(e.tags?.type ?? '').trim().toLowerCase();
    const route = String(e.tags?.route ?? '').trim().toLowerCase();
    const circuit = String(e.tags?.circuit ?? '').trim().toLowerCase();
    return (hw === 'raceway' || type === 'circuit' || route === 'raceway') && circuit !== 'kart';
  });

  if (circuitRelations.length > 1) {
    // Only apply per-relation isolation when the relations are geometrically independent
    // (low way membership overlap). High overlap means they share a backbone and represent
    // layout variants of the same circuit (e.g. Silverstone GP vs International at 96%
    // overlap) — those are handled correctly by buildLayoutsFromWays above. Low overlap
    // means they are distinct circuits at the same venue (e.g. Mexican GP vs E-Prix at
    // ~33% overlap), where merging all ways produces an incorrect superset geometry.
    const memberSets = circuitRelations.map(r => new Set(r.members.map(m => m.ref)));
    const allMemberIds = new Set(memberSets.flatMap(s => [...s]));
    let sharedCount = 0;
    for (const id of allMemberIds) {
      if (memberSets.every(s => s.has(id))) sharedCount++;
    }
    const overlapRatio = allMemberIds.size > 0 ? sharedCount / allMemberIds.size : 1;
    const INDEPENDENT_CIRCUIT_OVERLAP_THRESHOLD = 0.5;

    if (overlapRatio < INDEPENDENT_CIRCUIT_OVERLAP_THRESHOLD) {
      const wayElementsById = new Map(allElements.filter(e => e.type === 'way').map(e => [e.id, e]));
      const perRelationLayouts = circuitRelations.flatMap((relation, i) => {
        const relationElements = [
          ...relation.members
            .filter(m => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2)
            .map(m => ({
              type: 'way',
              id: m.ref,
              tags: wayElementsById.get(m.ref)?.tags ?? {},
              geometry: m.geometry,
            })),
          relation,
        ];
        const result = buildTrackGeometryResult(relationElements, trackName);
        if (!result?.layouts?.length) return [];
        const relationName = relation.tags?.name?.trim();
        return result.layouts.map((layout, j) => ({
          ...layout,
          id: `layout-${i + 1}${j > 0 ? `-${j + 1}` : ''}`,
          // Use the relation name as the layout name so each independent circuit
          // is distinguishable (e.g. "Mexican Grand Prix" vs "Mexico City E-Prix")
          name: relationName || layout.name,
        }));
      });

      if (perRelationLayouts.length > 0) {
        const deduped = dedupeLayoutsByGeometry(
          dedupeLayoutsByName(canonicalizeLayoutNames(perRelationLayouts), trackName),
          trackName,
        );
        return { layouts: deduped, selectedLayoutIndex: 0, osmVenueNames };
      }
    }
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
      osmVenueNames,
    };
  }

  return {
    layouts: dedupeLayoutsByGeometry(dedupeLayoutsByName(canonicalizeLayoutNames(layouts), trackName), trackName),
    selectedLayoutIndex: 0,
    osmVenueNames,
  };
}

export function buildTrackGeometryFromOverpassPayload(payload, trackName) {
  return buildTrackGeometryResult(payload?.elements ?? [], trackName);
}

// Fetch raceway geometry using Overpass bbox query around Wikidata P625 coordinates.
// Much more reliable than P402 (stale OSM relation IDs) or name searches (timeouts).
export async function fetchTrackGeometry(lat, lon, signal, trackName, options = {}) {
  const localGeometry = options.skipLocal ? null : await getTrackGeometry(options.wikidataId);
  if (localGeometry) {
    return localGeometry;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('No coordinates available for this circuit');
  }

  // ~9km margin — covers any F1 circuit layout but avoids pulling in distant tracks
  const MARGIN = 0.08;
  const bbox = `${lat - MARGIN},${lon - MARGIN},${lat + MARGIN},${lon + MARGIN}`;
  const query = `[out:json][timeout:30];(way["highway"="raceway"](${bbox});relation["highway"="raceway"](${bbox});relation["type"="circuit"](${bbox}););out geom;`;

  const queryResults = await runOverpassQueries(query, signal);
  const geometryResults = queryResults
    .map(({ data }) => buildTrackGeometryFromOverpassPayload(data, trackName))
    .filter(Boolean);

  if (geometryResults.length === 0) {
    throw new Error(`No raceway found near ${trackName ?? 'this location'}`);
  }

  return geometryResults.sort((a, b) => scoreGeometryResult(b, trackName) - scoreGeometryResult(a, trackName))[0];
}
