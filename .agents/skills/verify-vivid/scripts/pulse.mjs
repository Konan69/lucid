import * as NodeHttp from 'node:http'
import { Ready } from './receipts.mjs'
import { worldApps } from './world.mjs'

/** A real catalogue source installs a fresh public Integration through Executor's normal copy path.
 * The event mutation is invoked outside Vivid. Its receipt is also Executor's deduplication id.
 * Source follows executor@2.0.0-beta.23's app-authoring/events.md and exact apps framework pin.
 * `approve` and `file` pause their call in Executor itself (`approval: always()`, then `ctx.elicit`
 * for `file`), the shapes `apps/server/src/connections/asks.live.test.ts` proves, so the asks
 * journey sees an Integration's own Approval and its mid-call form. Each emits one pulse once it
 * runs, carrying the Person's answer, which is the provider-side evidence of what was sent. */
export const files = [
  {
    path: 'package.json',
    content: JSON.stringify({ name: '@verify/pulse', dependencies: { apps: '0.0.1-beta.92' } }),
  },
  {
    path: 'index.ts',
    content: `import { defineApp, defineProvider, event, mutation, object, query, router, secrets, string } from "apps";
import { always } from "apps/operations/approval";
const pulse = defineProvider({ name: "Verify Pulse", auth: { key: secrets({ label: "Verification code", fields: object({ code: string() }) }) } });
const requirements = { user: { accounts: { pulse } }, events: { "pulse.received": event({ description: "A verification pulse arrived.", payload: object({ receipt: string(), words: string() }) }) } };
const emit = mutation({ description: "Produce a verification pulse.", input: object({ receipt: string(), words: string() }) }, async (ctx, input) => {
  ctx.events.emit("pulse.received", input, { id: input.receipt });
  return { receipt: input.receipt };
});
const read = query({ description: "Read forty disposable sample records for coverage verification.", input: object({}) }, async () => ({ records: Array.from({ length: 40 }, (_, index) => ({ index, text: "sample" })) }));
const approve = mutation({ title: "Send a verification pulse", description: "Send one verification pulse after Executor asks the Person first.", input: object({ receipt: string() }), approval: always() }, async (ctx, input) => {
  ctx.events.emit("pulse.received", { receipt: input.receipt, words: "approved" }, { id: input.receipt });
  return { receipt: input.receipt };
});
const file = mutation({ title: "File a verification issue", description: "File one verification issue after asking the Person for its details.", input: object({ receipt: string() }), approval: always() }, async (ctx, input) => {
  const answer = await ctx.elicit({ mode: "form", message: "Which priority should the issue have?", requestedSchema: { type: "object", properties: {
    priority: { type: "string", title: "Priority", oneOf: [{ const: "low", title: "Low" }, { const: "medium", title: "Medium" }, { const: "high", title: "High" }], default: "medium" },
    summary: { type: "string", title: "Summary", default: "Phone form bug" },
    labels: { type: "array", title: "Labels", items: { type: "string", enum: ["bug", "phone", "web"] } },
    urgent: { type: "boolean", title: "Urgent" },
    estimate: { type: "integer", title: "Estimate", description: "Hours, from 1 to 8", minimum: 1, maximum: 8 },
    assignee: { type: "string", title: "Assignee", description: "GitHub username", maxLength: 39 },
  }, required: ["priority", "summary", "labels", "urgent"] } });
  ctx.events.emit("pulse.received", { receipt: input.receipt, words: JSON.stringify(answer) }, { id: input.receipt });
  return answer;
});
export default defineApp(requirements, { tools: router({ emit, read, approve, file }) });`,
  },
]

/** Generate the private app sources once, before serving the supported catalogue documents. */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const world = await worldApps(process.env.VIVID_VERIFY_WORLD)
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
          ...world.map((app) => app.entry),
        ],
      },
      '/apps/verify-pulse.json': { package: '@verify/pulse', files },
      ...Object.fromEntries(world.map((app) => ['/' + app.entry.source, app.document])),
    }
    const document = documents[request.url]
    response.writeHead(document ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(document ?? { error: 'Not found' }))
  })
  server.listen(Number(process.argv[2]), '127.0.0.1', () => process.send(Ready.make({})))
  process.on('SIGTERM', () => server.close())
}
