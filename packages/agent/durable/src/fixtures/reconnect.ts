import { FixtureFailed } from './harness.ts'
import { runForPi } from '../pi.ts'
// Disposable HTTP child for conformance/crashing.test.ts; no shared data or live model provider.
import * as NodeEvents from 'node:events'
import * as NodeHttp from 'node:http'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry, type Conversation } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Effect, Predicate, Stream, type Scope } from 'effect'
import { respond, history } from '../main.ts'
import { streamingProvider, waitForFrame } from './provider.ts'

const context = BACKGROUND_CONTEXT
export const recoveredReply =
  'The whole regenerated reply replaces the interrupted attempt exactly once.'

/** Real TCP ingress reads bytes and delegates to the public Promise API, including bodyless GET. */
const route = Effect.fn('Test.route')(function* (
  harness: Harness,
  root: Conversation,
  incoming: NodeHttp.IncomingMessage,
  outgoing: NodeHttp.ServerResponse,
) {
  incoming.setEncoding('utf8')
  const parts: string[] = []
  incoming.on('data', (part: string) => parts.push(part))
  yield* Effect.tryPromise({
    try: () => NodeEvents.EventEmitter.once(incoming, 'end'),
    catch: (cause) => new FixtureFailed({ cause }),
  })
  if (incoming.url === undefined || incoming.method === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected HTTP ingress') })
  const url = new URL(incoming.url, 'http://durable.test')
  const response = url.pathname.endsWith('/history')
    ? Response.json(
        yield* Effect.tryPromise({
          try: () => history(harness, root.id, { limit: 10 }, context),
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      )
    : yield* Effect.tryPromise({
        try: () =>
          respond(
            harness,
            root.id,
            new Request(
              url,
              incoming.method === 'GET'
                ? { method: 'GET' }
                : { method: incoming.method, body: parts.join('') },
            ),
            context,
          ),
        catch: (cause) => new FixtureFailed({ cause }),
      })
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body !== null) {
    const body = response.body
    yield* Stream.runForEach(
      Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) => new FixtureFailed({ cause }),
      }),
      (chunk) =>
        outgoing.write(chunk)
          ? Effect.void
          : Effect.asVoid(
              Effect.tryPromise({
                try: () => NodeEvents.EventEmitter.once(outgoing, 'drain'),
                catch: (cause) => new FixtureFailed({ cause }),
              }),
            ),
    )
  }
  outgoing.end()
  return undefined
})

export type Listening = { readonly server: NodeHttp.Server; readonly address: string }

/** Node owns this callback's Promise; failure destroys only the response belonging to this request. */
function serverFor(harness: Harness, root: Conversation) {
  return NodeHttp.createServer((incoming, outgoing) => {
    void runForPi(route(harness, root, incoming, outgoing), undefined).catch((error: Error) =>
      outgoing.destroy(error),
    )
  })
}

/** The public listen receipt owns an ephemeral test port; callers register close before sending. */
export const listen = Effect.fn('Test.listen')(function* (
  harness: Harness,
  root: Conversation,
): Effect.fn.Return<Listening, FixtureFailed, Scope.Scope> {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => serverFor(harness, root)),
    (value) => Effect.promise(() => runForPi(close(value), undefined)),
  )
  const bound = NodeEvents.EventEmitter.once(server, 'listening')
  server.listen(0, '127.0.0.1')
  yield* Effect.tryPromise({ try: () => bound, catch: (cause) => new FixtureFailed({ cause }) })
  const address = server.address()
  if (address === null || Predicate.isString(address))
    return yield* new FixtureFailed({ cause: new Error('Expected ephemeral TCP address') })
  return { server, address: `http://127.0.0.1:${address.port}` }
})

/** Manual close and scoped release share one operation; an already closed listener needs no second receipt. */
export const close = Effect.fn('Test.closeListener')(function* (server: NodeHttp.Server) {
  if (!server.listening) return
  const closed = NodeEvents.EventEmitter.once(server, 'close')
  server.close()
  yield* Effect.tryPromise({ try: () => closed, catch: (cause) => new FixtureFailed({ cause }) })
})

/** Gate the first provider text frame on IPC, so SIGKILL timing never depends on a token rate. */
const main = Effect.fn('Test.main')(function* () {
  const [, , file] = process.argv
  if (file === undefined)
    return yield* new FixtureFailed({ cause: new Error('Expected disposable SQLite path') })
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
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(file),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 0 } } },
          context,
        ),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  const bound = yield* listen(harness, root)
  process.stdout.write(bound.address + '\n')
  return yield* Effect.never
})
const executable = process.argv[1]
if (executable !== undefined && import.meta.url === NodeURL.pathToFileURL(executable).href)
  await runForPi(Effect.scoped(main()), undefined)
