const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const workspaceRoot = path.resolve(__dirname, '..', '..')

/**
 * Metro's default resolver takes a relative import literally, so `./identity.js` next to an
 * `identity.ts` file does not resolve and the native bundle fails at `@vivid/contracts`.
 *
 * The extension is not a mistake. `packages/agent/runtime` typechecks under `moduleResolution:
 * "NodeNext"`, where Node's ESM rules require the emitted `.js` specifier on every relative
 * import, so the shared packages must carry it. TypeScript, Vite and Node all map that specifier
 * back to the `.ts` source; Metro is the only resolver in the toolchain that does not.
 *
 * So this retries such an import against its real source file, and only for first-party code:
 * anything reached from inside `node_modules` keeps the default resolution, because a published
 * package's `.js` specifier means an actual `.js` file. Delete this once Metro resolves a `.js`
 * specifier to a TypeScript sibling on its own.
 */
const config = getDefaultConfig(__dirname)

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isRelative = moduleName.startsWith('./') || moduleName.startsWith('../')
  const origin = context.originModulePath
  if (
    isRelative &&
    moduleName.endsWith('.js') &&
    origin.startsWith(workspaceRoot) &&
    !origin.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    return context.resolveRequest(context, moduleName.slice(0, -'.js'.length), platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
