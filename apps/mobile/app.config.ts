import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * Adds the one value a build is given from outside: where its Vivid is. `app.json` stays the
 * whole static config; this file only lays `extra.server` over it from `VIVID_SERVER` in the
 * environment of whoever runs the build, so no address is ever committed. The app decodes it in
 * `src/data/origin.ts`. With the variable unset, `extra.server` is absent and the app says so.
 */
export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const server = process.env['VIVID_SERVER']
  if (server === undefined || server === '') return config
  return { ...config, extra: { ...config.extra, server } }
}
