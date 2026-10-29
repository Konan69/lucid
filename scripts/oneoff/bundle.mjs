import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

/** Use the cells package's pinned builder; the artifact runs in Node 24 without the one-off tree. */
const root = NodeURL.fileURLToPath(new URL('../../', import.meta.url))
const require = NodeModule.createRequire(new URL('../../apps/cells/package.json', import.meta.url))
const esbuild = require('esbuild')
const output = process.argv[2]
if (output === undefined) throw new Error('Usage: node scripts/oneoff/bundle.mjs <reader.cjs>')
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['scripts/oneoff/main.ts'],
  outfile: NodePath.resolve(output),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['pg-native'],
  logLevel: 'info',
})
