/**
 * Stores for the search UI state.
 */

import { writable } from 'svelte/store';
import type { SearchResult } from '../types/search.js';

/** The current value of the search input field. */
export const searchQuery = writable<string>('');

/** The list of search results matching the current query. */
export const searchResults = writable<SearchResult[]>([]);
