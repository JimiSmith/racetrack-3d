/**
 * Vite-only shim that holds the SINGLE `?url` import of the manifold WASM binary.
 *
 * Node (tsx tests / scripts) NEVER imports this file — `base-plate-csg.ts`
 * resolves the wasm via `import.meta.resolve('manifold-3d/manifold.wasm')` under
 * node instead (see `resolveWasmUrl`). Keeping the `?url` specifier isolated here
 * means esbuild/tsx never evaluates it, so the node test suite loads cleanly.
 *
 * Vite statically analyses the `?url` import, emits `manifold.wasm` as a hashed,
 * base-prefixed asset, and rewrites this to the served URL.
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';

export const MANIFOLD_WASM_URL: string = wasmUrl;
