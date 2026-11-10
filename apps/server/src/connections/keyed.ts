import { appsVersion } from './framework.ts'
import { Schema } from 'effect'

const keyedMcpVersion = '1.30.0'

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
const KeyedApp = Schema.Struct({ name: Schema.NonEmptyString, ...KeyedTransport.fields })

/** Port the proven defineProvider/secrets + mcpRouter mechanism, keeping Executor responsible
 * for credential storage and header injection. A fixed account identifier and JSON literals
 * prevent supplied names, URLs, hosts and header policies from becoming executable syntax. */
/** JSON.stringify leaves U+2028/U+2029 raw; older parsers end a line there, so escape them. */
function literal(value: string) {
  return JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

export function keyedFiles(input: typeof KeyedApp.Type) {
  const source = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
import { mcpRouter } from "apps/mcp";
const service = defineProvider({ name: ${literal(input.name)}, hosts: [${literal(input.host)}], auth: { pat: secrets({ label: "Personal access token", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user, signal, cache }) => {
if (user === undefined) return { tools: router({}) };
const [account] = user.accounts.service;
if (account === undefined) return { tools: router({}) };
return { tools: await mcpRouter({ url: ${literal(input.address.href)}, headers: { [${literal(input.header)}]: ${literal(input.prefix)} + account.fields.token }, accountId: account.id, cache: cache.forAccount(account), signal }) }; });
`
  return [
    { path: 'index.ts', content: source },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'vivid-keyed-mcp',
        private: true,
        type: 'module',
        dependencies: { apps: appsVersion, '@modelcontextprotocol/sdk': keyedMcpVersion },
      }),
    },
  ]
}
