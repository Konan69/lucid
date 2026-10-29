import { useAtomValue } from '@effect/atom-react'
import type { OwedId } from '@vivid/contracts'
import { owed } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { Atom, AsyncResult } from 'effect/reactivity'
import { please } from './feed'
import { changing } from './live'
import { engine } from './runtime'

/**
 * Closing a record of what the Person is waiting on, from its row on the Feed.
 *
 * The list is the server's (`live.owed`). Each record has its own close machine
 * (`owed.CloseMachine`, `@vivid/state`), kept in the app registry for as long as the page lives,
 * so a row folded by a press stays folded across a route change until the list drops it. This
 * adapter supplies only how the server is asked.
 */

const closer = Layer.succeed(owed.Closer, {
  close: Effect.fn('Owed.close')(function* ({ id, closing }: owed.Delivery) {
    const how = owed.closingWords(closing)
    const answered = yield* owed.Closing.match(closing, {
      Resolve: () => changing((client) => client.ResolveOwed({ id, how })),
      Drop: () => changing((client) => client.DropOwed({ id, why: how })),
    })
    if (Result.isFailure(answered)) return yield* new owed.CloseRefused({ id })
    // Vivid's face is pleased for a moment, as it is when a Feed card is settled.
    please()
    return undefined
  }),
})

/** The registry holds each record's machine; its state is read from the machine alone. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<OwedId, owed.CloseAtoms>>(new Map()))

const machineFor = (id: OwedId): owed.CloseAtoms => {
  const known = engine.registry.get(machines)
  const existing = known.get(id)
  if (existing !== undefined) return existing
  const machine = owed.makeClose(closer)
  engine.registry.set(machines, new Map(known).set(id, machine))
  engine.registry.mount(machine.snapshot)
  return machine
}

/** Where every pressed record stands; a record never pressed is absent and so `shown`. */
const standings = Atom.make((get): ReadonlyMap<OwedId, owed.Standing> => {
  const held = new Map<OwedId, owed.Standing>()
  for (const [id, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(id, owed.standingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list so a press redraws only what changed. */
export const useStandings = (): ReadonlyMap<OwedId, owed.Standing> => useAtomValue(standings)

/** Closes one record. The machine refuses a second press while the first is on its way. */
export function closeOwed(id: OwedId, closing: owed.Closing) {
  engine.registry.set(
    machineFor(id).send,
    owed.CloseEvents.Close({
      id,
      closing,
      attempt: owed.AttemptId.make(crypto.randomUUID()),
    }),
  )
}
