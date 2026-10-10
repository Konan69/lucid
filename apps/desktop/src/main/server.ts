import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { ServerAddress, ServerChoice } from '../shared/settings.ts'
import type { DesktopSettings } from './settings.ts'

const decodeHealth = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ ok: Schema.Literal(true), service: Schema.Literal('vivid') }),
)

/** Verify the existing /health contract without treating an arbitrary web page as Vivid. */
export const probeServer = Effect.fn('DesktopServer.probe')(
  function* (origin: ServerAddress) {
    const response = yield* HttpClient.get(`${origin}/health`)
    if (response.status !== 200) return ServerChoice.cases.NotVivid.make({})
    return yield* decodeHealth(response).pipe(
      Effect.as(ServerChoice.cases.Chosen.make({})),
      Effect.catchTag('SchemaError', () => Effect.succeed(ServerChoice.cases.NotVivid.make({}))),
    )
  },
  (program) =>
    program.pipe(
      Effect.catchTag('HttpClientError', () =>
        Effect.succeed(
          ServerChoice.cases.Unreachable.make({ reason: 'The server could not be reached.' }),
        ),
      ),
      Effect.timeoutOption('3 seconds'),
      Effect.map(
        Option.getOrElse(() =>
          ServerChoice.cases.Unreachable.make({
            reason: 'The server did not respond within 3 seconds.',
          }),
        ),
      ),
    ),
)

/** Persist only verified origins; health probing uses no app cookies and follows no redirects. */
export const chooseServer = Effect.fn('DesktopServer.choose')(function* (
  origin: ServerAddress,
  settings: DesktopSettings['Service'],
) {
  const canonical = ServerAddress.make(new URL(origin).origin)
  const result = yield* probeServer(canonical).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'omit', redirect: 'error' }),
  )
  if (ServerChoice.guards.Chosen(result)) yield* settings.set(canonical)
  return result
})
