import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Layer, Predicate, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { LibraryFolderId, PersonId, RunId, RuntimeAdmissionBody, ThreadId } from '@vivid/contracts'
import { refusalLogs } from '../observability/testlogger.ts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import {
  AdmissionRefused,
  AdmissionUncertain,
  Runtime,
  runtimeLayer,
  type RuntimeMessage,
} from './client.ts'

const decodeIncoming = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeAdmissionBody))
/** Flue's keyed id for `MARK-thread` and `event-1`: the Run every error below must name. */
const submission = RunId.make('sub_ik_6582cbafc27e51d07440c6dbaad55c0c')

const admissionInput: Parameters<Runtime['Service']['admit']>[0] = {
  threadId: ThreadId.make('MARK-thread'),
  idempotencyKey: 'event-1',
  turn: 3,
  origin: { creator: PersonId.make('MARK-person'), creatorName: 'Ada' },
  scope: {
    acting: PersonId.make('MARK-person'),
    libraryFolder: LibraryFolderId.make('926eaf36-3b29-41a8-8021-90fe0f694c52'),
  },
  message: { kind: 'user', body: 'Review.' },
}
const receiptBody = JSON.stringify({
  submissionId: submission,
  offset: '7',
  uid: 'MARK-incarnation',
})

/** Keep the caller scope open after admission, so abort assertions prove the method owns its response. */
const admitInputWith = Effect.fn('Runtime.test.admitInputWith')(function* (
  http: HttpClient.HttpClient,
  input: Parameters<Runtime['Service']['admit']>[0],
) {
  const context = yield* Layer.build(
    runtimeLayer.pipe(
      Layer.provide(Layer.merge(testConfigLayer, Layer.succeed(HttpClient.HttpClient, http))),
    ),
  )
  const runtime = yield* Runtime.pipe(Effect.provideContext(context))
  return yield* runtime.admit(input).pipe(Effect.result)
})
const admitWith = (http: HttpClient.HttpClient) => admitInputWith(http, admissionInput)

/** Classification is observed through the real Runtime Layer; only the remote HTTP transport varies. */
/** Each case builds its own log capture and transport so recorded refusals cannot leak. */
describe.skipIf(!testDatabaseConfigured)('Runtime admission classification', () => {
  const statuses = [
    { status: 400, tag: 'AdmissionRefused', reason: 'Rejected' },
    { status: 401, tag: 'AdmissionRefused', reason: 'Rejected' },
    { status: 404, tag: 'AdmissionRefused', reason: 'Rejected' },
    { status: 405, tag: 'AdmissionRefused', reason: 'Rejected' },
    { status: 415, tag: 'AdmissionRefused', reason: 'Rejected' },
    { status: 200, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 409, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 403, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 413, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 429, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 500, tag: 'AdmissionUncertain', reason: 'Status' },
    { status: 503, tag: 'AdmissionUncertain', reason: 'Status' },
  ]
  for (const { status, tag, reason } of statuses) {
    it.effect(
      `classifies HTTP ${status} before trusting receipt-shaped content and releases it`,
      () =>
        Effect.gen(function* () {
          const cancelled = yield* Deferred.make<void>()
          const http = HttpClient.make((request, _url, signal) =>
            Effect.sync(() => {
              signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
                once: true,
              })
              return HttpClientResponse.fromWeb(request, new Response(receiptBody, { status }))
            }),
          )
          const logs = refusalLogs()
          const result = yield* admitWith(http).pipe(Effect.provide(yield* Layer.build(logs.layer)))
          if (Result.isSuccess(result)) expect.fail('Non-202 response was admitted')
          expect(result.failure).toMatchObject({
            _tag: tag,
            reason,
            threadId: admissionInput.threadId,
            runId: submission,
          })
          const recorded = logs.recorded()
          expect(recorded).toHaveLength(tag === 'AdmissionRefused' ? 1 : 0)
          if (tag === 'AdmissionRefused') {
            expect(recorded[0]).toContain('vivid.refusal.kind=AdmissionRefused')
            expect(recorded[0]).toContain(`vivid.refusal.reason=${reason}`)
            expect(recorded[0]).not.toContain(admissionInput.threadId)
          }
          expect(yield* Deferred.isDone(cancelled)).toBe(true)
        }).pipe(Effect.scoped),
    )
  }

  const requestFailures = [
    { reason: HttpClientError.EncodeError, tag: 'AdmissionRefused', expected: 'Encoding' },
    { reason: HttpClientError.InvalidUrlError, tag: 'AdmissionRefused', expected: 'Address' },
    { reason: HttpClientError.TransportError, tag: 'AdmissionUncertain', expected: 'Transport' },
  ]
  for (const failure of requestFailures) {
    it.effect(`classifies ${failure.expected} without guessing from transport cause codes`, () =>
      Effect.gen(function* () {
        const http = HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({ reason: new failure.reason({ request }) }),
          ),
        )
        const logs = refusalLogs()
        const result = yield* admitWith(http).pipe(Effect.provide(yield* Layer.build(logs.layer)))
        if (Result.isSuccess(result)) expect.fail('Failed request was admitted')
        expect(result.failure).toMatchObject({
          _tag: failure.tag,
          reason: failure.expected,
          threadId: admissionInput.threadId,
          runId: submission,
        })
        const recorded = logs.recorded()
        expect(recorded).toHaveLength(failure.tag === 'AdmissionRefused' ? 1 : 0)
        if (failure.tag === 'AdmissionRefused') {
          expect(recorded[0]).toContain('vivid.refusal.kind=AdmissionRefused')
          expect(recorded[0]).toContain(`vivid.refusal.reason=${failure.expected}`)
        }
      }).pipe(Effect.scoped),
    )
  }

  it.effect('refuses an invalid HTTP address before dispatching any request', () =>
    Effect.gen(function* () {
      const http = HttpClient.mapRequest(
        HttpClient.make(() => Effect.sync(() => expect.fail('Invalid address reached transport'))),
        (request) => HttpClientRequest.setUrl(request, 'invalid address'),
      )
      const result = yield* admitWith(http)
      if (Result.isSuccess(result)) expect.fail('Invalid address was admitted')
      expect(result.failure).toMatchObject(
        AdmissionRefused.make({
          reason: 'Address',
          threadId: admissionInput.threadId,
          runId: submission,
        }),
      )
    }).pipe(Effect.scoped),
  )

  // A turn the shared contract rejects never becomes a request: a typed refusal, not a defect.
  for (const turn of [0, 1.5]) {
    it.effect(`refuses turn ${turn} at encoding without reaching the transport`, () =>
      Effect.gen(function* () {
        const dispatched = yield* Deferred.make<void>()
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(dispatched, Exit.void)
            return HttpClientResponse.fromWeb(request, new Response(receiptBody, { status: 202 }))
          }),
        )
        const result = yield* admitInputWith(http, { ...admissionInput, turn })
        if (Result.isSuccess(result)) expect.fail('Unencodable request was admitted')
        expect(result.failure).toEqual(
          AdmissionRefused.make({
            reason: 'Encoding',
            threadId: admissionInput.threadId,
            runId: submission,
          }),
        )
        expect(yield* Deferred.isDone(dispatched)).toBe(false)
      }).pipe(Effect.scoped),
    )
  }
})

/** A 409 is never a refusal. Only Flue's named conflict is `Conflict`; every other 409 is `Status`. */
describe.skipIf(!testDatabaseConfigured)('Runtime admission conflict', () => {
  const conflicts = [
    {
      name: 'Flue submission_conflict',
      // The envelope Flue 2.2.2's SubmissionConflictError serializes.
      body: JSON.stringify({
        error: {
          type: 'submission_conflict',
          message: 'This idempotency key already names a different submission.',
          meta: { submissionId: submission },
        },
      }),
      reason: 'Conflict',
    },
    {
      name: 'another error type',
      body: JSON.stringify({ error: { type: 'agent_busy', message: 'Busy.' } }),
      reason: 'Status',
    },
    { name: 'an error without a type', body: JSON.stringify({ error: {} }), reason: 'Status' },
    { name: 'a non-string type', body: JSON.stringify({ error: { type: 409 } }), reason: 'Status' },
    { name: 'malformed JSON', body: '{', reason: 'Status' },
    { name: 'an empty body', body: '', reason: 'Status' },
  ] as const
  for (const conflict of conflicts) {
    it.effect(`classifies a 409 with ${conflict.name} as ${conflict.reason} and releases it`, () =>
      Effect.gen(function* () {
        const cancelled = yield* Deferred.make<void>()
        const http = HttpClient.make((request, _url, signal) =>
          Effect.sync(() => {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
              once: true,
            })
            return HttpClientResponse.fromWeb(request, new Response(conflict.body, { status: 409 }))
          }),
        )
        const result = yield* admitWith(http)
        if (Result.isSuccess(result)) expect.fail('Conflicting request was admitted')
        expect(result.failure).toEqual(
          AdmissionUncertain.make({
            reason: conflict.reason,
            threadId: admissionInput.threadId,
            runId: submission,
          }),
        )
        expect(yield* Deferred.isDone(cancelled)).toBe(true)
      }).pipe(Effect.scoped),
    )
  }

  it.effect('classifies a 409 whose body cannot be read as Status', () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error('Connection lost during the conflict body'))
                },
              }),
              { status: 409 },
            ),
          ),
        ),
      )
      const result = yield* admitWith(http)
      if (Result.isSuccess(result)) expect.fail('Unreadable conflict was admitted')
      expect(result.failure).toEqual(
        AdmissionUncertain.make({
          reason: 'Status',
          threadId: admissionInput.threadId,
          runId: submission,
        }),
      )
    }).pipe(Effect.scoped),
  )
})

/** Accepted status alone is insufficient; keyed identity, wire shape and body readability must agree. */
describe.skipIf(!testDatabaseConfigured)('Runtime admission receipts', () => {
  for (const repeated of [false, true]) {
    it.effect(`validates and releases a matching 202 receipt with deduplicated=${repeated}`, () =>
      Effect.gen(function* () {
        const cancelled = yield* Deferred.make<void>()
        const http = HttpClient.make((request, _url, signal) =>
          Effect.sync(() => {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
              once: true,
            })
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  submissionId: submission,
                  offset: '7',
                  uid: 'MARK-incarnation',
                  deduplicated: repeated,
                }),
                { status: 202 },
              ),
            )
          }),
        )
        const result = yield* admitWith(http)
        if (Result.isFailure(result)) expect.fail('Matching receipt was refused')
        expect(result.success).toEqual({
          runId: submission,
          offset: '7',
          incarnation: 'MARK-incarnation',
          repeated,
        })
        expect(yield* Deferred.isDone(cancelled)).toBe(true)
      }).pipe(Effect.scoped),
    )
  }

  for (const body of [
    '',
    '{',
    '{}',
    JSON.stringify({ submissionId: 'other', offset: '7', uid: 'u' }),
  ]) {
    it.effect(
      `retains uncertainty and releases a 202 with invalid receipt ${JSON.stringify(body)}`,
      () =>
        Effect.gen(function* () {
          const cancelled = yield* Deferred.make<void>()
          const http = HttpClient.make((request, _url, signal) =>
            Effect.sync(() => {
              signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
                once: true,
              })
              return HttpClientResponse.fromWeb(request, new Response(body, { status: 202 }))
            }),
          )
          const result = yield* admitWith(http)
          if (Result.isSuccess(result)) expect.fail('Invalid receipt was admitted')
          expect(result.failure).toMatchObject(
            AdmissionUncertain.make({
              reason: 'Receipt',
              threadId: admissionInput.threadId,
              runId: submission,
            }),
          )
          expect(yield* Deferred.isDone(cancelled)).toBe(true)
        }).pipe(Effect.scoped),
    )
  }

  it.effect('retains uncertainty when an accepted receipt body cannot be read', () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error('Connection lost after acceptance'))
                },
              }),
              { status: 202 },
            ),
          ),
        ),
      )
      const result = yield* admitWith(http)
      if (Result.isSuccess(result)) expect.fail('Unreadable receipt was admitted')
      expect(result.failure).toMatchObject(
        AdmissionUncertain.make({
          reason: 'Receipt',
          threadId: admissionInput.threadId,
          runId: submission,
        }),
      )
    }).pipe(Effect.scoped),
  )
})

/** The response deadline covers both dispatch and body reading; abort is observed before caller cleanup. */
describe.skipIf(!testDatabaseConfigured)('Runtime admission deadline', () => {
  for (const stalled of ['headers', 'body']) {
    it.effect(`bounds stalled admission ${stalled} at 30 seconds and releases the request`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cancelled = yield* Deferred.make<void>()
        const http = HttpClient.make((request, _url, signal) =>
          Effect.gen(function* () {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
              once: true,
            })
            if (stalled === 'headers') {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  pull() {
                    Deferred.doneUnsafe(started, Exit.void)
                  },
                }),
                { status: 202 },
              ),
            )
          }),
        )
        const fiber = yield* admitWith(http).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* TestClock.adjust('30 seconds')
        const result = yield* Fiber.join(fiber)
        if (Result.isSuccess(result)) expect.fail('Stalled request was admitted')
        expect(result.failure).toMatchObject(
          AdmissionUncertain.make({
            reason: 'TimedOut',
            threadId: admissionInput.threadId,
            runId: submission,
          }),
        )
        expect(yield* Deferred.isDone(cancelled)).toBe(true)
      }).pipe(Effect.scoped),
    )
  }
})

/** A controlled HTTP transport verifies the production client wire request and Flue receipt validation. */
const transport = (receiptId: string, message: RuntimeMessage) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (!Predicate.isTagged(request.body, 'Uint8Array'))
          return expect.fail('Expected encoded JSON')
        const delivery = yield* decodeIncoming(new TextDecoder().decode(request.body.body)).pipe(
          Effect.catchTag('SchemaError', () =>
            Effect.sync(() => expect.fail('Runtime client emitted an invalid request')),
          ),
        )
        expect(request.method).toBe('POST')
        expect(delivery.attributes).toEqual(message.kind === 'user' ? {} : message.attributes)
        expect(delivery.attachments).toEqual(message.kind === 'user' ? message.attachments : [])
        expect(delivery.scope).toEqual({
          acting: 'MARK-person',
          libraryFolder: '926eaf36-3b29-41a8-8021-90fe0f694c52',
        })
        expect(delivery.turn).toBe(3)
        expect(delivery.initialData).toEqual({ creator: 'MARK-person', creatorName: 'Ada' })
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ submissionId: receiptId, offset: '7', uid: 'MARK-incarnation' }),
            { status: 202 },
          ),
        )
      }),
    ),
  )

const messages: ReadonlyArray<RuntimeMessage> = [
  {
    kind: 'signal',
    type: 'schedule',
    tagName: 'schedule',
    body: 'Review.',
    attributes: { from: 'Ada', turn: '3', name: 'Morning review' },
  },
  {
    kind: 'user',
    body: 'Look.',
    attachments: [
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
        filename: 'picture.png',
      },
    ],
  },
]

/** The expected submission vector follows Flue 2.2.2's frozen protocol, without importing private SDK helpers. */
describe.skipIf(!testDatabaseConfigured)('Runtime delivery wire boundary', () => {
  /** A refused body is never pulled, so only the request scope can release its runtime socket. */
  it.effect('aborts an unconsumed runtime read when its caller scope closes', () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>()
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
          Effect.sync(() => {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(cancelled, Exit.void), {
              once: true,
            })
            return HttpClientResponse.fromWeb(request, new Response('private buffered content'))
          }),
        ),
      )
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime
        const response = yield* runtime.read({
          threadId: ThreadId.make('MARK-thread'),
          suffix: '',
          search: '?view=updates',
          accept: 'text/event-stream',
        })
        expect(response.status).toBe(200)
        expect(yield* Deferred.isDone(cancelled)).toBe(false)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          yield* Layer.build(runtimeLayer.pipe(Layer.provide(Layer.merge(testConfigLayer, http)))),
        ),
      )
      // Abort dispatch is synchronous at scope close; regression must fail immediately, not hang.
      expect(yield* Deferred.isDone(cancelled)).toBe(true)
    }),
  )

  for (const message of messages) {
    it.effect(`forwards ${message.kind} content and scope, and rejects a mismatched receipt`, () =>
      Effect.gen(function* () {
        for (const receiptId of [submission, 'unexpected-submission']) {
          const result = yield* Effect.result(
            Effect.gen(function* () {
              const runtime = yield* Runtime
              return yield* runtime.admit({
                threadId: ThreadId.make('MARK-thread'),
                idempotencyKey: 'event-1',
                turn: 3,
                origin: { creator: PersonId.make('MARK-person'), creatorName: 'Ada' },
                scope: {
                  acting: PersonId.make('MARK-person'),
                  libraryFolder: LibraryFolderId.make('926eaf36-3b29-41a8-8021-90fe0f694c52'),
                },
                message,
              })
            }).pipe(
              Effect.provide(
                yield* Layer.build(
                  runtimeLayer.pipe(
                    Layer.provide(Layer.merge(testConfigLayer, transport(receiptId, message))),
                  ),
                ),
              ),
            ),
          )
          if (receiptId === submission)
            expect(Result.isSuccess(result) && result.success).toEqual({
              runId: submission,
              offset: '7',
              incarnation: 'MARK-incarnation',
              repeated: false,
            })
          else
            expect(Result.isFailure(result) && result.failure).toMatchObject(
              AdmissionUncertain.make({
                reason: 'Receipt',
                threadId: ThreadId.make('MARK-thread'),
                runId: submission,
              }),
            )
        }
      }).pipe(Effect.scoped),
    )
  }
})
