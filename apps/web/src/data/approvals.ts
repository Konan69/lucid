import { useAtomValue } from '@effect/atom-react'
import type { DecideApprovalRequest } from '@vivid/contracts'
import { allowing } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { engine } from './runtime'

/**
 * Deciding an Approval from the Feed and from Notifications (`allowing`, `@vivid/state`). The
 * server's typed refusals say why nothing ran: what it was for changed (#167), or it ran out.
 */
const decisions = allowing.make(
  Layer.succeed(allowing.Sending, {
    send: Effect.fn('Approvals.decide')(function* (request: DecideApprovalRequest) {
      const result = yield* changing((client) => client.DecideApproval(request))
      if (Result.isFailure(result))
        return yield* new allowing.Refused({
          id: request.id,
          refusal: allowing.refusalOf(result.failure),
        })
    }),
  }),
)

// A decision outlives the popover or card that pressed it, so its refusal is still said there.
engine.registry.mount(decisions.reading)

/** Every surface that decides an Approval away from its Thread reads the same attempt. */
export const useApprovalDecision = () => useAtomValue(decisions.reading)

/** The machine takes a press only while no other decision is on its way. */
export const decideApproval = (request: DecideApprovalRequest) =>
  engine.registry.set(decisions.send, decisions.decide({ request }))
