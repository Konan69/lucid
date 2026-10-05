import * as NodeCrypto from 'node:crypto'
import { InvalidRequest } from '@vivid/contracts'
import { Effect, Redacted, Schema } from 'effect'
import { ExecutorReferences, ExecutorStep } from './executor.ts'

const State = Schema.String.check(Schema.isMinLength(32))
const decodeState = Schema.decodeUnknownEffect(State)

/** Executor's implementation/oauth.ts pendingAttempt hashes opaque one-time state to find an
 * encrypted OAuth attempt. Treat that correlation as secret-bearing authority: persist only its
 * SHA-256 digest, never its raw value, authorization URL, code, or PKCE material.
 */
export const callbackHash = Effect.fn('Connections.callbackHash')(function* (
  address: Redacted.Redacted,
) {
  const value = Redacted.value(address)
  if (!URL.canParse(value))
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Integration sign-in return is invalid.' }),
    )
  const states = new URL(value).searchParams.getAll('state')
  const state = yield* decodeState(states.length === 1 ? states[0] : null).pipe(
    Effect.mapError(
      () => new InvalidRequest({ message: 'Integration sign-in return is invalid.' }),
    ),
  )
  return NodeCrypto.createHash('sha256').update(state).digest('hex')
})

/** Correlation belongs to the successful browser step, not to an unstarted or lost OAuth request. */
export const correlateSignIn = Effect.fn('Connections.correlateSignIn')(function* (
  step: typeof ExecutorStep.Type,
) {
  if (!ExecutorStep.guards.OpenSignIn(step)) return step
  const stateHash = yield* callbackHash(Redacted.make(step.address))
  const references = step.references
  return ExecutorStep.cases.OpenSignIn.make({
    address: step.address,
    references: ExecutorReferences.cases.OAuthSigningIn.make({
      service: references.service,
      app: references.app,
      profile: references.profile,
      owner: references.owner,
      appOwnership: references.appOwnership,
      authorization: references.authorization,
      stateHash,
    }),
  })
})
