import { useAtomValue } from '@effect/atom-react'
import { MeResponse, Person, type PersonName } from '@vivid/contracts'
import { naming, type LiveQuery, type makeLive } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { confirm } from './haptics'
import { useLiveData, type LiveData } from './live'

/**
 * The Person's own name, changed from Settings (`@vivid/state` `naming`), one machine for the
 * session as the web app has one for the page. The new name shows in the session's live `Me` the
 * moment Save is pressed, and is taken back if the server refuses it.
 */
export const makeNaming = (engine: ReturnType<typeof makeLive>, me: LiveQuery<MeResponse>) => {
  const renaming = naming.make(
    Layer.succeed(naming.Renaming, {
      rename: Effect.fn('Name.rename')(function* (name: PersonName) {
        const result = yield* engine.change(
          (client) => client.SetPersonName({ name }),
          () =>
            me.expect(
              (current) =>
                new MeResponse({
                  person: new Person({ ...current.person, name }),
                  workspace: current.workspace,
                  companies: current.companies,
                }),
            ),
        )
        if (Result.isFailure(result)) return yield* new naming.Refused({ name })
      }),
    }),
  )
  // The sheet closing does not lose a refusal: the session holds the machine.
  engine.registry.mount(renaming.reading)
  return renaming
}

/** Where the name sheet stands. */
export const useNaming = () => {
  const data = useLiveData()
  return useAtomValue(data.naming.reading)
}

/** The Person pressed their name, or closed the sheet. The machine refuses what its state does not take. */
export const openNaming = (data: LiveData) =>
  data.registry.set(data.naming.send, data.naming.open())
export const closeNaming = (data: LiveData) =>
  data.registry.set(data.naming.send, data.naming.close())

/** Save, with a name the sheet already checked. A second press while saving is not taken. */
export const saveName = (data: LiveData, name: PersonName) => {
  confirm()
  data.registry.set(data.naming.send, data.naming.save({ name }))
}
