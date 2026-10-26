import { useAtomValue } from '@effect/atom-react'
import { MeResponse, Person, type PersonName } from '@vivid/contracts'
import { naming } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { live } from './live'
import { engine } from './runtime'

/**
 * The Person's own name, changed from Settings (`@vivid/state` `naming`). The new name shows in
 * every live `Me` the moment Save is pressed, and is taken back if the server refuses it.
 */
const renaming = naming.make(
  Layer.succeed(naming.Renaming, {
    rename: Effect.fn('Name.rename')(function* (name: PersonName) {
      const result = yield* changing(
        (client) => client.SetPersonName({ name }),
        () =>
          live.me.expect(
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

// Settings is a dialog; a refusal outlives it being closed and opened again.
engine.registry.mount(renaming.reading)

/** Where the name form stands, the same for every screen that shows it. */
export const useNaming = () => useAtomValue(renaming.reading)

/** The Person pressed the name, or closed the form. The machine refuses what its state does not take. */
export const openNaming = () => engine.registry.set(renaming.send, renaming.open())
export const closeNaming = () => engine.registry.set(renaming.send, renaming.close())

/** Save, with a name the form already checked. A second press while saving is not taken. */
export const saveName = (name: PersonName) =>
  engine.registry.set(renaming.send, renaming.save({ name }))
