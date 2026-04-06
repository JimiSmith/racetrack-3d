<script lang="ts">
  import { exaggeration } from '../stores/options.js';
  import { nodes, elevations } from '../stores/model.js';
  import { loadElevations } from '../track-loader.js';
  import { get } from 'svelte/store';

  let sliderValue = $state($exaggeration);
  let gradientStyle = $state('');
  let elevationRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  // Track whether elevations have been loaded (show slider only then)
  let elevationsLoaded = $derived($elevations !== null);

  function computeGradient(value: number, min: number, max: number): string {
    const progress = ((value - min) / (max - min)) * 100;
    return `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${progress}%, rgba(99, 108, 128, 0.45) ${progress}%, rgba(99, 108, 128, 0.45) 100%)`;
  }

  $effect(() => {
    sliderValue = $exaggeration;
    gradientStyle = computeGradient(sliderValue, 0, 20);
  });

  function handleInput(e: Event): void {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    sliderValue = value;
    exaggeration.set(value);
    gradientStyle = computeGradient(value, 0, 20);

    const currentNodes = get(nodes);
    if (!currentNodes) {
      return;
    }

    clearTimeout(elevationRefreshTimer);
    elevationRefreshTimer = setTimeout(async () => {
      await loadElevations(currentNodes!);
    }, 150);
  }
</script>

{#if elevationsLoaded}
  <div id="exaggeration-wrap" class="field-card controls-wrap">
    <div class="range-header">
      <label for="exaggeration">Elevation exaggeration</label>
      <output id="exaggeration-value" for="exaggeration">{sliderValue}x</output>
    </div>
    <input
      id="exaggeration"
      type="range"
      min="0"
      max="20"
      value={sliderValue}
      step="1"
      style="background: {gradientStyle}"
      oninput={handleInput}
    />
  </div>
{/if}
