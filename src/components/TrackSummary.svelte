<script lang="ts">
  import { selectPrintedTrackName } from '../search/index.js';
  import { selectedTrack, layouts, layoutIndex, osmVenueNames } from '../stores/track.js';
  import { labelOverride } from '../stores/options.js';
  import { isTrackSummaryExpanded } from '../stores/ui.js';
  import { invalidatePlacementCache, rebuildModel } from '../track-loader.js';

  const mobileSummaryMedia = window.matchMedia('(max-width: 699px)');

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

  function handleLabelInput(e: Event): void {
    const value = (e.currentTarget as HTMLInputElement).value;
    labelInputValue = value;
    labelOverride.set(value);
    showResetButton = true;

    if (!$layouts.length || !$selectedTrack) {
      return;
    }

    invalidatePlacementCache();
    rebuildModel();
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

  function handleToggleClick(): void {
    if (!$selectedTrack || !mobileSummaryMedia.matches) {
      return;
    }
    isTrackSummaryExpanded.set(!$isTrackSummaryExpanded);
  }

  $effect(() => {
    function handleMediaChange() {
      if ($selectedTrack && mobileSummaryMedia.matches) {
        isTrackSummaryExpanded.set(false);
      }
    }
    mobileSummaryMedia.addEventListener('change', handleMediaChange);
    return () => {
      mobileSummaryMedia.removeEventListener('change', handleMediaChange);
    };
  });

  let panelHidden = $derived.by(() => {
    if (!$selectedTrack) {
      return false;
    }
    return mobileSummaryMedia.matches ? !$isTrackSummaryExpanded : false;
  });

  let toggleAriaExpanded = $derived.by(() => {
    if (!$selectedTrack) {
      return 'false';
    }
    return mobileSummaryMedia.matches ? String($isTrackSummaryExpanded) : 'true';
  });

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
      : 'Preview and export settings update live as you edit options.';
  });

  let mobileName = $derived.by(() => {
    const track = $selectedTrack;
    if (!track) {
      return '';
    }
    return heading;
  });
</script>

<section id="track-summary" class="summary-card" aria-live="polite">
  <div class="section-heading-row">
    <p class="section-heading">Selected track</p>
    <span class="summary-pill">Track summary</span>
  </div>
  {#if !$selectedTrack}
    <div id="track-summary-empty" class="summary-empty">
      Search for a circuit to preview the model, adjust options, and export a print-ready file.
    </div>
  {:else}
    <div id="track-summary-content">
      <div class="summary-mobile-header">
        <div class="summary-mobile-copy">
          <p id="selected-track-mobile-name" class="summary-mobile-name">{mobileName}</p>
        </div>
        <button
          id="track-summary-toggle"
          class="summary-toggle"
          type="button"
          aria-expanded={toggleAriaExpanded}
          aria-controls="track-summary-panel"
          onclick={handleToggleClick}
        >
          <span aria-hidden="true">i</span>
          <span class="sr-only">Toggle track info</span>
        </button>
      </div>
      <div id="track-summary-panel" hidden={panelHidden}>
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
    </div>
  {/if}
</section>
