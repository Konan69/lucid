import { useAtomValue } from '@effect/atom-react'
import { ApprovalDecision, type DecideApprovalRequest } from '@vivid/contracts'
import { allowing, responding, type makeLive } from '@vivid/state'
import { Effect, Layer, Option, Result } from 'effect'
import { makeDeviceDecisions } from './devices'
import { makeIntegrationAnswers } from './filling'
import { confirm, warn } from './haptics'
import { useLiveData, useLiveValue, type LiveData } from './live'

/**
 * Deciding an Approval from the Feed and from Notifications (`allowing`, `@vivid/state`), one
 * machine for the session, as a computer's access is (`devices.ts`). The web does the same
 * (`apps/web/src/data/approvals.ts`).
 */
export const makeApprovalDecisions = (engine: ReturnType<typeof makeLive>) => {
  const decisions = allowing.make(
    Layer.succeed(allowing.Sending, {
      send: Effect.fn('Approvals.decide')(function* (request: DecideApprovalRequest) {
        const result = yield* engine.change((client) => client.DecideApproval(request))
        if (Result.isFailure(result))
          return yield* new allowing.Refused({
            id: request.id,
            refusal: responding.refusalOf(result.failure),
          })
      }),
    }),
  )
  engine.registry.mount(decisions.reading)
  // What waits on the Person in every Thread (`WatchInbox`): the Approvals these decide.
  return { ...decisions, inbox: engine.query((client) => client.WatchInbox()) }
}

/**
 * The session's decision machines: a computer's access, an Approval away from its Thread, and an
 * answer to an Integration's question (`filling.ts`), each of which outlives what pressed it.
 */
export const makeDecisions = (engine: ReturnType<typeof makeLive>) => ({
  devices: makeDeviceDecisions(engine),
  approvals: makeApprovalDecisions(engine),
  filling: makeIntegrationAnswers(engine),
})

/** The Feed and Notifications read the same attempt, and its refusal, wherever it was pressed. */
export const useApprovalDecision = () => {
  const data = useLiveData()
  return useAtomValue(data.approvals.reading)
}

/** A yes is felt as a yes and a no as a no, as in the Thread (`Chat.tsx`). */
export const decideApproval = (data: LiveData, request: DecideApprovalRequest) => {
  if (ApprovalDecision.guards.Deny(request.decision)) warn()
  else confirm()
  data.registry.set(data.approvals.send, data.approvals.decide({ request }))
}

/** Every Approval waiting on the Person (`WatchInbox`), as the server last said. */
export const useInbox = () => {
  const data = useLiveData()
  return Option.match(useLiveValue(data.approvals.inbox), {
    onNone: () => [],
    onSome: (held) => held.approvals,
  })
}

/**
 * The Approvals waiting on the Person, less any decided here: one decided is never pending again,
 * so it leaves at once rather than when the inbox next answers.
 */
export const useWaitingApprovals = () => {
  const reading = useApprovalDecision()
  return useInbox().filter((approval) => !allowing.sentOn(reading, approval.id))
}
