import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { CreateRuleRequest, RuleId } from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { RuleStore } from './store.ts'

/** Live reads use the rule store's ownership predicate. */
const loadRules = Effect.fn('Rules.load')(function* (actor: Actor) {
  return { rules: yield* (yield* RuleStore).list(actor) }
})

/** Policy management is reserved to a signed-in Person, never a Run. */
const ruleActor = Effect.fn('Rules.person')(function* () {
  const auth = yield* requirePerson()
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  } satisfies Actor
})

export const ruleHandlers = {
  WatchRules: () => live('WatchRules', [], loadRules),
  /** The store commits policy, its audit entry and the notice in one transaction. */
  CreateRule: Effect.fn('Rpc.CreateRule')(function* (request: CreateRuleRequest) {
    const actor = yield* ruleActor()
    const rule = yield* (yield* RuleStore).create(actor, request)
    return { rule }
  }),
  /** Removal reuses the same authorization as creation. */
  DeleteRule: Effect.fn('Rpc.DeleteRule')(function* ({ id }: { readonly id: RuleId }) {
    const actor = yield* ruleActor()
    yield* (yield* RuleStore).remove(actor, id)
  }),
}
