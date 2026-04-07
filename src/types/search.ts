/**
 * Shared types for the track search index and result ranking pipeline.
 */

/**
 * A pre-processed record in the track search index.
 * Built by `buildTrackSearchEntry` from raw Wikidata/OSM data and stored in
 * `src/generated/track-search-index.json`.
 */
export interface TrackSearchEntry {
  /** Wikidata entity ID (e.g. "Q123456"). */
  wikidataId: string;
  /** Primary display name (human-readable label). */
  label: string;
  /** Alternative names for this venue. */
  aliases: string[];
  /** Wikidata description string, if available. */
  description: string | null;
  /** Venue type string from Wikidata (e.g. "street circuit"), if available. */
  type: string | null;
  /** Country name, if available. */
  country: string | null;
  /** City or locality name, if available. */
  city: string | null;
  /** Latitude of the venue. */
  lat: number;
  /** Longitude of the venue. */
  lon: number;
  /** Short name from Wikidata (e.g. abbreviated circuit name), if available. */
  wikidataShortName: string | null;
  /** Pre-normalised versions of the text fields for fast matching. */
  normalized: {
    label: string | null;
    aliases: string[];
    shortName: string;
    city: string;
    country: string;
  };
  /** Deduplicated set of all normalised phrase strings used for matching. */
  phrases: string[];
  /** Deduplicated union of all tokens across all phrases. */
  tokens: string[];
  /** Total number of unique tokens. */
  tokenCount: number;
  /** Number of alias strings. */
  aliasCount: number;
  /** Number of words in the normalised label. */
  labelWordCount: number;
}

/**
 * A scored search result returned by `searchLocalTrackIndex`.
 * Extends `TrackSearchEntry` with display fields and ranking metadata.
 */
export interface SearchResult extends TrackSearchEntry {
  /** Primary display name (same as `label`). */
  name: string;
  /** Full display name including location (e.g. "Silverstone - Towcester, United Kingdom"). */
  displayName: string;
  /** The Wikidata label (same as `label`). */
  wikidataLabel: string;
  /** Wikidata aliases (same as `aliases`). */
  wikidataAliases: string[];
  /** Wikidata description (same as `description`). */
  wikidataDescription: string | null;
  /** Composite ranking score — higher is better. */
  rankScore: number;
  /** Which matching rule produced the highest score. */
  matchCategory:
    | 'exact-label'
    | 'exact-alias'
    | 'exact-short-name'
    | 'exact-city'
    | 'exact-phrase'
    | 'prefix-label'
    | 'prefix-alias'
    | 'prefix-short-name'
    | 'prefix-phrase'
    | 'token-overlap'
    | 'substring';
}
