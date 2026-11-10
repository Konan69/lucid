import { createRequire, register } from 'node:module'
import * as NodeURL from 'node:url'

/**
 * The loader every verify-vivid script runs under: the server's own tsx, then one resolve hook.
 * The scripts import `@vivid/contracts` and `@earendil-works/chord` by name, but they live in no
 * workspace package and pnpm 12 hoists neither to the repository root, so those names are
 * resolved as `packages/client/state` resolves them; that package depends on both (`resolve.mjs`).
 */
const root = new URL('../../../../', import.meta.url)
await import(
  NodeURL.pathToFileURL(createRequire(new URL('apps/server/package.json', root)).resolve('tsx'))
    .href
)
register('./resolve.mjs', import.meta.url, {
  data: { parent: new URL('packages/client/state/package.json', root).href },
})
