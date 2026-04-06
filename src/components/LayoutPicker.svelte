<script lang="ts">
  import { layouts, layoutIndex } from '../stores/track.js';
  import { combinedLayoutMode, exaggeration } from '../stores/options.js';
  import { nodes } from '../stores/model.js';
  import { buildLayoutPickerState, getSelectedLayout, normalizeSelectedLayoutIndex } from '../search/layout-picker.js';
  import { rebuildModel, loadElevations, invalidatePlacementCache } from '../track-loader.js';
  import { get } from 'svelte/store';
  import { elevations, secondaryElevations } from '../stores/model.js';

  let pickerState = $derived(buildLayoutPickerState($layouts, $layoutIndex));

  async function handleLayoutChange(e: Event): Promise<void> {
    const currentLayouts = $layouts;
    if (!currentLayouts.length) {
      return;
    }

    const nextIndex = Number((e.currentTarget as HTMLSelectElement).value);
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= currentLayouts.length) {
      return;
    }

    const normalizedIndex = normalizeSelectedLayoutIndex(currentLayouts, nextIndex);
    layoutIndex.set(normalizedIndex);
    elevations.set(null);
    invalidatePlacementCache();
    rebuildModel();

    const primaryNodes = getSelectedLayout(currentLayouts, normalizedIndex)?.nodes ?? [];
    await loadElevations(primaryNodes);
  }

  async function handleCombinedToggle(e: Event): Promise<void> {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    combinedLayoutMode.set(checked);

    if (!checked) {
      secondaryElevations.set([]);
    }

    invalidatePlacementCache();
    rebuildModel();

    if (checked) {
      const currentNodes = get(nodes);
      if (currentNodes?.length) {
        await loadElevations(currentNodes);
      }
    }
  }
</script>

{#if !pickerState.hidden}
  <div id="layout-wrap" class="field-card">
    <label for="layout-select">Layout</label>
    <select id="layout-select" onchange={handleLayoutChange}>
      {#each pickerState.options as option}
        <option value={option.value} selected={option.selected}>{option.label}</option>
      {/each}
    </select>
    <p id="layout-hint">{pickerState.hint}</p>
  </div>
{/if}
{#if $layouts.length >= 2}
  <div id="combined-layout-wrap" class="field-card">
    <label class="checkbox-label">
      <input
        type="checkbox"
        id="combined-layout-toggle"
        checked={$combinedLayoutMode}
        onchange={handleCombinedToggle}
      />
      Show all layouts
    </label>
  </div>
{/if}
