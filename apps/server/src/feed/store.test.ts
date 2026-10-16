import { describe, expect, layer } from '@effect/vitest'
import {
  Company,
  CompanyId,
  FeedItem,
  MarkFeedCardRequest,
  Person,
  PersonId,
  PostRequest,
  RunId,
  ThreadId,
  type FeedAsk,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { approvals } from '../approvals/tables.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { inputRequests } from '../inputs/tables.ts'
import type { ThreadPlace } from '../threads/place.ts'
import { runs, threads } from '../threads/tables.ts'
import { cardIdOf } from './read.ts'
import { FeedStore, feedStoreLayer } from './store.ts'
import { feedCards } from './tables.ts'

/**
 * The Feed over the real tables on the disposable database: what each background Thread shows as,
 * whose Feed it reaches, how long settled work stays and that open work is never cut. Threads,
 * Runs, Approvals and questions are written as rows, because the Feed reads them as rows and the
 * stores that write them in production are not what these tests are about.
 */

const testLayer = feedStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

const now = 1_800_000_000_000
const hour = 60 * 60 * 1000
const day = 24 * hour

const firstPost = PostRequest.make({
  title: 'Invoice from Arik Air',
  words: 'An invoice for ₦84,000 arrived. Pay it?',
  display: null,
  actions: ['Pay it'],
})
const followUp = PostRequest.make({
  title: 'Invoice from Arik Air',
  words: 'Paid. The receipt is in your mail.',
  display: null,
  actions: [],
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
  return { ada: ada.id, ben: ben.id, company: company.id }
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
      // The Feed never reads a Run's origin, only its state and times.
      origin: {},
      state: 'working',
      startedAt,
    }),
  )
})

const list = (person: PersonId) => Effect.flatMap(FeedStore, (store) => store.list(person))
const items = (person: PersonId) => Effect.map(list(person), (feed) => feed.items)

describe.skipIf(!testDatabaseConfigured)('Feed', () => {
  layer(testLayer)((it) => {
    it.effect(
      'a post from a background Thread waits with its words, and a second post updates the same item',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* FeedStore
          const thread = yield* background(test.ada, now - hour)
          yield* TestClock.setTime(now)

          const posted = yield* store.post({ person: test.ada, thread, request: firstPost })
          expect(posted._tag).toBe('Posted')
          const waiting = (post: typeof firstPost, at: number) =>
            FeedItem.cases.Waiting.make({
              card: cardIdOf(thread),
              thread,
              from: 'Mail',
              at,
              post: { title: post.title, words: post.words, display: null, actions: post.actions },
              seen: false,
              asking: [],
            })
          expect(yield* items(test.ada)).toEqual([waiting(firstPost, now)])

          yield* TestClock.setTime(now + 5 * 60 * 1000)
          const again = yield* store.post({ person: test.ada, thread, request: followUp })
          expect(again._tag).toBe('Updated')
          expect(yield* items(test.ada)).toEqual([waiting(followUp, now + 5 * 60 * 1000)])
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
          yield* TestClock.setTime(posted)
          yield* store.post({ person: test.ada, thread, request: firstPost })

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
            post: {
              title: firstPost.title,
              words: firstPost.words,
              display: null,
              actions: ['Pay it'],
            },
          })
          expect(yield* items(test.ada)).toEqual([settled])

          // History is dated by when it settled: still there at the end of the window, gone after.
          yield* TestClock.setTime(now + day)
          expect(yield* items(test.ada)).toEqual([settled])
          yield* TestClock.setTime(now + day + 1)
          expect(yield* items(test.ada)).toEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect('only the Person’s own background Threads reach their Feed', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* FeedStore
        yield* TestClock.setTime(now)
        // Ben's background Thread is shared with the whole Company, so Ada can read it.
        const bens = yield* insertThread(
          { person: test.ben, place: 'Background', company: test.company, updatedAt: now },
          'Ben’s mail',
        )
        yield* store.post({ person: test.ben, thread: bens, request: firstPost })
        // Ada's own conversation, with a card and a Run going, is not background work.
        const conversation = yield* insertThread(
          { person: test.ada, place: 'Conversation', company: null, updatedAt: now },
          'Talking',
        )
        yield* store.post({ person: test.ada, thread: conversation, request: firstPost })
        yield* working(test.ada, conversation, now)

        expect(yield* items(test.ada)).toEqual([])
        expect((yield* items(test.ben)).map((item) => [item._tag, item.thread])).toEqual([
          ['Waiting', bens],
        ])
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
        yield* store.post({ person: test.ben, thread: bens, request: firstPost })
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
