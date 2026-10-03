import { ConnectionState, DEFAULT_APPEARANCE, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { live, useLiveValue } from './live'
import { mayCustomise, useAppearance } from './vivid'

/** The steps of getting started, in the order they are listed. */
export type StepKind = 'connect' | 'name' | 'say'

/** One step and whether it is taken, read from what is really there. */
export interface Step {
  readonly kind: StepKind
  readonly done: boolean
}

/**
 * Where getting started stands for this Person, read from real state: their ready Integrations,
 * Vivid's saved name and look, their Threads. Doing a step anywhere (Settings, a Thread, another
 * device) therefore ticks it everywhere it is shown.
 *
 * `None` until both lists have arrived, so a step is never shown as undone, and the count never
 * steps from "0 of 3" to "2 of 3", for the moment before the answers are known. Naming Vivid is
 * left out for a Person who may not change its appearance: a step they cannot take would make a
 * list that can never be finished.
 *
 * A hook, because each part is its own live query.
 */
export function useProgress(me: MeResponse): Option.Option<ReadonlyArray<Step>> {
  const connections = useLiveValue(live.connections)
  const threads = useLiveValue(live.threads)
  const appearance = useAppearance()
  const named =
    appearance.name !== DEFAULT_APPEARANCE.name ||
    appearance.look._tag !== DEFAULT_APPEARANCE.look._tag
  const naming: ReadonlyArray<Step> = mayCustomise(me) ? [{ kind: 'name', done: named }] : []
  return Option.flatMap(connections, (connected) =>
    Option.map(threads, (started) => [
      {
        kind: 'connect',
        // Only a ready Connection counts: one still waiting on its sign-in connects nothing yet.
        done: connected.connections.some((connection) =>
          ConnectionState.guards.Ready(connection.state),
        ),
      },
      ...naming,
      { kind: 'say', done: started.threads.length > 0 },
    ]),
  )
}

/** Whether every step this Person can take is taken. */
export const finished = (steps: ReadonlyArray<Step>) => steps.every((step) => step.done)
