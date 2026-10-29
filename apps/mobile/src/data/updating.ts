import * as Updates from 'expo-updates'
import { Effect } from 'effect'
import { AppState } from 'react-native'
import { start } from './app'
import { isChoosing } from './documents'
import { isSigningIn } from './signing'
import { keepCurrent, UpdateStepFailed, type UpdateClient } from './update'

/**
 * The phone's side of keeping current (`update.ts`): expo-updates for the download and the
 * restart, the app state for when the Person leaves and returns.
 */
const client: UpdateClient = {
  download: Effect.gen(function* () {
    const check = yield* Effect.tryPromise({
      try: () => Updates.checkForUpdateAsync(),
      catch: () => new UpdateStepFailed({ step: 'download' }),
    })
    if (!check.isAvailable) return false
    const fetched = yield* Effect.tryPromise({
      try: () => Updates.fetchUpdateAsync(),
      catch: () => new UpdateStepFailed({ step: 'download' }),
    })
    return fetched.isNew
  }),
  restart: Effect.tryPromise({
    try: () => Updates.reloadAsync(),
    catch: () => new UpdateStepFailed({ step: 'restart' }),
  }),
  away: () => AppState.currentState === 'background' && !isChoosing() && !isSigningIn(),
}

/**
 * Starts keeping the app current, once, for the life of the app (`index.ts`). A development build
 * loads its JavaScript from Metro and a build given no server has updates off; in both
 * expo-updates rejects every call, so neither starts. The reference guards the same way
 * (`isAppUpdateCheckAvailable`): the development launcher reports updates as enabled.
 */
export const startUpdating = (): void => {
  if (!Updates.isEnabled || __DEV__) return
  const keeper = keepCurrent(client)
  AppState.addEventListener('change', (state) => {
    if (state === 'background') void start(keeper.left(Date.now()))
    if (state === 'active') void start(keeper.returned(Date.now()))
  })
  void start(keeper.look())
}
