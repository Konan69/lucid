import { useAtomValue } from '@effect/atom-react'
import type { TodoId } from '@vivid/contracts'
import { todos } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { please } from './feed'
import { confirm } from './haptics'
import type { LiveData } from './live'

/**
 * Closing a to-do from its row on the phone's Feed: the same close machine as the web's
 * (`todos.CloseMachine`, `@vivid/state`), one per to-do, owned by the session's registry so a row
 * folded by a press stays folded while the Feed is covered, as the waiting-on rows are
 * (`data/owed.ts`).
 */

/** Each session's registry owns its to-dos' machines. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<TodoId, todos.CloseAtoms>>(new Map()))

/** Where every pressed to-do stands, read from the machines themselves. */
const standings = Atom.make((get): ReadonlyMap<TodoId, todos.Standing> => {
  const held = new Map<TodoId, todos.Standing>()
  for (const [id, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(id, todos.standingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list. */
export const useTodoStandings = (): ReadonlyMap<TodoId, todos.Standing> => useAtomValue(standings)

/** Asks the server through the session's product transport; a refusal becomes `Unsent`. */
const closer = (data: LiveData) =>
  Layer.succeed(todos.Closer, {
    close: Effect.fn('Todos.close')(function* ({ id, closing }: todos.Delivery) {
      const answered = yield* Effect.promise(() =>
        todos.Closing.match(closing, {
          Complete: () => data.change((client) => client.CompleteTodo({ id })),
          Drop: () => data.change((client) => client.DropTodo({ id, why: todos.DROPPED_WORDS })),
        }),
      )
      if (Result.isFailure(answered)) return yield* new todos.CloseRefused({ id })
      confirm()
      please(data)
      return undefined
    }),
  })

const machineFor = (data: LiveData, id: TodoId): todos.CloseAtoms => {
  const known = data.registry.get(machines)
  const existing = known.get(id)
  if (existing !== undefined) return existing
  const machine = todos.makeClose(closer(data))
  data.registry.set(machines, new Map(known).set(id, machine))
  data.registry.mount(machine.snapshot)
  return machine
}

/** Closes one to-do. The machine refuses a second press while the first is on its way. */
export function closeTodo(data: LiveData, id: TodoId, closing: todos.Closing): void {
  data.registry.set(
    machineFor(data, id).send,
    todos.CloseEvents.Close({ id, closing, attempt: todos.AttemptId.make(randomUUID()) }),
  )
}
