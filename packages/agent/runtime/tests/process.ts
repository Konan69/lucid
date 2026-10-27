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
import { Deferred, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import type * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { routes } from '../src/app.ts'
import { productLayer, type Acting } from '../src/client.ts'
import { Models, type ModelsService } from '../src/models.ts'
import { RuntimeSettings } from '../src/settings.ts'
import { builtinSkillsLayer } from './skills.ts'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { openPerson, Person } from '../src/person.ts'
import { openNotes, Notes, NotesUnavailable } from '../src/notes.ts'
import { RcMap } from 'effect'

const TOKEN = 'fixture-runtime-token'
const PROVIDER = 'fixture'
const MODEL = 'text'

/** A directory could not be made for a case, or a link ended early; nothing was started. */
export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()(
  'FixtureFailed',
  {},
  { title: 'Runtime fixture failed' },
) {}

/** Native SQLite files and the scripted provider survive a simulated cell restart. The case
 * retains its activated Person names so start can drive their recovery without a client. */
export interface World {
  readonly directory: string
  readonly people: Set<PersonId>
  readonly faux: FauxProviderHandle
  /** Every Acting pair a product client was built for, in order. */
  readonly asked: Array<Acting>
  readonly requests: Array<HttpClientRequest.HttpClientRequest>
  readonly models: ModelsService
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
  const faux = fauxProvider({
    provider: PROVIDER,
    models: [{ id: MODEL }],
    tokensPerSecond: options.tokensPerSecond,
  })
  const collection = createModels()
  collection.setProvider(faux.provider)
  return {
    directory: root,
    people: new Set(),
    faux,
    asked: [],
    requests: [],
    models: Models.of({
      collection,
      selected: { provider: PROVIDER, modelId: MODEL },
      name: `${PROVIDER}/${MODEL}`,
      // A retried model call backs off on Pi's own clock; here it does not wait.
      settings: { retry: { baseDelayMs: 0 } },
    }),
  } satisfies World
})

/**
 * The application server as the cases meet it: unreachable. The production client is used as it
 * is; only its transport is the fixture's, and every request fails there the way a server that
 * is down fails. Context reads then fall back to their documented defaults and a tool call
 * reports a failure to the model, so a case observes the runtime's own behaviour, and reads from
 * the attribution headers of each request whom the runtime asked as.
 */
const serverLayer = (given: World) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      given.requests.push(request)
      const thread = decodeThread(request.headers[runtimeHeaders.thread])
      const actor = decodePerson(request.headers[runtimeHeaders.actor])
      if (Option.isSome(thread) && Option.isSome(actor))
        given.asked.push({ threadId: thread.value, personId: actor.value })
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

/** Fixtures apply the same generated SQL that the cell bundles, on their disposable native database. */
const memoryMigration = Effect.tryPromise({
  try: () =>
    NodeFSP.readFile(
      new URL(
        '../../../../apps/cells/src/memory/migrations/20261027123834_memory/migration.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  catch: () => new FixtureFailed(),
})

type Cell = {
  readonly person: Effect.Success<ReturnType<typeof openPerson>>
  readonly notes: Effect.Success<ReturnType<typeof openNotes>>
}

/**
 * Tests host each Person on Pi's first-party file-backed SQLite adapter. This fixture emulates
 * cell activation only; celld ownership and alarms require the parent's real host proof.
 */
export const start = Effect.fn('RuntimeFixture.start')(function* (given: World) {
  // Activation failures mean unavailable memory only at this note-tool boundary.
  const noteCell = (person: PersonId) =>
    RcMap.get(cells, person).pipe(Effect.mapError(() => NotesUnavailable.make({})))
  const notes = Notes.of({
    index: (person) =>
      Effect.scoped(Effect.flatMap(noteCell(person), (cell) => cell.notes.index())),
    list: (person, listing) =>
      Effect.scoped(Effect.flatMap(noteCell(person), (cell) => cell.notes.list(listing))),
    read: (person, file) =>
      Effect.scoped(Effect.flatMap(noteCell(person), (cell) => cell.notes.read(file))),
    write: (person, write) =>
      Effect.scoped(Effect.flatMap(noteCell(person), (cell) => cell.notes.write(write))),
    delete: (person, file) =>
      Effect.scoped(Effect.flatMap(noteCell(person), (cell) => cell.notes.delete(file))),
  })
  const context = yield* Layer.build(
    Layer.mergeAll(
      productLayer.pipe(Layer.provide(serverLayer(given))),
      builtinSkillsLayer,
      Layer.succeed(Models, given.models),
      Layer.succeed(Notes, notes),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(
          RuntimeSettings,
          RuntimeSettings.of({
            token: Redacted.make(TOKEN),
            serverUrl: new URL('http://server.invalid'),
          }),
        ),
      ),
    ),
  )
  const cells: RcMap.RcMap<
    PersonId,
    Cell,
    | FixtureFailed
    | import('../src/threads.ts').PiRejected
    | import('../src/notes.ts').NotesUnavailable
  > = yield* RcMap.make({
    idleTimeToLive: Infinity,
    lookup: (personId: PersonId) =>
      Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => openNodeSqliteDatabase(NodePath.join(given.directory, `${personId}.sqlite`)),
            catch: () => new FixtureFailed(),
          }),
          (connection) => Effect.promise(connection.close.bind(connection)),
        )
        const storage = yield* Effect.tryPromise({
          try: () => SqliteStorage.open(database, { prefix: 'pi_' }),
          catch: () => new FixtureFailed(),
        })
        const localNotes = yield* openNotes(database, yield* memoryMigration)
        const person = yield* openPerson(personId, storage, undefined).pipe(Effect.provide(context))
        given.people.add(personId)
        person.harness.resume()
        return { person, notes: localNotes }
      }),
  })
  const persons = {
    use: <A, E, R>(personId: PersonId, use: (person: Cell['person']) => Effect.Effect<A, E, R>) =>
      Effect.scoped(Effect.flatMap(RcMap.get(cells, personId), (cell) => use(cell.person))),
  }
  for (const person of given.people) yield* persons.use(person, () => Effect.void)
  const handler = yield* HttpRouter.toHttpEffect(routes)

  const call = (request: Request) => {
    const personId = new URL(request.url).pathname.split('/')[2]
    const person = PersonId.make(personId === undefined ? 'fixture-health' : personId)
    return persons.use(person, (bound) =>
      handler.pipe(
        Effect.provideService(Person, bound),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Effect.provide(context),
        Effect.scoped,
      ),
    )
  }

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
    const response = yield* call(request)
    const web = HttpServerResponse.toWeb(response)
    return {
      status: web.status,
      body: yield* Effect.promise(() => web.text()).pipe(Effect.flatMap(decodeBody)),
    }
  })

  return {
    send,
    link: (path: string) => Effect.flatMap(call(reading(path, 'text/event-stream')), linked),
    bytes: (path: string) => Effect.flatMap(call(reading(path, '*/*')), bytesOf),
    persons,
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
