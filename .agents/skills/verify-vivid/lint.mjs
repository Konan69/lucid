import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'

/** Inherit the repository rules without its blanket owner-skill exclusion. Relative custom
 * plugin specifiers still resolve against the repository configuration, never this skill. */
const authority = new URL('../../../.oxlintrc.json', import.meta.url)
const config = JSON.parse(NodeFS.readFileSync(authority, 'utf8'))
export default {
  ...config,
  ignorePatterns: config.ignorePatterns.filter((pattern) => pattern !== '.agents/**'),
  jsPlugins: config.jsPlugins.map((plugin) =>
    typeof plugin === 'string'
      ? plugin
      : {
          ...plugin,
          specifier: NodeURL.fileURLToPath(new URL(plugin.specifier, authority)),
        },
  ),
}
