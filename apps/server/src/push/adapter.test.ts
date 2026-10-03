import * as NodeCrypto from 'node:crypto'
import { expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Predicate, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { NotificationId, PushDestination, PushPayload, ThreadId } from '@vivid/contracts'
import { PushAdapter, pushAdapterLayer } from './adapter.ts'
import { PushConfig } from './config.ts'
import { PushAcceptance } from './receipts.ts'
import { testPushConfig } from './testing.ts'

const payload = PushPayload.make({
  notificationId: NotificationId.make('notification'),
  title: 'Meeting clash',
  body: 'Choose which meeting to move.',
  threadId: ThreadId.make('thread'),
})
const phone = PushDestination.cases.Phone.make({ token: 'ExpoPushToken[test-device]' })
const ExpoWire = Schema.Struct({
  to: Schema.String,
  title: Schema.String,
  body: Schema.String,
  sound: Schema.Literal('default'),
  data: PushPayload,
})
const decodeExpo = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoWire))

/** Encryption remains real; only provider HTTP responses are controlled at the narrow adapter. */
it.effect(
  'encrypts Web Push with VAPID and classifies expired authority without following redirects',
  () =>
    Effect.gen(function* () {
      const curve = NodeCrypto.createECDH('prime256v1')
      curve.generateKeys()
      const destination = PushDestination.cases.Browser.make({
        endpoint: 'https://fcm.googleapis.com/push/test',
        keys: {
          p256dh: curve.getPublicKey().toString('base64url'),
          auth: NodeCrypto.randomBytes(16).toString('base64url'),
        },
      })
      for (const status of [201, 410, 302]) {
        const transport = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              expect(request.url).toBe(destination.endpoint)
              expect(request.headers['content-encoding']).toBe('aes128gcm')
              expect(request.headers.authorization).toContain('vapid ')
              if (!Predicate.isTagged(request.body, 'Uint8Array'))
                return expect.fail('Expected encrypted Web Push body')
              expect(Buffer.from(request.body.body).toString()).not.toContain(payload.body)
              return HttpClientResponse.fromWeb(request, new Response(null, { status }))
            }),
          ),
        )
        const result = yield* Effect.gen(function* () {
          return yield* (yield* PushAdapter).send(destination, payload).pipe(Effect.result)
        }).pipe(
          Effect.provide(pushAdapterLayer),
          Effect.provide(transport),
          Effect.provideService(PushConfig, testPushConfig),
        )
        if (status === 201)
          expect(result).toEqual(Result.succeed(PushAcceptance.cases.Browser.make({})))
        else
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            status === 410 ? 'PushTargetGone' : 'PushRejected',
          )
      }
    }),
)

/** Validate the documented Expo ticket and late receipt protocols, including malformed responses. */
it.effect(
  'sends the Expo v2 payload without Person identifiers and decodes tickets and gone receipts',
  () =>
    Effect.gen(function* () {
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (!Predicate.isTagged(request.body, 'Uint8Array'))
              return expect.fail('Expected Expo JSON body')
            const data = yield* decodeExpo(new TextDecoder().decode(request.body.body)).pipe(
              Effect.catchTag('SchemaError', () =>
                Effect.sync(() => expect.fail('Invalid Expo request')),
              ),
            )
            expect(data).toEqual({
              to: phone.token,
              title: payload.title,
              body: payload.body,
              sound: 'default',
              data: payload,
            })
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket' } })),
            )
          }),
        ),
      )
      const receiptTransport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.url).toBe('https://exp.host/--/api/v2/push/getReceipts')
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  data: {
                    ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } },
                  },
                }),
              ),
            )
          }),
        ),
      )
      const acceptance = yield* Effect.gen(function* () {
        return yield* (yield* PushAdapter).send(phone, payload)
      }).pipe(
        Effect.provide(pushAdapterLayer),
        Effect.provide(transport),
        Effect.provideService(PushConfig, testPushConfig),
      )
      expect(acceptance).toEqual(
        PushAcceptance.cases.Phone.make({ ticket: 'ticket', confirmed: false }),
      )
      const receipt = yield* Effect.gen(function* () {
        return yield* (yield* PushAdapter).receipt('ticket')
      }).pipe(
        Effect.provide(pushAdapterLayer),
        Effect.provide(receiptTransport),
        Effect.provideService(PushConfig, testPushConfig),
      )
      expect(receipt).toEqual(Option.some('Gone'))
    }),
)

/** A lost response may have sent: the ten-second deadline reports uncertainty, never retries. */
it.effect('times out a pending provider using TestClock and reports the send as uncertain', () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    )
    const result = yield* Effect.gen(function* () {
      const adapter = yield* PushAdapter
      const pending = yield* adapter.send(phone, payload).pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(requested)
      yield* TestClock.adjust('10 seconds')
      return yield* Fiber.join(pending)
    }).pipe(
      Effect.provide(pushAdapterLayer),
      Effect.provide(transport),
      Effect.provideService(PushConfig, testPushConfig),
    )
    expect(Result.isFailure(result) && result.failure._tag).toBe('PushUncertain')
  }),
)
