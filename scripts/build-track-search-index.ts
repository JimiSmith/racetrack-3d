import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTrackSearchEntry } from '../src/search/normalize.js';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const TRACK_INSTANCE_IDS: Record<string, string> = {
  Q2338524: 'motorsport racing track',
  Q926439: 'street circuit',
  Q66436502: 'race track layout',
};
const ENTITY_BATCH_SIZE = 50;

interface SparqlBinding {
  item?: { value: string };
  type?: { value: string };
  lat?: { value: string };
  lon?: { value: string };
}

interface MergedTrackRow {
  wikidataId: string;
  type: string | null;
  lat: number;
  lon: number;
  countryId: string | null;
  cityIds: string[];
}

interface EntityDetail {
  label: string | null;
  aliases: string[];
  description: string | null;
  wikidataShortName: string | null;
  countryId: string | null;
  cityIds: string[];
}

interface WikidataClaim {
  mainsnak?: { datavalue?: { value?: { text?: string; id?: string } } };
}

interface WikidataAlias {
  value: string;
}

interface WikidataEntity {
  labels?: { en?: { value: string } };
  aliases?: { en?: WikidataAlias[] };
  descriptions?: { en?: { value: string } };
  claims?: Record<string, WikidataClaim[]>;
}

// Per-track alias supplements. Keys are Wikidata IDs; values are arrays of
// additional alias strings to merge with the Wikidata-sourced aliases.
// Use this for well-known names absent from Wikidata (e.g. branding names or
// popular venue names pending a Wikidata edit).
const SEARCH_INDEX_ALIASES = new Map([
  ['Q126193406', ['Circuit IFEMA Madrid', 'IFEMA Madrid', 'IFEMA']],
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'src', 'generated');
const outputPath = path.join(outputDir, 'track-search-index.json');

function extractWikidataId(value: unknown): string | null {
  return String(value ?? '').split('/').pop()! || null;
}

async function fetchJson(url: string, options?: RequestInit, retryOptions?: { retries?: number; baseDelayMs?: number }): Promise<unknown> {
  const { retries = 4, baseDelayMs = 1000 } = retryOptions ?? {};
  const { headers: optionHeaders, ...restOptions } = options ?? {};

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'racetrack-3d-search-index-builder/1.0 (https://github.com/)',
        ...(optionHeaders ?? {}),
      },
      ...restOptions,
    });

    if (response.ok) {
      return response.json();
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries) {
      throw new Error(`Request failed with ${response.status} for ${url}`);
    }

    const delayMs = baseDelayMs * 2 ** attempt;
    console.warn(`Request failed with ${response.status} for ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`);
    await new Promise(resolve => { setTimeout(resolve, delayMs); });
  }
}

async function fetchTrackRows(): Promise<SparqlBinding[]> {
  const pageSize = 500;
  const rows: SparqlBinding[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const sparql = `
SELECT DISTINCT ?item ?type ?lat ?lon WHERE {
  VALUES ?type { wd:Q2338524 wd:Q926439 wd:Q66436502 }
  ?item wdt:P31 ?type .
  ?item p:P625 ?coordinateStatement .
  ?coordinateStatement psv:P625 ?coordinateNode .
  ?coordinateNode wikibase:geoLatitude ?lat .
  ?coordinateNode wikibase:geoLongitude ?lon .
}
ORDER BY ?item
LIMIT ${pageSize}
OFFSET ${offset}
    `.trim();

    const payload = await fetchJson(WIKIDATA_SPARQL, {
      method: 'POST',
      headers: {
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: `query=${encodeURIComponent(sparql)}&format=json`,
    }) as { results?: { bindings?: SparqlBinding[] } };

    const pageRows = payload.results?.bindings ?? [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      return rows;
    }
  }
}

function mergeTrackRows(rows: SparqlBinding[]) {
  const merged = new Map<string, MergedTrackRow>();

  for (const row of rows) {
    const wikidataId = extractWikidataId(row.item?.value);
    if (!wikidataId) {
      continue;
    }

    const existing = merged.get(wikidataId) ?? {
      wikidataId,
      type: TRACK_INSTANCE_IDS[extractWikidataId(row.type?.value)!] ?? null,
      lat: Number.parseFloat(row.lat?.value ?? ''),
      lon: Number.parseFloat(row.lon?.value ?? ''),
      countryId: null,
      cityIds: [],
    };

    merged.set(wikidataId, existing);
  }

  return [...merged.values()];
}

async function fetchEntityDetails(ids: string[]) {
  const entities = new Map<string, EntityDetail>();

  for (let index = 0; index < ids.length; index += ENTITY_BATCH_SIZE) {
    const batch = ids.slice(index, index + ENTITY_BATCH_SIZE);
    const url = `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(batch.join('|'))}&languages=en&props=labels|aliases|descriptions|claims&format=json&origin=*`;
    const payload = await fetchJson(url) as { entities?: Record<string, WikidataEntity> };

    for (const id of batch) {
      const entity: WikidataEntity = payload.entities?.[id] ?? {};
      const shortName = entity.claims?.P1813
        ?.find((claim: WikidataClaim) => claim?.mainsnak?.datavalue?.value?.text)
        ?.mainsnak?.datavalue?.value?.text ?? null;
      const getEntityClaimIds = (property: string): string[] => (entity.claims?.[property] ?? [])
        .map((claim: WikidataClaim) => claim?.mainsnak?.datavalue?.value?.id)
        .filter((value): value is string => Boolean(value));

      entities.set(id, {
        label: entity.labels?.en?.value ?? null,
        aliases: (entity.aliases?.en ?? []).map((alias: WikidataAlias) => alias.value).filter(Boolean),
        description: entity.descriptions?.en?.value ?? null,
        wikidataShortName: shortName,
        countryId: getEntityClaimIds('P17')[0] ?? null,
        cityIds: [
          ...getEntityClaimIds('P740'),
          ...getEntityClaimIds('P276'),
          ...getEntityClaimIds('P131'),
          ...getEntityClaimIds('P159'),
        ],
      });
    }
  }

  return entities;
}

function assembleIndex(baseRows: MergedTrackRow[], entityDetails: Map<string, EntityDetail>) {
  return baseRows
    .map(row => {
      const details: EntityDetail = entityDetails.get(row.wikidataId) ?? {
        label: null,
        aliases: [],
        description: null,
        wikidataShortName: null,
        countryId: null,
        cityIds: [],
      };
      const country = details.countryId ? entityDetails.get(details.countryId)?.label ?? null : null;
      const city = (details.cityIds ?? []).map((id: string) => entityDetails.get(id)?.label ?? null).find(Boolean) ?? null;
      const extraAliases = SEARCH_INDEX_ALIASES.get(row.wikidataId) ?? [];
      return buildTrackSearchEntry({
        wikidataId: row.wikidataId,
        label: details.label,
        aliases: [...(details.aliases ?? []), ...extraAliases],
        description: details.description,
        type: row.type,
        country,
        city,
        lat: row.lat,
        lon: row.lon,
        wikidataShortName: details.wikidataShortName,
      });
    })
    .filter(Boolean)
    .sort((a, b) => a!.label.localeCompare(b!.label) || a!.wikidataId.localeCompare(b!.wikidataId));
}

async function main() {
  const rows = await fetchTrackRows();
  const mergedRows = mergeTrackRows(rows);
  const entityDetails = await fetchEntityDetails(mergedRows.map(row => row.wikidataId));
  const relatedIds = new Set<string>();
  for (const row of mergedRows) {
    const details = entityDetails.get(row.wikidataId);
    if (details?.countryId) {
      relatedIds.add(details.countryId);
    }
    for (const cityId of details?.cityIds ?? []) {
      relatedIds.add(cityId);
    }
  }

  if (relatedIds.size > 0) {
    const relatedEntityDetails = await fetchEntityDetails([...relatedIds]);
    for (const [id, details] of relatedEntityDetails) {
      entityDetails.set(id, details);
    }
  }

  const index = assembleIndex(mergedRows, entityDetails);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`);

  console.log(`Wrote ${index.length} track entries to ${path.relative(projectRoot, outputPath)}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
