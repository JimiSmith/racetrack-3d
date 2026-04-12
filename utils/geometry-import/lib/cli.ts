import type { CreateTrackGeometryOptions, FindLoopsOptions, ImportOsmDataOptions } from './types.js';

const DEFAULT_BBOX_MARGIN = 0.02;

export function parseImportOsmDataArgs(argv: string[]): ImportOsmDataOptions {
  const options: ImportOsmDataOptions = {
    tracks: null,
    force: false,
    bboxMargin: DEFAULT_BBOX_MARGIN,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printImportOsmDataHelp();
      process.exit(0);
    }

    if (arg === '--track') {
      const value = argv[i + 1] ?? '';
      options.tracks = value.split(',').map(s => s.trim()).filter(Boolean);
      if (options.tracks.length === 0) {
        console.error('Error: --track requires at least one Wikidata ID (e.g. --track Q171402)');
        process.exit(1);
      }
      i += 1;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--bbox-margin') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error('Error: --bbox-margin requires a positive number');
        process.exit(1);
      }
      options.bboxMargin = value;
      i += 1;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }

  return options;
}

function printImportOsmDataHelp(): void {
  console.log(`
Usage: import-osm-data [options]

Fetch OSM way data for racetracks and save as ways files.

Options:
  --track <ids>       Comma-separated Wikidata IDs (e.g. Q171402,Q172851)
                      If omitted, processes all tracks in the search index.
  --force             Re-fetch even if the output file already exists.
  --bbox-margin <n>   Bounding box margin in degrees (default: ${DEFAULT_BBOX_MARGIN}).
  --dry-run           Print what would be fetched without making network requests.
  -h, --help          Show this help message.
`.trim());
}

export function parseCreateTrackGeometryArgs(argv: string[]): CreateTrackGeometryOptions {
  const options: CreateTrackGeometryOptions = {
    tracks: null,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printCreateTrackGeometryHelp();
      process.exit(0);
    }

    if (arg === '--track') {
      const value = argv[i + 1] ?? '';
      options.tracks = value.split(',').map(s => s.trim()).filter(Boolean);
      if (options.tracks.length === 0) {
        console.error('Error: --track requires at least one Wikidata ID (e.g. --track Q172851)');
        process.exit(1);
      }
      i += 1;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }

  return options;
}

function printCreateTrackGeometryHelp(): void {
  console.log(`
Usage: create-track-geometry [options]

Generate runtime geometry from layout files and ways files.

Options:
  --track <ids>       Comma-separated Wikidata IDs (e.g. Q171402,Q172851)
                      If omitted, processes all layout files found.
  --force             Overwrite existing output files.
  --dry-run           Print what would be generated without writing files.
  -h, --help          Show this help message.
`.trim());
}

const DEFAULT_MAX_DEPTH = 1000;
const DEFAULT_MIN_LENGTH = 200;
const DEFAULT_MAX_LENGTH = 30_000;
const DEFAULT_MAX_LOOPS = 1000;

export function parseFindLoopsArgs(argv: string[]): FindLoopsOptions {
  const options: FindLoopsOptions = {
    tracks: null,
    maxDepth: DEFAULT_MAX_DEPTH,
    minLength: DEFAULT_MIN_LENGTH,
    maxLength: DEFAULT_MAX_LENGTH,
    maxLoops: DEFAULT_MAX_LOOPS,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printFindLoopsHelp();
      process.exit(0);
    }

    if (arg === '--track') {
      const value = argv[i + 1] ?? '';
      options.tracks = value.split(',').map(s => s.trim()).filter(Boolean);
      if (options.tracks.length === 0) {
        console.error('Error: --track requires at least one Wikidata ID (e.g. --track Q172851)');
        process.exit(1);
      }
      i += 1;
      continue;
    }

    if (arg === '--max-depth') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        console.error('Error: --max-depth requires a positive integer');
        process.exit(1);
      }
      options.maxDepth = value;
      i += 1;
      continue;
    }

    if (arg === '--min-length') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        console.error('Error: --min-length requires a non-negative number');
        process.exit(1);
      }
      options.minLength = value;
      i += 1;
      continue;
    }

    if (arg === '--max-length') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error('Error: --max-length requires a positive number');
        process.exit(1);
      }
      options.maxLength = value;
      i += 1;
      continue;
    }

    if (arg === '--max-loops') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        console.error('Error: --max-loops requires a positive integer');
        process.exit(1);
      }
      options.maxLoops = value;
      i += 1;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
  }

  return options;
}

function printFindLoopsHelp(): void {
  console.log(`
Usage: find-loops [options]

Find all closed loops in OSM way data.

Options:
  --track <ids>       Comma-separated Wikidata IDs (e.g. Q171402,Q172851)
                      If omitted, processes all ways files found.
  --max-depth <n>     Maximum DFS traversal depth in segments (default: ${DEFAULT_MAX_DEPTH}).
  --min-length <m>    Minimum loop length in metres (default: ${DEFAULT_MIN_LENGTH}).
  --max-length <m>    Maximum loop length in metres (default: ${DEFAULT_MAX_LENGTH}).
  --max-loops <n>     Maximum number of loops to emit (default: ${DEFAULT_MAX_LOOPS}).
  --force             Overwrite existing loops file.
  --dry-run           Print stats without writing files.
  -h, --help          Show this help message.
`.trim());
}
