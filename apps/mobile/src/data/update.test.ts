import { expect, it } from '@effect/vitest'
import { Deferred, Effect } from 'effect'
import { keepCurrent, LOOK_AGAIN_AFTER_MS, UpdateStepFailed, type UpdateClient } from './update'

/** A device whose server answers are scripted, recording every download and restart asked of it. */
const device = (answers: ReadonlyArray<boolean | 'offline'>) => {
  const calls: Array<'download' | 'restart'> = []
  const state = {
    away: false,
    restartFails: false,
    asked: 0,
    restartHeld: false,
    /** Told each time a restart is asked for, before it answers. */
    onRestart: (): void => undefined,
  }
  const client: UpdateClient = {
    download: Effect.suspend(() => {
      calls.push('download')
      const answer = answers[state.asked]
      state.asked += 1
      return answer === 'offline' || answer === undefined
        ? Effect.fail(new UpdateStepFailed({ step: 'download' }))
        : Effect.succeed(answer)
    }),
    restart: Effect.suspend(() => {
      calls.push('restart')
      state.onRestart()
      if (state.restartHeld) return Effect.never
      return state.restartFails
        ? Effect.fail(new UpdateStepFailed({ step: 'restart' }))
        : Effect.void
    }),
    away: () => state.away,
  }
  return { calls, state, keeper: keepCurrent(client) }
}

it.effect('restarts into a downloaded update only once the Person has left the app', () =>
  Effect.gen(function* () {
    const { calls, state, keeper } = device([true])
    yield* keeper.look()
    expect(calls).toEqual(['download'])
    // A picker covering the app is not leaving it.
    yield* keeper.left(1_000)
    expect(calls).toEqual(['download'])
    state.away = true
    yield* keeper.returned(2_000)
    yield* keeper.left(3_000)
    expect(calls).toEqual(['download', 'restart'])
  }),
)

it.effect('asks again after a long absence, and not after a short one or with one waiting', () =>
  Effect.gen(function* () {
    const { calls, state, keeper } = device([false, 'offline', true])
    yield* keeper.look()
    yield* keeper.left(0)
    yield* keeper.returned(LOOK_AGAIN_AFTER_MS - 1)
    expect(calls).toEqual(['download'])
    // A failed check leaves the app as it is, and the next long absence asks once more.
    yield* keeper.left(0)
    yield* keeper.returned(LOOK_AGAIN_AFTER_MS)
    yield* keeper.left(0)
    yield* keeper.returned(LOOK_AGAIN_AFTER_MS)
    expect(calls).toEqual(['download', 'download', 'download'])
    // With an update downloaded there is nothing more to ask; leaving restarts into it.
    yield* keeper.returned(LOOK_AGAIN_AFTER_MS * 2)
    state.away = true
    yield* keeper.left(0)
    expect(calls).toEqual(['download', 'download', 'download', 'restart'])
  }),
)

it.effect('stops waiting when a restart fails, so a later check can arm it again', () =>
  Effect.gen(function* () {
    const { calls, state, keeper } = device([true, true])
    state.restartFails = true
    yield* keeper.look()
    state.away = true
    yield* keeper.left(0)
    yield* keeper.left(1)
    expect(calls).toEqual(['download', 'restart'])
    state.restartFails = false
    yield* keeper.returned(1 + LOOK_AGAIN_AFTER_MS)
    yield* keeper.left(0)
    expect(calls).toEqual(['download', 'restart', 'download', 'restart'])
  }),
)

it.effect('restarts at once when the download lands after the Person has left', () =>
  Effect.gen(function* () {
    const { calls, state, keeper } = device([true])
    state.away = true
    yield* keeper.look()
    expect(calls).toEqual(['download', 'restart'])
  }),
)

it.effect('asks for one restart, however often the app is left while it is pending', () =>
  Effect.gen(function* () {
    const { calls, state, keeper } = device([true])
    yield* keeper.look()
    state.away = true
    state.restartHeld = true
    const begun = yield* Deferred.make<void>()
    state.onRestart = () => {
      Deferred.doneUnsafe(begun, Effect.void)
    }
    yield* Effect.forkChild(keeper.left(0))
    // The native restart has been asked for and has not answered: that is the pending moment.
    yield* Deferred.await(begun)
    yield* keeper.returned(1)
    yield* keeper.left(2)
    expect(calls).toEqual(['download', 'restart'])
  }),
)
