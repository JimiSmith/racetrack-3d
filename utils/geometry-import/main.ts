import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const command = process.argv[2];
  const commandArgs = process.argv.slice(3);

  switch (command) {
    case 'import-osm-data': {
      const { run } = await import('./commands/import-osm-data.js');
      await run(commandArgs);
      break;
    }

    case 'create-track-geometry': {
      const { run } = await import('./commands/create-track-geometry.js');
      await run(commandArgs);
      break;
    }

    default:
      printUsage();
      process.exitCode = command == null || command === '--help' || command === '-h' ? 0 : 1;
  }
}

function printUsage(): void {
  console.log(`
Usage: geometry-import <command> [options]

Commands:
  import-osm-data         Fetch OSM way data for racetracks
  create-track-geometry   Generate runtime geometry from layout files

Run <command> --help for command-specific options.
`.trim());
}
