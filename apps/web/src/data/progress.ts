import { ConnectionState, DEFAULT_APPEARANCE, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { live, useLiveValue } from './live'
import { mayCustomise, useAppearance } from './vivid'

/** The steps of getting started, in the order they are listed. */
export type StepKind = 'connect' | 'name'

/** One step and whether it is taken, read from what is really there. */
export interface Step {
  readonly kind: StepKind
  readonly done: boolean
}

/**
 * Where getting started stands for this Person, read from real state: their ready Integrations,
 * and Vivid's saved name and look. Doing a step anywhere (Settings, another device) therefore
 * ticks it everywhere it is shown.
 *
 * Having a Thread is not a step. Vivid opens the first Thread itself, so every new Person has
 * one before they have done anything, and a step that is always taken only made the count start
 * one ahead.
 *
 * `None` until the Integrations have arrived, so a step is never shown as undone, and the count
 * never steps up by itself, for the moment before the answer is known. Naming Vivid is left out
 * for a Person who may not change its appearance: a step they cannot take would make a list that
 * can never be finished.
 *
 * A hook, because each part is its own live query.
 */
export function useProgress(me: MeResponse): Option.Option<ReadonlyArray<Step>> {
  const connections = useLiveValue(live.connections)
  const appearance = useAppearance()
  const named =
    appearance.name !== DEFAULT_APPEARANCE.name ||
    appearance.look._tag !== DEFAULT_APPEARANCE.look._tag
  const naming: ReadonlyArray<Step> = mayCustomise(me) ? [{ kind: 'name', done: named }] : []
  return Option.map(connections, (connected) => [
    {
      kind: 'connect',
      // Only a ready Connection counts: one still waiting on its sign-in connects nothing yet.
      done: connected.connections.some((connection) =>
        ConnectionState.guards.Ready(connection.state),
      ),
    },
    ...naming,
  ])
}

/** Whether every step this Person can take is taken. */
export const finished = (steps: ReadonlyArray<Step>) => steps.every((step) => step.done)
