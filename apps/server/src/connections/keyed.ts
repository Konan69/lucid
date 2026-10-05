import { Schema } from 'effect'

/** Versions proven together on executor-selfhost:2.0.0-beta.8 in
 * artifacts/research/github-token-proof.md, Route 2. Upgrading needs another real token proof. */
export const keyedAppsVersion = '0.0.1-beta.19'
export const keyedMcpVersion = '1.30.0'

/** Public transport policy is data; secrets never enter this source-generation boundary. */
export const KeyedTransport = Schema.Struct({
  address: Schema.URLFromString,
  host: Schema.NonEmptyString,
  header: Schema.NonEmptyString,
  prefix: Schema.String,
})
export const KeyedService = Schema.Struct({
  ...KeyedTransport.fields,
  instruction: Schema.NonEmptyString,
})
export const KeyedApp = Schema.Struct({ name: Schema.NonEmptyString, ...KeyedTransport.fields })

/** Port the proven defineProvider/secrets + mcpRouter mechanism, keeping Executor responsible
 * for credential storage and header injection. A fixed account identifier and JSON literals
 * prevent supplied names, URLs, hosts and header policies from becoming executable syntax. */
export function keyedFiles(input: typeof KeyedApp.Type) {
  const source = `import { defineApp, defineProvider, secrets, object, string } from "apps";
import { mcpRouter } from "apps/mcp";
const service = defineProvider({ name: ${JSON.stringify(input.name)}, hosts: [${JSON.stringify(input.host)}], auth: { pat: secrets({ label: "Personal access token", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async ({ accounts, signal, cache }) => ({ tools: await mcpRouter({ url: ${JSON.stringify(input.address.href)}, headers: { [${JSON.stringify(input.header)}]: ${JSON.stringify(input.prefix)} + accounts.service.fields.token }, accountId: accounts.service.id, cache: cache.forAccount(accounts.service), signal }) }));
`
  return [
    { path: 'index.ts', content: source },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'vivid-keyed-mcp',
        private: true,
        type: 'module',
        dependencies: { apps: keyedAppsVersion, '@modelcontextprotocol/sdk': keyedMcpVersion },
      }),
    },
  ]
}
