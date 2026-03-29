const LAYOUT_VARIANT_PATTERN = /\b(layout|variant|alternate|alternative|historic|historical|original|modified|grand\s+prix|gp\b|national|club|endurance|inner|outer|short|oval|\d{4})\b/i;
const VENUE_NAME_PATTERN = /\b(international circuit|circuit|autodrome|autodromo|raceway|speedway|ring)\b/i;

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchText(value) {
  return collapseWhitespace(
    String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' '),
  );
}

export function tokenizeNormalizedText(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return [];
  }

  return [...new Set(normalized.split(' ').filter(Boolean))];
}

function isRawIdentifierLike(value) {
  return /^q\d+$/i.test(String(value ?? '').trim());
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeStringArray(values) {
  return dedupeStrings((values ?? []).map(normalizeSearchText).filter(Boolean));
}

export function buildTrackDisplayName({ label, city, country }) {
  const parts = [city, country].filter(Boolean);
  const location = parts.length === 2 && normalizeSearchText(parts[0]) === normalizeSearchText(parts[1])
    ? parts[0]
    : parts.join(', ');

  return location ? `${label} - ${location}` : label;
}

export function buildTrackSearchEntry(record) {
  const label = collapseWhitespace(String(record?.label ?? ''));
  const aliases = dedupeStrings((record?.aliases ?? []).map(alias => collapseWhitespace(String(alias ?? ''))).filter(Boolean));
  const country = collapseWhitespace(String(record?.country ?? '')) || null;
  const city = collapseWhitespace(String(record?.city ?? '')) || null;

  const normalized = {
    label: normalizeSearchText(label),
    aliases: normalizeStringArray(aliases),
    city: normalizeSearchText(city),
    country: normalizeSearchText(country),
  };

  const phrases = dedupeStrings([
    normalized.label,
    ...normalized.aliases,
    normalized.city,
    normalized.country,
  ]);
  const tokens = [...new Set(phrases.flatMap(tokenizeNormalizedText))];

  if ((!normalized.label && normalized.aliases.length === 0) || !Number.isFinite(record?.lat) || !Number.isFinite(record?.lon)) {
    return null;
  }

  if (phrases.length === 0) {
    return null;
  }

  const usefulLabel = normalized.label && !isRawIdentifierLike(label);
  const usefulAliases = normalized.aliases.filter(alias => !isRawIdentifierLike(alias));
  if (!usefulLabel && usefulAliases.length === 0) {
    return null;
  }

  return {
    wikidataId: record.wikidataId,
    label: usefulLabel ? label : aliases[0],
    aliases,
    description: record.description ?? null,
    type: record.type ?? null,
    country,
    city,
    lat: record.lat,
    lon: record.lon,
    wikidataShortName: record.wikidataShortName ?? null,
    normalized,
    tokens,
    phrases,
    tokenCount: tokens.length,
    aliasCount: aliases.length,
    labelWordCount: tokenizeNormalizedText(label).length,
  };
}

function scoreTokenOverlap(queryTokens, candidateTokens) {
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

function includesSubstring(values, query) {
  return values.some(value => value.includes(query) || query.includes(value));
}

function scoreTrackSearchEntry(entry, normalizedQuery, queryTokens) {
  const normalized = entry.normalized ?? {};
  const label = normalized.label ?? '';
  const aliases = normalized.aliases ?? [];
  const city = normalized.city ?? '';
  const country = normalized.country ?? '';
  const phrases = entry.phrases ?? [];
  const tokenOverlap = scoreTokenOverlap(queryTokens, entry.tokens ?? []);

  let score = -Infinity;
  let matchCategory = null;

  if (label === normalizedQuery) {
    score = 5000;
    matchCategory = 'exact-label';
  } else if (aliases.includes(normalizedQuery)) {
    score = 4700;
    matchCategory = 'exact-alias';
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

  if (!Number.isFinite(score)) {
    return null;
  }

  const labelTokens = tokenizeNormalizedText(label);
  const aliasTokens = aliases.flatMap(tokenizeNormalizedText);
  const locationTokens = [...tokenizeNormalizedText(city), ...tokenizeNormalizedText(country)];
  const labelTokenOverlap = scoreTokenOverlap(queryTokens, labelTokens);
  const aliasTokenOverlap = scoreTokenOverlap(queryTokens, aliasTokens);
  const locationTokenOverlap = scoreTokenOverlap(queryTokens, locationTokens);

  if (labelTokenOverlap?.coversAllTokens) {
    score += 280;
  }
  if (aliasTokenOverlap?.coversAllTokens) {
    score += 180;
  }
  if (locationTokenOverlap?.coversAllTokens) {
    score += 80;
  }

  if ((matchCategory === 'exact-city' || matchCategory === 'exact-phrase') && !(labelTokenOverlap?.matchedCount || aliasTokenOverlap?.matchedCount)) {
    score -= 120;
  }

  if (VENUE_NAME_PATTERN.test(entry.label ?? '')) {
    score += 30;
  }
  if (LAYOUT_VARIANT_PATTERN.test(entry.label ?? '')) {
    score -= 260;
  }

  score -= Math.max(0, (entry.labelWordCount ?? 0) - 4) * 12;
  score -= Math.max(0, (entry.aliasCount ?? 0) - 4) * 6;

  return {
    score,
    matchCategory,
  };
}

function compareTrackSearchResults(a, b) {
  return b.rankScore - a.rankScore
    || a.name.length - b.name.length
    || a.name.localeCompare(b.name);
}

export function searchLocalTrackIndex(query, index) {
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
      return {
        ...entry,
        name,
        displayName: buildTrackDisplayName(entry),
        wikidataLabel: entry.label,
        wikidataAliases: entry.aliases ?? [],
        wikidataDescription: entry.description ?? null,
        rankScore: ranked.score,
        matchCategory: ranked.matchCategory,
      };
    })
    .filter(Boolean)
    .sort(compareTrackSearchResults);
}
