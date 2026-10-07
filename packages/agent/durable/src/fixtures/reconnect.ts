// Disposable HTTP child for conformance/crashing.test.ts; no shared data or live model provider.
import * as NodeEvents from 'node:events'
import * as NodeHttp from 'node:http'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry, type Conversation } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Effect, Predicate } from 'effect'
import { respond, history } from '../main.ts'
import { streamingProvider, waitForFrame } from './provider.ts'

const context = BACKGROUND_CONTEXT
export const recoveredReply =
  'The whole regenerated reply replaces the interrupted attempt exactly once.'

/** Real TCP ingress reads bytes and delegates to the public Promise API, including bodyless GET. */
async function route(
  harness: Harness,
  root: Conversation,
  incoming: NodeHttp.IncomingMessage,
  outgoing: NodeHttp.ServerResponse,
) {
  incoming.setEncoding('utf8')
  const parts: string[] = []
  incoming.on('data', (part: string) => parts.push(part))
  await NodeEvents.EventEmitter.once(incoming, 'end')
  if (incoming.url === undefined || incoming.method === undefined)
    throw new Error('Expected HTTP ingress')
  const url = new URL(incoming.url, 'http://durable.test')
  const response = url.pathname.endsWith('/history')
    ? Response.json(await history(harness, root.id, { limit: 10 }, context))
    : await respond(
        harness,
        root.id,
        new Request(
          url,
          incoming.method === 'GET'
            ? { method: 'GET' }
            : { method: incoming.method, body: parts.join('') },
        ),
        context,
      )
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body !== null)
    for await (const chunk of response.body) {
      if (!outgoing.write(chunk)) await NodeEvents.EventEmitter.once(outgoing, 'drain')
    }
  outgoing.end()
}

/** The public listen receipt owns an ephemeral test port; callers register close before sending. */
export async function listen(
  harness: Harness,
  root: Conversation,
): Promise<{ readonly server: NodeHttp.Server; readonly address: string }> {
  const server = NodeHttp.createServer((incoming, outgoing) => {
    void route(harness, root, incoming, outgoing).catch((error: Error) => outgoing.destroy(error))
  })
  const bound = NodeEvents.EventEmitter.once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await bound
  const address = server.address()
  if (address === null || Predicate.isString(address))
    throw new Error('Expected ephemeral TCP address')
  return { server, address: `http://127.0.0.1:${address.port}` }
}

/** Await exactly this captured server's close, with no port discovery or process-name matching. */
export async function close(server: NodeHttp.Server): Promise<void> {
  const closed = NodeEvents.EventEmitter.once(server, 'close')
  server.close()
  await closed
}

/** Gate the first provider text frame on IPC, so SIGKILL timing never depends on a token rate. */
async function main() {
  const [, , file] = process.argv
  if (file === undefined) throw new Error('Expected disposable SQLite path')
  let gated = false
  const provider = streamingProvider({
    partialFamily: 'parsed',
    // Unlimited faux emits a whole text delta. This owned provider publishes its first eight
    // characters and waits, giving the harness a genuine committed partial with no token clock.
    rewriteFrame: (event) =>
      event.type !== 'text_delta'
        ? event
        : {
            ...event,
            delta: event.delta.slice(0, 8),
            partial: {
              ...event.partial,
              content: event.partial.content.map((block) =>
                block.type === 'text' ? { ...block, text: block.text.slice(0, 8) } : block,
              ),
            },
          },
    onFrame: (event, signal) => {
      if (event.type !== 'text_delta' || gated) return Effect.void
      gated = true
      return waitForFrame(
        Effect.promise(() => NodeEvents.EventEmitter.once(process, 'message').then(() => {})),
        signal,
      )
    },
  })
  provider.setResponses([fauxAssistantMessage(recoveredReply)])
  const models = createModels()
  models.setProvider(provider.provider)
  const harness = await Harness.open(
    await openNodeSqliteStorage(file),
    { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 0 } } },
    context,
  )
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  const bound = await listen(harness, root)
  process.stdout.write(bound.address + '\n')
}
const executable = process.argv[1]
if (executable !== undefined && import.meta.url === NodeURL.pathToFileURL(executable).href)
  await main()
