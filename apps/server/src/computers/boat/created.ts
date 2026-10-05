import { Config, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

const Record = Schema.Struct({ sandbox: Schema.Struct({ createdAt: Schema.String }) })
const decodeRecord = HttpClientResponse.schemaBodyJson(Record)

/** A machine made a little before the proof's own clock says it began is still the proof's:
 * the two clocks are different machines'. One the installation already had is days old. */
const CLOCKS_APART = 120_000

/**
 * Whether a live proof itself made a Boat machine: Boat's own record says it was created after
 * the proof began. This is the only ground on which a proof may delete a machine.
 *
 * Until 5 October 2026 the proofs deleted whatever machine their Person was bound to. An
 * installation that names its existing machine (`VIVID_BOAT_MACHINE`) binds the Person to that
 * one, so the proof would have deleted the only machine there is; and the proof's own settings
 * cannot be trusted to say which case it is in, because the server it talks to has its own.
 * Anything that cannot be read or understood answers `false`: when in doubt nothing is deleted.
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
