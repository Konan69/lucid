import { Activities } from '../activity/service.ts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { DecideApprovalRequest } from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { InputStore } from '../inputs/store.ts'
import { handoffsWaiting } from '../inputs/handoff.ts'
import { live } from '../live/query.ts'
import { ApprovalStore } from './store.ts'

/** The live inbox reads addressed records in the Actor's current workspace. */
export const loadInbox = Effect.fn('Inbox.load')(function* (actor: Actor) {
  return {
    approvals: yield* (yield* ApprovalStore).inbox(actor),
    requests: yield* (yield* InputStore).inbox(actor),
    handoffs: yield* handoffsWaiting(actor),
  }
})

/** A Run cannot answer its own request for authorization. */
const decidingPerson = Effect.fn('Approvals.person')(function* () {
  const auth = yield* requirePerson()
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  } satisfies Actor
})

export const approvalHandlers = {
  WatchInbox: () => live('WatchInbox', ['activity'], loadInbox),
  /** The digest and pending claim are enforced in the store before any execution. */
  DecideApproval: Effect.fn('Rpc.DecideApproval')(function* (request: DecideApprovalRequest) {
    const actor = yield* decidingPerson()
    const approval = yield* (yield* ApprovalStore).decide(actor, request)
    yield* (yield* Activities)
      .refresh(actor.person.id)
      .pipe(Effect.catch(() => Effect.logWarning('Live Activity refresh failed')))
    return { approval }
  }),
}
