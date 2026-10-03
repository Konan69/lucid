import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Layer, Predicate, Result, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  LibraryFolderId,
  PersonId,
  RuntimeRunRequest,
  ThreadId,
  ThreadOrigin,
} from '@vivid/contracts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import { Runtime, runtimeLayer, type RuntimeMessage } from './client.ts'

const Incoming = Schema.fromJsonString(
  Schema.Struct({ ...RuntimeRunRequest.fields, initialData: ThreadOrigin }),
)
const decodeIncoming = Schema.decodeUnknownEffect(Incoming)
const submission = 'sub_ik_6582cbafc27e51d07440c6dbaad55c0c'

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

/** The expected submission vector follows Flue 2.1's frozen protocol, without importing private SDK helpers. */
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
          else expect(Result.isFailure(result) && result.failure._tag).toBe('RuntimeUnavailable')
        }
      }).pipe(Effect.scoped),
    )
  }
})
