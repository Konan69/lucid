import type { PersonId } from '@vivid/contracts'
import { Option } from 'effect'
import { create } from 'zustand'
import { kept } from './kept'

/**
 * Whether a Person's getting-started list is over, for good: they finished it, or they closed it.
 * Either way it never comes back, so Home does not nag someone who chose not to connect anything.
 *
 * It is kept on this device, per Person, because the server has nowhere to record it yet. The
 * steps themselves are read from real state everywhere; only "do not show me this again" is local,
 * so on a second device a Person who dismissed it without finishing sees it once more.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * It holds the People whose list ended while this page was open; an ending from an earlier visit
 * is read from the browser, which is kept per Person under a name of its own and so cannot be
 * read before the Person is known. A browser that refuses to keep anything therefore still puts
 * the list away for as long as the page is open.
 */
const nameOf = (person: PersonId) => `vivid-onboarding:${person}`

interface Onboarding {
  readonly ended: ReadonlyArray<PersonId>
}

export const useOnboarding = create<Onboarding>()(() => ({ ended: [] }))

/** Whether the list is over for this Person on this device. */
export const overFor = (person: PersonId) => (state: Onboarding) =>
  state.ended.includes(person) || Option.isSome(kept.read(nameOf(person)))

export const onboarding = {
  /**
   * Ends the list. Saying it twice is saying it once, and nothing changes the second time, so
   * it is safe to call from wherever the list is found to be complete.
   */
  end: (person: PersonId, how: 'finished' | 'dismissed') => {
    if (overFor(person)(useOnboarding.getState())) return
    kept.write(nameOf(person), how)
    useOnboarding.setState((was) => ({ ended: [...was.ended, person] }))
  },
}
