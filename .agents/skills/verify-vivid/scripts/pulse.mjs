import * as NodeHttp from 'node:http'
import { Ready } from './receipts.mjs'

/** A real catalogue source installs a fresh public Integration through Executor's normal copy path.
 * The event mutation is invoked outside Vivid. Its receipt is also Executor's deduplication id.
 * Source follows executor@2.0.0-beta.23's app-authoring/events.md and exact apps framework pin. */
export const files = [
  {
    path: 'package.json',
    content: JSON.stringify({ name: '@verify/pulse', dependencies: { apps: '0.0.1-beta.92' } }),
  },
  {
    path: 'index.ts',
    content: `import { defineApp, defineProvider, event, mutation, object, router, secrets, string } from "apps";
const pulse = defineProvider({ name: "Verify Pulse", auth: { key: secrets({ label: "Verification code", fields: object({ code: string() }) }) } });
const requirements = { user: { accounts: { pulse } }, events: { "pulse.received": event({ description: "A verification pulse arrived.", payload: object({ receipt: string(), words: string() }) }) } };
const emit = mutation({ description: "Produce a verification pulse.", input: object({ receipt: string(), words: string() }) }, async (ctx, input) => {
  ctx.events.emit("pulse.received", input, { id: input.receipt });
  return { receipt: input.receipt };
});
export default defineApp(requirements, { tools: router({ emit }) });`,
  },
]

/** Serve only the two published feed documents. No product endpoint or source is replaced. */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = NodeHttp.createServer((request, response) => {
    const documents = {
      '/index.json': {
        version: 1,
        apps: [
          {
            id: 'verify-pulse',
            package: '@verify/pulse',
            name: 'Verify Pulse',
            description: 'Disposable event source for the Watch journey.',
            auth: [{ method: 'key', kind: 'secrets', label: 'Verification code' }],
            icons: [],
            source: 'apps/verify-pulse.json',
          },
        ],
      },
      '/apps/verify-pulse.json': { package: '@verify/pulse', files },
    }
    const document = documents[request.url]
    response.writeHead(document ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(document ?? { error: 'Not found' }))
  })
  server.listen(Number(process.argv[2]), '127.0.0.1', () => process.send(Ready.make({})))
  process.on('SIGTERM', () => server.close())
}
