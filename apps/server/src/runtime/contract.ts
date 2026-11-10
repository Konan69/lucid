import { CodeName, ContractFingerprint, RuntimeContract } from '@vivid/contracts'
import { contractFingerprint } from '@vivid/contracts/fingerprint'
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as HttpClient from 'effect/http/HttpClient'
import { ServerConfig } from '../config.ts'
import { cellNodes } from './transport.ts'

/**
 * How this server's wire contract stands against the published cells' (`GET /contract`).
 *
 * - `Matched`: the cells were built from this server's wire schemas.
 * - `Mismatched`: they answered another fingerprint, so any send they cannot read is refused.
 * - `Unanswered`: they answered without a fingerprint. The Worker published before `/contract`
 *   existed answers 400, which is what production's Worker of 30 October 2026 would say.
 * - `Unreachable`: no answer at all; `failure` is the HTTP client's reason.
 */
export const CellContractReading = Schema.TaggedUnion({
  Matched: {},
  Mismatched: { server: ContractFingerprint, cells: ContractFingerprint },
  Unanswered: { status: Schema.Int },
  Unreachable: { failure: CodeName },
})
export type CellContractReading = typeof CellContractReading.Type

/**
 * Whether the cells this server sends to read the same wire. The server's `/health` answers
 * not-ready on anything but `Matched`, so Railway keeps the previous deployment serving and marks
 * this one FAILED instead of letting it fail every send, as it did from 8 November 2026 when the
 * Worker publish never ran and nothing checked.
 *
 * Strict equality, unlike the cell's own decode-first rule (`packages/agent/runtime/src/app.ts`
 * `admissionBody`): this check runs while the new server is not yet taking traffic, after the
 * pre-deploy step published the Worker from the same commit (`infra/railway.ts`), so the only
 * honest answer for a pair built from different schemas is "not this deployment".
 */
export class CellContract extends Context.Service<
  CellContract,
  { readonly read: Effect.Effect<CellContractReading> }
>()('vivid/CellContract') {}

/**
 * Asks the cells on each read until they once match, then answers `Matched` without asking: this
 * process's fingerprint never changes, and a Worker of another build is published only with
 * another server. Railway polls `/health` from start until it answers or its timeout ends, so the
 * first reads are the startup check, and a Worker still propagating is read again on the next
 * poll rather than on a timer here.
 */
export const cellContractLayer = Layer.effect(
  CellContract,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const http = cellNodes(yield* HttpClient.HttpClient, config.RUNTIME_URLS)
    const request = HttpClientRequest.get(new URL('/contract', config.RUNTIME_URLS[0])).pipe(
      HttpClientRequest.bearerToken(Redacted.value(config.RUNTIME_TOKEN)),
    )
    const matched = yield* Ref.make(false)
    /** One `GET /contract`; the body is read only from a 200, as the route answers it. */
    const ask = Effect.fn('Runtime.contract')(function* () {
      const response = yield* http.execute(request)
      if (response.status !== 200)
        return CellContractReading.cases.Unanswered.make({ status: response.status })
      const answer = yield* HttpClientResponse.schemaBodyJson(RuntimeContract)(response).pipe(
        Effect.option,
      )
      return Option.match(answer, {
        onNone: () => CellContractReading.cases.Unanswered.make({ status: response.status }),
        onSome: ({ contract }) =>
          contract === contractFingerprint
            ? CellContractReading.cases.Matched.make({})
            : CellContractReading.cases.Mismatched.make({
                server: contractFingerprint,
                cells: contract,
              }),
      })
    }, Effect.scoped)
    const read = Effect.gen(function* () {
      if (yield* Ref.get(matched)) return CellContractReading.cases.Matched.make({})
      const reading = yield* ask().pipe(
        Effect.catchTag('HttpClientError', (error) =>
          Effect.succeed(
            CellContractReading.cases.Unreachable.make({
              failure: CodeName.make(error.reason._tag),
            }),
          ),
        ),
      )
      if (CellContractReading.guards.Matched(reading)) yield* Ref.set(matched, true)
      else yield* Effect.logError('The cells do not read this server’s wire contract', reading)
      return reading
    })
    return CellContract.of({ read })
  }),
)
