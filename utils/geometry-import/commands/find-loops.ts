import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFindLoopsArgs } from '../lib/cli.js';
import { findLoops } from '../lib/loop-finder.js';
import type { TrackLoopsFile, TrackWaysFile } from '../lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WAYS_DIR = path.resolve(__dirname, '../../../src/generated/geometry/ways');
const OUTPUT_DIR = path.resolve(__dirname, '../../../src/generated/geometry/loops');

export async function run(argv: string[]): Promise<void> {
  const options = parseFindLoopsArgs(argv);

  // Discover ways files
  let waysFiles: string[];
  try {
    waysFiles = (await readdir(WAYS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    console.error(`Error: ways directory not found at ${WAYS_DIR}`);
    process.exitCode = 1;
    return;
  }

  if (options.tracks) {
    const requested = new Set(options.tracks);
    waysFiles = waysFiles.filter(f => requested.has(f.replace('.json', '')));
    const found = new Set(waysFiles.map(f => f.replace('.json', '')));
    for (const id of options.tracks) {
      if (!found.has(id)) {
        console.error(`Warning: no ways file found for ${id}`);
      }
    }
  }

  if (waysFiles.length === 0) {
    console.log('No ways files to process.');
    return;
  }

  console.log(`\nFind loops for ${waysFiles.length} track${waysFiles.length === 1 ? '' : 's'}\n`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const report = { found: 0, skipped: 0, failed: [] as { trackId: string; error: string }[] };

  for (const [index, file] of waysFiles.entries()) {
    const trackId = file.replace('.json', '');
    const startTime = performance.now();

    try {
      const label = `[${index + 1}/${waysFiles.length}] ${trackId}`;

      // Check existing output
      const outputPath = path.join(OUTPUT_DIR, `${trackId}.json`);
      if (!options.force && await fileExists(outputPath)) {
        console.log(`${label} - skipped (file exists, use --force to overwrite)`);
        report.skipped += 1;
        continue;
      }

      // Read raw file for hashing, then parse
      const waysRaw = await readFile(path.join(WAYS_DIR, file), 'utf8');
      const waysFileHash = `sha256:${createHash('sha256').update(waysRaw).digest('hex')}`;
      const waysFile: TrackWaysFile = JSON.parse(waysRaw);

      if (options.dryRun) {
        console.log(`${label} - ${waysFile.ways.length} ways (dry run)`);
        continue;
      }

      if (waysFile.ways.length === 0) {
        console.log(`${label} - no ways, skipping`);
        continue;
      }

      console.log(`${label} - ${waysFile.ways.length} ways`);

      // Run the algorithm
      const result = findLoops(waysFile.ways, {
        maxDepth: options.maxDepth,
        minLength: options.minLength,
        maxLength: options.maxLength,
        maxLoops: options.maxLoops,
      });

      // Build output
      const output: TrackLoopsFile = {
        trackId,
        generatedAt: new Date().toISOString(),
        waysFileHash,
        stats: {
          totalWays: waysFile.ways.length,
          junctionCoords: result.junctionCount,
          segments: result.segmentCount,
          loopsFound: result.loops.length,
        },
        loops: result.loops,
        unusedWays: result.unusedWays,
      };

      await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${result.loops.length} loops written (${elapsed}s)`);
      report.found += 1;
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${index + 1}/${waysFiles.length}] ${trackId} - FAILED (${elapsed}s): ${message}`);
      report.failed.push({ trackId, error: message });
    }
  }

  if (!options.dryRun) {
    printSummary(report);
  }

  if (report.failed.length > 0) {
    process.exitCode = 1;
  }
}

function printSummary(report: { found: number; skipped: number; failed: { trackId: string; error: string }[] }): void {
  console.log('\n--- Summary ---');
  console.log(`  Processed: ${report.found}`);
  if (report.skipped > 0) {
    console.log(`  Skipped:   ${report.skipped}`);
  }
  if (report.failed.length > 0) {
    console.log(`  Failed:    ${report.failed.length}`);
    for (const { trackId, error } of report.failed) {
      console.log(`    - ${trackId}: ${error}`);
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
