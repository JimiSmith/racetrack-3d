/**
 * validate:meshes — mesh-validation sweep across the prebuilt geometry corpus (#122).
 *
 * Reads the shipped `src/generated/geometry/*.json` files, builds each track headlessly
 * through the SAME `buildTrackModel` worker/export path the in-app export uses, runs the
 * merged `validateModel()` entry point on every part, and prints a compact failure table
 * keyed by track id + mode + part.
 *
 * Modes:
 *   (no args)        representative sample, auto-trimmed 'sample' matrix (tens of seconds).
 *   --all            all buildable tracks, lean 8-mode 'all' matrix (on-demand, slow).
 *   --track <id>     one track, full cross-product matrix.
 *   --help           usage.
 *
 * No mesh fixes live here; the sweep captures the current baseline. Exits non-zero on any
 * failure. The sweep core lives in `test-utils/mesh-sweep.ts` so the committed test runs
 * the same code path.
 */

import {
  REPRESENTATIVE_SAMPLE,
  buildableTrackIds,
  formatFailureTable,
  readTrackFile,
  isBuildable,
  runSweep,
} from '../test-utils/mesh-sweep.js';

const USAGE = `Usage: npm run validate:meshes [-- <options>]

  (no options)     Run the representative sample (auto-trimmed matrix). Default.
  --all            Run every buildable track (lean 8-mode matrix). Slow, on-demand.
  --track <id>     Run a single track by wikidata id (full cross-product matrix).
  --help           Show this message.

Exits non-zero if any (track, mode, part) fails the current mesh detectors
(non-manifold edges, degenerate triangles, T-junctions, self-intersections,
flipped faces, or disjoint shells).`;

interface ParsedArgs {
  help: boolean;
  all: boolean;
  track: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, all: false, track: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--track') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--track requires a wikidata id, e.g. --track Q172851');
      }
      parsed.track = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.track) {
    const file = readTrackFile(args.track);
    if (file === null) {
      console.error(`Unknown track id: ${args.track} (no geometry file found)`);
      process.exitCode = 1;
      return;
    }
    if (!isBuildable(file)) {
      console.error(`Track ${args.track} has no buildable geometry (stub or <3 nodes)`);
      process.exitCode = 1;
      return;
    }
    console.log(`validate:meshes — single track ${args.track} (full matrix)\n`);
    const result = await runSweep([args.track], { variant: 'full' });
    report(result, 1);
    return;
  }

  if (args.all) {
    const ids = buildableTrackIds();
    console.log(`validate:meshes — all ${ids.length} buildable tracks (lean matrix). This may take minutes.\n`);
    const started = Date.now();
    const result = await runSweep(ids, { variant: 'all' });
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
    report(result, ids.length);
    return;
  }

  console.log(`validate:meshes — representative sample of ${REPRESENTATIVE_SAMPLE.length} tracks (auto-trimmed matrix)\n`);
  const started = Date.now();
  const result = await runSweep(REPRESENTATIVE_SAMPLE, { variant: 'sample' });
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  report(result, REPRESENTATIVE_SAMPLE.length);
}

function report(result: Awaited<ReturnType<typeof runSweep>>, requested: number): void {
  if (result.failures.length === 0) {
    console.log(`validate:meshes — ${result.built} tracks, 0 failures`);
    return;
  }
  console.log(formatFailureTable(result, requested));
  process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
