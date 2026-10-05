import { describe, expect, it } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  Appearance,
  CompanyId,
  DEFAULT_APPEARANCE,
  DraftListResponse,
  MeResponse,
  NotificationListResponse,
  Person,
  PersonId,
  ProjectListResponse,
  Settings,
  ThreadAudience,
  ThreadId,
  ThreadListResponse,
  Unauthenticated,
  Workspace,
  type Thread,
} from '@vivid/contracts'
import { Clock, Effect, Fiber, FiberSet, Layer, Option, Queue, Ref, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { LiveState, liveStateOf, makeLive, type ProductFailure } from './live.js'
import {
  judge,
  keepLatest,
  makeSnapshots,
  readSnapshot,
  Verdict,
  writeSnapshot,
  type Snapshot,
} from './snapshot.js'

const ORIGIN = 'https://vivid.example'

const person = (id: string, name: string) =>
  new Person({ id: PersonId.make(id), name, email: `${id}@example.com` })

const personal = Workspace.cases.Personal.make({})

const meOf = (who: Person, workspace: Workspace) =>
  new MeResponse({ person: who, workspace, companies: [] })

const ada = person('ada', 'Ada')
const ben = person('ben', 'Ben')

const thread = (id: string, title: string): Thread => ({
  id: ThreadId.make(id),
  title,
  preview: '',
  updatedAt: 1,
  archived: false,
  createdBy: { id: ada.id, name: ada.name, image: null },
  audience: ThreadAudience.cases.Private.make({}),
  projectId: null,
  attention: 'Quiet',
})

const listOf = (...threads: ReadonlyArray<Thread>): ThreadListResponse => ({ threads })

/** The text a device holds for a snapshot it wrote. Every snapshot here is one it can write. */
const textOf = (snapshot: Snapshot) => Option.getOrThrow(writeSnapshot(snapshot))

/** What a device wrote down the last time Ada used it. */
const kept: Snapshot = {
  version: 1,
  origin: ORIGIN,
  me: meOf(ada, personal),
  threads: Option.some(listOf(thread('t1', 'Board pack'))),
  projects: Option.none(),
  settings: Option.none(),
  appearance: Option.some(DEFAULT_APPEARANCE),
  notifications: Option.none(),
  drafts: Option.none(),
}

describe('a snapshot in a device store', () => {
  it('reads back what was written', () => {
    const read = readSnapshot(Option.some(textOf(kept)), ORIGIN)
    expect(Option.map(read, (snapshot) => snapshot.me.person.id)).toEqual(Option.some(ada.id))
    expect(Option.flatMap(read, (snapshot) => snapshot.threads)).toEqual(kept.threads)
    expect(Option.flatMap(read, (snapshot) => snapshot.projects)).toEqual(Option.none())
  })

  it('refuses one read from another server', () => {
    expect(readSnapshot(Option.some(textOf(kept)), 'https://other.example')).toEqual(Option.none())
  })

  it('refuses text that is not this format, and never casts it', () => {
    const text = textOf(kept)
    expect(readSnapshot(Option.none(), ORIGIN)).toEqual(Option.none())
    expect(readSnapshot(Option.some(text.slice(0, 40)), ORIGIN)).toEqual(Option.none())
    expect(readSnapshot(Option.some(text.replace('"version":1', '"version":2')), ORIGIN)).toEqual(
      Option.none(),
    )
    // A Thread list from a build whose Threads had no title is not a Thread list.
    expect(readSnapshot(Option.some(text.replace('"title":"Board pack",', '')), ORIGIN)).toEqual(
      Option.none(),
    )
  })

  it('judges whose it is by the server, not by what it says itself', () => {
    const northwind = Workspace.cases.Company.make({
      company: { id: CompanyId.make('northwind'), name: 'Northwind', slug: 'northwind' },
      role: 'member',
    })
    expect(judge(kept, meOf(ada, personal))).toEqual(Verdict.Same())
    expect(judge(kept, meOf(ada, northwind))).toEqual(Verdict.OtherWorkspace())
    expect(judge(kept, meOf(ben, personal))).toEqual(Verdict.OtherPerson())
  })
})

describe('writing a snapshot down', () => {
  it.effect('writes once after the opening burst, then at most every ten seconds', () =>
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1)
      const writes = yield* Ref.make(0)
      const fiber = yield* keepLatest(
        changes,
        Ref.update(writes, (count) => count + 1),
      ).pipe(Effect.forkScoped)
      yield* Queue.offer(changes, undefined)
      yield* Queue.offer(changes, undefined)
      yield* TestClock.adjust('400 millis')
      yield* Queue.offer(changes, undefined)
      expect(yield* Ref.get(writes)).toBe(0)
      yield* TestClock.adjust('100 millis')
      expect(yield* Ref.get(writes)).toBe(1)

      // A list that moves five times in the next ten seconds is one more write, not five.
      yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        Queue.offer(changes, undefined).pipe(Effect.andThen(TestClock.adjust('1 second'))),
      )
      expect(yield* Ref.get(writes)).toBe(1)
      yield* TestClock.adjust('5 seconds')
      expect(yield* Ref.get(writes)).toBe(2)
      yield* Fiber.interrupt(fiber)
    }),
  )
})

/**
 * A device at launch: a store holding `stored`, a socket whose answers the test sends, and the
 * snapshot wiring over both, all on the test's clock.
 */
const launched = Effect.fn('Test.launched')(function* (stored: Option.Option<string>) {
  const run = yield* FiberSet.makeRuntime()
  const clock = yield* Clock.Clock
  const store = yield* Ref.make(stored)
  const me = yield* Queue.unbounded<MeResponse, ProductFailure>()
  const threads = yield* Queue.unbounded<ThreadListResponse>()
  const live = makeLive(
    Layer.provide(Layer.mock(VividRpcClient, {}), Layer.succeed(Clock.Clock, clock)),
  )
  const queries = {
    me: live.kept(() => Stream.fromQueue(me)),
    threads: live.kept(() => Stream.fromQueue(threads)),
    projects: live.kept<ProjectListResponse>(() => Stream.never),
    settings: live.kept<Settings>(() => Stream.never),
    appearance: live.kept<Appearance>(() => Stream.never),
    notifications: live.kept<typeof NotificationListResponse.Type>(() => Stream.never),
    drafts: live.kept<DraftListResponse>(() => Stream.never),
  }
  const snapshots = makeSnapshots({
    registry: live.registry,
    queries,
    origin: ORIGIN,
    store: {
      read: Ref.get(store),
      write: (text) => Ref.set(store, Option.some(text)),
      erase: Ref.set(store, Option.none()),
    },
    launch: (program) => {
      const fiber = run(program)
      return () => {
        run(Fiber.interrupt(fiber))
      }
    },
  })
  yield* Effect.addFinalizer(() => Effect.sync(snapshots.stop))
  // Lets the store be read and the subscriptions open before the test speaks for the server.
  yield* TestClock.adjust(0)
  const titles = () =>
    LiveState.$match(liveStateOf(live.registry.get(queries.threads.atom)), {
      Loading: () => 'loading',
      Failed: () => 'failed',
      Ready: ({ value }) => value.threads.map((each) => each.title).join(', '),
    })
  return {
    titles,
    origin: () => live.registry.get(queries.threads.origin),
    stored: Effect.map(Ref.get(store), (text) => readSnapshot(text, ORIGIN)),
    hearMe: (next: MeResponse) => Queue.offer(me, next).pipe(Effect.andThen(TestClock.adjust(0))),
    hearThreads: (next: ThreadListResponse) =>
      Queue.offer(threads, next).pipe(Effect.andThen(TestClock.adjust(0))),
    endSession: Queue.fail(me, new Unauthenticated({ message: 'Sign in again.' })).pipe(
      Effect.andThen(TestClock.adjust(0)),
    ),
    flush: snapshots.flush,
    erase: snapshots.erase.pipe(Effect.andThen(TestClock.adjust(0))),
  }
})

describe('launching from what the device kept', () => {
  it.effect('draws the Thread list before the server has said anything', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      expect(device.titles()).toBe('Board pack')
      expect(device.origin()).toBe('device')
    }),
  )

  it.effect('waits for the server on a first launch', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.none())
      expect(device.titles()).toBe('loading')
      expect(device.origin()).toBe('nothing')
    }),
  )

  it.effect('is corrected by the first live answer and writes that down', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      yield* device.hearMe(meOf(ada, personal))
      expect(device.titles()).toBe('Board pack')
      yield* device.hearThreads(listOf(thread('t1', 'Board pack'), thread('t2', 'Hiring plan')))
      expect(device.titles()).toBe('Board pack, Hiring plan')
      expect(device.origin()).toBe('server')
      yield* TestClock.adjust('500 millis')
      const written = yield* device.stored
      expect(
        Option.map(
          Option.flatMap(written, (snapshot) => snapshot.threads),
          (list) => list.threads.length,
        ),
      ).toEqual(Option.some(2))
    }),
  )

  it.effect('never writes the kept copy back as if the server had said it', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      yield* device.hearMe(meOf(ada, personal))
      yield* device.flush
      // Only `me` has been said live. The Thread list on screen is the device's own copy and
      // is not the server's word, so the new snapshot does not carry it.
      const written = yield* device.stored
      expect(Option.flatMap(written, (snapshot) => snapshot.threads)).toEqual(Option.none())
      expect(device.titles()).toBe('Board pack')
    }),
  )

  it.effect("takes another Person's snapshot down and erases it", () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      yield* device.hearMe(meOf(ben, personal))
      expect(device.titles()).toBe('loading')
      // What is kept now, once written, is Ben's own `me` and nothing of Ada's.
      yield* device.flush
      const written = yield* device.stored
      expect(Option.map(written, (snapshot) => snapshot.me.person.id)).toEqual(Option.some(ben.id))
      expect(Option.flatMap(written, (snapshot) => snapshot.threads)).toEqual(Option.none())
    }),
  )

  it.effect('erases everything when the server says the session is gone', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      expect(device.titles()).toBe('Board pack')
      yield* device.endSession
      expect(device.titles()).toBe('loading')
      expect(yield* device.stored).toEqual(Option.none())
    }),
  )

  it.effect('erases everything on sign-out', () =>
    Effect.gen(function* () {
      const device = yield* launched(Option.some(textOf(kept)))
      yield* device.hearMe(meOf(ada, personal))
      yield* device.hearThreads(listOf(thread('t1', 'Board pack')))
      yield* device.erase
      expect(yield* device.stored).toEqual(Option.none())
      yield* device.flush
      expect(yield* device.stored).toEqual(Option.none())
    }),
  )

  it.effect('discards a snapshot it cannot read, so it is not read again', () =>
    Effect.gen(function* () {
      const store = Option.some('{"version":0}')
      const device = yield* launched(store)
      expect(device.titles()).toBe('loading')
      expect(yield* device.stored).toEqual(Option.none())
    }),
  )
})
