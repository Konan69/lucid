import { useAtomValue } from '@effect/atom-react'
import { refOf, type BackgroundWork } from '@vivid/contracts'
import { work } from '@vivid/state'
import { Effect, Layer, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { confirm } from './haptics'
import type { LiveData } from './live'

/**
 * Stopping Vivid's background work from the phone's Settings: the same Stop machines as the web's
 * (`work.StopMachine`, `work.StopAllMachine`, `@vivid/state`), owned by the session's registry so a
 * row that is stopping stays so while the sheet is closed and opened again.
 */

/** Asks the server through the session's product transport; a refusal becomes `Unsent`. */
const stopper = (data: LiveData) =>
  Layer.succeed(work.Stopper, {
    stop: Effect.fn('Work.stop')(function* (delivery: work.Delivery) {
      const answered = yield* Effect.promise(() =>
        data.change((client) => client.StopWork({ work: refOf(delivery.work) })),
      )
      if (Result.isFailure(answered))
        return yield* new work.StopRefused({ attempt: delivery.attempt })
      confirm()
      return answered.success.result
    }),
    stopAll: Effect.fn('Work.stopAll')(function* (attempt: work.AttemptId) {
      const answered = yield* Effect.promise(() => data.change((client) => client.StopAllWork()))
      if (Result.isFailure(answered)) return yield* new work.StopRefused({ attempt })
      confirm()
      return answered.success.stopped
    }),
  })

/** Each session's registry owns its pieces' machines. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<string, work.StopAtoms>>(new Map()))

/** Where every pressed piece stands, read from the machines themselves. */
const standings = Atom.make((get): ReadonlyMap<string, work.RowStanding> => {
  const held = new Map<string, work.RowStanding>()
  for (const [key, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(key, work.rowStandingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list. */
export const useWorkStandings = (): ReadonlyMap<string, work.RowStanding> => useAtomValue(standings)

const machineFor = (data: LiveData, key: string): work.StopAtoms => {
  const known = data.registry.get(machines)
  const existing = known.get(key)
  if (existing !== undefined) return existing
  const machine = work.makeStop(stopper(data))
  data.registry.set(machines, new Map(known).set(key, machine))
  data.registry.mount(machine.snapshot)
  return machine
}

/** Stops one piece. The machine refuses a second press while the first is on its way. */
export function stopWork(data: LiveData, piece: BackgroundWork): void {
  data.registry.set(
    machineFor(data, work.keyOf(refOf(piece))).send,
    work.StopEvents.Stop({ work: piece, attempt: work.AttemptId.make(randomUUID()) }),
  )
}

/** Stop everything: one machine per session, made on first use. */
const allHeld = Atom.keepAlive(Atom.make<Option.Option<work.StopAllAtoms>>(Option.none()))

const allMachine = (data: LiveData): work.StopAllAtoms => {
  const held = data.registry.get(allHeld)
  if (Option.isSome(held)) return held.value
  const machine = work.makeStopAll(stopper(data))
  data.registry.set(allHeld, Option.some(machine))
  data.registry.mount(machine.snapshot)
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

/**
 * Stop everything, once the system alert has had its yes: the alert is the phone's second press,
 * so arming and confirming are sent together. Arm is refused outside `Idle` and `Reported`, and
 * Confirm outside `Armed` and `Unsent`, so a stray press does nothing.
 */
export function stopEverything(data: LiveData): void {
  const machine = allMachine(data)
  data.registry.set(machine.send, work.StopAllEvents.Arm())
  data.registry.set(
    machine.send,
    work.StopAllEvents.Confirm({ attempt: work.AttemptId.make(randomUUID()) }),
  )
}

/** Puts the report or the refusal away. */
export function dismissStopAll(data: LiveData): void {
  data.registry.set(allMachine(data).send, work.StopAllEvents.Dismiss())
}
