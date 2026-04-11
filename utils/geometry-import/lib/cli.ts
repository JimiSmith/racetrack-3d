import type { ImportOsmDataOptions } from './types.js';

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
