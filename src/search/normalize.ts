import type { TrackSearchEntry } from '../types/search.js';

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchText(value: unknown): string {
  return collapseWhitespace(
    String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' '),
  );
}

export function tokenizeNormalizedText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return [];
  }

  return [...new Set(normalized.split(' ').filter(Boolean))];
}

function isRawIdentifierLike(value: unknown): boolean {
  return /^q\d+$/i.test(String(value ?? '').trim());
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function normalizeStringArray(values: string[] | undefined | null): string[] {
  return dedupeStrings((values ?? []).map(normalizeSearchText).filter(Boolean));
}

export function buildTrackDisplayName({ label, city, country }: { label: string; city: string | null; country: string | null }): string {
  const parts = [city, country].filter((v): v is string => Boolean(v));
  const location =
    parts.length === 2 && normalizeSearchText(parts[0]!) === normalizeSearchText(parts[1]!)
      ? parts[0]!
      : parts.join(', ');

  return location ? `${label} - ${location}` : label;
}

export function buildTrackSearchEntry(record: {
  wikidataId: string;
  label?: unknown;
  aliases?: unknown[];
  wikidataShortName?: unknown;
  country?: unknown;
  city?: unknown;
  lat?: unknown;
  lon?: unknown;
  description?: string | null;
  type?: string | null;
}): TrackSearchEntry | null {
  const label = collapseWhitespace(String(record?.label ?? ''));
  const aliases = dedupeStrings(
    ((record?.aliases ?? []) as unknown[])
      .map(alias => collapseWhitespace(String(alias ?? '')))
      .filter(Boolean),
  );
  const shortName = collapseWhitespace(String(record?.wikidataShortName ?? '')) || null;
  const country = collapseWhitespace(String(record?.country ?? '')) || null;
  const city = collapseWhitespace(String(record?.city ?? '')) || null;

  const usefulLabel = Boolean(label) && !isRawIdentifierLike(label);
  const usefulAliases = aliases.filter(alias => !isRawIdentifierLike(alias));
  const resolvedLabel = usefulLabel ? label : (usefulAliases[0] ?? label);

  const normalized = {
    label: normalizeSearchText(resolvedLabel) || null,
    aliases: normalizeStringArray(aliases),
    shortName: normalizeSearchText(shortName),
    city: normalizeSearchText(city),
    country: normalizeSearchText(country),
  };

  const phrases = dedupeStrings([
    normalized.label,
    ...normalized.aliases,
    normalized.shortName,
    normalized.city,
    normalized.country,
  ]);
  const tokens = [...new Set(phrases.flatMap(tokenizeNormalizedText))];

  if (
    (!normalized.label && normalized.aliases.length === 0) ||
    !Number.isFinite(record?.lat) ||
    !Number.isFinite(record?.lon)
  ) {
    return null;
  }

  if (phrases.length === 0) {
    return null;
  }

  if (!usefulLabel && usefulAliases.length === 0) {
    return null;
  }

  return {
    wikidataId: record.wikidataId,
    label: resolvedLabel,
    aliases,
    description: record.description ?? null,
    type: record.type ?? null,
    country,
    city,
    lat: Number(record.lat),
    lon: Number(record.lon),
    wikidataShortName: shortName,
    normalized,
    tokens,
    phrases,
    tokenCount: tokens.length,
    aliasCount: aliases.length,
    labelWordCount: tokenizeNormalizedText(label).length,
  };
}
