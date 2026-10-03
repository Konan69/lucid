import * as Effect from 'effect/Effect'
import { Workspace, type Appearance } from '@vivid/contracts'
import { requireActor, requireAdmin, requirePerson, type Actor } from '../auth/access.ts'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { AppearanceStore, appearanceOwnerOf } from './store.ts'

/** Vivid's name and look where the Actor is working: their own, or their Company's. */
const appearance = Effect.fn('Appearance.get')(function* (
  actor: Pick<Actor, 'person' | 'workspace'>,
) {
  return yield* (yield* AppearanceStore).get(appearanceOwnerOf(actor.person.id, actor.workspace))
})

export const appearanceHandlers = {
  /** Vivid reads it too: it is told the name the Person it acts for knows it by. */
  GetAppearance: Effect.fn('Rpc.GetAppearance')(function* () {
    return yield* appearance(yield* requireActor())
  }),
  WatchAppearance: () => live(appearance),
  /**
   * In a personal space the Person changes their own Vivid. In a Company everyone shares one, so
   * only an owner or admin may change it; a member's attempt is refused here, not hidden by a
   * client. Vivid itself never renames or recolours itself: this needs a signed-in Person.
   */
  SetAppearance: Effect.fn('Rpc.SetAppearance')(function* (request: Appearance) {
    const auth = yield* requirePerson()
    if (Workspace.guards.Company(auth.workspace)) yield* requireAdmin(auth.workspace)
    const saved = yield* (yield* AppearanceStore).set(
      appearanceOwnerOf(auth.person.id, auth.workspace),
      request,
    )
    // The Person's topic and, in a Company, the Company's: every open client there redraws.
    yield* changed(auth)
    return saved
  }),
}
