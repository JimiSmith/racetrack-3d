/**
 * Warns when any .ts or .svelte file in src/ exceeds 300 lines.
 *
 * This is a warning-only check — it exits 0 even when violations are found.
 * Some files may temporarily exceed the limit during migration.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const LINE_LIMIT = 300;
const SRC_DIR = new URL('../src', import.meta.url).pathname;

/** Recursively collect all .ts and .svelte files under a directory. */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === '.ts' || ext === '.svelte') {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').length;
}

const files = collectFiles(SRC_DIR);
const violations: { file: string; lines: number }[] = [];

for (const file of files) {
  const lines = countLines(file);
  if (lines > LINE_LIMIT) {
    violations.push({ file, lines });
  }
}

if (violations.length === 0) {
  console.log(`check:file-sizes — all files within ${LINE_LIMIT}-line limit`);
} else {
  console.warn(`\ncheck:file-sizes — ${violations.length} file(s) exceed the ${LINE_LIMIT}-line limit:\n`);
  for (const { file, lines } of violations) {
    const relative = file.replace(`${SRC_DIR}/`, 'src/');
    console.warn(`  ${lines.toString().padStart(4)} lines  ${relative}`);
  }
  console.warn(`\nConsider splitting these files along responsibility boundaries.`);
  console.warn(`See .agents/skills/architecture/SKILL.md — "No file over 300 lines."\n`);
}

// Exit 0 — warning only, not a hard block during migration
process.exit(0);
