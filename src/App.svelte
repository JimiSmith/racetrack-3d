<script lang="ts">
  import SearchBar from './components/SearchBar.svelte';
  import TrackSummary from './components/TrackSummary.svelte';
  import PreviewCanvas from './components/PreviewCanvas.svelte';
  import OptionsPanel from './components/OptionsPanel.svelte';
  import ExportBar from './components/ExportBar.svelte';
  import PlacementDebug from './components/PlacementDebug.svelte';
  import { statusMessage, statusIsError } from './stores/ui.js';
  import { debugScreenVisible } from './stores/debug.js';

  type MobileTab = 'track' | 'tune' | 'export';
  let activeTab = $state<MobileTab>('track');
</script>

<div class="app-shell" data-active-tab={activeTab}>

  <header class="top-bar">
    <a href="/" class="top-bar-logo" aria-label="Racetrack3D home">
      <svg class="top-bar-logo-icon" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path d="M 5,18 C 4,13 7,8 12,7 L 18,7 C 23,7 26,12 25,17 L 22,23 C 21,25 19,25 17,23 L 14,20 C 12,18 10,20 8,22 Z" stroke="#E10600" stroke-width="2" stroke-linejoin="round" fill="none"/>
      </svg>
      <span class="top-bar-logo-wordmark">Racetrack<span class="accent">3D</span></span>
    </a>

    <div class="top-bar-actions" aria-hidden="true">
      <!-- Desktop visual indicator only; export functionality lives in right rail -->
    </div>

    <div class="top-bar-mobile-icons">
      <button
        class="top-bar-icon-btn"
        type="button"
        aria-label="Search circuits"
        onclick={() => activeTab = 'track'}
      >⌕</button>
    </div>
  </header>

  <div class="canvas-region">
    <PreviewCanvas />
  </div>

  <div class="left-rail" role="region" aria-label="Track selection">
    <div class="step-indicator">
      <span class="step-n">01·</span>
      <span class="step-line"></span>
      <span class="step-label">Choose Circuit</span>
    </div>
    <SearchBar />
    <p id="status" class={$statusIsError ? 'error' : ''}>{$statusMessage}</p>

    <div class="step-indicator">
      <span class="step-n">02·</span>
      <span class="step-line"></span>
      <span class="step-label">Track Info</span>
    </div>
    <div class="glass">
      <TrackSummary />
    </div>
  </div>

  <div class="right-rail" role="region" aria-label="Model options and export">
    <div class="options-card-wrap">
      <div class="step-indicator">
        <span class="step-n">03·</span>
        <span class="step-line"></span>
        <span class="step-label">Tune</span>
      </div>
      <div class="glass">
        <OptionsPanel />
      </div>
    </div>

    <div class="export-bar-wrap">
      <div class="step-indicator">
        <span class="step-n">04·</span>
        <span class="step-line"></span>
        <span class="step-label">Export</span>
      </div>
      <div class="glass">
        <ExportBar />
      </div>
      <p class="mobile-export-status" class:error={$statusIsError}>{$statusMessage}</p>
    </div>
  </div>

  <nav class="mobile-tab-bar" aria-label="Section tabs">
    <button
      class="mobile-tab-btn"
      class:active={activeTab === 'track'}
      type="button"
      onclick={() => activeTab = 'track'}
    >
      <span class="mobile-tab-btn-icon" aria-hidden="true">◎</span>
      Track
    </button>
    <button
      class="mobile-tab-btn"
      class:active={activeTab === 'tune'}
      type="button"
      onclick={() => activeTab = 'tune'}
    >
      <span class="mobile-tab-btn-icon" aria-hidden="true">⚙</span>
      Tune
    </button>
    <button
      class="mobile-tab-btn"
      class:active={activeTab === 'export'}
      type="button"
      onclick={() => activeTab = 'export'}
    >
      <span class="mobile-tab-btn-icon" aria-hidden="true">↓</span>
      Export
    </button>
  </nav>

  <footer class="site-footer">
    <p>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a></p>
  </footer>

</div>

{#if $debugScreenVisible}
  <PlacementDebug />
{/if}

