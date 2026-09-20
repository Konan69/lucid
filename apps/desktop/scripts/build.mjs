import { build } from 'esbuild'

/**
 * Bundle main and preload as CommonJS because Electron loads both directly. The preload stays one
 * file: sandboxed preloads may require Electron and selected built-ins only, so Effect and the
 * shared bridge contract must be inlined rather than resolved at runtime.
 */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'external',
  logLevel: 'info',
}

await build({
  ...shared,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.cjs',
})

await build({
  ...shared,
  entryPoints: ['src/preload/main.ts'],
  outfile: 'dist/preload/main.cjs',
})
