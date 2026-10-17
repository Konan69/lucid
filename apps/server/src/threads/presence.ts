import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import type * as Scope from 'effect/Scope'
import type { PersonId, PersonSummary, Presence as PresenceEntry, ThreadId } from '@vivid/contracts'
import { Changes, Topic } from '../live/changes.ts'
import { untraced } from '../observability/quiet.ts'
import type { Link } from '../rpc/link.ts'

/**
 * How long presence outlives the call that held it. A client that starts or stops typing closes
 * its hold and opens another at once (`BePresent` carries `typing`); for that moment the Person is
 * still there, and nobody should see them leave and come back. A Person who really left is seen
 * gone this much later.
 */
const LEFT_AFTER = '1 second'

/** How often a link that went silent is looked for (`Link`, `SILENT_AFTER_MS`). */
const SWEEP_EVERY = '5 seconds'

/** One call holding a Person present in a Thread: what it said, and the link it came on. */
interface Hold {
  readonly person: PersonSummary
  readonly typing: boolean
  readonly link: Link
}

export interface PresenceService {
  /**
   * Holds a Person present in a Thread for as long as the calling scope is open and the link it
   * came on stays live. Other people are told when what they see changes: the Person arrived,
   * left, or started or stopped typing.
   */
  readonly hold: (
    threadId: ThreadId,
    person: PersonSummary,
    typing: boolean,
    link: Link,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Who has the Thread open right now. */
  readonly here: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PresenceEntry>>
  /** Whether this Person has the Thread open, so they are not notified about what they can see. */
  readonly watching: (threadId: ThreadId, personId: PersonId) => Effect.Effect<boolean>
  /** Whether this Person has any Thread open, which means they are in the app. */
  readonly present: (personId: PersonId) => Effect.Effect<boolean>
}

/**
 * Who is looking at a Thread, and whether they are writing.
 *
 * A Person is present for exactly as long as one of their clients holds `BePresent` open on a
 * link that is still live. The hold ends when the client closes the call (the screen closed, the
 * window went behind another), when its socket closes, and when the link goes silent: a client
 * that runs pings every five seconds, so silence means it is gone even when no socket closed.
 * Nothing is said on a timer; the server hears presence from the call being open.
 *
 * Presence is held in memory and nowhere else: it is true for seconds, is worth nothing after a
 * restart, and writing it to the database would turn every keystroke into a row.
 */
export class Presence extends Context.Service<Presence, PresenceService>()('vivid/Presence') {}

/**
 * Who a Thread's holds show, one entry a Person. A Person with two holds (two windows, or the
 * moment between an old hold and the one that replaced it) shows what their newest hold said.
 */
const audience = (holds: ReadonlySet<Hold>, now: number): ReadonlyArray<PresenceEntry> => {
  const people = new Map<PersonId, PresenceEntry>()
  for (const hold of holds) {
    if (hold.link.live(now))
      people.set(hold.person.id, { person: hold.person, typing: hold.typing })
  }
  return [...people.values()]
}

/**
 * What other people see of an audience, as one comparable word, or `undefined` for nobody: the
 * Thread's watchers were told it was empty, or never told anything.
 */
const seen = (entries: ReadonlyArray<PresenceEntry>) =>
  entries.length === 0
    ? undefined
    : entries
        .map((entry) => `${entry.person.id}:${entry.typing}`)
        .toSorted()
        .join(',')

const makePresence = Effect.fn('Presence.make')(function* () {
  const changes = yield* Changes
  const scope = yield* Effect.scope
  // Insertion order is hold order, so the last live hold of a Person is their newest.
  const threads = new Map<ThreadId, Set<Hold>>()
  // What each Thread's watchers were last told, kept only while it is somebody.
  const told = new Map<ThreadId, string>()

  const audienceOf = (threadId: ThreadId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const holds = threads.get(threadId)
      return holds === undefined ? [] : audience(holds, now)
    })

  /** Tells the Thread's watchers when what they see of it is not what they were last told. */
  const settle = Effect.fn('Presence.settle')(function* (threadId: ThreadId) {
    const shown = seen(yield* audienceOf(threadId))
    const holds = threads.get(threadId)
    if (holds !== undefined && holds.size === 0) threads.delete(threadId)
    if (shown === told.get(threadId)) return
    if (shown === undefined) told.delete(threadId)
    else told.set(threadId, shown)
    yield* changes.publish([Topic.thread(threadId)])
  })

  /** Lets a hold go `LEFT_AFTER` from now, in the service's own scope: its caller has gone. */
  const release = (threadId: ThreadId, held: Hold) =>
    Effect.sleep(LEFT_AFTER).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const holds = threads.get(threadId)
          if (holds !== undefined) holds.delete(held)
          return settle(threadId)
        }),
      ),
      untraced,
      Effect.forkIn(scope),
      Effect.asVoid,
    )

  const hold: PresenceService['hold'] = Effect.fn('Presence.hold')(
    function* (threadId, person, typing, link) {
      const held: Hold = { person, typing, link }
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const holds = threads.get(threadId) ?? new Set<Hold>()
          holds.add(held)
          threads.set(threadId, holds)
          return settle(threadId)
        }),
        () => release(threadId, held),
      )
    },
  )

  const here: PresenceService['here'] = audienceOf

  const watching: PresenceService['watching'] = Effect.fn('Presence.watching')(
    function* (threadId, personId) {
      return (yield* audienceOf(threadId)).some((entry) => entry.person.id === personId)
    },
  )

  const present: PresenceService['present'] = Effect.fn('Presence.present')(function* (personId) {
    for (const threadId of threads.keys()) {
      if ((yield* audienceOf(threadId)).some((entry) => entry.person.id === personId)) return true
    }
    return false
  })

  /** Tells each Thread's watchers about anyone whose link went silent since the last look. */
  const sweep = Effect.suspend(() => Effect.forEach([...threads.keys()], settle, { discard: true }))

  yield* sweep.pipe(untraced, Effect.repeat(Schedule.spaced(SWEEP_EVERY)), Effect.forkScoped)

  return Presence.of({ hold, here, watching, present })
})

export const presenceLayer = Layer.effect(Presence, makePresence())
