/**
 * Registration script for the ts-resolver loader hook.
 * Loaded via `--import` so the hook is active for all subsequently
 * loaded modules, including the test files and their imports.
 *
 * Usage: node --import ./scripts/ts-resolver-register.mjs --test
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolver.mjs', pathToFileURL('./scripts/'));
