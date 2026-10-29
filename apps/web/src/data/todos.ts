import { useAtomValue } from '@effect/atom-react'
import type { TodoId } from '@vivid/contracts'
import { todos } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { Atom, AsyncResult } from 'effect/reactivity'
import { please } from './feed'
import { changing } from './live'
import { engine } from './runtime'

/**
 * Closing a to-do from its row on the Feed, as the waiting-on rows close (`data/owed.ts`).
 *
 * The list is the server's (`live.todos`). Each to-do has its own close machine
 * (`todos.CloseMachine`, `@vivid/state`), kept in the app registry for as long as the page lives,
 * so a row folded by a press stays folded across a route change until the list drops it. This
 * adapter supplies only how the server is asked.
 */

const closer = Layer.succeed(todos.Closer, {
  close: Effect.fn('Todos.close')(function* ({ id, closing }: todos.Delivery) {
    const answered = yield* todos.Closing.match(closing, {
      Complete: () => changing((client) => client.CompleteTodo({ id })),
      Drop: () => changing((client) => client.DropTodo({ id, why: todos.DROPPED_WORDS })),
    })
    if (Result.isFailure(answered)) return yield* new todos.CloseRefused({ id })
    // Vivid's face is pleased for a moment, as it is when a Feed card is settled.
    please()
    return undefined
  }),
})

/** The registry holds each to-do's machine; its state is read from the machine alone. */
const machines = Atom.keepAlive(Atom.make<ReadonlyMap<TodoId, todos.CloseAtoms>>(new Map()))

const machineFor = (id: TodoId): todos.CloseAtoms => {
  const known = engine.registry.get(machines)
  const existing = known.get(id)
  if (existing !== undefined) return existing
  const machine = todos.makeClose(closer)
  engine.registry.set(machines, new Map(known).set(id, machine))
  engine.registry.mount(machine.snapshot)
  return machine
}

/** Where every pressed to-do stands; a to-do never pressed is absent and so `shown`. */
const standings = Atom.make((get): ReadonlyMap<TodoId, todos.Standing> => {
  const held = new Map<TodoId, todos.Standing>()
  for (const [id, machine] of get(machines)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) held.set(id, todos.standingOf(result.value))
  }
  return held
})

/** Every row's standing, read once by the list so a press redraws only what changed. */
export const useTodoStandings = (): ReadonlyMap<TodoId, todos.Standing> => useAtomValue(standings)

/** Closes one to-do. The machine refuses a second press while the first is on its way. */
export function closeTodo(id: TodoId, closing: todos.Closing) {
  engine.registry.set(
    machineFor(id).send,
    todos.CloseEvents.Close({
      id,
      closing,
      attempt: todos.AttemptId.make(crypto.randomUUID()),
    }),
  )
}
