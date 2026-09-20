import * as Effect from 'effect/Effect'
import type { PatchSettingsRequest } from '@vivid/contracts'
import { requirePerson } from '../auth/session.ts'
import { SettingsStore } from './store.ts'

export const getSettings = Effect.fn('Api.getSettings')(function* () {
  const auth = yield* requirePerson()
  const store = yield* SettingsStore
  return yield* store.get(auth.person.id)
})
export const patchSettings = Effect.fn('Api.patchSettings')(function* (payload: PatchSettingsRequest) {
  const auth = yield* requirePerson()
  const store = yield* SettingsStore
  return yield* store.patch(auth.person.id, payload)
})
