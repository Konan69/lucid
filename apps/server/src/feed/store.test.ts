import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  Company,
  CompanyId,
  FeedDisplayInvalid,
  FeedItem,
  MarkFeedCardRequest,
  Person,
  PersonId,
  FeedCause,
  FeedEvidence,
  FeedPost,
  FeedProvenance,
  PostRequest,
  RunId,
  WatchId,
  ThreadId,
  Workspace,
  type FeedAsk,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Exit, Layer, Option } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { approvals } from '../approvals/tables.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { inputRequests } from '../inputs/tables.ts'
import { CHANNEL } from '../live/changes.ts'
import { payload, silent } from '../live/testing.ts'
import { Runtime } from '../runtime/client.ts'
import { ChildRuns } from '../runs/store.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import type { ThreadPlace } from '../threads/place.ts'
import { RunEnding, RunStore, runStoreLayer, TurnReservation } from '../threads/runs.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { stopPersonRun } from '../threads/stop.ts'
import { runs, threads } from '../threads/tables.ts'
import { cardIdOf } from './read.ts'
import { FeedStore, feedStoreLayer } from './store.ts'
import { feedCards } from './tables.ts'

/**
 * The Feed over the real tables on the disposable database: what each owned Thread shows as,
 * whose Feed it reaches, how long settled work stays and that open work is never cut. Threads,
 * Runs, Approvals and questions are written as rows, because the Feed reads them as rows and the
 * stores that write them in production are exercised separately for their committed Feed notices.
 */

// This suite proves the committed SQL publication; real runtime abortion is driven by the live recipe.
const testLayer = Layer.mergeAll(
  feedStoreLayer,
  runStoreLayer,
  threadStoreLayer,
  Layer.mock(Runtime, { stop: () => Effect.succeed(false) }),
  Layer.mock(ChildRuns, { stopThread: () => Effect.void }),
).pipe(Layer.provideMerge(testDatabaseLayer))

const now = 1_800_000_000_000
const hour = 60 * 60 * 1000
const day = 24 * hour

const firstPost = PostRequest.cases.Said.make({
  title: 'Invoice from Arik Air',
  words: 'An invoice for ₦84,000 arrived. Pay it?',
  actions: ['Pay it'],
  sources: [],
  from: 'your mail',
  urgency: 'ordinary',
})
const followUp = PostRequest.cases.Said.make({
  title: 'Invoice from Arik Air',
  words: 'Paid. The receipt is in your mail.',
  actions: [],
  sources: [],
  from: 'your mail',
  urgency: 'ordinary',
})

/** The Watch the fixture's background work comes from. Its row never exists here, as after removal. */
const mailWatch = WatchId.make('watch-mail')
/** A Run's origin as the receiver stores one for an event of `mailWatch`. */
const watchOrigin = StoredRunOrigin.cases.Watch.make({
  watchId: mailWatch,
  watchName: 'Mail',
  eventId: 'event-1',
  event: 'message.received',
  occurredAt: '2026-10-29T09:00:00Z',
})

/** A card as the Feed reads it back: the posted content with the provenance the server recorded. */
const shown = (request: PostRequest, provenance: FeedProvenance): FeedPost =>
  PostRequest.match(request, {
    Drawn: ({ title, display }): FeedPost =>
      FeedPost.cases.Drawn.make({ title, display, provenance, from: request.from }),
    Said: ({ title, words, actions }): FeedPost =>
      FeedPost.cases.Said.make({ title, words, actions, provenance, from: request.from }),
  })

/** What a post records when `postedBy` posts in a Thread the Watch Run `cause` started. */
const recorded = (thread: ThreadId, cause: RunId, postedBy = cause) =>
  FeedProvenance.cases.Recorded.make({
    postedBy,
    cause: FeedCause.cases.Watch.make({
      run: cause,
      watch: mailWatch,
      watchName: 'Mail',
      eventId: 'event-1',
    }),
    evidence: [FeedEvidence.cases.ThreadRun.make({ thread, run: cause })],
  })

/** A failed cleanup fails the test rather than leaving the fixture's rows behind. */
const cleanupFailed = () => Effect.sync(() => expect.fail('Feed fixture cleanup failed'))

const personNamed = (name: string) =>
  Person.make({
    id: PersonId.make(crypto.randomUUID()),
    name,
    email: `${crypto.randomUUID()}@feed.test`,
    image: null,
  })

/**
 * Two People who are both Members of one Company, removed with everything they own when the test
 * ends. The cleanup is registered before the first write.
 */
const fixture = Effect.fn('FeedTest.fixture')(function* () {
  const database = yield* Database
  const ada = personNamed('Ada')
  const ben = personNamed('Ben')
  const company = Company.make({
    id: CompanyId.make(crypto.randomUUID()),
    name: 'Feed Company',
    slug: crypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(inArray(personTable.id, [ada.id, ben.id])),
      )
    }).pipe(Effect.catch(cleanupFailed)),
  )
  yield* database.run(database.insert(personTable).values([ada, ben]))
  yield* database.run(database.insert(companyTable).values(company))
  yield* database.run(
    database.insert(membershipTable).values(
      [ada, ben].map((person) => ({
        id: crypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: 'member',
      })),
    ),
  )
  return { ada: ada.id, ben: ben.id, company: company.id, person: ada }
})

/** Where a Thread lives and who may read it; a personal-space Thread has no Company. */
interface Placed {
  readonly person: PersonId
  readonly place: ThreadPlace
  readonly company: CompanyId | null
  readonly updatedAt: number
}

/** The values of one Thread row, private unless it is in a Company, where all Members read it. */
const threadRow = (input: Placed, title: string) => ({
  id: ThreadId.make(crypto.randomUUID()),
  personId: input.person,
  companyId: input.company,
  audience: input.company === null ? 'private' : 'company',
  place: input.place,
  title,
  titleSource: 'Person' as const,
  updatedAt: input.updatedAt,
})

const insertThread = Effect.fn('FeedTest.thread')(function* (input: Placed, title: string) {
  const database = yield* Database
  const row = threadRow(input, title)
  yield* database.run(database.insert(threads).values(row))
  return row.id
})

/** A personal-space background Thread of this Person, last moved at `updatedAt`. */
const background = (person: PersonId, updatedAt: number, title = 'Mail') =>
  insertThread({ person, place: 'Background', company: null, updatedAt }, title)

/** A Run of the Thread that is still going, as a Watch delivery records one. */
const working = Effect.fn('FeedTest.working')(function* (
  person: PersonId,
  thread: ThreadId,
  startedAt: number,
) {
  const database = yield* Database
  yield* database.run(
    database.insert(runs).values({
      id: RunId.make(`run-${crypto.randomUUID()}`),
      threadId: thread,
      personId: person,
      turn: 1,
      origin: watchOrigin,
      state: 'working',
      startedAt,
    }),
  )
})

/**
 * The Run a Watch event started in this Thread, finished at `at`: the first Run, which every post
 * there names as its cause. It is finished so the Thread's stage is the card's alone.
 */
const watched = Effect.fn('FeedTest.watched')(function* (
  person: PersonId,
  thread: ThreadId,
  at: number,
) {
  const database = yield* Database
  const id = RunId.make(`run-${crypto.randomUUID()}`)
  yield* database.run(
    database.insert(runs).values({
      id,
      threadId: thread,
      personId: person,
      turn: 1,
      origin: watchOrigin,
      state: 'completed',
      startedAt: at,
      finishedAt: at,
    }),
  )
  return id
})

const list = (person: PersonId) => Effect.flatMap(FeedStore, (store) => store.list(person))
const items = (person: PersonId) => Effect.map(list(person), (feed) => feed.items)
/** The posted cards on the Person's Feed, in its order. */
const posts = (person: PersonId) =>
  Effect.map(items(person), (all) => all.flatMap((item) => (item.post === null ? [] : [item.post])))

describe.skipIf(!testDatabaseConfigured)('Feed', () => {
  layer(testLayer)((it) => {
    it.effect(
      'a post from a background Thread waits with its words, and a second post updates the same item',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* FeedStore
          const thread = yield* background(test.ada, now - hour)
          const run = yield* watched(test.ada, thread, now - hour)
          yield* TestClock.setTime(now)

          const posted = yield* store.post({
            person: test.ada,
            thread,
            postedBy: run,
            request: firstPost,
          })
          expect(posted._tag).toBe('Posted')
          const waiting = (post: FeedPost, at: number) =>
            FeedItem.cases.Waiting.make({
              card: cardIdOf(thread),
              thread,
              from: 'Mail',
              at,
              post,
              seen: false,
              asking: [],
            })
          expect(yield* items(test.ada)).toEqual([
            waiting(shown(firstPost, recorded(thread, run)), now),
          ])

          yield* TestClock.setTime(now + 5 * 60 * 1000)
          const again = yield* store.post({
            person: test.ada,
            thread,
            postedBy: run,
            request: followUp,
          })
          expect(again._tag).toBe('Updated')
          expect(yield* items(test.ada)).toEqual([
            waiting(shown(followUp, recorded(thread, run)), now + 5 * 60 * 1000),
          ])
        }).pipe(Effect.scoped),
    )

    it.effect(
      'a post records the Run that posted it and the Watch event that caused it, and a follow-up keeps the cause',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const store = yield* FeedStore
          const thread = yield* background(test.ada, now - hour)
          const cause = yield* watched(test.ada, thread, now - hour)
          yield* TestClock.setTime(now)
          const page = { label: 'Invoice email', url: 'https://mail.example.com/m/42' }
          yield* store.post({
            person: test.ada,
            thread,
            postedBy: cause,
            request: PostRequest.cases.Said.make({ ...firstPost, sources: [page] }),
          })
          expect((yield* posts(test.ada))[0]).toHaveProperty(
            'provenance',
            FeedProvenance.cases.Recorded.make({
              postedBy: cause,
              cause: FeedCause.cases.Watch.make({
                run: cause,
                watch: mailWatch,
                watchName: 'Mail',
                eventId: 'event-1',
              }),
              evidence: [
                FeedEvidence.cases.ThreadRun.make({ thread, run: cause }),
                FeedEvidence.cases.Web.make(page),
              ],
            }),
          )

          // The Person answers on the card; a later Run in the Thread posts the follow-up. It is
          // the poster now, and the Watch event is still what started the work. No Watch row
          // exists for `mailWatch`, as after the Watch is removed: the cause needs none.
          const followed = RunId.make(`run-${crypto.randomUUID()}`)
          yield* database.run(
            database.insert(runs).values({
              id: followed,
              threadId: thread,
              personId: test.ada,
              turn: 2,
              origin: StoredRunOrigin.cases.Decision.make({}),
              state: 'completed',
              startedAt: now,
              finishedAt: now,
            }),
          )
          yield* TestClock.setTime(now + hour)
          yield* store.post({ person: test.ada, thread, postedBy: followed, request: followUp })
          expect(yield* posts(test.ada)).toEqual([
            shown(followUp, recorded(thread, cause, followed)),
          ])
        }).pipe(Effect.scoped),
    )

    it.effect('a card posted before provenance was recorded reads as Legacy', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const thread = yield* background(test.ada, now - hour)
        yield* TestClock.setTime(now)
        // Written as the earlier server did, without the column: its default is what old rows hold.
        yield* database.run(
          database.insert(feedCards).values({
            id: cardIdOf(thread),
            personId: test.ada,
            threadId: thread,
            title: firstPost.title,
            words: firstPost.words,
            display: null,
            actions: firstPost.actions,
            state: 'new',
            postedAt: now,
            updatedAt: now,
          }),
        )
        // It also says nothing of where it came from: that was not kept then.
        expect(yield* posts(test.ada)).toEqual([
          { ...shown(firstPost, FeedProvenance.cases.Legacy.make({})), from: null },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('a drawn card is the drawing alone, and reads back as drawn', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        const thread = yield* background(test.ada, now - hour)
        const run = yield* watched(test.ada, thread, now - hour)
        yield* TestClock.setTime(now)
        const drawn = PostRequest.cases.Drawn.make({
          title: 'Reply to Dana',
          display:
            'root = Col([Card([Caption("To Dana"), Text("Friday works. I will bring the deck.", "sm")], "soft"), Button("Send it", @ToAssistant("Send the reply to Dana"))])',
          sources: [],
          from: 'your mail',
          urgency: 'ordinary',
        })

        yield* store.post({ person: test.ada, thread, postedBy: run, request: drawn })
        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Waiting.make({
            card: cardIdOf(thread),
            thread,
            from: 'Mail',
            at: now,
            post: shown(drawn, recorded(thread, run)),
            seen: false,
            asking: [],
          }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('a display with no root statement is refused and no card is made', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        const thread = yield* background(test.ada, now - hour)
        const run = yield* watched(test.ada, thread, now - hour)
        yield* TestClock.setTime(now)
        const bare = PostRequest.cases.Drawn.make({
          title: 'Reply to Dana',
          display: 'Card([Caption("To Dana"), Text("Friday works.", "sm")], "soft")',
          sources: [],
          from: 'your mail',
          urgency: 'ordinary',
        })

        const refused = yield* Effect.flip(
          store.post({ person: test.ada, thread, postedBy: run, request: bare }),
        )
        expect(refused).toEqual(new FeedDisplayInvalid({ reason: 'NoRoot' }))
        expect(
          (yield* items(test.ada)).some((item) => item.thread === thread && item.post !== null),
        ).toBe(false)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'an old Thread whose card is put away now is settled now, kept a day, then gone',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* FeedStore
          const posted = now - 2 * day
          const thread = yield* background(test.ada, posted)
          const run = yield* watched(test.ada, thread, posted)
          yield* TestClock.setTime(posted)
          yield* store.post({ person: test.ada, thread, postedBy: run, request: firstPost })

          // Two days later the card is still open, so the Thread's age does not drop it.
          yield* TestClock.setTime(now)
          expect((yield* items(test.ada)).map((item) => [item._tag, item.thread])).toEqual([
            ['Waiting', thread],
          ])

          yield* store.mark(
            test.ada,
            MarkFeedCardRequest.make({ card: cardIdOf(thread), state: 'done' }),
          )
          const settled = FeedItem.cases.Settled.make({
            card: cardIdOf(thread),
            thread,
            from: 'Mail',
            at: now,
            post: shown(firstPost, recorded(thread, run)),
          })
          expect(yield* items(test.ada)).toEqual([settled])

          // History is dated by when it settled: still there at the end of the window, gone after.
          yield* TestClock.setTime(now + day)
          expect(yield* items(test.ada)).toEqual([settled])
          yield* TestClock.setTime(now + day + 1)
          expect(yield* items(test.ada)).toEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect(
      'a put-away card whose Thread ran again is dated by the later settlement, everywhere',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const store = yield* FeedStore
          const posted = now - 3 * day
          const thread = yield* background(test.ada, posted)
          const run = yield* watched(test.ada, thread, posted)
          yield* TestClock.setTime(posted)
          yield* store.post({ person: test.ada, thread, postedBy: run, request: firstPost })
          yield* store.mark(
            test.ada,
            MarkFeedCardRequest.make({ card: cardIdOf(thread), state: 'done' }),
          )
          // Today a Run finishes there without posting: it ended an hour ago, and settling it
          // touched the Thread now. The card's time, the Run's and the Thread's all disagree.
          yield* database.run(
            database.insert(runs).values({
              id: RunId.make(`run-${crypto.randomUUID()}`),
              threadId: thread,
              personId: test.ada,
              turn: 2,
              origin: StoredRunOrigin.cases.Decision.make({}),
              state: 'completed',
              startedAt: now - 2 * hour,
              finishedAt: now - hour,
            }),
          )
          yield* database.run(
            database.update(threads).set({ updatedAt: now }).where(eq(threads.id, thread)),
          )
          const quieter = yield* background(test.ada, now - hour / 2, 'Calendar')
          yield* TestClock.setTime(now)

          const shown = yield* items(test.ada)
          expect(shown.map((item) => [item._tag, item.thread])).toEqual([
            ['Settled', thread],
            ['Settled', quieter],
          ])
          expect(shown.map((item) => (FeedItem.guards.Settled(item) ? item.at : 0))).toEqual([
            now,
            now - hour / 2,
          ])
          // The same time decides when it leaves history.
          yield* TestClock.setTime(now + day)
          expect((yield* items(test.ada)).map((item) => item.thread)).toEqual([thread])
          yield* TestClock.setTime(now + day + 1)
          expect(yield* items(test.ada)).toEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect('only the Person’s own Threads reach their Feed, including Conversations', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        yield* TestClock.setTime(now)
        // Ben's background Thread is shared with the whole Company, so Ada can read it.
        const bens = yield* insertThread(
          { person: test.ben, place: 'Background', company: test.company, updatedAt: now },
          'Ben’s mail',
        )
        yield* store.post({
          person: test.ben,
          thread: bens,
          postedBy: yield* watched(test.ben, bens, now),
          request: firstPost,
        })
        // A Conversation has no posted card, but its working Run still belongs in Ada's Feed.
        const conversation = yield* insertThread(
          { person: test.ada, place: 'Conversation', company: null, updatedAt: now },
          'Talking',
        )
        yield* working(test.ada, conversation, now)

        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Working.make({
            card: cardIdOf(conversation),
            thread: conversation,
            from: 'Talking',
            since: now,
            post: null,
          }),
        ])
        const bensFeed = yield* items(test.ben)
        expect(bensFeed.map((item) => [item._tag, item.thread])).toEqual([['Waiting', bens]])
      }).pipe(Effect.scoped),
    )

    it.effect('a Conversation with a pending Approval waits without a posted card', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const thread = yield* insertThread(
          { person: test.ada, place: 'Conversation', company: null, updatedAt: now - hour },
          'Approve payment',
        )
        yield* working(test.ada, thread, now - hour)
        yield* database.run(
          database.insert(approvals).values({
            id: crypto.randomUUID(),
            threadId: thread,
            personId: test.ada,
            action: {},
            digest: 'digest',
            status: 'pending',
            expiresAt: now + hour,
            createdAt: now,
          }),
        )
        yield* TestClock.setTime(now)
        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Waiting.make({
            card: cardIdOf(thread),
            thread,
            from: 'Approve payment',
            at: now,
            post: null,
            seen: false,
            asking: ['approval'],
          }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('a Conversation settled today appears without a posted card', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const opened = yield* (yield* ThreadStore).openFirst({
          person: test.person,
          workspace: Workspace.cases.Personal.make({}),
          by: 'person' as const,
          threadId: Option.none<ThreadId>(),
          helper: Option.none(),
        })
        expect(opened._tag).toBe('Opened')
        expect(yield* items(test.ada)).toEqual([])
        const thread = yield* insertThread(
          { person: test.ada, place: 'Conversation', company: null, updatedAt: now - hour },
          'Finished payment',
        )
        yield* database.run(
          database.insert(runs).values({
            id: RunId.make(crypto.randomUUID()),
            threadId: thread,
            personId: test.ada,
            turn: 1,
            origin: {},
            state: 'completed',
            startedAt: now - 2 * hour,
            finishedAt: now - hour,
          }),
        )
        yield* TestClock.setTime(now)
        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Settled.make({
            card: cardIdOf(thread),
            thread,
            from: 'Finished payment',
            at: now - hour,
            post: null,
          }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('a Conversation without a posted card refuses both seen and done marks', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        const thread = yield* insertThread(
          { person: test.ada, place: 'Conversation', company: null, updatedAt: now },
          'Talking',
        )
        yield* working(test.ada, thread, now)
        yield* TestClock.setTime(now)
        const before = yield* items(test.ada)
        expect(before).toHaveLength(1)
        for (const state of ['seen', 'done'] as const) {
          const refused = yield* Effect.flip(
            store.mark(test.ada, MarkFeedCardRequest.make({ card: cardIdOf(thread), state })),
          )
          expect(refused._tag).toBe('NotFound')
          expect(refused.message).toBe('That card is gone.')
        }
        expect(yield* items(test.ada)).toEqual(before)
      }).pipe(Effect.scoped),
    )

    it.effect('a foreground Run starting and settling announces its Thread owner’s Feed', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* RunStore
        // Ben acts in Ada's readable Company Thread. The Feed follows ownership, not the Run.
        const thread = yield* insertThread(
          {
            person: test.ada,
            place: 'Conversation',
            company: test.company,
            updatedAt: now - 2 * day,
          },
          'Shared work',
        )
        const id = RunId.make(crypto.randomUUID())
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* TestClock.setTime(now - hour)
        expect(
          yield* store.start({
            id,
            threadId: thread,
            personId: test.ben,
            origin: StoredRunOrigin.cases.Message.make({}),
          }),
        ).toEqual(TurnReservation.cases.Reserved.make({ turn: 1 }))
        expect(yield* Effect.exit(payload(notifications, [`p/feed:${test.ada}`]))).toEqual(
          Exit.succeed(undefined),
        )
        yield* TestClock.setTime(now)
        expect(yield* store.end(id, RunEnding.cases.Completed.make({ responseId: id }))).toBe(true)
        expect(yield* Effect.exit(payload(notifications, [`p/feed:${test.ada}`]))).toEqual(
          Exit.succeed(undefined),
        )
        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Settled.make({
            card: cardIdOf(thread),
            thread,
            from: 'Shared work',
            at: now,
            post: null,
          }),
        ])
        expect(yield* items(test.ben)).toEqual([])
        expect(yield* store.end(id, RunEnding.cases.Completed.make({ responseId: id }))).toBe(false)
        yield* silent(notifications)
      }).pipe(Effect.scoped),
    )

    it.effect('desktop Stop publishes the owner’s Feed once and dates old work as handled', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const thread = yield* insertThread(
          {
            person: test.ada,
            place: 'Conversation',
            company: test.company,
            updatedAt: now - 2 * day,
          },
          'Desktop work',
        )
        const runId = RunId.make(crypto.randomUUID())
        yield* (yield* RunStore).start({
          id: runId,
          threadId: thread,
          personId: test.ben,
          origin: StoredRunOrigin.cases.Message.make({}),
        })
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        yield* TestClock.setTime(now)
        // SQL publication is the seam under test. Runtime abortion returns after the commit.
        yield* stopPersonRun(test.ben, runId)
        expect(yield* Effect.exit(payload(notifications, [`p/feed:${test.ada}`]))).toEqual(
          Exit.succeed(undefined),
        )
        expect(yield* items(test.ada)).toEqual([
          FeedItem.cases.Settled.make({
            card: cardIdOf(thread),
            thread,
            from: 'Desktop work',
            at: now,
            post: null,
          }),
        ])
        yield* stopPersonRun(test.ben, runId)
        expect(yield* (yield* RunStore).end(runId, RunEnding.cases.Stopped.make({}))).toBe(false)
        yield* silent(notifications)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'a Company Thread leaves the Feed, and cannot be marked, once its Person leaves',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const store = yield* FeedStore
          yield* TestClock.setTime(now)
          const adas = yield* insertThread(
            { person: test.ada, place: 'Background', company: test.company, updatedAt: now },
            'Company mail',
          )
          yield* store.post({
            person: test.ada,
            thread: adas,
            postedBy: yield* watched(test.ada, adas, now),
            request: firstPost,
          })
          expect((yield* items(test.ada)).map((item) => item.thread)).toEqual([adas])

          yield* database.run(
            database.delete(membershipTable).where(eq(membershipTable.userId, test.ada)),
          )
          expect(yield* items(test.ada)).toEqual([])
          const refused = yield* Effect.flip(
            store.mark(test.ada, MarkFeedCardRequest.make({ card: cardIdOf(adas), state: 'seen' })),
          )
          expect(refused._tag).toBe('NotFound')
        }).pipe(Effect.scoped),
    )

    it.effect(
      'every open item is listed however many, and settled history keeps the newest hundred',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          yield* TestClock.setTime(now)
          const open = Array.from({ length: 205 }, (_, i) =>
            threadRow(
              {
                person: test.ada,
                place: 'Background',
                company: null,
                updatedAt: now - 2 * day - i,
              },
              `Open ${i}`,
            ),
          )
          const settled = Array.from({ length: 105 }, (_, i) =>
            threadRow(
              { person: test.ada, place: 'Background', company: null, updatedAt: now - 1 - i },
              `Settled ${i}`,
            ),
          )
          yield* database.run(database.insert(threads).values([...open, ...settled]))
          yield* database.run(
            database.insert(feedCards).values(
              open.map((row) => ({
                id: cardIdOf(row.id),
                personId: test.ada,
                threadId: row.id,
                title: firstPost.title,
                words: firstPost.words,
                display: null,
                actions: firstPost.actions,
                state: 'seen' as const,
                postedAt: row.updatedAt,
                updatedAt: row.updatedAt,
              })),
            ),
          )

          const listed = yield* items(test.ada)
          const threadsOf = (tag: FeedItem['_tag']) =>
            listed.filter((item) => item._tag === tag).map((item) => item.thread)
          expect(threadsOf('Waiting')).toEqual(open.map((row) => row.id))
          expect(threadsOf('Settled')).toEqual(settled.slice(0, 100).map((row) => row.id))
          expect(listed).toHaveLength(305)
        }).pipe(Effect.scoped),
    )

    it.effect('a Run stopped on an Approval or a question waits on the Person, not working', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        yield* TestClock.setTime(now)
        const approving = yield* background(test.ada, now - 3 * hour, 'Approving')
        const asking = yield* background(test.ada, now - 3 * hour, 'Asking')
        const expired = yield* background(test.ada, now - 3 * hour, 'Expired')
        for (const thread of [approving, asking, expired])
          yield* working(test.ada, thread, now - 3 * hour)
        const approval = (thread: ThreadId, expiresAt: number) => ({
          id: crypto.randomUUID(),
          threadId: thread,
          personId: test.ada,
          action: {},
          digest: 'digest',
          status: 'pending',
          expiresAt,
          createdAt: now - 2 * hour,
        })
        yield* database.run(
          database
            .insert(approvals)
            .values([approval(approving, now + hour), approval(expired, now - 1)]),
        )
        yield* database.run(
          database.insert(inputRequests).values({
            id: crypto.randomUUID(),
            threadId: asking,
            personId: test.ada,
            questions: [],
            status: 'waiting',
            createdAt: now - hour,
          }),
        )

        const waitingOn = (thread: ThreadId, from: string, kind: FeedAsk, at: number) =>
          FeedItem.cases.Waiting.make({
            card: cardIdOf(thread),
            thread,
            from,
            at,
            post: null,
            seen: false,
            asking: [kind],
          })
        expect(yield* items(test.ada)).toEqual([
          waitingOn(asking, 'Asking', 'question', now - hour),
          waitingOn(approving, 'Approving', 'approval', now - 2 * hour),
          // An Approval that has expired asks nothing: the Run is simply still going.
          FeedItem.cases.Working.make({
            card: cardIdOf(expired),
            thread: expired,
            from: 'Expired',
            since: now - 3 * hour,
            post: null,
          }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('marking another Person’s card is NotFound and leaves it as it was', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        yield* TestClock.setTime(now)
        // In the Company, so Ada can read the Thread: only the card's owner may move it.
        const bens = yield* insertThread(
          { person: test.ben, place: 'Background', company: test.company, updatedAt: now },
          'Ben’s mail',
        )
        yield* store.post({
          person: test.ben,
          thread: bens,
          postedBy: yield* watched(test.ben, bens, now),
          request: firstPost,
        })
        const before = yield* items(test.ben)

        yield* TestClock.setTime(now + hour)
        for (const state of ['seen', 'done'] as const) {
          const refused = yield* Effect.flip(
            store.mark(test.ada, MarkFeedCardRequest.make({ card: cardIdOf(bens), state })),
          )
          expect(refused._tag).toBe('NotFound')
        }
        expect(yield* items(test.ben)).toEqual(before)
        const database = yield* Database
        const rows = yield* database.run(
          database
            .select({ state: feedCards.state, updatedAt: feedCards.updatedAt })
            .from(feedCards)
            .where(eq(feedCards.threadId, bens)),
        )
        expect(rows).toEqual([{ state: 'new', updatedAt: now }])
      }).pipe(Effect.scoped),
    )
  })
})
