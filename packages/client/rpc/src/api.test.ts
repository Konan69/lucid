import { describe, expect, it } from '@effect/vitest'
import { Unauthenticated } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { VividClient } from './api.js'

/** A transport that answers every request with one canned response and records what was asked. */
const transport = (respond: (url: string) => Response) => {
  const seen: Array<string> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(`${request.method} ${request.url}`)
        return HttpClientResponse.fromWeb(request, respond(request.url))
      }),
    ),
  )
  return { seen, layer }
}

/** A JSON response from wire text, so each test states exactly what the server sent. */
const json = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

// Failures travel as their own encoded form; encoding the real class keeps the fixture honest.
const encodeUnauthenticated = Schema.encodeSync(Schema.fromJsonString(Unauthenticated))

describe('VividClient', () => {
  it.effect('derives the request and decodes the response from the shared API declaration', () => {
    const { seen, layer } = transport(() =>
      json(200, '{"person":{"id":"p1","name":"Ada","email":"ada@example.com","image":null}}'),
    )
    return Effect.gen(function* () {
      const client = yield* VividClient
      const me = yield* client.vivid.me()
      expect(me.person.name).toBe('Ada')
      expect(seen).toEqual(['GET https://vivid.test/api/me'])
    }).pipe(
      Effect.provide(
        VividClient.layer({ baseUrl: 'https://vivid.test' }).pipe(Layer.provide(layer)),
      ),
    )
  })

  it.effect('decodes a declared failure into its tagged error, not a status code', () => {
    const { layer } = transport(() =>
      json(401, encodeUnauthenticated(new Unauthenticated({ message: 'Invalid session' }))),
    )
    return Effect.gen(function* () {
      const client = yield* VividClient
      const failure = yield* client.vivid.me().pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Unauthenticated)
    }).pipe(
      Effect.provide(
        VividClient.layer({ baseUrl: 'https://vivid.test' }).pipe(Layer.provide(layer)),
      ),
    )
  })
})
