import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImportOsmDataArgs } from '../lib/cli.js';
import { fetchOsmWays, RateLimitExhaustedError } from '../lib/osm-fetch.js';
import { resolveTracks } from '../lib/track-index.js';
import type { ImportOsmDataOptions, TrackEntry, TrackWaysFile } from '../lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../../../src/generated/geometry/ways');

export async function run(argv: string[]): Promise<void> {
  const options = parseImportOsmDataArgs(argv);
  const tracks = await resolveTracks(options.tracks);

  console.log(`\nImport OSM data for ${tracks.length} track${tracks.length === 1 ? '' : 's'}\n`);

  const outputDir = OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });

  const report = { fetched: 0, skipped: 0, empty: 0, failed: [] as { track: TrackEntry; error: string }[] };

  for (const [index, track] of tracks.entries()) {
    const label = `[${index + 1}/${tracks.length}] ${track.label} (${track.wikidataId})`;
    const outputPath = path.join(outputDir, `${track.wikidataId}.json`);

    if (!options.force && await fileExists(outputPath)) {
      console.log(`${label} - skipped (file exists, use --force to re-fetch)`);
      report.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      console.log(`${label} - would fetch (bbox margin ${options.bboxMargin})`);
      continue;
    }

    const startTime = performance.now();
    try {
      process.stdout.write(`${label} - fetching...`);

      const { ways: allWays, bbox, requestCount, relationMemberIds } = await fetchOsmWays(
        track.lat,
        track.lon,
        options.bboxMargin,
        track.wikidataId,
      );

      let relationSourcedCount = 0;
      const circuitWays = allWays.filter(way => {
        const fromRelation = relationMemberIds.has(way.id);
        const highway = String(way.tags.highway ?? '').trim().toLowerCase();
        const sport = String(way.tags.sport ?? '').trim().toLowerCase();
        const fromTags = highway === 'raceway' && sport === 'motor';
        if (fromRelation && !fromTags) {
          relationSourcedCount += 1;
        }
        return fromRelation || fromTags;
      });

      const output: TrackWaysFile = {
        trackId: track.wikidataId,
        fetchedAt: new Date().toISOString(),
        center: { lat: track.lat, lon: track.lon },
        boundingBox: bbox,
        ways: circuitWays.map(way => ({
          id: way.id,
          tags: way.tags,
          nodes: way.geometry,
        })),
      };

      await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const wayCount = circuitWays.length;
      const parts: string[] = [];
      if (relationSourcedCount > 0) {
        parts.push(`+${relationSourcedCount} via circuit relation`);
      }
      if (requestCount > 1) {
        parts.push(`${requestCount} requests`);
      }
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      process.stdout.write(`\r${label} - ${wayCount} way${wayCount === 1 ? '' : 's'}${suffix} (${elapsed}s)\n`);

      if (wayCount === 0) {
        report.empty += 1;
      }
      report.fetched += 1;
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\r${label} - FAILED (${elapsed}s): ${message}\n`);
      report.failed.push({ track, error: message });

      if (err instanceof RateLimitExhaustedError) {
        console.error('\nAborting: OSM API rate limit exhausted. Try again later.');
        break;
      }
    }
  }

  if (!options.dryRun) {
    printSummary(report);
  }

  if (report.failed.length > 0) {
    process.exitCode = 1;
  }
}

function printSummary(report: { fetched: number; skipped: number; empty: number; failed: { track: TrackEntry; error: string }[] }): void {
  console.log('\n--- Summary ---');
  console.log(`  Fetched:  ${report.fetched}${report.empty > 0 ? ` (${report.empty} with no matching ways)` : ''}`);
  if (report.skipped > 0) {
    console.log(`  Skipped:  ${report.skipped}`);
  }
  if (report.failed.length > 0) {
    console.log(`  Failed:   ${report.failed.length}`);
    for (const { track, error } of report.failed) {
      console.log(`    - ${track.label} (${track.wikidataId}): ${error}`);
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
