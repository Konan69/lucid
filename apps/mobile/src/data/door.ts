import { Cause, Effect, Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * The atoms that belong to the device rather than to a signed-in Person: where this phone stands
 * (signed out, signed in, at which server), how it looks, and signing in itself.
 *
 * They need a registry that exists before anyone is signed in and outlives every session. The
 * live data of a session lives in a second registry, built when the session begins and disposed
 * when it ends (`live.ts`), so nothing a previous Person saw can still be on screen.
 *
 * Effects here are run by the registry, not by a component: writing to a function atom starts
 * it, reading the atom says how it went. That is how the app signs in, saves and pairs without a
 * hand-rolled runtime or an effect hook.
 */
export const door = AtomRegistry.make()

/**
 * Reads a device atom. The component re-renders when, and only when, its value changes.
 *
 * `subscribe` is kept stable per atom because React resubscribes whenever it changes identity,
 * and for an atom that is alive only while it is read (the device code exchange) a resubscribe
 * on every render would be a disposal and a restart away from an interrupted exchange.
 */
export function useDoor<Value>(atom: Atom.Atom<Value>): Value {
  const subscribe = useCallback((notify: () => void) => door.subscribe(atom, notify), [atom])
  const snapshot = () => door.get(atom)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * Says so once something has been waited on for long enough that a Person deserves more than
 * "connecting". It is one timer, started when a screen first reads it and thrown away when that
 * screen goes; nothing is polled.
 */
export const patienceAtom = Atom.make(Effect.as(Effect.sleep('6 seconds'), true))

/** How a device action (signing in, saving) stands, as the three things a form draws. */
export interface Attempt {
  /** It is on its way. */
  readonly busy: boolean
  /** It ended in a failure with a sentence for the Person. A defect has no such sentence. */
  readonly refusal: Option.Option<string>
}

/** Reads a function atom's result the way a form needs it. */
export const attemptOf = <Value, Failure extends { readonly message: string }>(
  result: AsyncResult.AsyncResult<Value, Failure>,
): Attempt => ({
  busy: result.waiting,
  refusal: AsyncResult.isFailure(result)
    ? Option.map(Cause.findErrorOption(result.cause), (failure) => failure.message)
    : Option.none(),
})
