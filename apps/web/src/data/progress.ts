import {
  ChannelStanding,
  ConnectionState,
  DEFAULT_APPEARANCE,
  type ChannelLink,
  type MeResponse,
} from '@vivid/contracts'
import { Option } from 'effect'
import { live, LiveState, useLive, useLiveValue } from './live'
import { mayCustomise, useAppearance } from './vivid'

/** The steps of getting started, in the order they are listed. */
export type StepKind = 'connect' | 'name' | 'text'

/** One step and whether it is taken, read from what is really there. */
export interface Step {
  readonly kind: StepKind
  readonly done: boolean
}

/**
 * Where getting started stands for this Person, read from real state: their ready Integrations,
 * Vivid's saved name and look, and whether their phone can text Vivid. Doing a step anywhere (Settings, another device) therefore
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
  const channels = useLive(live.channels)
  const appearance = useAppearance()
  // Held back until the channels have answered too, for the same reason: the count must not
  // grow by a step a moment after it is first shown.
  if (LiveState.$is('Loading')(channels)) return Option.none()
  const texting = LiveState.$is('Ready')(channels) ? textingStep(channels.value.channels) : []
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
    ...texting,
  ])
}

/**
 * The step for texting Vivid. It is iMessage's: that is the one channel Vivid texts on, and every
 * running Vivid has it, so the step is there as soon as the channels are known. A channel Vivid
 * does not text on yet (WhatsApp) adds no step, for the reason naming is left out above: a step
 * nobody can take makes a list that can never be finished.
 */
const textingStep = (links: ReadonlyArray<ChannelLink>): ReadonlyArray<Step> =>
  links.flatMap((link) =>
    link.channel === 'iMessage'
      ? [{ kind: 'text', done: ChannelStanding.guards.Connected(link.standing) }]
      : [],
  )

/** Whether every step this Person can take is taken. */
export const finished = (steps: ReadonlyArray<Step>) => steps.every((step) => step.done)
