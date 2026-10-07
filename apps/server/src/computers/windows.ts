import { WindowOutcome, type UseWindowRequest } from '@vivid/contracts'
import { Effect, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import { DeviceRegistry } from './device.ts'

/**
 * Only one Working Run of this Person may use their own computer; this never falls back to
 * Vivid's Computer. The Device allowance is the whole permission, with no Gate or Approval:
 * the owner's decision is that it is their own machine and they already allowed it.
 */
export const computerWindow = Effect.fn('Computer.window')(function* (
  actor: Actor,
  request: UseWindowRequest,
) {
  const origin = yield* actionOrigin(actor).pipe(
    Effect.asSome,
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  if (Option.isNone(origin) || !ActionOrigin.guards.Run(origin.value))
    return WindowOutcome.cases.RunRequired.make({})
  return yield* (yield* DeviceRegistry).window({
    personId: actor.person.id,
    threadId: origin.value.threadId,
    runId: origin.value.runId,
    action: request.action,
  })
})
