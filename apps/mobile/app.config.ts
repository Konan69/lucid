import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * Adds the one value a build is given from outside: where its Vivid is. `app.json` stays the
 * whole static config; this file only lays the address over it from `VIVID_SERVER` in the
 * environment of whoever runs the build, so no address is ever committed. The app decodes
 * `extra.server` in `src/data/origin.ts`. With the variable unset, `extra.server` is absent and
 * the app says so.
 *
 * The same address is where the build asks for newer JavaScript (`updates.url`, answered by
 * `apps/server/src/updates`), so a build with no address also has updates off: there is nobody to
 * ask. The path is added to the address as given, so a Vivid mounted under a path keeps it, as
 * the app's own reading of the address does (`src/data/server.ts`). `new URL` throws on an address
 * that does not parse, which fails the build instead of shipping a binary that can never update.
 *
 * `checkAutomatically: 'ON_LOAD'` with `fallbackToCacheTimeout: 0` is the launch behavior of the
 * reference this was ported from (`apps/mobile/app.config.ts` in the T3 Code fork): start at once
 * on the newest bundle already on the phone and fetch a newer one in the background, never hold
 * the first frame on the network.
 */
export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const server = process.env['VIVID_SERVER']
  if (server === undefined || server === '') return { ...config, updates: { enabled: false } }
  return {
    ...config,
    extra: { ...config.extra, server },
    updates: {
      enabled: true,
      url: new URL(`${server.replace(/\/+$/u, '')}/api/updates/manifest`).toString(),
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
  }
}
