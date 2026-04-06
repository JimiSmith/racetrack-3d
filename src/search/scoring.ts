import type { TrackSearchEntry, SearchResult } from '../types/search.js';
import { normalizeSearchText, tokenizeNormalizedText, buildTrackDisplayName } from './normalize.js';

const LAYOUT_VARIANT_PATTERN =
  /\b(layout|variant|alternate|alternative|historic|historical|original|modified|grand\s+prix|gp\b|national|club|endurance|inner|outer|short|oval|\d{4})\b/i;
const VENUE_NAME_PATTERN =
  /\b(international circuit|circuit|autodrome|autodromo|raceway|speedway|ring)\b/i;

interface TokenOverlapResult {
  matchedCount: number;
  coversAllTokens: boolean;
  overlapRatio: number;
  coverageRatio: number;
}

function scoreTokenOverlap(
  queryTokens: string[],
  candidateTokens: string[],
): TokenOverlapResult | null {
  if (!queryTokens.length || !candidateTokens.length) {
    return null;
  }

  const tokenSet = new Set(candidateTokens);
  const matchedCount = queryTokens.filter(token => tokenSet.has(token)).length;
  if (matchedCount === 0) {
    return null;
  }

  const coversAllTokens = matchedCount === queryTokens.length;
  const overlapRatio = matchedCount / queryTokens.length;
  const coverageRatio = matchedCount / tokenSet.size;

  return {
    matchedCount,
    coversAllTokens,
    overlapRatio,
    coverageRatio,
  };
}

function includesSubstring(values: string[], query: string): boolean {
  return values.some(value => value.includes(query) || query.includes(value));
}

interface ScoreResult {
  score: number;
  matchCategory: SearchResult['matchCategory'];
}

function scoreTrackSearchEntry(
  entry: TrackSearchEntry,
  normalizedQuery: string,
  queryTokens: string[],
): ScoreResult | null {
  const normalized = entry.normalized ?? {};
  const label = normalized.label ?? '';
  const aliases = normalized.aliases ?? [];
  const shortName = normalized.shortName ?? '';
  const city = normalized.city ?? '';
  const country = normalized.country ?? '';
  const phrases = entry.phrases ?? [];
  const tokenOverlap = scoreTokenOverlap(queryTokens, entry.tokens ?? []);

  let score = -Infinity;
  let matchCategory: SearchResult['matchCategory'] | null = null;

  if (label === normalizedQuery) {
    score = 5000;
    matchCategory = 'exact-label';
  } else if (aliases.includes(normalizedQuery)) {
    score = 4700;
    matchCategory = 'exact-alias';
  } else if (shortName && shortName === normalizedQuery) {
    score = 4550;
    matchCategory = 'exact-short-name';
  } else if (city && city === normalizedQuery) {
    score = 4300;
    matchCategory = 'exact-city';
  } else if (phrases.includes(normalizedQuery)) {
    score = 4000;
    matchCategory = 'exact-phrase';
  } else if (label.startsWith(normalizedQuery)) {
    score = 3600;
    matchCategory = 'prefix-label';
  } else if (aliases.some(alias => alias.startsWith(normalizedQuery))) {
    score = 3350;
    matchCategory = 'prefix-alias';
  } else if (shortName && shortName.startsWith(normalizedQuery)) {
    score = 3825;
    matchCategory = 'prefix-short-name';
  } else if (phrases.some(phrase => phrase.startsWith(normalizedQuery))) {
    score = 3100;
    matchCategory = 'prefix-phrase';
  } else if (tokenOverlap) {
    score = tokenOverlap.coversAllTokens ? 2500 : 1800;
    score += tokenOverlap.matchedCount * 140;
    score += Math.round(tokenOverlap.overlapRatio * 200);
    score += Math.round(tokenOverlap.coverageRatio * 80);
    matchCategory = 'token-overlap';
  } else if (includesSubstring([label, ...aliases, ...phrases], normalizedQuery)) {
    score = 900;
    matchCategory = 'substring';
  }

  if (!Number.isFinite(score) || matchCategory === null) {
    return null;
  }

  const labelTokens = tokenizeNormalizedText(label);
  const aliasTokens = aliases.flatMap(tokenizeNormalizedText);
  const shortNameTokens = tokenizeNormalizedText(shortName);
  const locationTokens = [...tokenizeNormalizedText(city), ...tokenizeNormalizedText(country)];
  const labelTokenOverlap = scoreTokenOverlap(queryTokens, labelTokens);
  const aliasTokenOverlap = scoreTokenOverlap(queryTokens, aliasTokens);
  const shortNameTokenOverlap = scoreTokenOverlap(queryTokens, shortNameTokens);
  const locationTokenOverlap = scoreTokenOverlap(queryTokens, locationTokens);

  if (labelTokenOverlap?.coversAllTokens) {
    score += 280;
  }
  if (aliasTokenOverlap?.coversAllTokens) {
    score += 180;
  }
  if (shortNameTokenOverlap?.coversAllTokens) {
    score += 240;
  }
  if (locationTokenOverlap?.coversAllTokens) {
    score += 80;
  }

  if (
    (matchCategory === 'exact-city' || matchCategory === 'exact-phrase') &&
    !(labelTokenOverlap?.matchedCount || aliasTokenOverlap?.matchedCount)
  ) {
    score -= 120;
  }

  if (VENUE_NAME_PATTERN.test(entry.label ?? '')) {
    score += 120;
  }
  if (LAYOUT_VARIANT_PATTERN.test(entry.label ?? '')) {
    score -= 260;
  }
  if (entry.type === 'street circuit') {
    score += 60;
  }

  if (
    matchCategory === 'exact-city' &&
    labelTokenOverlap?.coversAllTokens &&
    !VENUE_NAME_PATTERN.test(entry.label ?? '')
  ) {
    score -= 420;
  }

  score -= Math.max(0, (entry.labelWordCount ?? 0) - 4) * 12;
  score -= Math.max(0, (entry.aliasCount ?? 0) - 4) * 6;

  return {
    score,
    matchCategory,
  };
}

export function compareTrackSearchResults(
  a: { rankScore: number; name: string },
  b: { rankScore: number; name: string },
): number {
  return b.rankScore - a.rankScore || a.name.length - b.name.length || a.name.localeCompare(b.name);
}

export function searchLocalTrackIndex(query: string, index: TrackSearchEntry[]): SearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = tokenizeNormalizedText(normalizedQuery);

  return (index ?? [])
    .map(entry => {
      const ranked = scoreTrackSearchEntry(entry, normalizedQuery, queryTokens);
      if (!ranked) {
        return null;
      }

      const name = entry.label;
      const result: SearchResult = {
        ...entry,
        name,
        displayName: buildTrackDisplayName(entry),
        wikidataLabel: entry.label,
        wikidataAliases: entry.aliases ?? [],
        wikidataDescription: entry.description ?? null,
        rankScore: ranked.score,
        matchCategory: ranked.matchCategory,
      };
      return result;
    })
    .filter((r): r is SearchResult => r !== null)
    .sort(compareTrackSearchResults);
}
