/**
 * Top-level track geometry orchestrator.
 * Drives the full pipeline: extract ways → filter → select component →
 * build named layouts → build fork layouts → deduplicate.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Way } from '../types/geometry.js';
import { measurePolylineLength } from './geo-math.js';
import { selectBestComponentWays, buildCandidateFromWays, measureWaySetLength } from './way-stitching.js';
import {
  extractWays,
  collectOsmVenueNames,
  collectNamedLayoutWays,
  PIT_PATTERN,
} from './osm-elements.js';
import {
  dedupeLayoutsByGeometry,
  dedupeLayoutsByName,
  canonicalizeLayoutNames,
} from './layout-dedup.js';
import {
  buildNamedCircuitLayouts,
  buildLayoutsFromWays,
  stitchWays,
  substituteVariantIntoLayout,
  buildNamedGroupChain,
} from './layout-builder.js';
import { closeNodeChainIfNearClosed } from './chain-cleanup.js';

/** Internal layout shape (superset of the public Layout type). */
interface InternalLayout {
  id: string;
  name: string;
  nameSourceRank?: number;
  groupWayNames?: string[];
  _dedupeGroup?: string;
  nodes: LatLonNode[];
  stats: {
    lengthMetres: number;
    segmentCount: number;
    variantSectionCount?: number;
  };
}

/** The result produced by this module. */
interface TrackGeometryResult {
  layouts: InternalLayout[];
  selectedLayoutIndex: number;
  osmVenueNames: string[];
}

/**
 * Core orchestrator: build a geometry result from a flat list of OSM elements.
 * This function is recursive — it calls itself once per circuit relation when
 * multiple independent circuit relations exist at the same venue.
 */
function buildTrackGeometryResult(
  elements: unknown[],
  trackName: string | null,
): TrackGeometryResult | null {
  const allElements = elements ?? [];
  const ways = extractWays(allElements);

  if (ways.length === 0) {
    return null;
  }

  // Exclude pit lanes and service roads — but NOT straights that merely contain "pit"
  // in their name (e.g. "National Pit Straight" is a legit racing-line way at Silverstone).
  const mainWays = ways.filter(w => {
    const name = (w.tags?.['name'] as string) ?? '';
    return !PIT_PATTERN.test(name);
  });
  const racingWays = mainWays.length > 0 ? mainWays : ways; // fallback if over-filtered
  const motorWays = racingWays.filter(way => {
    const sport = String(way.tags?.['sport'] ?? '').trim().toLowerCase();
    return !sport || sport === 'motor';
  });
  const filteredWays = motorWays.length > 0 ? motorWays : racingWays;

  const componentWays = selectBestComponentWays(filteredWays, trackName ?? undefined);
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
  //
  // All relations in allElements have already been filtered to circuit routes by
  // parseOsmApiMapXml upstream, so a type check is sufficient here.
  const circuitRelations = allElements.filter(e => (e as Record<string, unknown>)['type'] === 'relation') as Array<Record<string, unknown>>;

  if (circuitRelations.length > 1) {
    // Only apply per-relation isolation when the relations are geometrically independent
    // (low way membership overlap). High overlap means they share a backbone and represent
    // layout variants of the same circuit (e.g. Silverstone GP vs International at 96%
    // overlap) — those are handled correctly by buildLayoutsFromWays above. Low overlap
    // means they are distinct circuits at the same venue (e.g. Mexican GP vs E-Prix at
    // ~33% overlap), where merging all ways produces an incorrect superset geometry.
    const memberSets = circuitRelations.map(r => new Set((r['members'] as Array<{ ref: unknown }>).map(m => m.ref)));
    const allMemberIds = new Set(memberSets.flatMap(s => [...s]));
    let sharedCount = 0;
    for (const id of allMemberIds) {
      if (memberSets.every(s => s.has(id))) { sharedCount++; }
    }
    const overlapRatio = allMemberIds.size > 0 ? sharedCount / allMemberIds.size : 1;
    const INDEPENDENT_CIRCUIT_OVERLAP_THRESHOLD = 0.5;

    if (overlapRatio < INDEPENDENT_CIRCUIT_OVERLAP_THRESHOLD) {
      const wayElementsById = new Map<unknown, Record<string, unknown>>(
        (allElements as Array<Record<string, unknown>>)
          .filter(e => e['type'] === 'way')
          .map(e => [e['id'], e]),
      );
      const perRelationLayouts = circuitRelations.flatMap((relation, i) => {
        const relationElements = [
          ...(relation['members'] as Array<Record<string, unknown>>)
            .filter(m => m['type'] === 'way' && Array.isArray(m['geometry']) && (m['geometry'] as unknown[]).length >= 2)
            .map(m => ({
              type: 'way',
              id: m['ref'],
              tags: (wayElementsById.get(m['ref']) as Record<string, unknown>)?.['tags'] ?? {},
              geometry: m['geometry'],
            })),
          relation,
        ];
        const result = buildTrackGeometryResult(relationElements, trackName);
        if (!result?.layouts?.length) { return []; }
        const relationName = (relation['tags'] as Record<string, unknown>)?.['name'] as string | undefined;
        return result.layouts.map((layout, j) => ({
          ...layout,
          id: `layout-${i + 1}${j > 0 ? `-${j + 1}` : ''}`,
          // Use the relation name as the layout name so each independent circuit
          // is distinguishable (e.g. "Mexican Grand Prix" vs "Mexico City E-Prix")
          name: relationName?.trim() || layout.name,
        }));
      });

      if (perRelationLayouts.length > 0) {
        const deduped = dedupeLayoutsByGeometry(
          dedupeLayoutsByName(canonicalizeLayoutNames(perRelationLayouts), trackName),
          trackName,
        );
        return { layouts: deduped, selectedLayoutIndex: 0, osmVenueNames };
      }
    } else {
      // High overlap (>= 50%): relations share a backbone and differ only in variant
      // sections (e.g. Barcelona GP FIA vs GP FIM vs World RX — same backbone, different
      // chicane/rallycross sections). Extract shared ways as backbone, substitute each
      // relation's unique ways as variants.
      const distinctNames = new Set(
        circuitRelations
          .map(r => ((r['tags'] as Record<string, unknown>)?.['name'] as string | undefined)?.trim())
          .filter((n): n is string => Boolean(n)),
      );

      if (distinctNames.size >= 2) {
        const sharedWayIds = new Set<unknown>();
        for (const id of allMemberIds) {
          if (memberSets.every(s => s.has(id))) { sharedWayIds.add(id); }
        }

        const wayElementsById = new Map<unknown, Record<string, unknown>>(
          (allElements as Array<Record<string, unknown>>)
            .filter(e => e['type'] === 'way')
            .map(e => [e['id'], e]),
        );

        // Build backbone from shared ways
        const sharedWayElements = [...sharedWayIds]
          .map(id => wayElementsById.get(id))
          .filter((e): e is Record<string, unknown> => e != null);
        const sharedWays = extractWays(sharedWayElements.map(e => ({ ...e, type: 'way' })));
        const backbone = buildCandidateFromWays(sharedWays);

        if (backbone && backbone.nodes.length >= 4 && backbone.endpointGap <= backbone.length * 0.15) {
          const baseNodes = closeNodeChainIfNearClosed(backbone.nodes, backbone.length * 0.15);
          const highOverlapLayouts: InternalLayout[] = [];
          let layoutIdx = 1;

          for (const relation of circuitRelations) {
            const relationName = ((relation['tags'] as Record<string, unknown>)?.['name'] as string | undefined)?.trim();
            if (!relationName) { continue; }

            const relationMemberIds = new Set(
              (relation['members'] as Array<{ ref: unknown }>).map(m => m.ref),
            );
            const uniqueWayIds = [...relationMemberIds].filter(id => !sharedWayIds.has(id));

            if (uniqueWayIds.length === 0) {
              // This relation is entirely shared — it IS the backbone/main layout
              highOverlapLayouts.push({
                id: `layout-${layoutIdx++}`,
                name: relationName,
                nodes: baseNodes,
                stats: {
                  lengthMetres: backbone.length,
                  segmentCount: sharedWays.length,
                },
              });
              continue;
            }

            const uniqueWayElements = uniqueWayIds
              .map(id => wayElementsById.get(id))
              .filter((e): e is Record<string, unknown> => e != null);
            const uniqueWays: Way[] = extractWays(uniqueWayElements.map(e => ({ ...e, type: 'way' })));
            if (uniqueWays.length === 0) { continue; }

            const variantChain = buildNamedGroupChain(uniqueWays);
            if (variantChain.length < 2) { continue; }

            const variantLength = measureWaySetLength(uniqueWays);
            const result = substituteVariantIntoLayout(
              baseNodes,
              variantChain,
              variantLength,
              relationName,
              backbone.length,
              trackName,
            );

            if (result) {
              highOverlapLayouts.push({
                id: `layout-${layoutIdx++}`,
                name: relationName,
                nodes: result.candidate.nodes,
                stats: {
                  lengthMetres: result.candidate.length,
                  segmentCount: result.selectedWays.length,
                  variantSectionCount: 1,
                },
              });
            }
          }

          if (highOverlapLayouts.length >= 2) {
            const deduped = dedupeLayoutsByGeometry(
              dedupeLayoutsByName(canonicalizeLayoutNames(highOverlapLayouts), trackName),
              trackName,
            );
            if (deduped.length >= 2) {
              return { layouts: deduped, selectedLayoutIndex: 0, osmVenueNames };
            }
          }
        }
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

/**
 * Build track geometry from a raw OSM API payload object.
 *
 * @param payload - The parsed OSM API response (should have an `elements` array)
 * @param trackName - Track name for scoring/naming heuristics
 */
export function buildTrackGeometryFromPayload(
  payload: { elements?: unknown[] } | null | undefined,
  trackName: string | null,
): TrackGeometryResult | null {
  return buildTrackGeometryResult(payload?.elements ?? [], trackName);
}
