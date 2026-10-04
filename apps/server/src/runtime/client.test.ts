import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Layer, Predicate, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  LibraryFolderId,
  PersonId,
  RuntimeRunRequest,
  ThreadId,
  ThreadOrigin,
} from '@vivid/contracts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import {
  AdmissionRefused,
  AdmissionUncertain,
  Runtime,
  runtimeLayer,
  type RuntimeMessage,
} from './client.ts'

const Incoming = Schema.fromJsonString(
  Schema.Struct({ ...RuntimeRunRequest.fields, initialData: ThreadOrigin }),
)
const decodeIncoming = Schema.decodeUnknownEffect(Incoming)
const submission = 'sub_ik_6582cbafc27e51d07440c6dbaad55c0c'

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
const admitWith = Effect.fn('Runtime.test.admitWith')(function* (http: HttpClient.HttpClient) {
  const context = yield* Layer.build(
    runtimeLayer.pipe(
      Layer.provide(Layer.merge(testConfigLayer, Layer.succeed(HttpClient.HttpClient, http))),
    ),
  )
  const runtime = yield* Runtime.pipe(Effect.provideContext(context))
  return yield* runtime.admit(admissionInput).pipe(Effect.result)
})

/** Classification is observed through the real Runtime Layer; only the remote HTTP transport varies. */
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
          const result = yield* admitWith(http)
          if (Result.isSuccess(result)) expect.fail('Non-202 response was admitted')
          expect(result.failure).toMatchObject({
            _tag: tag,
            reason,
            threadId: admissionInput.threadId,
          })
          expect(yield* Deferred.isDone(cancelled)).toBe(true)
        }).pipe(Effect.scoped),
    )
  }

  const requestFailures = [
    { reason: HttpClientError.EncodeError, tag: 'AdmissionRefused', expected: 'Encoding' },
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
        const result = yield* admitWith(http)
        if (Result.isSuccess(result)) expect.fail('Failed request was admitted')
        expect(result.failure).toMatchObject({
          _tag: failure.tag,
          reason: failure.expected,
          threadId: admissionInput.threadId,
        })
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
        Effect.provide(runtimeLayer.pipe(Layer.provide(Layer.merge(testConfigLayer, http)))),
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
                runtimeLayer.pipe(
                  Layer.provide(Layer.merge(testConfigLayer, transport(receiptId, message))),
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
              }),
            )
        }
      }).pipe(Effect.scoped),
    )
  }
})
