import { expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted, Result } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { ServerBuild, PersonId, ThreadId, emptyConversation } from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { RuntimeRejected, RuntimeTransportFailed, Runtime, runtimeLayer } from './client.ts'

const personId = PersonId.make('reader-person')
const threadId = ThreadId.make('reader-thread')
const config = Layer.succeed(ServerConfig, {
  BUILD: ServerBuild.cases.Unnamed.make({}),
  DATABASE_URL: Redacted.make('postgres://unused.invalid/unused'),
  AUTH_SECRET: Redacted.make('test-Auth_secret-0123456789-ABCDEFG'),
  RUNTIME_URL: new URL('https://runtime.example.test'),
  RUNTIME_TOKEN: Redacted.make('test-runtime-token'),
  PORT: 8787,
  PUBLIC_URL: new URL('https://vivid.example.test'),
  GOOGLE_OAUTH: {
    clientId: 'unused',
    clientSecret: Redacted.make('unused'),
    redirectUri: new URL('https://vivid.example.test/google'),
  },
})

/** The real client constructs and decodes the route; only the remote response varies. */
const read = (body: string, status: number) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      runtimeLayer.pipe(
        Layer.provide([
          config,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                expect(request.url).toBe(
                  'https://runtime.example.test/persons/reader-person/threads/reader-thread/state',
                )
                expect(request.headers.accept).toBe('application/json')
                return HttpClientResponse.fromWeb(request, new Response(body, { status }))
              }),
            ),
          ),
        ]),
      ),
    )
    const runtime = yield* Runtime.pipe(Effect.provideContext(context))
    return yield* runtime.conversation(personId, threadId).pipe(Effect.result)
  }).pipe(Effect.scoped)

it.effect('reads the projected conversation under the creator Person', () =>
  Effect.gen(function* () {
    const result = yield* read(JSON.stringify(emptyConversation), 200)
    expect(Result.isSuccess(result) && result.success).toEqual(emptyConversation)
  }),
)

it.effect('preserves runtime refusal separately from unreadable state', () =>
  Effect.gen(function* () {
    const refusal = yield* read(JSON.stringify({ error: 'UnknownThread' }), 404)
    expect(Result.isFailure(refusal) && refusal.failure).toMatchObject(
      RuntimeRejected.make({ personId, threadId, refusal: { error: 'UnknownThread' } }),
    )
    const unreadable = yield* read(JSON.stringify({ messages: [] }), 200)
    expect(Result.isFailure(unreadable) && unreadable.failure).toMatchObject(
      RuntimeTransportFailed.make({ personId, threadId }),
    )
  }),
)
