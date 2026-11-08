import { useAtomValue } from '@effect/atom-react'
import { handing } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { engine } from './runtime'

/**
 * The web's calls for a handoff (`handing`, `@vivid/state`). Each goes over the app's socket as a
 * change; the step's record comes back with the Thread's detail, which is what moves the banner.
 * A fill's values leave here inside the call and are kept nowhere on this side.
 */
const calls = handing.make(
  Layer.succeed(handing.Calling, {
    call: Effect.fn('Handoffs.call')(function* (command: handing.Command) {
      const result = yield* changing((client) =>
        handing.Command.match(command, {
          Fill: ({ request }) => client.FillHandoff(request),
          Begin: ({ id }) => client.BeginHandoff({ id }),
          Complete: ({ id }) => client.CompleteHandoff({ id }),
          Withdraw: ({ id }) => client.WithdrawHandoff({ id }),
        }),
      )
      if (Result.isFailure(result))
        return yield* new handing.Refused({
          id: handing.idOf(command),
          words: handing.refusedWords(result.failure),
        })
    }),
  }),
)

// A call outlives the banner that pressed it: the step's record may fold it away first.
engine.registry.mount(calls.reading)

/** Every banner and card reads the same call. */
export const useHanding = () => useAtomValue(calls.reading)

/** The machine takes a press only while no other call about a step is out. */
export const pressHandoff = (command: handing.Command) =>
  engine.registry.set(calls.send, calls.press({ command }))
