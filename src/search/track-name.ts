const STRONG_VENUE_PATTERNS = [
  /\bInternational Circuit\b/i,
  /\bMotor Speedway\b/i,
  /\bPark Circuit\b/i,
  /\bCircuit\b/i,
  /\bAutodrome\b/i,
  /\bAutodromo\b/i,
  /\bRaceway\b/i,
  /\bSpeedway\b/i,
  /\bRing\b/i,
];

const COMPACT_BASE_SUFFIX_PATTERN =
  /\s+(International Circuit|Motor Speedway|Park Circuit|Circuit|Autodrome|Autodromo|Raceway|Speedway|Ring)$/i;
const PREFIX_BASE_PATTERN =
  /^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\s+(.+)$/i;
const GENERIC_LAYOUT_PATTERN = /^(main|alternate|layout\s+\d+)$/i;
const LAYOUT_ONLY_BASE_PATTERN =
  /^(grand prix circuit|inner circuit|national circuit|main|alternate|layout\s+\d+)$/i;
const LAYOUT_VARIANT_PATTERN =
  /\b(grand\s*prix|gp|layout|oval|national|endurance|inner|outer|short|alternate|club|kart|moto|rallycross|test|main)\b/i;
const EVENT_STYLE_PATTERN = /\bgrand\s*prix\b|\bgp\b/i;
const DESCRIPTION_LIKE_PATTERN = /\b(circuit|raceway|track)\b.*\b(in|on|near|at)\b.*,/i;

function normalizeWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeNameKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isStrongVenueName(value: string): boolean {
  return STRONG_VENUE_PATTERNS.some(pattern => pattern.test(value));
}

function isLayoutOnlyBaseName(value: string): boolean {
  return LAYOUT_ONLY_BASE_PATTERN.test(normalizeWhitespace(value));
}

function isGenericLayoutName(value: string): boolean {
  return GENERIC_LAYOUT_PATTERN.test(normalizeWhitespace(value));
}

function looksLikeDistinctLayoutName(value: string): boolean {
  return LAYOUT_VARIANT_PATTERN.test(normalizeWhitespace(value));
}

function looksLikeDescription(value: string, description: string | undefined | null): boolean {
  const normalizedValue = normalizeNameKey(value);
  const normalizedDescription = normalizeNameKey(description ?? '');
  return (
    Boolean(normalizedValue) &&
    (normalizedValue === normalizedDescription ||
      DESCRIPTION_LIKE_PATTERN.test(normalizeWhitespace(value)))
  );
}

function isEventStyleName(value: string): boolean {
  return EVENT_STYLE_PATTERN.test(value);
}

function isClearlyGenericVenueName(value: string): boolean {
  return !isStrongVenueName(value) && /^([a-z0-9'.-]+\s*){1,3}$/i.test(normalizeWhitespace(value));
}

interface Candidate {
  value: string;
  source: 'label' | 'alias' | 'osm' | 'shortName';
  index: number;
  normalizedKey: string;
  strongVenue: boolean;
  eventStyle: boolean;
  layoutOnlyBase: boolean;
  genericVenue: boolean;
}

function buildCandidate(
  name: unknown,
  source: Candidate['source'],
  index: number,
): Candidate | null {
  const value = normalizeWhitespace(name);
  if (!value) {
    return null;
  }

  return {
    value,
    source,
    index,
    normalizedKey: normalizeNameKey(value),
    strongVenue: isStrongVenueName(value),
    eventStyle: isEventStyleName(value),
    layoutOnlyBase: isLayoutOnlyBaseName(value),
    genericVenue: isClearlyGenericVenueName(value),
  };
}

function filterCandidates(
  candidates: Candidate[],
  description: string | undefined | null,
): Candidate[] {
  const strongNonEventExists = candidates.some(
    candidate => candidate.strongVenue && !candidate.eventStyle && !candidate.layoutOnlyBase,
  );

  return candidates.filter(candidate => {
    if (!candidate) {
      return false;
    }
    if (looksLikeDescription(candidate.value, description)) {
      return false;
    }
    if (candidate.layoutOnlyBase) {
      return false;
    }
    if (candidate.eventStyle && strongNonEventExists) {
      return false;
    }
    if (candidate.genericVenue && strongNonEventExists) {
      return false;
    }
    return true;
  });
}

function candidateScore(candidate: Candidate): number {
  let score = 0;

  if (candidate.strongVenue) {
    score += 100;
  }
  if (/^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\b/i.test(candidate.value)) {
    score += 20;
  }
  if (/\bInternational Circuit\b/i.test(candidate.value)) {
    score += 15;
  }
  if (candidate.source === 'label') {
    score += 6;
  }
  if (candidate.source === 'osm') {
    score += 3;
  }
  if (candidate.source === 'shortName') {
    score -= 40;
  }
  if (candidate.eventStyle) {
    score -= 20;
  }
  if (candidate.genericVenue) {
    score -= 10;
  }

  return score;
}

interface BaseVenueSelection {
  candidate: Candidate;
  reason: string;
}

function pickBaseVenueName(
  candidates: Candidate[],
  wikidataLabel: string | undefined | null,
): BaseVenueSelection | null {
  if (!candidates.length) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    const scoreDelta = candidateScore(b) - candidateScore(a);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const lengthDelta = a.value.length - b.value.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }

    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }

    return a.index - b.index;
  });

  const best = sorted[0]!;
  const labelCandidate = candidates.find(
    candidate =>
      candidate.source === 'label' && candidate.value === normalizeWhitespace(wikidataLabel),
  );

  if (
    labelCandidate &&
    best.source === 'alias' &&
    best.strongVenue &&
    labelCandidate.strongVenue &&
    /^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\b/i.test(best.value) &&
    !/^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\b/i.test(labelCandidate.value)
  ) {
    return { candidate: best, reason: 'alias clearly improves label wording' };
  }

  return {
    candidate: best,
    reason:
      best.source === 'shortName'
        ? 'short name fallback because no better venue-form candidate exists'
        : `selected best ${best.source} venue candidate`,
  };
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const bestCandidatesByKey = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const existing = bestCandidatesByKey.get(candidate.normalizedKey);
    if (!existing) {
      bestCandidatesByKey.set(candidate.normalizedKey, candidate);
      continue;
    }

    const scoreDelta = candidateScore(candidate) - candidateScore(existing);
    if (scoreDelta > 0) {
      bestCandidatesByKey.set(candidate.normalizedKey, candidate);
      continue;
    }

    if (scoreDelta === 0 && candidate.index < existing.index) {
      bestCandidatesByKey.set(candidate.normalizedKey, candidate);
    }
  }

  return [...bestCandidatesByKey.values()];
}

function buildMeaningfulLayoutSuffix(
  selectedLayoutName: string | undefined | null,
  baseVenueName: string,
  candidates: Candidate[],
): string | null {
  const layoutName = normalizeWhitespace(selectedLayoutName);
  if (!layoutName || isGenericLayoutName(layoutName)) {
    return null;
  }

  const baseKey = normalizeNameKey(baseVenueName);
  const layoutKey = normalizeNameKey(layoutName);
  if (!layoutKey || layoutKey === baseKey) {
    return null;
  }
  if (baseKey.includes(layoutKey) || layoutKey.includes(baseKey)) {
    return null;
  }

  const matchingVenueAlias = candidates.find(candidate => {
    if (candidate.value === baseVenueName || candidate.value !== layoutName) {
      return false;
    }

    return !looksLikeDistinctLayoutName(candidate.value);
  });
  if (matchingVenueAlias) {
    return null;
  }

  return layoutName;
}

function composePrintedName(baseVenueName: string, layoutSuffix: string | null): string {
  if (!layoutSuffix) {
    return baseVenueName;
  }

  const compactSuffixBase = baseVenueName.match(COMPACT_BASE_SUFFIX_PATTERN);
  if (compactSuffixBase) {
    const venueRoot = normalizeWhitespace(
      baseVenueName.replace(COMPACT_BASE_SUFFIX_PATTERN, ''),
    );
    if (venueRoot) {
      return `${venueRoot} ${layoutSuffix}`;
    }
  }

  const prefixedBase = baseVenueName.match(PREFIX_BASE_PATTERN);
  if (prefixedBase && /\bCircuit\b/i.test(layoutSuffix)) {
    return `${prefixedBase[2]!} ${layoutSuffix}`;
  }

  return `${baseVenueName} ${layoutSuffix}`;
}

export interface PrintedTrackNameResult {
  baseVenueName: string;
  layoutSuffix: string | null;
  printedName: string;
  reason: string;
}

export function selectPrintedTrackName({
  wikidataLabel,
  wikidataAliases = [],
  wikidataShortName,
  description,
  osmVenueNames = [],
  selectedLayoutName,
}: {
  wikidataLabel?: string | null;
  wikidataAliases?: string[];
  wikidataShortName?: string | null;
  description?: string | null;
  osmVenueNames?: string[];
  selectedLayoutName?: string | null;
} = {}): PrintedTrackNameResult {
  const candidates = [
    buildCandidate(wikidataLabel, 'label', 0),
    ...wikidataAliases.map((alias, index) => buildCandidate(alias, 'alias', index)),
    ...osmVenueNames.map((name, index) => buildCandidate(name, 'osm', index)),
    buildCandidate(wikidataShortName, 'shortName', 0),
  ].filter((c): c is Candidate => c !== null);

  const uniqueCandidates = dedupeCandidates(candidates);
  const filteredCandidates = filterCandidates(uniqueCandidates, description);
  const baseSelection = pickBaseVenueName(filteredCandidates, wikidataLabel);
  const fallbackLabel =
    [wikidataShortName, wikidataLabel]
      .map(value => normalizeWhitespace(value))
      .find(value => value && !looksLikeDescription(value, description)) ?? 'Unknown';
  const baseVenueName = baseSelection?.candidate?.value ?? fallbackLabel;
  const layoutSuffix = buildMeaningfulLayoutSuffix(
    selectedLayoutName,
    baseVenueName,
    filteredCandidates,
  );
  const printedName = composePrintedName(baseVenueName, layoutSuffix);

  return {
    baseVenueName,
    layoutSuffix,
    printedName,
    reason:
      baseSelection?.reason ??
      'fell back to label because no valid candidate remained',
  };
}
