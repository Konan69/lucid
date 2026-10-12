import { Effect, Option } from 'effect'
import type { SaveDraftRequest } from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { DraftStore } from './store.ts'

/** Both RPCs use the same Person/workspace loader; SQL rows are decoded by the store. */
const load = Effect.fn('Drafts.load')(function* (actor: Actor) {
  return yield* (yield* DraftStore).list(actor)
})

export const draftHandlers = {
  /** Session authority is re-resolved before each live load by the house live helper. */
  WatchDrafts: () => live('WatchDrafts', load),
  /** RPC middleware decodes SaveDraftRequest; only the signed-in Person may keep unsent words. */
  SaveDraft: Effect.fn('Rpc.SaveDraft')(function* (request: SaveDraftRequest) {
    const auth = yield* requirePerson()
    const actor: Actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'person',
      threadId: Option.none(),
    }
    return yield* (yield* DraftStore).save(actor, request)
  }),
}
