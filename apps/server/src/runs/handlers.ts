import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  Forbidden,
  NotFound,
  type ChildRun,
  type ChildRunRequest,
  type FollowUpChildRunRequest,
  type SettleChildRunRequest,
  type SpawnChildRunRequest,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { requireVivid } from '../auth/access.ts'
import { requireThread } from '../threads/access.ts'
import { ChildRuns } from './store.ts'

const missing = () => new NotFound({ message: 'Helper not found.' })

/** A helper by id, for a caller who can see its Thread. Another Thread's helper is not found. */
const visible = Effect.fn('Helpers.visible')(function* (id: ChildRun['id']) {
  const auth = yield* AuthContext
  if (AuthState.$is('Runtime')(auth)) return yield* missing()
  const run = yield* (yield* ChildRuns).find(id)
  if (Option.isNone(run)) return yield* missing()
  yield* requireThread(run.value.threadId, auth.person.id).pipe(Effect.mapError(missing))
  // Vivid and a helper only ever reach the helpers of the Thread they act in.
  if (!AuthState.$is('Person')(auth) && auth.threadId !== run.value.threadId)
    return yield* missing()
  return { auth, run: run.value }
})

export const childHandlers = {
  /** Only Vivid's own call, never a helper's: helpers do not start helpers. */
  SpawnChildRun: Effect.fn('Rpc.SpawnChildRun')(function* (request: SpawnChildRunRequest) {
    const auth = yield* requireVivid()
    return yield* (yield* ChildRuns).spawn(
      { personId: auth.person.id, threadId: auth.threadId },
      request,
    )
  }),
  /** The runtime reports as Vivid in the helper's Thread, for the Person its parent acts for. */
  SettleChildRun: Effect.fn('Rpc.SettleChildRun')(function* (request: SettleChildRunRequest) {
    const auth = yield* requireVivid()
    return yield* (yield* ChildRuns).settle(
      { personId: auth.person.id, threadId: auth.threadId },
      request.id,
      request.report,
    )
  }),
  GetChildRun: Effect.fn('Rpc.GetChildRun')(function* ({ id }: ChildRunRequest) {
    const { run } = yield* visible(id)
    return yield* (yield* ChildRuns).detail(run)
  }),
  /**
   * Any Person who may stop the Thread may stop its helper (scope decision 6). Vivid may stop the
   * helpers its own Person's Runs started there. A helper may not stop helpers.
   */
  CancelChildRun: Effect.fn('Rpc.CancelChildRun')(function* ({ id }: ChildRunRequest) {
    const { auth, run } = yield* visible(id)
    const helpers = yield* ChildRuns
    if (AuthState.$is('Person')(auth)) return yield* helpers.cancel(run, 'Person')
    if (!AuthState.$is('Vivid')(auth))
      return yield* new Forbidden({ message: 'A helper cannot stop helpers.' })
    const person = yield* helpers.actingFor(id)
    if (!Option.contains(person, auth.person.id)) return yield* missing()
    return yield* helpers.cancel(run, 'Vivid')
  }),
}

/**
 * Following up a helper, in its own RPC group (`rpc/server.ts`): any Person who may stop the
 * Thread may send its helper a follow-up, and Vivid may for the Person its own Runs act for. A
 * helper may not follow up helpers.
 */
export const followUpHandlers = {
  FollowUpChildRun: Effect.fn('Rpc.FollowUpChildRun')(function* ({
    id,
    message,
    key,
  }: FollowUpChildRunRequest) {
    const { auth, run } = yield* visible(id)
    const helpers = yield* ChildRuns
    if (AuthState.$is('Person')(auth))
      return yield* helpers.followUp(run, { message, key, by: 'Person' })
    if (!AuthState.$is('Vivid')(auth))
      return yield* new Forbidden({ message: 'A helper cannot follow up helpers.' })
    const person = yield* helpers.actingFor(id)
    if (!Option.contains(person, auth.person.id)) return yield* missing()
    return yield* helpers.followUp(run, { message, key, by: 'Vivid' })
  }),
}
