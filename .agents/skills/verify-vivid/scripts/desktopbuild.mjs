import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import * as NodeURL from 'node:url'
import { root, command, json } from './process.mjs'

/** Run the shipped bundler with scratch outputs, retaining its entry points and bundling rules.
 * Linux cannot use the Windows Computer binaries; that release fetch is outside this proof. */
export async function buildDesktop(state) {
  const app = state.scratch + '/desktop/apps/desktop'
  await NodeFSP.mkdir(app, { recursive: true })
  await NodeFSP.symlink(root + '/packages', state.scratch + '/desktop/packages')
  const shipped = await NodeFSP.readFile(root + '/apps/desktop/scripts/build.mjs', 'utf8')
  for (const marker of ["from 'esbuild'", 'const desktopDirectory =', "'dist/main/main.cjs'"])
    if (!shipped.includes(marker)) throw new Error('Desktop bundler changed: ' + marker)
  const require = NodeModule.createRequire(root + '/apps/desktop/package.json')
  const source = shipped
    .replace(
      "from 'esbuild'",
      'from ' + JSON.stringify(NodeURL.pathToFileURL(require.resolve('esbuild')).href),
    )
    .replace(
      /const desktopDirectory = .*\n/u,
      'const desktopDirectory = ' + JSON.stringify(root + '/apps/desktop') + '\n',
    )
    .replace(
      /const rendererDirectory = .*\n/u,
      'const rendererDirectory = ' + JSON.stringify(state.scratch + '/web-dist') + '\n',
    )
    .replaceAll("'dist/", "'" + app + '/dist/')
  const script = state.scratch + '/desktopbuild.mjs'
  await NodeFSP.writeFile(script, source)
  await command([process.execPath, script], {
    cwd: root + '/apps/desktop',
    env: { PATH: process.env.PATH, HOME: state.scratch, VIVID_COMMIT: state.head },
    log: state.evidence + '/desktop-build.json',
  })
  await NodeFSP.copyFile(root + '/apps/desktop/package.json', app + '/package.json')
  await json(state.evidence + '/desktop-build-scope.json', {
    shipped: 'apps/desktop/scripts/build.mjs',
    overrides: ['output directories', 'renderer from this run', 'esbuild resolution'],
    omitted: 'Windows-only vendor/computer/fetch.sh; Linux apps ability is false',
    app,
  })
  return { app, electron: require('electron') }
}
