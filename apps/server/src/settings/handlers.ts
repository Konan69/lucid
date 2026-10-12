import * as Effect from 'effect/Effect'
import type { PatchSettingsRequest } from '@vivid/contracts'
import { requireActor, requirePerson, type Actor } from '../auth/access.ts'
import { Changes, Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { SettingsStore } from './store.ts'

/** Settings are a Person's own and the same in every workspace. */
const settings = Effect.fn('Settings.get')(function* (actor: Pick<Actor, 'person'>) {
  return yield* (yield* SettingsStore).get(actor.person.id)
})

export const settingsHandlers = {
  /** Vivid reads them too: the acting Person's time zone decides what "tomorrow at 9" means. */
  GetSettings: Effect.fn('Rpc.GetSettings')(function* () {
    return yield* settings(yield* requireActor())
  }),
  WatchSettings: () => live('WatchSettings', [], settings),
  PatchSettings: Effect.fn('Rpc.PatchSettings')(function* (request: PatchSettingsRequest) {
    const auth = yield* requirePerson()
    const saved = yield* (yield* SettingsStore).patch(auth.person.id, request)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
    return saved
  }),
}
