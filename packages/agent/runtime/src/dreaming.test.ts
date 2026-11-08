import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect } from 'effect'
import { start, world } from '../tests/process.ts'
import { ada, admit, delivery, settled, type Runtime } from '../tests/requests.ts'
import { DreamHome } from './dreaming.ts'
import { pi } from './threads.ts'

const THREAD = 'dreaming-proof'
const ZONE = 'Pacific/Auckland'

/**
 * The tasks of one kind once each is asleep, read from Pi's own inspection. It looks, and when a
 * task is still running it waits for the next commit and looks again: a signal, never a timer.
 */
const asleep = Effect.fn('DreamingProof.asleep')(function* (harness: Harness, kind: string) {
  for (;;) {
    const committed = yield* Deferred.make<void>()
    const stop = harness.subscribeCommits(() => {
      Deferred.doneUnsafe(committed, Effect.void)
    })
    const tasks = yield* pi(() => harness.inspect(BACKGROUND_CONTEXT)).pipe(
      Effect.map(({ tasks: all }) => all.filter((task) => task.record.kind === kind)),
      Effect.ensuring(Effect.sync(stop)),
    )
    const sleeping = tasks.flatMap((task) =>
      task.state.kind === 'sleeping' ? [task.state.until] : [],
    )
    if (tasks.length > 0 && sleeping.length === tasks.length) return sleeping
    yield* Deferred.await(committed)
  }
})

/** One Person message in the proof Thread, answered and settled through the real routes. */
const exchange = Effect.fn('DreamingProof.exchange')(function* (runtime: Runtime, turn: number) {
  const receipt = yield* admit(
    runtime,
    ada,
    delivery(THREAD, `message-${turn}`, { body: `Message ${turn}.`, turn }),
  )
  yield* settled(runtime, ada, THREAD, receipt.submissionId)
})

/** The hour and minute an instant shows on a clock in `zone`, read by the platform, not by Effect. */
const clock = (at: number, zone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)

describe('the Dreamer on native Pi SQLite', () => {
  it.effect('sleeps until 03:00 in the Person’s time zone once they have spoken', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        given.faux.setResponses([fauxAssistantMessage('Okay.')])
        const runtime = yield* start(given)
        // The fixture has no server, so no response is given a zone; the cell keeps the last one.
        yield* runtime.persons.use(ada, (person) =>
          pi(() =>
            // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit callback.
            person.harness.commit(async (tx) => {
              const home = await tx.doc(DreamHome)
              home.timezone = ZONE
            }, BACKGROUND_CONTEXT),
          ),
        )
        const before = Date.now()
        yield* exchange(runtime, 1)
        yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            yield* person.quiet
            const [until, ...more] = yield* asleep(person.harness, 'vivid.nights')
            expect(more, 'one scheduler per cell').toHaveLength(0)
            expect(until).toBeDefined()
            if (until === undefined) return
            expect(clock(until, ZONE)).toBe('03:00')
            expect(until).toBeGreaterThan(before)
            expect(until - before).toBeLessThanOrEqual(25 * 60 * 60_000)
            const home = yield* pi(() => person.harness.snapshot(DreamHome, BACKGROUND_CONTEXT))
            expect(home).toMatchObject({
              threadId: THREAD,
              timezone: ZONE,
              today: [expect.any(Number)],
            })
          }),
        )
      }),
    ),
  )

  it.effect('queues one quiet pass for a long conversation and waits for it to go quiet', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        given.faux.setResponses(
          Array.from({ length: 7 }, (_, index) => fauxAssistantMessage(`Reply ${index + 1}.`)),
        )
        const runtime = yield* start(given)
        for (let turn = 1; turn <= 5; turn++) yield* exchange(runtime, turn)
        yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            yield* person.quiet
            const tasks = yield* pi(() => person.harness.inspect(BACKGROUND_CONTEXT))
            expect(
              tasks.tasks.filter((task) => task.record.kind === 'vivid.dreaming'),
              'five messages are not yet a long conversation',
            ).toHaveLength(0)
          }),
        )
        const before = Date.now()
        yield* exchange(runtime, 6)
        yield* exchange(runtime, 7)
        yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            yield* person.quiet
            const sleeping = yield* asleep(person.harness, 'vivid.dreaming')
            expect(sleeping, 'one quiet pass per conversation a day').toHaveLength(1)
            const [until] = sleeping
            expect(until).toBeGreaterThanOrEqual(before + 20 * 60_000)
            expect(until).toBeLessThanOrEqual(Date.now() + 20 * 60_000)
          }),
        )
      }),
    ),
  )
})
