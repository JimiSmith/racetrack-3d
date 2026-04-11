import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrackEntry } from './types.js';

interface SearchIndexEntry {
  wikidataId: string;
  label: string;
  lat: number;
  lon: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_INDEX_PATH = path.resolve(__dirname, '../../../src/generated/track-search-index.json');

let cachedIndex: TrackEntry[] | null = null;

async function loadSearchIndex(): Promise<TrackEntry[]> {
  if (cachedIndex) {
    return cachedIndex;
  }

  const raw = await readFile(SEARCH_INDEX_PATH, 'utf8');
  const entries: SearchIndexEntry[] = JSON.parse(raw);

  cachedIndex = entries
    .filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map(e => ({
      wikidataId: e.wikidataId,
      label: e.label,
      lat: e.lat,
      lon: e.lon,
    }));

  return cachedIndex;
}

/**
 * Resolve tracks by Wikidata IDs, or return all tracks if ids is null.
 * Throws if any requested ID is not found in the search index.
 */
export async function resolveTracks(ids: string[] | null): Promise<TrackEntry[]> {
  const index = await loadSearchIndex();

  if (ids === null) {
    return index;
  }

  const byId = new Map(index.map(t => [t.wikidataId, t]));
  const tracks: TrackEntry[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const track = byId.get(id);
    if (track) {
      tracks.push(track);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Track(s) not found in search index: ${missing.join(', ')}`);
  }

  return tracks;
}
