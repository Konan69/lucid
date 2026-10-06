const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { withSentryConfig } = require('@sentry/react-native/metro')

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

/**
 * Sentry's additions (`@sentry/react-native/metro`, SDK 8.29.0, checked against the installed
 * source). Its serializer stamps a debug ID into every bundle Metro writes — development, an
 * over-the-air export (`scripts/publish.mjs`) and an embedded iOS or Android build alike — and
 * writes the same ID into the map beside the bundle, which is what pairs the uploaded map with a
 * report's stack frames later (`scripts/sentry-upload.mjs`). It also collapses Sentry's own
 * frames in LogBox. Nothing here changes what the app bundles; only the output is annotated.
 *
 * This wraps the resolver fix above, so a report's frame for `packages/...` keeps naming the
 * source file the import came from.
 */
module.exports = withSentryConfig(config)