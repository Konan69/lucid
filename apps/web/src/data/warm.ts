import type { ThreadId } from '@vivid/contracts'
import type { LiveQuery } from '@vivid/state'
import { warmConversation } from './sending'
import { live, memory } from './live'
import { engine } from './runtime'

/**
 * Opening a place's data before the place is drawn.
 *
 * A screen reads its live queries with `useLive`, and a query nobody has read begins when it is
 * first read. Left at that, every query began when its screen mounted, so each screen drew once
 * with nothing (a skeleton, an empty Thread) and again a round trip later. Here the same queries
 * are begun earlier, by the router: when a pointer rests on a link to a place and at the moment
 * the Person goes there (`loader` in `src/routes`, `defaultPreload` in `src/router.ts`), and for
 * the places beside Threads as soon as the first screen is up (`App.tsx`). The screen then mounts
 * onto data that is already here.
 *
 * Nothing is fetched and nothing is copied: reading an atom is what begins its subscription, and
 * the screen reads the same atom.
 */

/**
 * Begins a query and leaves it. The registry keeps a query nobody is reading for its idle time
 * (`IDLE_FOR_MS` in `@vivid/state`, five minutes), which is far longer than a hover lasts; one
 * whose place is never opened is let go by itself.
 */
const begin = <Value>(query: LiveQuery<Value>): void => {
  engine.registry.get(query.atom)
}

/** Begins a query and keeps it for the life of the page, as something reading it would. */
const keep = <Value>(query: LiveQuery<Value>): void => {
  engine.registry.mount(query.atom)
}

export const warm = {
  /**
   * A Thread: its detail and its conversation. The detail is the Thread's own query and not
   * `seenThread`: resting on a link is not reading the Thread, and must not mark it read.
   */
  thread: (id: ThreadId): void => {
    begin(live.thread.get(id))
    warmConversation(id)
  },
  /** The Library's own shelf, the one every Person has and the screen opens on. */
  library: (): void => {
    begin(live.library.get('Mine'))
  },
  /** The Feed: Vivid's own work, what waits on the Person, and what is handled. */
  feed: (): void => {
    begin(live.feed)
  },
  /** The shelf of Projects. */
  projects: (): void => {
    begin(live.projects)
  },
  /** Every section of Settings, so moving between them does not wait on any. */
  settings: (): void => {
    begin(live.settings)
    begin(live.people)
    begin(live.connections)
    begin(live.channels)
    begin(live.rules)
    memory.begin()
    begin(live.devices)
    begin(live.audit)
  },
  /**
   * The places beside Threads, held open for the life of the page: a handful of small lists the
   * server only speaks about when they change. Called once, when the first screen is up, so a
   * Person who goes to the Library an hour into a session still finds them drawn.
   */
  places: (): void => {
    keep(live.feed)
    keep(live.settings)
    keep(live.library.get('Mine'))
  },
}
