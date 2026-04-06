<script lang="ts">
  import SearchBar from './components/SearchBar.svelte';
  import TrackSummary from './components/TrackSummary.svelte';
  import PreviewCanvas from './components/PreviewCanvas.svelte';
  import OptionsPanel from './components/OptionsPanel.svelte';
  import ExportBar from './components/ExportBar.svelte';
  import { statusMessage, statusIsError } from './stores/ui.js';
</script>

<div id="app">
  <header class="hero">
    <p class="eyebrow">racetrack-3d</p>
    <h1>Turn race circuits into printable models.</h1>
  </header>
  <SearchBar />
  <p id="status" class={$statusIsError ? 'error' : ''}>{$statusMessage}</p>
  <TrackSummary />
  <PreviewCanvas />
  <OptionsPanel />
  <ExportBar />
</div>
