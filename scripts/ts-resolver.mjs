/**
 * Node.js ESM loader hook that resolves `.js` imports to `.ts` files when
 * the corresponding TypeScript source exists. This allows `.js` files to
 * import from TypeScript modules using the `.js` extension (as required by
 * the TypeScript `verbatimModuleSyntax` / bundler module resolution), while
 * still running in Node's native test runner without a build step.
 *
 * Only redirects when a `.ts` file exists at the mapped path and the
 * corresponding `.js` file does not — so compiled output takes precedence.
 *
 * Usage (loaded via --import in package.json "test" script):
 *   node --import ./scripts/ts-resolver-register.mjs --test
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  // Only handle relative specifiers ending in .js
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const parentURL = context.parentURL;
    if (parentURL) {
      const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
      const tsPath = fileURLToPath(new URL(tsSpecifier, parentURL));
      const jsPath = fileURLToPath(new URL(specifier, parentURL));

      if (existsSync(tsPath) && !existsSync(jsPath)) {
        return nextResolve(tsSpecifier, context);
      }
    }
  }

  return nextResolve(specifier, context);
}
