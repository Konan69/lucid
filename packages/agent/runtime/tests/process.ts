import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { ConversationFrame, PersonId, ThreadId } from '@vivid/contracts'
import { runtimeHeaders } from '@vivid/contracts/auth'
import { Context, Deferred, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { routes } from '../src/app.ts'
import { productLayer, type Acting } from '../src/client.ts'
import { Models } from '../src/models.ts'
import { Persons, personsLayer, runtimeNotesLayer } from '../src/persons.ts'
import { RuntimeSettings } from '../src/settings.ts'
import { builtinSkillsLayer } from '../src/skills.ts'
import { storesLayer } from '../src/storage/stores.ts'
import { disposableDatabase } from './database.ts'

const TOKEN = 'fixture-runtime-token'
const PROVIDER = 'fixture'
const MODEL = 'text'

/** A directory could not be made for a case, or a link ended early; nothing was started. */
export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()(
  'FixtureFailed',
  {},
  { title: 'Runtime fixture failed' },
) {}

/**
 * What survives a restart of the process under test: its database (a disposable copy of the
 * migrated template, `tests/database.ts`), the notes directory, the scripted model (its queue of
 * answers is the "provider", which does not restart with the runtime), and the record of whom
 * the server was asked as.
 */
export interface World {
  readonly database: string
  readonly notes: string
  readonly faux: FauxProviderHandle
  /** Every Acting pair a product client was built for, in order. */
  readonly asked: Array<Acting>
}

/**
 * A fresh world, removed with the case's scope. The scripted model answers at once unless a case
 * asks it to stream (`tokensPerSecond`), as the throughput measurement does.
 */
export const world = Effect.fn('RuntimeFixture.world')(function* (
  options: { readonly tokensPerSecond: number } = { tokensPerSecond: 0 },
) {
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-runtime-')),
      catch: () => new FixtureFailed(),
    }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  )
  return {
    database: yield* disposableDatabase(),
    notes: NodePath.join(root, 'notes'),
    faux: fauxProvider({
      provider: PROVIDER,
      models: [{ id: MODEL }],
      tokensPerSecond: options.tokensPerSecond,
    }),
    asked: [],
  } satisfies World
})

/**
 * The application server as the cases meet it: unreachable. The production client is used as it
 * is; only its transport is the fixture's, and every request fails there the way a server that
 * is down fails. Context reads then fall back to their documented defaults and a tool call
 * reports a failure to the model, so a case observes the runtime's own behaviour, and reads from
 * the attribution headers of each request whom the runtime asked as.
 */
const serverLayer = (asked: Array<Acting>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const thread = decodeThread(request.headers[runtimeHeaders.thread])
      const actor = decodePerson(request.headers[runtimeHeaders.actor])
      if (Option.isSome(thread) && Option.isSome(actor))
        asked.push({ threadId: thread.value, personId: actor.value })
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: 'The fixture has no application server.',
          }),
        }),
      )
    }),
  )
const DATA = 'data: '
const isText = Schema.is(Schema.String)
const decodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(ConversationFrame)),
)
const decodeThread = Schema.decodeUnknownOption(ThreadId)
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
const decodePerson = Schema.decodeUnknownOption(PersonId)

/** A read as the server makes it, asking for one kind of answer. */
const reading = (path: string, accept: string) =>
  new Request(`http://runtime.test${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept },
  })

/**
 * The state link as a reader has it: the route's streamed answer read event by event. `event`
 * resolves with the next event's text (a frame's `data:` line or a comment) and with nothing once
 * the runtime has ended the link; `leave` is the reader going away.
 */
const linked = Effect.fn('RuntimeFixture.linked')(function* (
  response: HttpServerResponse.HttpServerResponse,
) {
  const web = HttpServerResponse.toWeb(response, { context: yield* Effect.context() })
  if (web.body === null) return yield* new FixtureFailed()
  const reader = web.body.getReader()
  const decoder = new TextDecoder()
  const read = { buffer: '' }
  const pull = (): Promise<Option.Option<string>> => {
    const end = read.buffer.indexOf('\n\n')
    if (end >= 0) {
      const event = read.buffer.slice(0, end)
      read.buffer = read.buffer.slice(end + 2)
      return Promise.resolve(Option.some(event))
    }
    return reader.read().then((chunk) => {
      if (chunk.done) return Option.none()
      read.buffer += decoder.decode(chunk.value, { stream: true })
      return pull()
    })
  }
  const event = Effect.promise(pull)
  return {
    status: web.status,
    contentType: web.headers.get('content-type'),
    event,
    /** The next frame; a link that ended, or a comment where a frame was expected, fails the case. */
    frame: Effect.gen(function* () {
      const text = yield* event
      if (Option.isNone(text) || !text.value.startsWith(DATA)) return yield* new FixtureFailed()
      return yield* decodeFrame(text.value.slice(DATA.length))
    }),
    leave: Effect.promise(() => reader.cancel()),
  }
})

/** An answer that is bytes, not JSON. */
const bytesOf = Effect.fn('RuntimeFixture.bytesOf')(function* (
  response: HttpServerResponse.HttpServerResponse,
) {
  const web = HttpServerResponse.toWeb(response)
  return {
    status: web.status,
    contentType: web.headers.get('content-type'),
    bytes: Buffer.from(yield* Effect.promise(() => web.arrayBuffer())),
  }
})

/**
 * The real process wiring minus the socket: the production routes, the production Persons and
 * Stores Layers on the world's database, the production skills, with the model and the server
 * supplied. Requests enter through the router as they would from the network. Closing the scope
 * this runs in is the process stopping; running it again on the same world is the next process.
 */
/** The settings a fixture process runs with: the world's database and notes, the fixture token. */
const settingsOf = (given: World, options: { readonly idleMillis: number }) =>
  Layer.succeed(
    RuntimeSettings,
    RuntimeSettings.of({
      notesDirectory: given.notes,
      databaseUrl: Redacted.make(given.database),
      token: Redacted.make(TOKEN),
      serverUrl: new URL('http://server.invalid'),
      idleMillis: options.idleMillis,
      host: '127.0.0.1',
      port: 0,
    }),
  )

/**
 * Every Person's conversations and what they need, but not the stores: what `main.ts` builds
 * while it owns them (`lifetime.ts`). The production Persons Layer, the production skills and
 * product client on the fixture's transport, and the scripted model.
 */
export const personsOn = (given: World, options: { readonly idleMillis: number }) => {
  const models = createModels()
  models.setProvider(given.faux.provider)
  return personsLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        productLayer.pipe(Layer.provide(serverLayer(given.asked))),
        builtinSkillsLayer,
        runtimeNotesLayer,
        Layer.succeed(
          Models,
          Models.of({
            collection: models,
            selected: { provider: PROVIDER, modelId: MODEL },
            name: `${PROVIDER}/${MODEL}`,
            // A retried model call backs off on Pi's own clock; here it does not wait.
            settings: { retry: { baseDelayMs: 0 } },
          }),
        ),
      ),
    ),
    Layer.provideMerge(settingsOf(given, options)),
  )
}

/** The production Stores Layer on the world's database. */
export const storesOf = (given: World, options: { readonly idleMillis: number }) =>
  storesLayer.pipe(Layer.provide(settingsOf(given, options)))

export const start = Effect.fn('RuntimeFixture.start')(function* (
  given: World,
  options: { readonly idleMillis: number },
) {
  const context = yield* Layer.build(
    personsOn(given, options).pipe(Layer.provideMerge(storesOf(given, options))),
  )
  const handler = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provide(context))

  const send = Effect.fn('RuntimeFixture.send')(function* (
    path: string,
    input: { readonly method: 'GET' | 'POST'; readonly body?: unknown; readonly token?: string },
  ) {
    const headers = {
      authorization: `Bearer ${input.token === undefined ? TOKEN : input.token}`,
      'content-type': 'application/json',
    }
    const request = new Request(
      `http://runtime.test${path}`,
      input.body === undefined
        ? { method: input.method, headers }
        : { method: input.method, headers, body: JSON.stringify(input.body) },
    )
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provide(context),
      Effect.scoped,
    )
    const web = HttpServerResponse.toWeb(response)
    return {
      status: web.status,
      body: yield* Effect.promise(() => web.text()).pipe(Effect.flatMap(decodeBody)),
    }
  })

  const call = (request: Request) =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provide(context),
      Effect.scoped,
    )
  return {
    send,
    link: (path: string) => Effect.flatMap(call(reading(path, 'text/event-stream')), linked),
    bytes: (path: string) => Effect.flatMap(call(reading(path, '*/*')), bytesOf),
    persons: Context.get(context, Persons),
  }
})

/**
 * A scripted answer the case holds open. The scripted provider awaits a factory before it looks
 * at its abort signal, so the factory watches the signal itself: a stop or a close rejects it,
 * as a real provider's request would be cut, and `release` lets it answer.
 */
export const held = Effect.fn('RuntimeFixture.held')(function* (answer: string | AssistantMessage) {
  const entered = yield* Deferred.make<void>()
  const released = yield* Deferred.make<void>()
  const services = yield* Effect.context()
  const factory: FauxResponseFactory = (_context, options) =>
    // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- pi's FauxResponseFactory is a Promise callback; it owns only this case's coordination.
    Effect.runPromiseWith(services)(
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(released)
        return isText(answer) ? fauxAssistantMessage(answer) : answer
      }),
      options === undefined || options.signal === undefined ? {} : { signal: options.signal },
    )
  return {
    factory,
    entered: Deferred.await(entered),
    release: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
  }
})
