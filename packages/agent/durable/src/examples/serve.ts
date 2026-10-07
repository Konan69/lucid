import * as NodeFSP from 'node:fs/promises'
import * as NodeHttp from 'node:http'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeSqlite from 'node:sqlite'
import * as NodeStream from 'node:stream'
import * as NodeURL from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message, TranscriptContext } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  ConversationMissing,
  TurnInvalid,
  TurnRegenerate,
  decodeTurn,
  toolsExtension,
} from '@vivid/durable'
import { tool } from 'ai'
import {
  Config,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import { z } from 'zod'

import { route, runForNode } from './main.ts'

const context = BACKGROUND_CONTEXT
const maximumBody = 5 * 1024 * 1024
const ChatId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^(?!\.{1,2}$)/u),
)
const ChatEnvelope = Schema.Struct({ id: ChatId })
const decodeJson = Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.MutableJson))
const ChatPath = Schema.Struct({
  id: Schema.StringFromUriComponent.pipe(Schema.decodeTo(ChatId)),
  action: Schema.Literals(['stream', 'history', 'waiting', 'abort', 'decide', 'answer']),
})
const Mapping = Schema.Struct({ conversation_id: ConversationMissing.fields.conversationId })
const StartOptions = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })),
  dataDirectory: Schema.String.check(Schema.isMinLength(1)),
})
export type StartOptions = typeof StartOptions.Type

const decodeMapping = Schema.decodeUnknownEffect(Mapping)
const decodeEnvelope = Schema.decodeUnknownEffect(ChatEnvelope)
const decodePath = Schema.decodeUnknownEffect(ChatPath)
const decodeStart = Schema.decodeUnknownEffect(StartOptions)
const decodeLength = Schema.decodeUnknownSync(Schema.FiniteFromString)
const decodeIngress = Schema.decodeUnknownEffect(
  Schema.Struct({ method: Schema.String, url: Schema.String }),
)
const decodeAddress = Schema.decodeUnknownResult(
  Schema.Struct({
    address: Schema.String,
    family: Schema.Literals(['IPv4', 'IPv6']),
    port: Schema.Finite,
  }),
)

/** Failures at Node/Pi resource adapters retain their operation and original diagnostic. */
class ExampleIO extends Schema.TaggedError<ExampleIO>()(
  'ExampleIO',
  {
    operation: Schema.Literals([
      'directory',
      'mapping',
      'storage',
      'harness',
      'registry',
      'conversation',
      'listen',
    ]),
    cause: Schema.Defect(),
  },
  { title: 'ExampleIO' },
) {}

/** The raw byte limit is separate from the bridge's decoded attachment limit. */
class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()(
  'BodyTooLarge',
  {},
  { title: 'BodyTooLarge' },
) {}

/** A broken request stream is an ingress failure, never a fabricated empty chat input. */
class BodyUnreadable extends Schema.TaggedError<BodyUnreadable>()(
  'BodyUnreadable',
  {
    cause: Schema.Defect(),
  },
  { title: 'BodyUnreadable' },
) {}

/** An SDK identity may only acquire a Pi conversation through POST /chat. */
class ChatMissing extends Schema.TaggedError<ChatMissing>()(
  'ChatMissing',
  { id: ChatId },
  { title: 'ChatMissing' },
) {}

/** Keep transcript text extraction identical for string and multimodal user messages. */
function messageText(message: Message) {
  return Predicate.isString(message.content)
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** Deterministic faux policy uses the newest user, and concludes a completed tool round once. */
function reply(transcript: TranscriptContext) {
  const latest = transcript.messages.at(-1)
  if (latest !== undefined && latest.role === 'toolResult') {
    const text = Match.value(latest.toolName).pipe(
      Match.when(
        'work',
        () =>
          'The second step arrives a little at a time. Its final sentence confirms that reconnect preserved the first step exactly once.',
      ),
      Match.when('pay', () =>
        latest.isError ? `Payment was not made: ${messageText(latest)}` : 'Payment confirmed.',
      ),
      Match.orElse(() => `Answer received: ${messageText(latest)}`),
    )
    return fauxAssistantMessage(text)
  }
  const user = transcript.messages.findLast((message) => message.role === 'user')
  if (user === undefined) throw new Error('A chat turn must have a user message')
  const text = messageText(user)
  const id = `example-${user.timestamp}`
  if (text.toLowerCase() === 'slow steps')
    return fauxAssistantMessage(
      [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id })],
      { stopReason: 'toolUse' },
    )
  if (text.toLowerCase().includes('approve'))
    return fauxAssistantMessage([fauxToolCall('pay', { amount: 100 }, { id })], {
      stopReason: 'toolUse',
    })
  if (text.toLowerCase().includes('ask'))
    return fauxAssistantMessage(
      [fauxToolCall('ask', { question: 'Which account should we use?' }, { id })],
      {
        stopReason: 'toolUse',
      },
    )
  if (text.toLowerCase().includes('slow'))
    return fauxAssistantMessage(
      'This reply arrives a little at a time. You can disconnect while these sentences are streaming. Reconnect to the same chat and the durable turn will continue. The final sentence confirms that the whole reply arrived.',
    )
  return fauxAssistantMessage(`Echo: ${text}`)
}

/** Replenish the public faux response queue, without replacing or patching the provider. */
function models() {
  const faux = fauxProvider({ tokensPerSecond: 32, tokenSize: { min: 4, max: 4 } })
  const next = (transcript: TranscriptContext) => {
    faux.appendResponses([next])
    return reply(transcript)
  }
  faux.setResponses([next])
  const collection = createModels()
  collection.setProvider(faux.provider)
  return collection
}

/** Register the same minimal pay/ask setup as the conformance host, using only public APIs. */
const registry = Effect.fn('Example.registry')(function* () {
  const result = createRegistry()
  const extension = yield* Effect.tryPromise({
    try: () =>
      toolsExtension(
        'example',
        {
          pay: tool({
            description: 'Pay an invoice after approval',
            inputSchema: z.object({ amount: z.number() }),
            execute: ({ amount }) => Promise.resolve({ receipt: amount }),
          }),
          work: tool({
            description: 'Prepare a response with a second step',
            inputSchema: z.object({}),
            execute: function prepareForSdk() {
              return Promise.resolve('Prepared.')
            },
          }),
          ask: tool({
            description: 'Ask a person which account to use',
            inputSchema: z.object({ question: z.string() }),
          }),
        },
        { approval: { pay: true } },
      ),
    catch: (cause) => new ExampleIO({ operation: 'registry', cause }),
  })
  result.install(extension)
  return result
})

/** Register close before creating the mapping table; this database contains no Pi-owned state. */
const mapping = Effect.fn('Example.mapping')(function* (directory: string) {
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(NodePath.join(directory, 'chats.sqlite')),
      catch: (cause) => new ExampleIO({ operation: 'mapping', cause }),
    }),
    (opened) => Effect.sync(() => opened.close()),
  )
  yield* Effect.try({
    try: () =>
      database.exec(
        'CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL UNIQUE)',
      ),
    catch: (cause) => new ExampleIO({ operation: 'mapping', cause }),
  })
  return database
})

type Host = {
  readonly harness: Harness
  readonly database: NodeSqlite.DatabaseSync
  readonly gate: Semaphore.Semaphore
}

/** Read every request from SQLite. Create independent chats: Harness.root is one reserved singleton. */
const conversation = Effect.fn('Example.conversation')(function* (
  host: Host,
  id: string,
  create: boolean,
) {
  return yield* host.gate.withPermit(
    Effect.gen(function* () {
      const row = yield* Effect.try({
        try: () =>
          host.database.prepare('SELECT conversation_id FROM chats WHERE chat_id = ?').get(id),
        catch: (cause) => new ExampleIO({ operation: 'mapping', cause }),
      })
      if (row !== undefined) return (yield* decodeMapping(row)).conversation_id
      if (!create) return yield* new ChatMissing({ id })
      const created = yield* Effect.tryPromise({
        try: () =>
          host.harness.createConversation(
            {
              ownership: { kind: 'ownerless' },
              agent: { model: { provider: 'faux', modelId: 'faux-1' } },
            },
            context,
          ),
        catch: (cause) => new ExampleIO({ operation: 'conversation', cause }),
      })
      yield* Effect.try({
        try: () =>
          host.database
            .prepare('INSERT INTO chats (chat_id, conversation_id) VALUES (?, ?)')
            .run(id, created.id),
        catch: (cause) => new ExampleIO({ operation: 'mapping', cause }),
      })
      return created.id
    }),
  )
})

/** Node's framework body reader bounds accumulated bytes before buffering or decoding JSON. */
function readBody(request: NodeHttp.IncomingMessage): Promise<string> {
  const length = request.headers['content-length']
  if (length !== undefined && decodeLength(length) > maximumBody) {
    request.resume()
    return Promise.reject(new BodyTooLarge({}))
  }
  let size = 0
  const chunks: Buffer[] = []
  const reader = request.iterator({ destroyOnReturn: false })
  /** Await one framework chunk at a time. Returning early preserves the previous
   * iterator close rule without destroying the host's incoming socket. */
  function next(): Promise<string> {
    return reader.next().then((item) => {
      if (item.done) return Buffer.concat(chunks).toString('utf8')
      const chunk = item.value
      if (!Buffer.isBuffer(chunk))
        return finish(new BodyUnreadable({ cause: 'Expected a byte stream' }))
      size += chunk.byteLength
      if (size > maximumBody) {
        request.resume()
        return finish(new BodyTooLarge({}))
      }
      chunks.push(chunk)
      return next()
    })
  }
  /** AsyncIteratorClose on a thrown body failure keeps that original failure.
   * AsyncIterator.return is optional; call it with its receiver when present. */
  function finish(error: BodyTooLarge | BodyUnreadable): Promise<never> {
    if (reader.return === undefined) return Promise.reject(error)
    return reader
      .return()
      .catch(() => {})
      .then(() => {
        throw error
      })
  }
  return next()
}

/** Node's Promise HTTP ingress calls the one imported Promise entry directly,
 * as reviewed in a020c7be. Wrapping route rejection in Effect.promise would turn
 * an expected transport failure into a defect. Resource mapping remains Effect. */
function requestRoute(host: Host, request: Request, body: string): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/chat') {
    if (request.method !== 'POST')
      return Promise.resolve(new Response(null, { status: 405, headers: { Allow: 'POST' } }))
    // Public turn validation must settle before conversation or mapping writes.
    return decodeJson(body)
      .then((json) => decodeTurn(json).then(() => runForNode(decodeEnvelope(json))))
      .then((envelope) => runForNode(conversation(host, envelope.id, true)))
      .then((id) => route(host.harness, id, request, context))
  }
  const match = /^\/chat\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
  if (match === null) return Promise.resolve(new Response(null, { status: 404 }))
  return runForNode(decodePath({ id: match[1], action: match[2] })).then((path) => {
    const method =
      path.action === 'stream' || path.action === 'history' || path.action === 'waiting'
        ? 'GET'
        : 'POST'
    if (request.method !== method)
      return new Response(null, { status: 405, headers: { Allow: method } })
    return runForNode(conversation(host, path.id, false)).then((id) => {
      url.pathname = path.action === 'stream' ? '/chat' : `/${path.action}`
      return route(host.harness, id, new Request(url, request), context)
    })
  })
}

/** Node's Promise-only framework ingress bounds bytes before constructing the
 * shared Request; expected route statuses remain the Promise route's authority. */
function response(
  host: Host,
  incoming: NodeHttp.IncomingMessage,
  signal: AbortSignal,
): Promise<Response> {
  if (incoming.method === 'OPTIONS') return Promise.resolve(new Response(null, { status: 204 }))
  return runForNode(decodeIngress({ method: incoming.method, url: incoming.url })).then((input) =>
    (input.method === 'POST' ? readBody(incoming) : Promise.resolve('')).then((body) => {
      const url = new URL(input.url, 'http://example.invalid')
      const request =
        input.method === 'POST'
          ? new Request(url, { method: input.method, body, signal })
          : new Request(url, { method: input.method, signal })
      return requestRoute(host, request, body)
    }),
  )
}

/** Only host ingress failures are mapped here; main.route owns bridge statuses. */
function ingressFailure(error: Error): Response {
  if (error instanceof BodyTooLarge)
    return new Response('Request body exceeds 5 MB', { status: 413 })
  if (error instanceof BodyUnreadable) return new Response('Unreadable request', { status: 400 })
  if (
    error instanceof Schema.SchemaError ||
    error instanceof TurnInvalid ||
    error instanceof TurnRegenerate
  )
    return new Response('Invalid request', { status: 400 })
  if (error instanceof ChatMissing) return new Response('Chat not found', { status: 404 })
  throw error
}

/** Development example only: any origin may use these unauthenticated, disposable chat routes. */
function cors(outgoing: NodeHttp.ServerResponse) {
  outgoing.setHeader('Access-Control-Allow-Origin', '*')
  outgoing.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  outgoing.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

/** Web stream cancellation detaches only this HTTP observation, preserving Pi's durable run. */
function writeResponse(
  outgoing: NodeHttp.ServerResponse,
  result: Response,
  signal: AbortSignal,
): Promise<void> {
  outgoing.statusCode = result.status
  result.headers.forEach((value, name) => outgoing.setHeader(name, value))
  outgoing.flushHeaders()
  if (result.body === null) {
    outgoing.end()
    return Promise.resolve()
  }
  return result.body.pipeTo(NodeStream.Writable.toWeb(outgoing), { signal })
}

/** The HTTP framework is the only runtime Promise ingress; expected route statuses come from main. */
function dispatch(
  host: Host,
  incoming: NodeHttp.IncomingMessage,
  outgoing: NodeHttp.ServerResponse,
) {
  cors(outgoing)
  const controller = new AbortController()
  const disconnected = () => controller.abort()
  outgoing.once('close', disconnected)
  void response(host, incoming, controller.signal)
    .catch(ingressFailure)
    .then((result) => writeResponse(outgoing, result, controller.signal))
    .catch((error: Error) => {
      // A cancelled pipe reports this observation's abort reason. It is an
      // ordinary disconnect; any other failure after disconnect gets one line.
      if (controller.signal.aborted && error === controller.signal.reason) return
      if (controller.signal.aborted) {
        console.error('Example HTTP request failed after client disconnect.')
        return
      }
      console.error('Example HTTP request failed.')
      if (outgoing.headersSent) outgoing.destroy()
      else {
        outgoing.statusCode = 500
        outgoing.end('Example host failed')
      }
    })
    .finally(() => outgoing.removeListener('close', disconnected))
}

/** Stop accepting connections and detach open streams before closing harness and SQLite resources. */
function closeServer(server: NodeHttp.Server) {
  return Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
    server.closeAllConnections()
  })
}

/** Bind port zero in tests and remove startup listeners once Node has settled the bind. */
function listen(server: NodeHttp.Server, options: StartOptions) {
  return Effect.callback<string, ExampleIO>((resume) => {
    const failed = (cause: Error) =>
      resume(Effect.fail(new ExampleIO({ operation: 'listen', cause })))
    const ready = () => {
      const parsed = decodeAddress(server.address())
      if (Result.isFailure(parsed)) return failed(parsed.failure)
      const address = parsed.success
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
      resume(Effect.succeed(`http://${host}:${address.port}`))
    }
    server.once('error', failed)
    server.listen(options.port, options.host, ready)
    return Effect.sync(() => server.removeListener('error', failed))
  })
}

/** All acquired resources have finalizers before first use; startup failure closes the private scope. */
const open = Effect.fn('Example.open')(function* (input: StartOptions) {
  const options = yield* decodeStart(input)
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(options.dataDirectory, { recursive: true }),
    catch: (cause) => new ExampleIO({ operation: 'directory', cause }),
  })
  const database = yield* mapping(options.dataDirectory)
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(NodePath.join(options.dataDirectory, 'session.sqlite')),
      catch: (cause) => new ExampleIO({ operation: 'storage', cause }),
    }),
    (opened) => Effect.promise(() => opened.close(context)),
  )
  const installed = yield* registry()
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          {
            models: models(),
            registry: installed,
            settings: { progress: { partialIntervalMs: 1 } },
          },
          context,
        ),
      catch: (cause) => new ExampleIO({ operation: 'harness', cause }),
    }),
    (opened) => Effect.promise(() => opened.close(context)),
  )
  /** Pi Durable 1.0.4 README "Persist and Resume" and dist/harness/types.d.ts:
   * resume(): void is idempotent, enables recovered pending work, and throws
   * after close. Read-only viewers do not start scheduling; resume before listen. */
  harness.resume()
  const gate = yield* Semaphore.make(1)
  const host: Host = { harness, database, gate }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeHttp.createServer((incoming, outgoing) => dispatch(host, incoming, outgoing)),
    ),
    closeServer,
  )
  const address = yield* listen(server, options)
  return { address, dataDirectory: options.dataDirectory }
})

/** A caller owns the returned close operation; it closes server, harness, and both SQLite files. */
export const start: (
  options: StartOptions,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof open>> & { readonly close: () => Effect.Effect<void> },
  Effect.Error<ReturnType<typeof open>>
> = Effect.fn('Example.start')(function* (options: StartOptions) {
  const scope = yield* Scope.make()
  const host = yield* open(options).pipe(
    Scope.provide(scope),
    Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
  )
  yield* Effect.sync(() =>
    console.warn(
      'Unauthenticated development example: permissive CORS; do not expose to untrusted networks.',
    ),
  )
  return { ...host, close: () => Scope.close(scope, Exit.void) }
})

/** CLI configuration alone chooses defaults; a supplied directory is retained for future starts. */
const configured = Effect.fn('Example.configured')(function* () {
  const host = yield* Config.String('HOST').pipe(Config.withDefault('127.0.0.1'))
  const port = yield* Config.Int('PORT').pipe(Config.withDefault(8787))
  const supplied = yield* Config.String('DURABLE_DATA').pipe(Config.option)
  const dataDirectory = Option.isSome(supplied)
    ? supplied.value
    : yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-durable-')),
        catch: (cause) => new ExampleIO({ operation: 'directory', cause }),
      })
  return yield* start({ host, port, dataDirectory })
})

/** Importing start has no CLI side effects; signal handlers exist only for the executable example. */
function main(): Promise<void> {
  return runForNode(configured()).then((host) => {
    const close = () => {
      process.removeListener('SIGINT', close)
      process.removeListener('SIGTERM', close)
      void runForNode(host.close()).catch((error: Error) => {
        console.error(error)
        process.exitCode = 1
      })
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    // Publish readiness only after immediate shutdown signals can be handled safely.
    console.log(`Durable example listening at ${host.address} (data: ${host.dataDirectory})`)
  })
}

const executable = process.argv[1]
if (executable !== undefined && import.meta.url === NodeURL.pathToFileURL(executable).href)
  void main().catch((error: Error) => {
    console.error(error)
    process.exitCode = 1
  })
