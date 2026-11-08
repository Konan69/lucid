import { useAtomValue } from '@effect/atom-react'
import { refOf, type BackgroundWork } from '@vivid/contracts'
import { work } from '@vivid/state'
import { Effect, Layer, Option, Result } from 'effect'
import { Atom, AsyncResult } from 'effect/reactivity'
import { changing } from './live'
import { engine } from './runtime'

/**
 * Stopping Vivid's background work from Settings (`screen/settings/Work.tsx`).
 *
 * The list is the server's (`live.work`). Each piece has its own Stop machine
 * (`work.StopMachine`, `@vivid/state`), kept in the app registry for as long as the page lives,
 * so a row that is stopping stays so when Settings is closed and opened again. Stop everything is
 * one machine for the page. This adapter supplies only how the server is asked.
 */

const stopper = Layer.succeed(work.Stopper, {
  stop: Effect.fn('Work.stop')(function* (delivery: work.Delivery) {
    const answered = yield* changing((client) => client.StopWork({ work: refOf(delivery.work) }))
    if (Result.isFailure(answered))
      return yield* new work.StopRefused({ attempt: delivery.attempt })
    return answered.success.result
  }),
  stopAll: Effect.fn('Work.stopAll')(function* (attempt: work.AttemptId) {
    const answered = yield* changing((client) => client.StopAllWork())
    if (Result.isFailure(answered)) return yield* new work.StopRefused({ attempt })
    return answered.success.stopped
  }),
})

/** The registry holds each piece's machine; its state is read from the machine alone. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<string, work.StopAtoms>>(new Map()))

const machineFor = (key: string): work.StopAtoms => {
  const known = engine.registry.get(machines)
  const existing = known.get(key)
  if (existing !== undefined) return existing
  const machine = work.makeStop(stopper)
  engine.registry.set(machines, new Map(known).set(key, machine))
  engine.registry.mount(machine.snapshot)
  return machine
}

/** Where every pressed piece stands; one never pressed is absent and so `Shown`. */
const standings = Atom.make((get): ReadonlyMap<string, work.RowStanding> => {
  const held = new Map<string, work.RowStanding>()
  for (const [key, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(key, work.rowStandingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list so a press redraws only what changed. */
export const useWorkStandings = (): ReadonlyMap<string, work.RowStanding> => useAtomValue(standings)

/** Stops one piece. The machine refuses a second press while the first is on its way. */
export function stopWork(piece: BackgroundWork) {
  engine.registry.set(
    machineFor(work.keyOf(refOf(piece))).send,
    work.StopEvents.Stop({ work: piece, attempt: work.AttemptId.make(crypto.randomUUID()) }),
  )
}

/** Stop everything: one machine for the page, made on first use and kept while the page lives. */
const allHeld = Atom.keepAlive(Atom.make<Option.Option<work.StopAllAtoms>>(Option.none()))

const allMachine = (): work.StopAllAtoms => {
  const held = engine.registry.get(allHeld)
  if (Option.isSome(held)) return held.value
  const machine = work.makeStopAll(stopper)
  engine.registry.set(allHeld, Option.some(machine))
  engine.registry.mount(machine.snapshot)
  return machine
}

const allStanding = Atom.make((get): work.AllStanding =>
  Option.match(get(allHeld), {
    onNone: () => work.AllStanding.cases.Idle.make({}),
    onSome: (machine) => {
      const result = get(machine.result)
      return AsyncResult.isSuccess(result)
        ? work.allStandingOf(result.value)
        : work.AllStanding.cases.Idle.make({})
    },
  }),
)

/** Where Stop everything stands, for its control and its report. */
export const useStopAll = (): work.AllStanding => useAtomValue(allStanding)

/** The presses Stop everything takes; the machine refuses any its state does not name. */
export const stopAll = {
  arm: () => engine.registry.set(allMachine().send, work.StopAllEvents.Arm()),
  disarm: () => engine.registry.set(allMachine().send, work.StopAllEvents.Disarm()),
  confirm: () =>
    engine.registry.set(
      allMachine().send,
      work.StopAllEvents.Confirm({ attempt: work.AttemptId.make(crypto.randomUUID()) }),
    ),
  dismiss: () => engine.registry.set(allMachine().send, work.StopAllEvents.Dismiss()),
}
