import * as Updates from 'expo-updates'
import { Effect } from 'effect'
import { AppState } from 'react-native'
import { start } from './app'
import { isChoosing } from './documents'
import { keepCurrent, UpdateStepFailed, type UpdateClient } from './update'

/**
 * The phone's side of keeping current (`update.ts`): expo-updates for the download and the
 * restart, the app state for when the Person leaves and returns.
 */
const client: UpdateClient = {
  download: Effect.tryPromise({
    try: async () => {
      const check = await Updates.checkForUpdateAsync()
      if (!check.isAvailable) return false
      const fetched = await Updates.fetchUpdateAsync()
      return fetched.isNew
    },
    catch: () => new UpdateStepFailed({ step: 'download' }),
  }),
  restart: Effect.tryPromise({
    try: () => Updates.reloadAsync(),
    catch: () => new UpdateStepFailed({ step: 'restart' }),
  }),
  away: () => AppState.currentState === 'background' && !isChoosing(),
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
