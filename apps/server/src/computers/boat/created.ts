import { Config, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

const Record = Schema.Struct({ sandbox: Schema.Struct({ createdAt: Schema.String }) })
const decodeRecord = HttpClientResponse.schemaBodyJson(Record)

/** A machine made a little before the proof's own clock says it began is still the proof's:
 * the two clocks are different machines'. One the installation already had is days old. */
const CLOCKS_APART = 120_000

/**
 * Whether Boat's own record says a machine was created after a live proof began.
 *
 * It is evidence, not authority. Until 5 October 2026 the proofs deleted whatever machine their
 * Person was bound to; an installation that names its existing machine (`VIVID_BOAT_MACHINE`)
 * binds the Person to that one, so a proof would have deleted the only machine there is. A date
 * cannot say who created a machine, so it never decides a deletion by itself:
 * - `boat.live.test.ts` builds the provider in its own process, so it knows whether it was set
 *   to take an existing machine; it deletes only when it was not, and this agrees.
 * - `thread.live.test.ts` talks to a server with settings of its own and cannot know. It deletes
 *   nothing, and uses this to say that a machine was made and has to be removed by hand.
 * Anything that cannot be read or understood answers `false`.
 */
export const createdSince = Effect.fn('BoatLive.createdSince')(
  function* (id: string, began: number) {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(
      HttpClientRequest.get(`https://boat.dev/api/v1/sandboxes/${id}`).pipe(
        HttpClientRequest.bearerToken(yield* Config.Redacted('VIVID_BOAT_API_KEY')),
        HttpClientRequest.setHeader('Connection', 'close'),
      ),
    )
    if (response.status !== 200) return false
    const created = Date.parse((yield* decodeRecord(response)).sandbox.createdAt)
    return Number.isFinite(created) && created >= began - CLOCKS_APART
  },
  (effect) => effect.pipe(Effect.catch(() => Effect.succeed(false))),
)
