import { useAtomValue } from '@effect/atom-react'
import type { OwedId } from '@vivid/contracts'
import { owed } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { please } from './feed'
import { confirm } from './haptics'
import type { LiveData } from './live'

/**
 * Closing a record of what the Person is waiting on, from its row on the phone's Feed: the same
 * close machine as the web's (`owed.CloseMachine`, `@vivid/state`), one per record, owned by the
 * session's registry so a row folded by a press stays folded while the Feed is covered.
 */

/** Each session's registry owns its records' machines. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<OwedId, owed.CloseAtoms>>(new Map()))

/** Where every pressed record stands, read from the machines themselves. */
const standings = Atom.make((get): ReadonlyMap<OwedId, owed.Standing> => {
  const held = new Map<OwedId, owed.Standing>()
  for (const [id, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(id, owed.standingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list. */
export const useStandings = (): ReadonlyMap<OwedId, owed.Standing> => useAtomValue(standings)

/** Asks the server through the session's product transport; a refusal becomes `Unsent`. */
const closer = (data: LiveData) =>
  Layer.succeed(owed.Closer, {
    close: Effect.fn('Owed.close')(function* ({ id, closing }: owed.Delivery) {
      const how = owed.closingWords(closing)
      const answered = yield* Effect.promise(() =>
        owed.Closing.match(closing, {
          Resolve: () => data.change((client) => client.ResolveOwed({ id, how })),
          Drop: () => data.change((client) => client.DropOwed({ id, why: how })),
        }),
      )
      if (Result.isFailure(answered)) return yield* new owed.CloseRefused({ id })
      confirm()
      please(data)
      return undefined
    }),
  })

const machineFor = (data: LiveData, id: OwedId): owed.CloseAtoms => {
  const known = data.registry.get(machines)
  const existing = known.get(id)
  if (existing !== undefined) return existing
  const machine = owed.makeClose(closer(data))
  data.registry.set(machines, new Map(known).set(id, machine))
  data.registry.mount(machine.snapshot)
  return machine
}

/** Closes one record. The machine refuses a second press while the first is on its way. */
export function closeOwed(data: LiveData, id: OwedId, closing: owed.Closing): void {
  data.registry.set(
    machineFor(data, id).send,
    owed.CloseEvents.Close({ id, closing, attempt: owed.AttemptId.make(randomUUID()) }),
  )
}
