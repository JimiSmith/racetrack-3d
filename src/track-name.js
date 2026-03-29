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

const COMPACT_BASE_SUFFIX_PATTERN = /\s+(International Circuit|Motor Speedway|Park Circuit|Circuit|Autodrome|Autodromo|Raceway|Speedway|Ring)$/i;
const PREFIX_BASE_PATTERN = /^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\s+(.+)$/i;
const GENERIC_LAYOUT_PATTERN = /^(main|alternate|layout\s+\d+)$/i;
const LAYOUT_ONLY_BASE_PATTERN = /^(grand prix circuit|inner circuit|national circuit|main|alternate|layout\s+\d+)$/i;
const EVENT_STYLE_PATTERN = /\bgrand\s*prix\b|\bgp\b/i;
const DESCRIPTION_LIKE_PATTERN = /\b(circuit|raceway|track)\b.*\b(in|on|near|at)\b.*,/i;

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeNameKey(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isStrongVenueName(value) {
  return STRONG_VENUE_PATTERNS.some(pattern => pattern.test(value));
}

function isLayoutOnlyBaseName(value) {
  return LAYOUT_ONLY_BASE_PATTERN.test(normalizeWhitespace(value));
}

function isGenericLayoutName(value) {
  return GENERIC_LAYOUT_PATTERN.test(normalizeWhitespace(value));
}

function looksLikeDescription(value, description) {
  const normalizedValue = normalizeNameKey(value);
  const normalizedDescription = normalizeNameKey(description);
  return Boolean(normalizedValue)
    && (normalizedValue === normalizedDescription || DESCRIPTION_LIKE_PATTERN.test(normalizeWhitespace(value)));
}

function isEventStyleName(value) {
  return EVENT_STYLE_PATTERN.test(value);
}

function isClearlyGenericVenueName(value) {
  return !isStrongVenueName(value) && /^([a-z0-9'.-]+\s*){1,3}$/i.test(normalizeWhitespace(value));
}

function buildCandidate(name, source, index) {
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

function filterCandidates(candidates, description) {
  const strongNonEventExists = candidates.some(candidate => candidate.strongVenue && !candidate.eventStyle && !candidate.layoutOnlyBase);

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

function candidateScore(candidate) {
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

function pickBaseVenueName(candidates, wikidataLabel) {
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

  const best = sorted[0];
  const labelCandidate = candidates.find(candidate => candidate.source === 'label' && candidate.value === normalizeWhitespace(wikidataLabel));

  if (
    labelCandidate
    && best.source === 'alias'
    && best.strongVenue
    && labelCandidate.strongVenue
    && /^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\b/i.test(best.value)
    && !/^(Circuit de|Autodromo(?: Internazionale)?|Autodrome)\b/i.test(labelCandidate.value)
  ) {
    return { candidate: best, reason: 'alias clearly improves label wording' };
  }

  return {
    candidate: best,
    reason: best.source === 'shortName'
      ? 'short name fallback because no better venue-form candidate exists'
      : `selected best ${best.source} venue candidate`,
  };
}

function buildMeaningfulLayoutSuffix(selectedLayoutName, baseVenueName) {
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

  return layoutName;
}

function composePrintedName(baseVenueName, layoutSuffix) {
  if (!layoutSuffix) {
    return baseVenueName;
  }

  const compactSuffixBase = baseVenueName.match(COMPACT_BASE_SUFFIX_PATTERN);
  if (compactSuffixBase) {
    const venueRoot = normalizeWhitespace(baseVenueName.replace(COMPACT_BASE_SUFFIX_PATTERN, ''));
    if (venueRoot) {
      return `${venueRoot} ${layoutSuffix}`;
    }
  }

  const prefixedBase = baseVenueName.match(PREFIX_BASE_PATTERN);
  if (prefixedBase && /\bCircuit\b/i.test(layoutSuffix)) {
    return `${prefixedBase[2]} ${layoutSuffix}`;
  }

  return `${baseVenueName} ${layoutSuffix}`;
}

export function selectPrintedTrackName({
  wikidataLabel,
  wikidataAliases = [],
  wikidataShortName,
  description,
  osmVenueNames = [],
  selectedLayoutName,
} = {}) {
  const candidates = [
    buildCandidate(wikidataLabel, 'label', 0),
    ...wikidataAliases.map((alias, index) => buildCandidate(alias, 'alias', index)),
    ...osmVenueNames.map((name, index) => buildCandidate(name, 'osm', index)),
    buildCandidate(wikidataShortName, 'shortName', 0),
  ].filter(Boolean);

  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.normalizedKey, candidate])).values()];
  const filteredCandidates = filterCandidates(uniqueCandidates, description);
  const baseSelection = pickBaseVenueName(filteredCandidates, wikidataLabel);
  const fallbackLabel = [wikidataShortName, wikidataLabel]
    .map(value => normalizeWhitespace(value))
    .find(value => value && !looksLikeDescription(value, description))
    ?? 'Unknown';
  const baseVenueName = baseSelection?.candidate?.value ?? fallbackLabel;
  const layoutSuffix = buildMeaningfulLayoutSuffix(selectedLayoutName, baseVenueName);
  const printedName = composePrintedName(baseVenueName, layoutSuffix);

  return {
    baseVenueName,
    layoutSuffix,
    printedName,
    reason: baseSelection?.reason ?? 'fell back to label because no valid candidate remained',
  };
}
