import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [scratch] = process.argv.slice(2)
const require = createRequire(process.cwd() + '/package.json')
const shipped = await fs.readFile('scripts/build.mjs', 'utf8')
if (!shipped.includes('await build({'))
  throw new Error('Shipped build changed; update output override')
const source = shipped
  .replace("from 'vite'", 'from ' + JSON.stringify(pathToFileURL(require.resolve('vite')).href))
  .replace(
    'await build({',
    'await build({ configFile: ' +
      JSON.stringify(process.cwd() + '/vite.config.ts') +
      ', build: { outDir: ' +
      JSON.stringify(scratch + '/runtime') +
      ', emptyOutDir: true },',
  )
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
