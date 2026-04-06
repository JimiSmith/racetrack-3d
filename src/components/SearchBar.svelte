<script lang="ts">
  import { searchTracks } from '../search/index.js';
  import { searchQuery, searchResults } from '../stores/search.js';
  import { selectTrack } from '../track-loader.js';
  import type { SearchResult } from '../types/search.js';

  let hasSearched = $state(false);
  let showResults = $state(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbortController: AbortController | null = null;

  function clearResults(): void {
    searchResults.set([]);
    hasSearched = false;
    showResults = false;
  }

  async function handleSelect(track: SearchResult): Promise<void> {
    clearResults();
    searchQuery.set('');
    await selectTrack(track);
  }

  function handleInput(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const query = input.value.trim();
    searchQuery.set(input.value);

    clearTimeout(debounceTimer);

    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }

    if (query.length < 3) {
      clearResults();
      return;
    }

    debounceTimer = setTimeout(async () => {
      searchAbortController = new AbortController();
      try {
        const tracks = await searchTracks(query, searchAbortController.signal);
        searchResults.set(tracks);
        hasSearched = true;
        showResults = true;
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          return;
        }
        console.error(err);
      }
    }, 800);
  }

  function handleDocumentClick(e: MouseEvent): void {
    const target = e.target as Node;
    const wrap = document.querySelector('.search-wrap');
    if (wrap && !wrap.contains(target)) {
      clearResults();
    }
  }

  $effect(() => {
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });
</script>

<div class="search-wrap">
  <input
    id="search-input"
    type="search"
    placeholder="Search track name..."
    autocomplete="off"
    spellcheck="false"
    value={$searchQuery}
    oninput={handleInput}
  />
  {#if showResults}
    <ul id="search-results">
      {#if $searchResults.length === 0 && hasSearched}
        <li class="no-results">No racetracks found.</li>
      {:else}
        {#each $searchResults as track}
          <li onclick={() => handleSelect(track)}>{track.displayName}</li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>
