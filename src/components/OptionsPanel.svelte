<script lang="ts">
  import {
    primaryOrientationDeg,
    textPositionRank,
    coasterMode,
    coasterShape,
    coasterInlay,
  } from '../stores/options.js';
  import { selectedTrack, layouts } from '../stores/track.js';
  import { normalizePrimaryOrientationDeg } from '../model/orientation.js';
  import { normalizeTextPositionRank, DEFAULT_TEXT_POSITION_RANK } from '../text3d.js';
  import { rebuildModel, loadElevations, invalidatePlacementCache } from '../track-loader.js';
  import { get } from 'svelte/store';
  import { nodes } from '../stores/model.js';
  import LayoutPicker from './LayoutPicker.svelte';
  import ElevationSlider from './ElevationSlider.svelte';
  import { debugScreenVisible } from '../stores/debug.js';

  function handleOrientationChange(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    primaryOrientationDeg.set(normalizePrimaryOrientationDeg(value));

    if (!get(layouts).length || !get(selectedTrack)) {
      return;
    }

    rebuildModel();
    const currentNodes = get(nodes);
    if (currentNodes?.length) {
      void loadElevations(currentNodes);
    }
  }

  function handleTextPositionChange(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    textPositionRank.set(normalizeTextPositionRank(value));

    if (!get(layouts).length || !get(selectedTrack)) {
      return;
    }

    invalidatePlacementCache();
    rebuildModel();
  }

  function handleCoasterChange(): void {
    if (!get(layouts).length || !get(selectedTrack)) {
      return;
    }
    invalidatePlacementCache();
    rebuildModel();
    const currentNodes = get(nodes);
    if (currentNodes?.length) {
      void loadElevations(currentNodes);
    }
  }

  function handleCoasterToggle(e: Event): void {
    coasterMode.set((e.currentTarget as HTMLInputElement).checked);
    handleCoasterChange();
  }

  function handleCoasterShapeChange(e: Event): void {
    coasterShape.set((e.currentTarget as HTMLSelectElement).value as 'round' | 'square');
    handleCoasterChange();
  }

  function handleCoasterInlayChange(e: Event): void {
    coasterInlay.set((e.currentTarget as HTMLSelectElement).value as 'flush' | 'raised');
    handleCoasterChange();
  }
</script>

<section class="options-card" aria-label="Model options">
  <div class="section-heading-row">
    <p class="section-heading">Options</p>
  </div>
  <LayoutPicker />
  <div class="field-card controls-wrap">
    <label for="orientation-select">Model orientation</label>
    <select id="orientation-select" onchange={handleOrientationChange}>
      <option value="auto" selected={$primaryOrientationDeg === 'auto'}>Auto</option>
      <option value="0" selected={$primaryOrientationDeg === 0}>0°</option>
      <option value="90" selected={$primaryOrientationDeg === 90}>90°</option>
      <option value="180" selected={$primaryOrientationDeg === 180}>180°</option>
      <option value="270" selected={$primaryOrientationDeg === 270}>270°</option>
    </select>
  </div>
  <div class="field-card controls-wrap">
    <label for="text-position-select">Label placement</label>
    <select id="text-position-select" onchange={handleTextPositionChange}>
      <option value="1" selected={$textPositionRank === 1}>Best fit</option>
      <option value="2" selected={$textPositionRank === 2}>Alternate 1</option>
      <option value="3" selected={$textPositionRank === 3}>Alternate 2</option>
    </select>
    <button class="debug-btn" onclick={() => debugScreenVisible.set(true)}>Debug</button>
  </div>
  <div class="field-card controls-wrap">
    <label class="coaster-toggle">
      <input
        type="checkbox"
        checked={$coasterMode}
        onchange={handleCoasterToggle}
      />
      <span>Coaster mode (90×90 mm)</span>
    </label>
  </div>
  {#if $coasterMode}
    <div class="field-card controls-wrap">
      <label for="coaster-shape-select">Coaster shape</label>
      <select id="coaster-shape-select" onchange={handleCoasterShapeChange}>
        <option value="round" selected={$coasterShape === 'round'}>Round</option>
        <option value="square" selected={$coasterShape === 'square'}>Square</option>
      </select>
    </div>
    <div class="field-card controls-wrap">
      <label for="coaster-inlay-select">Track inlay</label>
      <select id="coaster-inlay-select" onchange={handleCoasterInlayChange}>
        <option value="raised" selected={$coasterInlay === 'raised'}>Raised 0.2 mm</option>
        <option value="flush" selected={$coasterInlay === 'flush'}>Flush (through-cut)</option>
      </select>
    </div>
  {:else}
    <ElevationSlider />
  {/if}
</section>

<style>
  .coaster-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .coaster-toggle input {
    cursor: pointer;
  }
</style>
