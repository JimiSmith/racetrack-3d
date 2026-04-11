import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreateTrackGeometryArgs } from '../lib/cli.js';
import { measurePolylineLength } from '../lib/geo-math.js';
import { stitchLayout } from '../lib/stitch.js';
import type { OutputWay, TrackLayoutFile, TrackWaysFile } from '../lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYOUTS_DIR = path.resolve(__dirname, '../../../src/generated/geometry/layouts');
const WAYS_DIR = path.resolve(__dirname, '../../../src/generated/geometry/ways');
const OUTPUT_DIR = path.resolve(__dirname, '../../../src/generated/geometry');

const MIN_LENGTH_METRES = 200;
const MAX_LENGTH_METRES = 30_000;

export async function run(argv: string[]): Promise<void> {
  const options = parseCreateTrackGeometryArgs(argv);

  // Discover layout files
  let layoutFiles: string[];
  try {
    layoutFiles = (await readdir(LAYOUTS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    console.error(`Error: layouts directory not found at ${LAYOUTS_DIR}`);
    process.exitCode = 1;
    return;
  }

  if (options.tracks) {
    const requested = new Set(options.tracks);
    layoutFiles = layoutFiles.filter(f => requested.has(f.replace('.json', '')));
    const found = new Set(layoutFiles.map(f => f.replace('.json', '')));
    for (const id of options.tracks) {
      if (!found.has(id)) {
        console.error(`Warning: no layout file found for ${id}`);
      }
    }
  }

  if (layoutFiles.length === 0) {
    console.log('No layout files to process.');
    return;
  }

  console.log(`\nGenerate geometry for ${layoutFiles.length} track${layoutFiles.length === 1 ? '' : 's'}\n`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const report = { generated: 0, skipped: 0, failed: [] as { trackId: string; error: string }[] };

  for (const [index, file] of layoutFiles.entries()) {
    const trackId = file.replace('.json', '');
    const startTime = performance.now();

    try {
      // Load layout file
      const layoutRaw = await readFile(path.join(LAYOUTS_DIR, file), 'utf8');
      const layoutFile: TrackLayoutFile = JSON.parse(layoutRaw);
      const label = `[${index + 1}/${layoutFiles.length}] ${layoutFile.name} (${trackId})`;

      // Check existing output
      const outputPath = path.join(OUTPUT_DIR, `${trackId}.json`);
      if (!options.force && await fileExists(outputPath)) {
        console.log(`${label} - skipped (file exists, use --force to overwrite)`);
        report.skipped += 1;
        continue;
      }

      if (options.dryRun) {
        const layoutCount = Object.keys(layoutFile.layouts).length;
        console.log(`${label} - would generate ${layoutCount} layout${layoutCount === 1 ? '' : 's'}`);
        continue;
      }

      // Load ways file
      const waysPath = path.join(WAYS_DIR, `${trackId}.json`);
      const waysRaw = await readFile(waysPath, 'utf8');
      const waysFile: TrackWaysFile = JSON.parse(waysRaw);

      // Build way index for O(1) lookup
      const wayIndex = new Map<number, OutputWay>();
      for (const way of waysFile.ways) {
        wayIndex.set(way.id, way);
      }

      // Check for orphaned ways
      const usedWayIds = new Set<number>();
      for (const layout of Object.values(layoutFile.layouts)) {
        for (const entry of layout.ways) {
          usedWayIds.add(entry.wayId);
        }
      }
      const excludedWayIds = new Set((layoutFile.excludedWays ?? []).map(e => e.wayId));
      const orphanedWays = waysFile.ways
        .filter(w => !usedWayIds.has(w.id) && !excludedWayIds.has(w.id))
        .map(w => w.id);
      if (orphanedWays.length > 0) {
        console.log(`  Warning: ${orphanedWays.length} orphaned way${orphanedWays.length === 1 ? '' : 's'} in ways file: ${orphanedWays.join(', ')}`);
      }

      // Collect osmVenueNames from all used ways
      const venueNameSet = new Set<string>();
      for (const wayId of usedWayIds) {
        const way = wayIndex.get(wayId);
        if (way?.tags.name) {
          venueNameSet.add(way.tags.name);
        }
      }
      const osmVenueNames = [...venueNameSet].sort();

      // Stitch each layout
      const layouts: Array<{ id: string; name: string; nodes: Array<{ lat: number; lon: number }>; stats: { lengthMetres: number; segmentCount: number } }> = [];
      const usedIds = new Set<string>();

      for (const [layoutName, layoutDef] of Object.entries(layoutFile.layouts)) {
        const result = stitchLayout(layoutName, layoutDef.ways, wayIndex);
        const lengthMetres = measurePolylineLength(result.nodes);

        if (lengthMetres < MIN_LENGTH_METRES) {
          console.log(`  Warning: layout "${layoutName}" is suspiciously short (${lengthMetres.toFixed(0)}m)`);
        } else if (lengthMetres > MAX_LENGTH_METRES) {
          console.log(`  Warning: layout "${layoutName}" is suspiciously long (${lengthMetres.toFixed(0)}m)`);
        }

        let id = slugify(layoutName);
        if (usedIds.has(id)) {
          let suffix = 2;
          while (usedIds.has(`${id}-${suffix}`)) suffix++;
          id = `${id}-${suffix}`;
        }
        usedIds.add(id);

        layouts.push({
          id,
          name: layoutName,
          nodes: result.nodes,
          stats: {
            lengthMetres,
            segmentCount: result.segmentCount,
          },
        });

        console.log(`  Layout "${layoutName}": ${result.segmentCount} ways, ${lengthMetres.toFixed(0)}m, ${result.nodes.length} nodes`);
      }

      // Build output
      const output = {
        trackId,
        name: layoutFile.name,
        source: {
          kind: 'osm-prebuilt',
          generatedAt: new Date().toISOString(),
          pipelineVersion: 2,
        },
        center: waysFile.center,
        names: {
          searchLabel: layoutFile.name,
          shortName: null,
          osmVenueNames,
        },
        layouts,
        selectedLayoutIndex: 0,
      };

      await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`${label} - ${layouts.length} layout${layouts.length === 1 ? '' : 's'} written (${elapsed}s)`);
      report.generated += 1;
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${index + 1}/${layoutFiles.length}] ${trackId} - FAILED (${elapsed}s): ${message}`);
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

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function printSummary(report: { generated: number; skipped: number; failed: { trackId: string; error: string }[] }): void {
  console.log('\n--- Summary ---');
  console.log(`  Generated: ${report.generated}`);
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
