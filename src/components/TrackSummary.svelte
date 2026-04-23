<script lang="ts">
  import { selectPrintedTrackName } from '../search/index.js';
  import { selectedTrack, layouts, layoutIndex, osmVenueNames } from '../stores/track.js';
  import { labelOverride } from '../stores/options.js';
  import { invalidatePlacementCache, rebuildModel } from '../track-loader.js';

  function getTrackNameState() {
    const track = $selectedTrack;
    const layout = $layouts[$layoutIndex] ?? null;
    return selectPrintedTrackName({
      wikidataLabel: track?.wikidataLabel ?? track?.name ?? null,
      wikidataAliases: track?.wikidataAliases ?? [],
      wikidataShortName: track?.wikidataShortName ?? null,
      description: track?.wikidataDescription ?? null,
      osmVenueNames: $osmVenueNames,
      selectedLayoutName: layout?.name ?? null,
    });
  }

  let labelInputValue = $state('');
  let showResetButton = $state(false);

  $effect(() => {
    const track = $selectedTrack;
    const override = $labelOverride;
    if (!track) {
      labelInputValue = '';
      showResetButton = false;
      return;
    }
    if (override !== null) {
      labelInputValue = override;
      showResetButton = true;
      return;
    }
    const trackNameState = getTrackNameState();
    labelInputValue = trackNameState.printedName;
    showResetButton = false;
  });

  let labelDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function handleLabelInput(e: Event): void {
    const value = (e.currentTarget as HTMLInputElement).value;
    labelInputValue = value;
    labelOverride.set(value);
    showResetButton = true;

    if (!$layouts.length || !$selectedTrack) {
      return;
    }

    if (labelDebounceTimer !== null) {
      clearTimeout(labelDebounceTimer);
    }
    labelDebounceTimer = setTimeout(() => {
      labelDebounceTimer = null;
      invalidatePlacementCache();
      rebuildModel();
    }, 300);
  }

  function handleLabelReset(): void {
    labelOverride.set(null);
    const trackNameState = getTrackNameState();
    labelInputValue = trackNameState.printedName;
    showResetButton = false;

    if (!$layouts.length || !$selectedTrack) {
      return;
    }

    invalidatePlacementCache();
    rebuildModel();
  }

  let heading = $derived.by(() => {
    const track = $selectedTrack;
    if (!track) {
      return '';
    }
    const trackNameState = getTrackNameState();
    return track.name ?? trackNameState.printedName;
  });

  let meta = $derived.by(() => {
    const track = $selectedTrack;
    if (!track) {
      return '';
    }
    const h = heading;
    return track.displayName && track.displayName !== h
      ? track.displayName
      : 'Settings update live as you edit options.';
  });
</script>

<section id="track-summary" aria-live="polite">
  {#if !$selectedTrack}
    <div id="track-summary-empty" class="summary-empty">
      Search for a circuit to preview the model, adjust options, and export a print-ready file.
    </div>
  {:else}
    <div id="track-summary-content">
      <h2 id="selected-track-name">{heading}</h2>
      <p id="selected-track-meta">{meta}</p>
      <dl class="summary-grid">
        <div>
          <dt>Label</dt>
          <dd>
            <div class="summary-label-wrap">
              <input
                id="summary-label-input"
                class="summary-label-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                value={labelInputValue}
                oninput={handleLabelInput}
              />
              <button
                id="summary-label-reset"
                class="summary-label-reset"
                type="button"
                title="Reset to default label"
                aria-label="Reset label to default"
                hidden={!showResetButton}
                onclick={handleLabelReset}
              >↺</button>
            </div>
          </dd>
        </div>
      </dl>
    </div>
  {/if}
</section>
