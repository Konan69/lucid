import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import type { PersonId, PersonSummary, Presence as PresenceEntry, ThreadId } from '@vivid/contracts'
import { Changes, Topic } from '../live/changes.ts'
import { untraced } from '../observability/quiet.ts'

/** How long a Person stays "here" after their client last said so. Clients report every 5 s. */
const PRESENT_FOR_MS = 15_000
const SWEEP_EVERY = '5 seconds'

interface Seen {
  readonly person: PersonSummary
  readonly typing: boolean
  readonly at: number
}

export interface PresenceService {
  /**
   * Notes that a Person has a Thread open. Returns true when what other people see changed (they
   * arrived, or started or stopped typing), so a heartbeat that changes nothing tells nobody.
   */
  readonly report: (
    threadId: ThreadId,
    person: PersonSummary,
    typing: boolean,
  ) => Effect.Effect<boolean>
  /** Who has the Thread open right now. */
  readonly here: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PresenceEntry>>
  /** Whether this Person has the Thread open, so they are not notified about what they can see. */
  readonly watching: (threadId: ThreadId, personId: PersonId) => Effect.Effect<boolean>
  /** Any current Thread heartbeat means the Person is present in the app. */
  readonly present: (personId: PersonId) => Effect.Effect<boolean>
}

/**
 * Who is looking at a Thread, and whether they are writing.
 *
 * Presence is held in memory and nowhere else: it is true for seconds, is worth nothing after a
 * restart, and writing it to the database would turn every keystroke into a row. A Person is
 * present until their client stops saying so for `PRESENT_FOR_MS`; a sweep notices the silence and
 * tells the Thread's watchers.
 */
export class Presence extends Context.Service<Presence, PresenceService>()('vivid/Presence') {}

const makePresence = Effect.fn('Presence.make')(function* () {
  const changes = yield* Changes
  const threads = new Map<ThreadId, Map<PersonId, Seen>>()

  const present = (threadId: ThreadId, now: number) => {
    const people = threads.get(threadId)
    return people === undefined
      ? []
      : [...people.values()].filter((seen) => now - seen.at < PRESENT_FOR_MS)
  }

  const report: PresenceService['report'] = Effect.fn('Presence.report')(
    function* (threadId, person, typing) {
      const now = yield* Clock.currentTimeMillis
      const people = threads.get(threadId) ?? new Map<PersonId, Seen>()
      const before = people.get(person.id)
      people.set(person.id, { person, typing, at: now })
      threads.set(threadId, people)
      return before === undefined || now - before.at >= PRESENT_FOR_MS || before.typing !== typing
    },
  )

  const here: PresenceService['here'] = Effect.fn('Presence.here')(function* (threadId) {
    const now = yield* Clock.currentTimeMillis
    return present(threadId, now).map((seen) => ({ person: seen.person, typing: seen.typing }))
  })

  const watching: PresenceService['watching'] = Effect.fn('Presence.watching')(
    function* (threadId, personId) {
      const now = yield* Clock.currentTimeMillis
      return present(threadId, now).some((seen) => seen.person.id === personId)
    },
  )

  /** Reuses the existing heartbeat clock; another open Thread still counts as being in the app. */
  const presentPerson = Effect.fn('Presence.present')(function* (personId: PersonId) {
    const now = yield* Clock.currentTimeMillis
    for (const threadId of threads.keys()) {
      if (present(threadId, now).some((seen) => seen.person.id === personId)) return true
    }
    return false
  })

  /** Drops everyone who went quiet and names the Threads whose audience just changed. */
  const sweep = Effect.fn('Presence.sweep')(function* () {
    const now = yield* Clock.currentTimeMillis
    const changed: Array<ThreadId> = []
    for (const [threadId, people] of threads) {
      const gone = [...people.values()].filter((seen) => now - seen.at >= PRESENT_FOR_MS)
      for (const seen of gone) people.delete(seen.person.id)
      if (gone.length > 0) changed.push(threadId)
      if (people.size === 0) threads.delete(threadId)
    }
    yield* changes.publish(changed.map(Topic.thread))
  })

  yield* sweep().pipe(untraced, Effect.repeat(Schedule.spaced(SWEEP_EVERY)), Effect.forkScoped)

  return Presence.of({ report, here, watching, present: presentPerson })
})

export const presenceLayer = Layer.effect(Presence, makePresence())
