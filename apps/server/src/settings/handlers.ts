import * as Effect from 'effect/Effect'
import type { PatchSettingsRequest, ShareLocationRequest } from '@vivid/contracts'
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

/**
 * Where the Person is, sent by one of their own signed-in devices (`location.ts`). Vivid acting
 * for them may read it through `GetSettings` and never writes it, so this takes a Person and not
 * any actor. Every device's Settings hears the change, as for any other setting.
 */
export const locationHandlers = {
  ShareLocation: Effect.fn('Rpc.ShareLocation')(function* (request: ShareLocationRequest) {
    const auth = yield* requirePerson()
    const saved = yield* (yield* SettingsStore).shareLocation(auth.person.id, request.reading)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
    return saved
  }),
}
