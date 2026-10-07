import { describe, expect, it, layer } from '@effect/vitest'
import { ChannelAddress } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Redacted, Ref, Result, Schema, Predicate } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { photonLayer } from './photon.ts'
import { ChannelProvider, ChannelEnrolmentId } from './provider.ts'

const credentials = { projectId: 'test-project', projectSecret: Redacted.make('test-secret') }
const address = ChannelAddress.make('+12025550123')
const decodeCreate = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, phoneNumber: Schema.String })),
)
const success = {
  succeed: true,
  data: { id: 'enrolled-person', assignedPhoneNumber: '+12025550100' },
}

/** Real provider methods run against HTTP transport stubs; consuming inbound is deliberately excluded. */
const configuredPhoton = photonLayer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        VIVID_PHOTON_PROJECT_ID: credentials.projectId,
        VIVID_PHOTON_PROJECT_SECRET: Redacted.value(credentials.projectSecret),
      }),
    ),
  ),
)

/** The real HTTP adapter talks to a transport stub, never Photon's hosted service. */
const transport = (status: number, body: Schema.Json) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    ),
  )

describe('Photon Stable enrolment protocol', () => {
  it.effect(
    'uses Basic auth, shared enrolment and the provider-assigned line, and deletes by its user id',
    () =>
      Effect.gen(function* () {
        const requests = yield* Ref.make<
          ReadonlyArray<{ method: string; url: string; authorization: string }>
        >([])
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            const authorization = request.headers.authorization
            if (authorization === undefined)
              return yield* Effect.sync(() => expect.fail('Missing Basic auth'))
            if (request.method === 'POST') {
              const body = request.body
              if (!Predicate.isTagged(body, 'Uint8Array'))
                return yield* Effect.sync(() => expect.fail('Missing JSON enrolment body'))
              expect(decodeCreate(new TextDecoder().decode(body.body))).toEqual({
                type: 'shared',
                phoneNumber: address,
              })
            }
            yield* Ref.update(requests, (all) => [
              ...all,
              {
                method: request.method,
                url: request.url,
                authorization,
              },
            ])
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify(
                  request.method === 'POST'
                    ? success
                    : { succeed: true, data: { userId: 'enrolled-person' } },
                ),
                { status: 200 },
              ),
            )
          }),
        )
        const layer = configuredPhoton.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        )
        yield* Effect.gen(function* () {
          const caseContext = yield* Layer.build(layer)
          return yield* Effect.gen(function* () {
            const enrolment = yield* ChannelProvider
            expect(yield* enrolment.enrol('iMessage', address)).toEqual({
              id: 'enrolled-person',
              textTo: '+12025550100',
            })
            yield* enrolment.unenrol('iMessage', ChannelEnrolmentId.make('enrolled-person'))
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped)
        expect((yield* Ref.get(requests)).map((request) => [request.method, request.url])).toEqual([
          ['POST', 'https://spectrum.photon.codes/projects/test-project/users/'],
          ['DELETE', 'https://spectrum.photon.codes/projects/test-project/users/enrolled-person/'],
        ])
        expect(
          (yield* Ref.get(requests)).every(
            (request) => request.authorization === `Basic ${btoa('test-project:test-secret')}`,
          ),
        ).toBe(true)
      }),
  )

  layer(
    configuredPhoton.pipe(
      Layer.provide(transport(200, { succeed: true, data: { id: 'private-provider-payload' } })),
    ),
  )((it) => {
    it.effect(
      'decodes malformed success as provider failure without returning provider payload',
      () =>
        Effect.gen(function* () {
          const result = yield* (yield* ChannelProvider)
            .enrol('iMessage', address)
            .pipe(Effect.result)
          expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
            'ChannelProviderFailed',
          )
          expect(JSON.stringify(result)).not.toContain('private-provider-payload')
        }).pipe(Effect.scoped),
    )
  })

  layer(configuredPhoton.pipe(Layer.provide(transport(403, { error: 'private-refusal' }))))(
    (it) => {
      it.effect('a provider refusal remains typed and contains no response body', () =>
        Effect.gen(function* () {
          const result = yield* (yield* ChannelProvider)
            .enrol('iMessage', address)
            .pipe(Effect.result)
          expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
            'ChannelProviderFailed',
          )
          expect(JSON.stringify(result)).not.toContain('private-refusal')
        }).pipe(Effect.scoped),
      )
    },
  )

  layer(configuredPhoton.pipe(Layer.provide(transport(404, {}))))((it) => {
    it.effect('an already-deleted provider user can be disconnected idempotently', () =>
      Effect.gen(function* () {
        yield* (yield* ChannelProvider).unenrol(
          'iMessage',
          ChannelEnrolmentId.make('deleted-person'),
        )
      }).pipe(Effect.scoped),
    )
  })

  layer(
    photonLayer.pipe(
      Layer.provide(transport(200, success)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VIVID_PHOTON_PROJECT_ID: 'test-project',
            VIVID_PHOTON_PROJECT_SECRET: 'test-secret',
          }),
        ),
      ),
    ),
  )((it) => {
    it.effect(
      'both credentials configure iMessage without a global number or opening the Spectrum stream',
      () =>
        Effect.gen(function* () {
          const provider = yield* ChannelProvider
          expect(provider.channels.includes('iMessage')).toBe(true)
          expect(provider.channels.includes('WhatsApp')).toBe(false)
          expect(yield* provider.enrol('iMessage', address)).toEqual({
            id: 'enrolled-person',
            textTo: '+12025550100',
          })
        }).pipe(Effect.scoped),
    )
  })
})
