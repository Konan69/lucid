import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { ApprovalId, DecideApprovalRequest } from '@vivid/contracts'
import { requireActor, requirePerson, type Actor } from '../auth/access.ts'
import { InputStore } from '../inputs/store.ts'
import { changed, Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { ApprovalStore } from './store.ts'

/** Both inbox entry points read the same addressed records in the Actor's current workspace. */
const loadInbox = Effect.fn('Inbox.load')(function* (actor: Actor) {
  return {
    approvals: yield* (yield* ApprovalStore).inbox(actor),
    requests: yield* (yield* InputStore).inbox(actor),
  }
})

/** A Run cannot answer or withdraw its own request for authorization. */
const decidingPerson = Effect.fn('Approvals.person')(function* () {
  const auth = yield* requirePerson()
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
  } satisfies Actor
})

export const approvalHandlers = {
  GetInbox: Effect.fn('Rpc.GetInbox')(function* () {
    return yield* loadInbox(yield* requireActor())
  }),
  WatchInbox: () => live(loadInbox),
  /** The digest and pending claim are enforced in the store before any execution. */
  DecideApproval: Effect.fn('Rpc.DecideApproval')(function* (request: DecideApprovalRequest) {
    return { approval: yield* (yield* ApprovalStore).decide(yield* decidingPerson(), request) }
  }),
  /** Withdrawal publishes the settled Thread and addressed Person without executing anything. */
  WithdrawApproval: Effect.fn('Rpc.WithdrawApproval')(function* ({
    id,
  }: {
    readonly id: ApprovalId
  }) {
    const actor = yield* decidingPerson()
    const threadId = yield* (yield* ApprovalStore).withdraw(actor, id)
    yield* changed(actor, Topic.thread(threadId))
  }),
}
