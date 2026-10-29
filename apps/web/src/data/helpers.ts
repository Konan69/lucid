import { useAtomValue } from '@effect/atom-react'
import type { ChildRun, RunId } from '@vivid/contracts'
import { helpers, liveStateOf } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { engine } from './runtime'

/** One stop at a time in this window; the Thread's live view shows where the helper then stands. */
const stops = helpers.make(
  Layer.succeed(helpers.Stopper, {
    stop: Effect.fn('Helpers.stop')(function* (id: RunId) {
      const result = yield* changing((client) => client.CancelChildRun({ id }))
      if (Result.isFailure(result)) return yield* new helpers.Refused({ id })
    }),
  }),
)

// A stop outlives the row that asked for it, including a row scrolled out of view.
engine.registry.mount(stops.reading)

const results = helpers.results(engine)

/** The stop every helper row reads: what is being asked and what was refused. */
export const useHelperStop = () => useAtomValue(stops.reading)

/** The machine takes the press only while no other stop is waiting on the server. */
export const stopHelper = (id: RunId) => engine.registry.set(stops.send, stops.stop({ id }))

/** A helper's result, asked for when its row is opened and again when its state changes. */
export const useHelperResult = (run: ChildRun) =>
  liveStateOf(useAtomValue(results(helpers.resultKey(run))))
