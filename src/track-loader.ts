/**
 * Track loading and model rebuilding orchestration.
 * Reads from and writes to Svelte stores; components call these functions.
 */

import { get } from 'svelte/store';
import { fetchTrackGeometry, selectPrintedTrackName } from './search/index.js';
import { getSelectedLayout, normalizeSelectedLayoutIndex } from './search/layout-picker.js';
import { projectNodes } from './geometry/projection.js';
import { fetchElevations } from './elevation/terrarium.js';
import { createModelWorkerClient } from './workers/model-client.js';
import { PRIMARY_ORIENTATION_AUTO } from './model/orientation.js';
import { DEFAULT_TEXT_POSITION_RANK } from './text3d.js';
import { selectedTrack, layouts, layoutIndex, osmVenueNames } from './stores/track.js';
import {
  currentModel,
  nodes,
  projectedNodes,
  elevations,
  secondaryElevations,
  outline,
  basePlate,
} from './stores/model.js';
import {
  primaryOrientationDeg,
  textPositionRank,
  labelOverride,
  combinedLayoutMode,
  exaggeration,
  placementCacheToken,
  effectiveLabel,
  coasterMode,
  coasterShape,
  coasterInlay,
  trackWidthAuto,
  trackWidthMm,
} from './stores/options.js';
import { statusMessage, statusIsError, previewOverlayState, isRebuilding } from './stores/ui.js';
import { placementDebugData } from './stores/debug.js';
import type { Layout } from './types/geometry.js';
import type { SearchResult } from './types/search.js';

// ── Worker client (singleton for the lifetime of the page) ───────────────────

const modelWorkerClient = createModelWorkerClient();

// ── Cache generation counter ─────────────────────────────────────────────────

// Maps the placementCacheToken object reference to a numeric generation.
// When a new token object is assigned (by invalidatePlacementCache), the
// generation increments so the worker knows to discard its cached placements.
let lastTokenRef: object | null = null;
let cacheGeneration = 0;

function getCacheGeneration(): number {
  const token = get(placementCacheToken);
  if (token !== null && token !== lastTokenRef) {
    lastTokenRef = token;
    cacheGeneration++;
  }
  return cacheGeneration;
}

export function invalidatePlacementCache(): void {
  placementCacheToken.set({});
}

function getSelectedTrackNameState(layout: Layout | null | undefined): ReturnType<typeof selectPrintedTrackName> {
  const track = get(selectedTrack);
  const venueNames = get(osmVenueNames);
  return selectPrintedTrackName({
    wikidataLabel: track?.wikidataLabel ?? track?.name ?? null,
    wikidataAliases: track?.wikidataAliases ?? [],
    wikidataShortName: track?.wikidataShortName ?? null,
    description: track?.wikidataDescription ?? null,
    osmVenueNames: venueNames,
    selectedLayoutName: layout?.name ?? null,
  });
}

/**
 * Rebuilds the 3D model from the current store state.
 * Accepts an optional elevation array to use instead of the stored one.
 * Returns a Promise that resolves when the model has been built and stored.
 */
export async function rebuildModel(elevationData: number[] | null = get(elevations)): Promise<void> {
  const currentLayouts = get(layouts);
  const currentLayoutIndex = get(layoutIndex);
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);

  if (!layout) {
    nodes.set(null);
    projectedNodes.set(null);
    elevations.set(null);
    secondaryElevations.set([]);
    outline.set(null);
    basePlate.set(null);
    currentModel.set(null);
    placementDebugData.set(null);
    previewOverlayState.set({
      title: 'No preview available',
      body: 'This selection does not include a printable layout yet.',
      hidden: false,
    });
    return;
  }

  const center = {
    lat: layout.nodes.reduce((s, n) => s + n.lat, 0) / layout.nodes.length,
    lon: layout.nodes.reduce((s, n) => s + n.lon, 0) / layout.nodes.length,
  };
  const projected = projectNodes(layout.nodes, elevationData, center);

  const isCombined = get(combinedLayoutMode);
  const currentSecondaryElevations = get(secondaryElevations);
  const secondaryProjectedNodes = isCombined && currentLayouts.length > 1
    ? currentLayouts
      .filter((_, i) => i !== currentLayoutIndex)
      .map((l, i) => projectNodes(l.nodes, currentSecondaryElevations[i] ?? null, center))
    : [];

  const trackLabel = get(effectiveLabel);
  const currentOrientationDeg = get(primaryOrientationDeg);
  const currentTextPositionRank = get(textPositionRank);
  const generation = getCacheGeneration();
  const isCoaster = get(coasterMode);

  isRebuilding.set(true);
  try {
    const model = await modelWorkerClient.requestModelBuild({
      projectedNodes: projected,
      secondaryProjectedNodes,
      trackName: trackLabel,
      primaryOrientationDeg: currentOrientationDeg,
      textPositionRank: currentTextPositionRank,
      cacheGeneration: generation,
      coasterMode: isCoaster,
      coasterShape: get(coasterShape),
      coasterInlay: get(coasterInlay),
      trackWidthAuto: get(trackWidthAuto),
      trackWidthMm: get(trackWidthMm),
    });

    nodes.set(layout.nodes);
    projectedNodes.set(projected);
    elevations.set(elevationData);
    outline.set(model.outlinePoints);
    basePlate.set(model.basePlate);
    currentModel.set(model);
    placementDebugData.set(
      model.allScoredPlacements?.length
        ? {
            allScoredPlacements: model.allScoredPlacements,
            dedupedPlacements: model.dedupedPlacements ?? [],
            candidates: model.placementCandidates!,
            scaledBasePlate: model.scaledBasePlate!,
          }
        : null,
    );

    const trackNameState = getSelectedTrackNameState(layout);
    const segmentCount = layout.stats?.segmentCount;
    const lengthKm = layout.stats?.lengthMetres ? layout.stats.lengthMetres / 1000 : null;
    const sizeDetail = isCoaster
      ? `Coaster · 90×90 mm ${get(coasterShape) === 'round' ? 'round' : 'square'}`
      : `${model.basePlate.width.toFixed(0)}m×${model.basePlate.height.toFixed(0)}m`;
    const detailParts = [
      Number.isFinite(lengthKm) ? `${lengthKm!.toFixed(1)} km` : null,
      Number.isFinite(segmentCount) ? `${segmentCount} segment${segmentCount === 1 ? '' : 's'}` : null,
      sizeDetail,
      currentOrientationDeg === PRIMARY_ORIENTATION_AUTO ? 'Auto orientation' : `${currentOrientationDeg}° orientation`,
    ].filter(Boolean);
    statusMessage.set(`${trackNameState.printedName} · ${detailParts.join(' · ')}`);
    statusIsError.set(false);

    previewOverlayState.set({ title: '', body: '', hidden: true });
  } catch (err) {
    if (err instanceof Error && err.message === 'Superseded by newer request') { return; }
    throw err;
  } finally {
    isRebuilding.set(false);
  }
}

/**
 * Loads elevations for the primary layout nodes (and secondary layouts in combined mode),
 * then rebuilds the model.
 */
export async function loadElevations(primaryNodes: import('./types/geometry.js').LatLonNode[]): Promise<void> {
  if (!primaryNodes?.length) {
    return;
  }

  // Coaster mode renders a level top surface — no elevation variation to fetch.
  if (get(coasterMode)) {
    return;
  }

  const currentLayouts = get(layouts);
  const currentLayoutIndex = get(layoutIndex);
  const isCombined = get(combinedLayoutMode);
  const currentExaggeration = get(exaggeration);

  try {
    const secondaryLayouts = isCombined && currentLayouts.length > 1
      ? currentLayouts.filter((_, i) => i !== currentLayoutIndex)
      : [];

    const allNodes = [...primaryNodes, ...secondaryLayouts.flatMap(l => l.nodes)];
    const allElevations = await fetchElevations(allNodes, currentExaggeration);

    const primaryElevations = allElevations.slice(0, primaryNodes.length);
    let offset = primaryNodes.length;
    const newSecondaryElevations = secondaryLayouts.map(l => {
      const elevs = allElevations.slice(offset, offset + l.nodes.length);
      offset += l.nodes.length;
      return elevs;
    });

    secondaryElevations.set(newSecondaryElevations);
    await rebuildModel(primaryElevations);
  } catch (err) {
    console.warn('Elevation loading failed, keeping flat model:', err);
  }
}

/**
 * Handles selecting a track from search results.
 * Resets all model state, fetches geometry, rebuilds model, loads elevations.
 */
export async function selectTrack(track: SearchResult): Promise<void> {
  statusMessage.set(`Loading geometry for ${track.name}...`);
  statusIsError.set(false);

  nodes.set(null);
  projectedNodes.set(null);
  elevations.set(null);
  secondaryElevations.set([]);
  selectedTrack.set(track);
  outline.set(null);
  basePlate.set(null);
  currentModel.set(null);
  placementDebugData.set(null);
  layouts.set([]);
  layoutIndex.set(0);
  osmVenueNames.set([]);
  labelOverride.set(null);
  primaryOrientationDeg.set('auto');
  textPositionRank.set(DEFAULT_TEXT_POSITION_RANK);
  combinedLayoutMode.set(false);
  exaggeration.set(1);

  previewOverlayState.set({
    title: 'Loading preview',
    body: `Fetching track geometry for ${track.name}...`,
    hidden: false,
  });

  try {
    const geometry = await fetchTrackGeometry(track.name, { wikidataId: track.wikidataId }) as {
      layouts?: Layout[];
      selectedLayoutIndex?: number;
      osmVenueNames?: string[];
    };

    const newLayouts = geometry.layouts ?? [];
    const newLayoutIndex = normalizeSelectedLayoutIndex(newLayouts, geometry.selectedLayoutIndex ?? 0);
    const newOsmVenueNames = geometry.osmVenueNames ?? [];

    layouts.set(newLayouts);
    layoutIndex.set(newLayoutIndex);
    osmVenueNames.set(newOsmVenueNames);
    invalidatePlacementCache();
    await rebuildModel();

    if (newLayouts.length === 0) {
      statusMessage.set('Loading the track data failed.');
      statusIsError.set(true);
      return;
    }

    const primaryNodes = getSelectedLayout(newLayouts, newLayoutIndex)?.nodes ?? [];
    await loadElevations(primaryNodes);
  } catch (err) {
    nodes.set(null);
    projectedNodes.set(null);
    elevations.set(null);
    selectedTrack.set(null);
    layouts.set([]);
    osmVenueNames.set([]);
    currentModel.set(null);

    const error = err as Error;
    const isUnavailable = error.message?.startsWith('No prebuilt geometry available');
    const overlayBody = isUnavailable
      ? 'Track geometry not available.'
      : 'Try another track or search again in a moment.';
    previewOverlayState.set({ title: 'Preview unavailable', body: overlayBody, hidden: false });
    statusMessage.set(`Error loading geometry: ${error.message}`);
    statusIsError.set(true);
    console.error(err);
  }
}
