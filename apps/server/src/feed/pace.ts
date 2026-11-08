import { and, desc, eq, gte, isNotNull, isNull, ne } from 'drizzle-orm'
import { Clock, Effect, Layer, Option, Schedule } from 'effect'
import type { CompanyId, PersonId, ThreadId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import { Push } from '../push/delivery.ts'
import { notifyPosted } from '../notifications/attention.ts'
import { notifications } from '../notifications/tables.ts'
import { observeFailures } from '../observability/failure.ts'
import { untraced } from '../observability/quiet.ts'
import { settingsTable } from '../settings/tables.ts'
import { Presence } from '../threads/presence.ts'
import { runs, threads } from '../threads/tables.ts'
import { feedCards } from './tables.ts'
import { cardPostedBy, markTold } from './store.ts'

/**
 * Pacing what Vivid says unasked. Konan's decision, 27 October 2026, from Muse's proactive pacing
 * (`muse/docs/calls-texts-notifications.md:123-137`): one item worth the interruption, saying
 * where it came from; "ordinary items wait for the user's waking hours and a quiet stretch and
 * arrive at most once a day"; urgent ones go at once (the Post handler tells those itself). An
 * ordinary card is on the Feed silently from the moment it is posted; this pass decides when the
 * Person is told of one, quietly. It is a rule of the server, not a setting ("No quiet-hours
 * setting"); the Person steers what is posted and how urgent it is by saying so, and Vivid keeps
 * that in the `attention` page it reads before posting.
 */

/** Muse's default window: "Messages may arrive from 09:00 to 21:30 local time" (`PROACTIVE_PREFERENCES.md`). */
const WAKING_FROM = 9 * 60
const WAKING_UNTIL = 21 * 60 + 30
/**
 * How long since the Person last started something in a conversation before the moment counts
 * as quiet. Muse names no number; half an hour is the choice closest to "a quiet stretch" that
 * does not interrupt a conversation still going on. Presence covers a client open right now.
 */
const QUIET_MS = 30 * 60_000
/** How often the pass looks. A held card waits at most this long after its moment comes. */
const CADENCE = '5 minutes'

/** Minutes past local midnight and the local date of an instant, in an IANA zone. */
const localOf = (at: number, zone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  // `formatToParts` always names these parts for these options; were one missing, the minutes
  // read as NaN, which no waking window contains, so nobody is told rather than told at night.
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.filter((one) => one.type === type).map((one) => one.value)
  return {
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    date: [...part('year'), ...part('month'), ...part('day')].join('-'),
  }
}

/** A stored zone the runtime does not know reads as UTC, the column's own default. */
const zoneOf = (stored: string) => {
  const known = Intl.supportedValuesOf('timeZone').includes(stored) || stored === 'UTC'
  return known ? stored : 'UTC'
}

/** One untold ordinary card, newest first per Person, with what telling it needs. */
interface Held {
  readonly personId: PersonId
  readonly threadId: ThreadId
  readonly companyId: CompanyId | null
  readonly title: string
  readonly words: string | null
}

/**
 * The newest untold ordinary card each Person has not looked at yet. A card they already saw or
 * put away needs no notice. A Person who turned notifications off is still read here; recording
 * the notice refuses them (`recordNotice`).
 */
const heldCards = Effect.fn('Pace.held')(function* () {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({
        personId: feedCards.personId,
        threadId: feedCards.threadId,
        companyId: threads.companyId,
        title: feedCards.title,
        words: feedCards.words,
        zone: settingsTable.timezone,
      })
      .from(feedCards)
      .innerJoin(threads, eq(threads.id, feedCards.threadId))
      .leftJoin(settingsTable, eq(settingsTable.personId, feedCards.personId))
      .where(
        and(
          eq(feedCards.urgency, 'ordinary'),
          isNull(feedCards.toldAt),
          eq(feedCards.state, 'new'),
          // A card posted before pacing has no `from`, and its notice went out when it was posted.
          isNotNull(feedCards.cameFrom),
        ),
      )
      .orderBy(desc(feedCards.postedAt)),
  )
  const newest = new Map<PersonId, (typeof rows)[number]>()
  for (const row of rows) if (!newest.has(row.personId)) newest.set(row.personId, row)
  return [...newest.values()]
})

/** Whether this Person was already told of an ordinary card on their local today. */
const toldToday = Effect.fn('Pace.toldToday')(function* (
  person: PersonId,
  zone: string,
  now: number,
) {
  const database = yield* Database
  // A day is at most 26 local hours, so the last notice of today is within that.
  const recent = yield* database.run(
    database
      .select({ at: notifications.createdAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.personId, person),
          eq(notifications.kind, 'posted'),
          gte(notifications.createdAt, now - 26 * 60 * 60_000),
        ),
      ),
  )
  const today = localOf(now, zone).date
  return recent.some(({ at }) => localOf(at, zone).date === today)
})

/** Whether the Person started something in a conversation within the quiet stretch. */
const talkingLately = Effect.fn('Pace.talking')(function* (person: PersonId, now: number) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(threads, eq(threads.id, runs.threadId))
      .where(
        and(
          eq(runs.personId, person),
          ne(threads.place, 'Background'),
          gte(runs.startedAt, now - QUIET_MS),
        ),
      )
      .limit(1),
  )
  return rows.length > 0
})

/**
 * Tells one Person of their newest untold ordinary card when the moment is right: inside waking
 * hours in their own zone, nobody of theirs looking at Vivid, no conversation of theirs started
 * in the quiet stretch, and no ordinary card told yet today. The card is claimed before the notice
 * is recorded, so two passes never tell it twice; a notice that then fails is not retried.
 */
const tellOne = Effect.fn('Pace.tellOne')(function* (
  held: Held & { readonly zone: string | null },
) {
  const now = yield* Clock.currentTimeMillis
  // A Person with no settings row has the documented defaults, UTC among them (`settings/tables.ts`).
  const zone = zoneOf(held.zone === null ? 'UTC' : held.zone)
  const { minutes } = localOf(now, zone)
  if (minutes < WAKING_FROM || minutes >= WAKING_UNTIL) return
  if (yield* (yield* Presence).present(held.personId)) return
  if (yield* talkingLately(held.personId, now)) return
  if (yield* toldToday(held.personId, zone, now)) return
  // A card from before provenance was recorded has no posting Run to name its notice; not told.
  const run = yield* cardPostedBy(held.personId, held.threadId)
  if (Option.isNone(run)) return
  if (!(yield* markTold(held.personId, held.threadId))) return
  yield* notifyPosted({
    personId: held.personId,
    thread: { id: held.threadId, companyId: held.companyId },
    run: run.value,
    // A drawn card has no words: its drawing is the card, so its notice has a title alone.
    post: { title: held.title, body: held.words === null ? '' : held.words, urgency: 'ordinary' },
  })
})

/** One pass over every Person with a card waiting to be told. One Person's failure stops no other. */
export const paceOnce = Effect.fn('Pace.pass')(function* () {
  const held = yield* heldCards()
  yield* Effect.forEach(
    held,
    (one) =>
      tellOne(one).pipe(
        Effect.tapError((error) => Effect.logWarning('Feed pacing could not tell a card', error)),
        Effect.ignore,
      ),
    { discard: true },
  )
})

/**
 * The pacing worker: one pass every few minutes, scoped to the server, as Watch renewal runs
 * (`watches/lifecycle.ts`, `watchRenewalLayer`). A waking hour arriving is a clock condition with
 * no event to wait on, so a spaced pass is the signal.
 */
export const feedPacingLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | Presence | Changes | Push>()
    const once = paceOnce().pipe(
      Effect.provideContext(services),
      observeFailures('schedule'),
      Effect.tapError((error) => Effect.logError('Feed pacing pass failed', error)),
      Effect.ignore,
    )
    yield* once.pipe(untraced, Effect.repeat(Schedule.spaced(CADENCE)), Effect.forkScoped)
  }),
)
