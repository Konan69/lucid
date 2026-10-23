import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { start } from '@flue/runtime/node'
import {
  PersonId,
  RuntimeAdmissionBody,
  RuntimeRunRequest,
  RuntimeRunResponse,
  ThreadId,
  ThreadOrigin,
} from '@vivid/contracts'
import { Config, Effect, Option, Redacted, Result, Schema } from 'effect'
import { Client } from 'pg'
import { disposableStorage, testDatabaseConfigured } from '../tests/schema.ts'
import { routes, Settled, RouteRequestFailed, type Routes } from '../tests/routes.ts'
import app from './app.ts'
import { Vivid } from './agents/vivid.ts'

/** Reading a body can fail independently of its wire schema. */
class ResponseBodyFailed extends Schema.TaggedError<ResponseBodyFailed>()(
  'ResponseBodyFailed',
  {},
  { title: 'Runtime response body read failed' },
) {}

/** Catalog inspection is separate from production Flue storage, and never borrows its pool. */
class SchemaInspectionFailed extends Schema.TaggedError<SchemaInspectionFailed>()(
  'SchemaInspectionFailed',
  { schema: Schema.String },
  { title: 'Runtime schema inspection failed' },
) {}

/** The failed-start control is a registration rejection, not a durable Run failure. */
class DuplicateRegistrationRejected extends Schema.TaggedError<DuplicateRegistrationRejected>()(
  'DuplicateRegistrationRejected',
  {},
  { title: 'Duplicate runtime registration rejected' },
) {}

/** Any other start failure must fail H4 rather than passing as the expected control. */
class UnexpectedStartFailure extends Schema.TaggedError<UnexpectedStartFailure>()(
  'UnexpectedStartFailure',
  {},
  { title: 'Unexpected runtime start failure' },
) {}

const Admission = RuntimeAdmissionBody
const encodeAdmission = Schema.encodeEffect(Schema.fromJsonString(Admission))
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeRunResponse))
const decodeAbort = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ aborted: Schema.Boolean })),
)
/** src/app.ts answers a refused delivery with one `error` sentence naming the reason. */
const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
)
/**
 * The wire text the shared codec really produced, read back as an open record so a malformed
 * case can change one key of an otherwise accepted body. Values stay opaque on purpose: the
 * control must not restate the contract's encoded field types.
 */
const decodeWire = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/**
 * Text-only history projection from Flue 2.2.2 sandbox-BSDnM6Na.d.mts ConversationUiMessage
 * and AgentConversationSnapshot, dispatch-BlxCz6iq.mjs handleHistory. Optional signal and
 * submissionId are genuine SDK absence; N7 asserts they exist on the admitted input. Parts
 * are intentionally text-only for this case: an unexpected tool/data/file part fails ingress.
 */
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      v: Schema.Literal(1),
      conversationId: Schema.String,
      offset: Schema.String,
      messages: Schema.Array(
        Schema.Struct({
          role: Schema.Literals(['user', 'assistant', 'system']),
          submissionId: Schema.optionalKey(Schema.String),
          signal: Schema.optionalKey(Schema.Struct({ tagName: Schema.optionalKey(Schema.String) })),
          parts: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
        }),
      ),
      settlements: Schema.Array(
        Schema.Struct({
          submissionId: Schema.String,
          outcome: Schema.Literals(['completed', 'aborted', 'failed']),
        }),
      ),
    }),
  ),
)
const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ namespace: Schema.NullOr(Schema.String), table: Schema.NullOr(Schema.String) }),
  ),
)

/** Fresh Thread ids keep authority and durable history separate in every scoped case. */
const thread = () => ThreadId.make(NodeCrypto.randomUUID())

/** Only the response read is unsafe; schema decoding follows at the real wire ingress. */
const bodyText = (response: Response) =>
  Effect.tryPromise({ try: () => response.text(), catch: () => new ResponseBodyFailed({}) })

/** Construct a keyed attributed message using the production wire vocabulary. */
const delivery = (threadId: ThreadId, turn: number, body: string) => {
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const request = RuntimeRunRequest.make({
    threadId,
    idempotencyKey: NodeCrypto.randomUUID(),
    type: 'message',
    body,
    attributes: { speaker: 'Fixture Person' },
    turn,
    scope: { acting: personId },
  })
  const initialData = ThreadOrigin.make({ creator: personId, creatorName: 'Fixture Person' })
  return Admission.make({ ...request, initialData })
}

/** All admissions go through the real token/context/Hono/Flue route, never init.dispatch. */
const admit = Effect.fn('RuntimeRoutesTest.admit')(function* (
  runtime: Routes,
  request: typeof Admission.Type,
) {
  const response = yield* runtime.send(`/agents/vivid/${request.threadId}`, {
    method: 'POST',
    body: yield* encodeAdmission(request),
  })
  expect(response.status).toBe(202)
  return yield* decodeReceipt(yield* bodyText(response))
})

/** A later client proves cleanup after the production adapter has already closed its pool. */
const catalog = Effect.fn('RuntimeRoutesTest.catalog')(function* (schema: string) {
  const url = yield* Config.Redacted('VIVID_TEST_DATABASE_URL')
  const client = new Client({ connectionString: Redacted.value(url) })
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => client.end()).pipe(
      Effect.catch(() =>
        Effect.sync(() => expect.fail('Schema inspection connection close failed')),
      ),
    ),
  )
  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: () => new SchemaInspectionFailed({ schema }),
  })
  const result = yield* Effect.tryPromise({
    try: () =>
      client.query(
        'SELECT to_regnamespace($1)::text AS namespace, to_regclass($2)::text AS table',
        [schema, `${schema}.flue_meta`],
      ),
    catch: () => new SchemaInspectionFailed({ schema }),
  })
  return yield* decodeCatalog(result.rows)
})

/** Reused baseline also proves a fresh public start after the previous scope stopped Flue. */
const baseline = Effect.gen(function* () {
  const runtime = yield* routes
  const id = thread()
  yield* runtime.inspectTools
  const receipt = yield* admit(runtime, delivery(id, 1, 'A real runtime message'))
  expect(yield* runtime.settled(id, receipt.submissionId)).toEqual(
    Settled.Completed({ text: 'ready' }),
  )
  expect(yield* runtime.modelCalls).toBe(1)
  return runtime.schema
}).pipe(Effect.withSpan('RuntimeRoutesTest.baseline'))

describe.skipIf(!testDatabaseConfigured)('production Flue routes on disposable PostgreSQL', () => {
  it.live(
    'H1 assembles the words every Vivid tool must say for its step and durably completes an authenticated signal',
    () => baseline.pipe(Effect.scoped),
  )

  it.live('H2 refuses a missing runtime token before calling the model', () =>
    Effect.gen(function* () {
      const runtime = yield* routes
      const request = delivery(thread(), 1, 'Unauthorized message')
      const body = yield* encodeAdmission(request)
      const path = `/agents/vivid/${request.threadId}`
      const response = yield* Effect.tryPromise({
        // Hono may answer synchronously; Promise.resolve preserves either result form.
        try: () =>
          Promise.resolve(
            app.fetch(
              new Request(`http://runtime.test${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
              }),
            ),
          ),
        catch: () => new RouteRequestFailed({ path }),
      })
      expect(response.status).toBe(401)
      expect(yield* runtime.modelCalls).toBe(0)
    }).pipe(Effect.scoped),
  )

  // Malformed wire input deliberately bypasses the shared constructor: the runtime must reject
  // the same invalid turns the server encoder refuses, before context or Flue calls the model.
  // The body starts as the shared codec's encoding of a valid request (the text `admit` sends
  // and H1 proves accepted) and only `turn` is replaced. If the codec later transforms a field,
  // the rest of the body stays valid, so the 400 is still about the turn and not the encoding.
  it.live('H2 rejects malformed turns at runtime ingress before calling the model', () =>
    Effect.gen(function* () {
      const runtime = yield* routes
      const request = delivery(thread(), 1, 'Invalid turn')
      const wire = yield* decodeWire(yield* encodeAdmission(request))
      expect(wire).toHaveProperty('turn', 1)
      for (const turn of [0, 1.5]) {
        const response = yield* runtime.send(`/agents/vivid/${request.threadId}`, {
          method: 'POST',
          body: JSON.stringify({ ...wire, turn }),
        })
        expect(response.status, `turn ${turn}`).toBe(400)
        expect(yield* decodeRefusal(yield* bodyText(response))).toEqual({
          error: 'Invalid runtime delivery',
        })
      }
      expect(yield* runtime.modelCalls).toBe(0)
      // The same encoded control is admitted and completed: the hostile inputs cannot pass
      // merely because the route stopped accepting every request.
      yield* runtime.reply('ready')
      const receipt = yield* admit(runtime, request)
      expect(yield* runtime.settled(request.threadId, receipt.submissionId)).toEqual(
        Settled.Completed({ text: 'ready' }),
      )
      expect(yield* runtime.modelCalls).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.live('H3 drops the stopped schema and starts another runtime in the same module graph', () =>
    Effect.gen(function* () {
      const first = yield* baseline.pipe(Effect.scoped)
      expect(yield* catalog(first)).toEqual([{ namespace: null, table: null }])
      const second = yield* baseline.pipe(Effect.scoped)
      expect(second).not.toBe(first)
      expect(yield* catalog(second)).toEqual([{ namespace: null, table: null }])
    }).pipe(Effect.scoped),
  )

  it.live('H4 cleans up a real migrated adapter after failed runtime assembly', () =>
    Effect.gen(function* () {
      const schema = yield* Effect.gen(function* () {
        const fixture = yield* disposableStorage
        // agents: [] fails before persistence (node/index.mjs start). Duplicate identity instead
        // fails in registerFlueAgents after connectPersistenceAdapter migrated the real adapter;
        // start catches assembly failure and closes it. No internal API is invoked by the case.
        const failure = yield* Effect.tryPromise({
          try: () => start({ agents: [Vivid, Vivid], db: fixture.storage, providers: [] }),
          catch: (cause) =>
            cause instanceof Error &&
            cause.message.startsWith('[flue] Duplicate agent identity "vivid".')
              ? new DuplicateRegistrationRejected({})
              : new UnexpectedStartFailure({}),
        }).pipe(Effect.result)
        if (Result.isSuccess(failure)) {
          yield* Effect.promise(() => failure.success.stop())
          expect.fail('Duplicate runtime registration unexpectedly started')
        }
        expect(failure.failure).toBeInstanceOf(DuplicateRegistrationRejected)
        expect(yield* catalog(fixture.schema)).toEqual([
          {
            namespace: fixture.schema,
            table: `${fixture.schema}.flue_meta`,
          },
        ])
        return fixture.schema
      }).pipe(Effect.scoped)
      expect(yield* catalog(schema)).toEqual([{ namespace: null, table: null }])
      // A failed assembly must also leave the public runtime bootstrap usable.
      yield* baseline.pipe(Effect.scoped)
    }).pipe(Effect.scoped),
  )

  it.live('N5 an idle bodyless abort leaves a later submission free to complete', () =>
    Effect.gen(function* () {
      const runtime = yield* routes
      const id = thread()
      yield* runtime.reply('first')
      const first = yield* admit(runtime, delivery(id, 1, 'First message'))
      expect(yield* runtime.settled(id, first.submissionId)).toEqual(
        Settled.Completed({ text: 'first' }),
      )
      const response = yield* runtime.send(`/agents/vivid/${id}/abort`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(yield* decodeAbort(yield* bodyText(response))).toEqual({ aborted: false })
      yield* runtime.reply('second')
      const second = yield* admit(runtime, delivery(id, 2, 'Later message'))
      expect(yield* runtime.settled(id, second.submissionId)).toEqual(
        Settled.Completed({ text: 'second' }),
      )
      expect(yield* runtime.modelCalls).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.live(
    'N6 bodyless abort settles both the held head and queued message without running the latter',
    () =>
      Effect.gen(function* () {
        const runtime = yield* routes
        const id = thread()
        const held = yield* runtime.hold('Head answer')
        const first = yield* admit(runtime, delivery(id, 1, 'Held message'))
        // If the first admission settles durably without reaching the model, `entered` never
        // resolves. Racing it against the public settlement read fails at once with the
        // outcome, instead of at the runner's timeout. The losing read is only abandoned: it
        // holds no resource, and the settlement is read again after the abort below.
        const early = yield* Effect.raceFirst(
          held.entered.pipe(Effect.as(Option.none<Settled>())),
          runtime.settled(id, first.submissionId).pipe(Effect.map(Option.some)),
        )
        if (Option.isSome(early)) {
          expect.fail(`First admission settled ${early.value._tag} before the model was entered`)
        }
        const second = yield* admit(runtime, delivery(id, 2, 'Queued message'))
        const response = yield* runtime.send(`/agents/vivid/${id}/abort`, { method: 'POST' })
        expect(response.status).toBe(200)
        expect(yield* decodeAbort(yield* bodyText(response))).toEqual({ aborted: true })
        yield* held.release
        expect(yield* runtime.settled(id, first.submissionId)).toEqual(Settled.Aborted())
        expect(yield* runtime.settled(id, second.submissionId)).toEqual(Settled.Aborted())
        expect(yield* runtime.modelCalls).toBe(1)
      }).pipe(Effect.scoped),
  )

  it.live('N7 history retains the admitted signal raw words and submission identity', () =>
    Effect.gen(function* () {
      const runtime = yield* routes
      const id = thread()
      const words = 'Keep these raw words <tag> & punctuation.\nSecond line.'
      yield* runtime.reply('ready')
      const receipt = yield* admit(runtime, delivery(id, 1, words))
      expect(yield* runtime.settled(id, receipt.submissionId)).toEqual(
        Settled.Completed({ text: 'ready' }),
      )
      const response = yield* runtime.send(`/agents/vivid/${id}`, { method: 'GET' })
      expect(response.status).toBe(200)
      const snapshot = yield* decodeSnapshot(yield* bodyText(response))
      const messages = snapshot.messages.filter(
        (message) => message.signal !== undefined && message.signal.tagName === 'message',
      )
      expect(messages).toHaveLength(1)
      const message = messages[0]
      if (message === undefined) expect.fail('History lost the admitted message')
      expect(message.submissionId).toBe(receipt.submissionId)
      expect(message.parts.map((part) => part.text).join('')).toBe(words)
      expect(snapshot.settlements).toEqual([
        { submissionId: receipt.submissionId, outcome: 'completed' },
      ])
    }).pipe(Effect.scoped),
  )
})
