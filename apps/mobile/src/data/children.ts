import { useAtomValue } from '@effect/atom-react'
import type { ChildRun, RunId } from '@vivid/contracts'
import { helpers, liveStateOf, type makeLive } from '@vivid/state'
import { randomUUID } from 'expo-crypto'
import { Effect, Layer, Result } from 'effect'
import { warn } from './haptics'
import { useLiveData, type LiveData } from './live'

/** Each signed-in session owns one stop machine and one result reading across its screens. */
export const makeHelpers = (engine: ReturnType<typeof makeLive>) => {
  const stops = helpers.make(
    Layer.succeed(helpers.Stopper, {
      stop: Effect.fn('Helpers.stop')(function* (id: RunId) {
        const result = yield* engine.change((client) => client.CancelChildRun({ id }))
        if (Result.isFailure(result)) return yield* new helpers.Refused({ id })
      }),
    }),
  )
  engine.registry.mount(stops.reading)
  const followUps = helpers.makeFollowUps(
    Layer.succeed(helpers.Sender, {
      send: Effect.fn('Helpers.followUp')(function* (draft) {
        const result = yield* engine.change((client) => client.FollowUpChildRun(draft))
        if (Result.isFailure(result)) return yield* new helpers.FollowUpRefused({ id: draft.id })
      }),
    }),
  )
  engine.registry.mount(followUps.reading)
  return { ...stops, results: helpers.results(engine), followUps }
}

/** The stop every helper row reads: what is being asked and what was refused. */
export const useHelperStop = () => useAtomValue(useLiveData().helpers.reading)

/** A helper's result, asked for when its row is opened and again when its state changes. */
export const useHelperResult = (run: ChildRun) =>
  liveStateOf(useAtomValue(useLiveData().helpers.results(helpers.resultKey(run))))

/** The machine takes the press only while no other stop is waiting on the server. */
export const stopHelper = (data: LiveData, id: RunId) => {
  warn()
  data.registry.set(data.helpers.send, data.helpers.stop({ id }))
}

/** The follow-up every helper row reads: what is being sent and what was refused. */
export const useHelperFollowUp = () => useAtomValue(useLiveData().helpers.followUps.reading)

/** The machine takes the press only while no other follow-up is waiting on the server. */
export const followUpHelper = (data: LiveData, id: RunId, message: string) => {
  const followUps = data.helpers.followUps
  data.registry.set(followUps.send, followUps.followUp({ id, message, key: randomUUID() }))
}
