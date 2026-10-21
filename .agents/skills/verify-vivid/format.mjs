import * as NodeFS from 'node:fs'

/** Keep the repository's formatting authority; only its blanket owner-skill exclusion is removed
 * for this explicitly requested narrow check. Dependencies and generated output stay excluded. */
const config = JSON.parse(
  NodeFS.readFileSync(new URL('../../../.oxfmtrc.json', import.meta.url), 'utf8'),
)
export default {
  ...config,
  ignorePatterns: config.ignorePatterns.filter((pattern) => pattern !== '.agents/**'),
}
