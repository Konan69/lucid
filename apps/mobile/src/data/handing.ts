import { useAtomValue } from '@effect/atom-react'
import { handing, type makeLive } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { warn } from './haptics'
import { useLiveData, type LiveData } from './live'

/**
 * The phone's calls for a handoff (`handing`, `@vivid/state`), one machine for the signed-in
 * session as the web keeps one for the page (`apps/web/src/data/handing.ts`). A fill's values
 * leave inside the call and are kept nowhere on the phone.
 */
export const makeHandoffCalls = (engine: ReturnType<typeof makeLive>) => {
  const calls = handing.make(
    Layer.succeed(handing.Calling, {
      call: Effect.fn('Handoffs.call')(function* (command: handing.Command) {
        const result = yield* engine.change((client) =>
          handing.Command.match(command, {
            Fill: ({ request }) => client.FillHandoff(request),
            Begin: ({ id }) => client.BeginHandoff({ id }),
            Complete: ({ id }) => client.CompleteHandoff({ id }),
            Withdraw: ({ id }) => client.WithdrawHandoff({ id }),
          }),
        )
        if (Result.isFailure(result)) {
          warn()
          return yield* new handing.Refused({
            id: handing.idOf(command),
            words: handing.refusedWords(result.failure),
          })
        }
      }),
    }),
  )
  // A call outlives the banner that pressed it: the step's record may slide it away first.
  engine.registry.mount(calls.reading)
  return calls
}

/** Every banner and card of the session reads the same call. */
export const useHanding = () => {
  const data = useLiveData()
  return useAtomValue(data.handing.reading)
}

/** The machine takes a press only while no other call about a step is out. */
export const pressHandoff = (data: LiveData, command: handing.Command) =>
  data.registry.set(data.handing.send, data.handing.press({ command }))
