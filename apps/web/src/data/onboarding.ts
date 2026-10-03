import type { PersonId } from '@vivid/contracts'
import { Option } from 'effect'
import { kept } from './kept'

/**
 * Whether a Person's getting-started list is over, for good: they finished it, or they closed it.
 * Either way it never comes back, so Home does not nag someone who chose not to connect anything.
 *
 * It is kept on this device, per Person, because the server has nowhere to record it yet. The
 * steps themselves are read from real state everywhere; only "do not show me this again" is local,
 * so on a second device a Person who dismissed it without finishing sees it once more.
 */
const listeners = new Set<() => void>()
const nameOf = (person: PersonId) => `vivid-onboarding:${person}`
const tell = () => {
  for (const listener of listeners) listener()
}

export const onboarding = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Whether the list is over for this Person on this device. */
  isOver: (person: PersonId) => Option.isSome(kept.read(nameOf(person))),
  /**
   * Ends the list. Saying it twice is saying it once, and nobody is told when nothing changed,
   * so it is safe to call from wherever the list is found to be complete.
   */
  end: (person: PersonId, how: 'finished' | 'dismissed') => {
    if (onboarding.isOver(person)) return
    kept.write(nameOf(person), how)
    tell()
  },
}
