import { describe, expect, it } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { MachineTest } from '@typeonce/effect-machine/testing'
import { FeedCardId, FeedItem, ThreadId } from '@vivid/contracts'
import {
  Arbitrary,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import {
  Press,
  Settling,
  feedFace,
  feedView,
  fill,
  folds,
  failed,
  pressKey,
  standingOf,
  PressMachine,
  PressStates,
  PressEvents,
  Sending,
  SendRefused,
  pressOf,
  revisionOf,
  seenReports,
  type Waiting,
  type Delivery,
} from './feed.js'

const thread = ThreadId.make('00000000-0000-4000-8000-000000000001')
const waiting = FeedItem.cases.Waiting.make({
  card: FeedCardId.make('card-1'),
  thread,
  from: 'Trip to Abuja',
  at: 10,
  post: {
    title: 'Which flight?',
    words: 'Both land in time.',
    display: null,
    actions: ['Not now', 'Book $flight'],
  },
  seen: false,
  asking: [],
})
const seen = FeedItem.cases.Waiting.make({ ...waiting, at: 11, seen: true })
const newPost = FeedItem.cases.Waiting.make({
  ...waiting,
  // A replacement can arrive with the same timestamp. Its post owns its identity.
  post: {
    title: 'Which flight?',
    words: 'There is another flight now.',
    display: null,
    actions: ['Not now', 'Book $flight'],
  },
})
const working = FeedItem.cases.Working.make({
  card: FeedCardId.make('card-2'),
  thread,
  from: 'Investor update',
  since: 5,
  post: null,
})

describe("a card button's words", () => {
  it('say what the Person picked under the name they use', () => {
    expect(fill('Book $flight', { $flight: 'Arik Air at 7:10' })).toBe('Book Arik Air at 7:10')
  })

  it('read a pick the renderer keeps inside its field', () => {
    expect(fill('Keep $day clear', { $day: { value: 'Fri 16', componentType: 'Select' } })).toBe(
      'Keep Fri 16 clear',
    )
  })

  it('say numbers, ticks and several picks as words', () => {
    expect(
      fill('Send $count to $who, cc $cc', { $count: 3, $who: ['Ada', 'Tobi'], $cc: false }),
    ).toBe('Send 3 to Ada, Tobi, cc no')
  })

  it('replaces repeated and numbered names without interpreting dollar signs in chosen words', () => {
    expect(fill('$ticket_2 then $ticket_2', { $ticket_2: '$5 & $flight' })).toBe(
      '$5 & $flight then $5 & $flight',
    )
  })

  it('keeps names for unsupported or absent renderer values', () => {
    for (const value of [null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fill('Book $flight', { $flight: value })).toBe('Book $flight')
    }
  })

  it('leave a name nothing was chosen under as Vivid wrote it', () => {
    expect(fill('Book $flight', {})).toBe('Book $flight')
    expect(fill('Book $flight', { $flight: '  ' })).toBe('Book $flight')
  })
})

describe('the Feed as it is drawn', () => {
  it('sorts items by stage and counts what waits', () => {
    const view = feedView([working, waiting])
    expect(view.waiting.map((item) => item.from)).toEqual(['Trip to Abuja'])
    expect(view.working.map((item) => item.from)).toEqual(['Investor update'])
    expect(standingOf(view.waiting.length)).toEqual({
      lead: '1 thing needs you.',
      rest: 'The rest is handled.',
    })
    expect(standingOf(0)).toEqual({ lead: 'Nothing needs you.', rest: '' })
  })

  it('shows the face pleased after a settle, then at work, then asking', () => {
    const view = feedView([working, waiting])
    expect(feedFace(view, true)).toBe('done')
    expect(feedFace(view, false)).toBe('working')
    expect(feedFace(feedView([waiting]), false)).toBe('waiting')
    expect(feedFace(feedView([]), false)).toBe('idle')
  })
})

describe('a press on a card', () => {
  const said = (key: string) => ({
    revision: revisionOf(waiting),
    how: Settling.Said({ words: 'Book Arik', key }),
  })

  it('folds the card it answered until Vivid posts again', () => {
    expect(folds(waiting, Option.some(Press.Sending(said('a'))))).toBe(true)
    expect(folds(waiting, Option.some(Press.Unsent(said('a'))))).toBe(false)
    expect(folds(seen, Option.some(Press.Sent(said('a'))))).toBe(true)
    expect(folds(newPost, Option.some(Press.Sent(said('a'))))).toBe(false)
    expect(failed(seen, Option.some(Press.Unsent(said('a'))))).toBe(true)
    expect(failed(newPost, Option.some(Press.Unsent(said('a'))))).toBe(false)
  })

  it('keeps the failed delivery key for the same words, and a new one otherwise', () => {
    const lost = Option.some(Press.Unsent(said('kept')))
    expect(pressKey(waiting, lost, 'Book Arik', () => 'new')).toBe('kept')
    expect(pressKey(seen, lost, 'Book Arik', () => 'new')).toBe('kept')
    expect(pressKey(newPost, lost, 'Book Arik', () => 'new')).toBe('new')
    expect(pressKey(waiting, lost, 'Not now', () => 'new')).toBe('new')
    expect(pressKey(waiting, Option.none(), 'Book Arik', () => 'new')).toBe('new')
  })
})

describe('seen reports', () => {
  it('deduplicates a post across seen updates and reports a new post on the same card', () => {
    const reports = seenReports()
    expect(reports.claim(waiting)).toBe(true)
    expect(reports.claim(waiting)).toBe(false)
    expect(reports.claim(seen)).toBe(false)
    expect(reports.claim(newPost)).toBe(true)
    expect(reports.claim(newPost)).toBe(false)
    expect(reports.claim({ ...waiting, card: FeedCardId.make('other') })).toBe(true)
  })

  it('retries a failed report, and a stale failure does not free a newer post', () => {
    const reports = seenReports()
    expect(reports.claim(waiting)).toBe(true)
    reports.forget(seen)
    expect(reports.claim(waiting)).toBe(true)
    expect(reports.claim(newPost)).toBe(true)
    // The first post's report fails after the card moved on: the newer claim stands.
    reports.forget(seen)
    expect(reports.claim(newPost)).toBe(false)
  })

  it('reports changed questions on cards without a post', () => {
    const reports = seenReports()
    const question = FeedItem.cases.Waiting.make({ ...waiting, post: null, asking: ['question'] })
    expect(reports.claim(question)).toBe(true)
    expect(reports.claim({ ...question, at: 11, seen: true })).toBe(false)
    expect(reports.claim({ ...question, asking: ['approval'] })).toBe(true)
  })
})

/** Every invocation gets its own answer, so an interrupted call can finish late in a test. */
const started = Effect.fn('Feed.test.started')(function* () {
  const calls = yield* Queue.unbounded<{
    readonly delivery: Delivery
    readonly answer: Deferred.Deferred<Result.Result<void, SendRefused>>
  }>()
  const interrupted = yield* Queue.unbounded<string>()
  const sent: Array<Delivery> = []
  const service = Layer.succeed(Sending, {
    send: (delivery) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<Result.Result<void, SendRefused>>()
        sent.push(delivery)
        yield* Queue.offer(calls, { delivery, answer })
        return yield* Deferred.await(answer).pipe(Effect.flatMap(Effect.fromResult))
      }).pipe(Effect.onInterrupt(() => Queue.offer(interrupted, delivery.pressed.revision))),
  })
  const ref = yield* Machine.start(PressMachine).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- This case owns the service and its hand-answered calls.
    Effect.provide(service),
  )
  const probe = yield* MachineTest.probe(PressMachine, ref)
  const at = (path: Parameters<typeof PressStates.matches>[1]) =>
    Machine.waitFor(ref, (snapshot) => PressStates.matches(snapshot.state, path))
  return { ref, probe, at, calls, interrupted, sent }
})

/** The caller supplies a fresh candidate key; the machine decides whether to reuse a lost one. */
const pressing = (words: string, key: string, item: Waiting = waiting) =>
  PressEvents.Press({
    item,
    how: Settling.Said({ words, key }),
  })

/** Runtime generation needs decoded events rather than the constructors' opaque values. */
type Said = Machine.Machine.InputEvent<typeof PressMachine>
const repeated = Arbitrary.schema(Schema.Literals(['Book Arik', 'Not now'])).pipe(
  Arbitrary.map((words): Said => ({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- runtimeCommands takes decoded events, not opaque event constructors.
    _tag: 'Press',
    item: waiting,
    how: Settling.Said({ words, key: 'duplicate' }),
  })),
)
const duplicates = MachineTest.runtimeCommands(PressMachine, {
  eventArbitrary: repeated,
  includeAdvance: false,
  includeStop: false,
  includeCheckpoint: false,
  maxCommands: 8,
}).arbitrary
const generated = { arbitrary: { runs: 40, seed: 20261020 } }

describe('a card press machine', () => {
  it.effect('a seen-only timestamp change stays folded and refuses another press', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'first'))
      const first = yield* Queue.take(made.calls)
      const duplicate = PressEvents.Press({
        item: seen,
        how: Settling.Said({ words: 'Not now', key: 'duplicate' }),
      })
      expect(folds(seen, pressOf((yield* made.at('Sending')).state))).toBe(true)
      expect((yield* made.probe.sendAndAwait(duplicate)).handled).toBe(false)
      yield* Deferred.succeed(first.answer, Result.succeed(undefined))
      expect(folds(seen, pressOf((yield* made.at('Sent')).state))).toBe(true)
      expect((yield* made.probe.sendAndAwait(duplicate)).handled).toBe(false)
      expect(made.sent).toHaveLength(1)
    }),
  )

  it.effect('walks Idle, Sending, Unsent, Sending and Sent with a hand-answered delivery', () =>
    Effect.gen(function* () {
      const made = yield* started()
      expect(pressOf((yield* made.at('Idle')).state)).toEqual(Option.none())
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'first'))
      const first = yield* Queue.take(made.calls)
      expect(pressOf((yield* made.at('Sending')).state)).toEqual(
        Option.some(Press.Sending(first.delivery.pressed)),
      )
      yield* Deferred.succeed(first.answer, Result.fail(new SendRefused({ card: waiting.card })))
      const unsent = pressOf((yield* made.at('Unsent')).state)
      expect(failed(waiting, unsent)).toBe(true)
      expect(folds(waiting, unsent)).toBe(false)
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'second'))
      const retry = yield* Queue.take(made.calls)
      expect(retry.delivery.pressed.how).toEqual(
        Settling.Said({ words: 'Book Arik', key: 'first' }),
      )
      yield* Deferred.succeed(retry.answer, Result.succeed(undefined))
      const sent = pressOf((yield* made.at('Sent')).state)
      expect(folds(waiting, sent)).toBe(true)
      expect(folds(seen, sent)).toBe(true)
      expect(folds(newPost, sent)).toBe(false)
    }),
  )

  it.effect('closes through the invoked service and can retry a refused close', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const event = PressEvents.Press({ item: waiting, how: Settling.Done() })
      yield* made.probe.sendAndAwait(event)
      const first = yield* Queue.take(made.calls)
      expect(first.delivery).toEqual({
        card: waiting.card,
        thread: waiting.thread,
        pressed: { revision: revisionOf(waiting), how: Settling.Done() },
      })
      yield* Deferred.succeed(first.answer, Result.fail(new SendRefused({ card: waiting.card })))
      yield* made.at('Unsent')
      yield* made.probe.sendAndAwait(event)
      const retry = yield* Queue.take(made.calls)
      yield* Deferred.succeed(retry.answer, Result.succeed(undefined))
      expect(pressOf((yield* made.at('Sent')).state)).toEqual(
        Option.some(Press.Sent(retry.delivery.pressed)),
      )
    }),
  )

  it.effect('a newer post interrupts an older send and ignores its late receipt', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'first'))
      const old = yield* Queue.take(made.calls)
      yield* made.probe.sendAndAwait(pressing('Not now', 'next', newPost))
      expect(yield* Queue.take(made.interrupted)).toBe(revisionOf(waiting))
      const current = yield* Queue.take(made.calls)
      yield* Deferred.succeed(old.answer, Result.succeed(undefined))
      // Acknowledgement observes all preceding work without a sleep or a polling loop.
      const duplicate = yield* made.probe.sendAndAwait(pressing('Book Arik', 'duplicate', newPost))
      expect(duplicate.handled).toBe(false)
      expect(pressOf(duplicate.after)).toEqual(Option.some(Press.Sending(current.delivery.pressed)))
      yield* Deferred.succeed(current.answer, Result.fail(new SendRefused({ card: waiting.card })))
      const unsent = pressOf((yield* made.at('Unsent')).state)
      expect(failed(newPost, unsent)).toBe(true)
      expect(failed(waiting, unsent)).toBe(false)
    }),
  )

  it.effect('stopping the card interrupts its delivery', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'first'))
      const call = yield* Queue.take(made.calls)
      yield* made.ref.stop
      expect(yield* Queue.take(made.interrupted)).toBe(revisionOf(waiting))
      yield* Deferred.succeed(call.answer, Result.succeed(undefined))
      expect((yield* made.ref.snapshot).status).toBe('stopped')
    }),
  )

  it.effect('elapsed time does not resend or finish an unacknowledged delivery', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.probe.sendAndAwait(pressing('Book Arik', 'first'))
      yield* Queue.take(made.calls)
      yield* TestClock.adjust('1 hour')
      expect(PressStates.matches((yield* made.ref.snapshot).state, 'Sending')).toBe(true)
      expect(made.sent).toHaveLength(1)
    }),
  )

  it.effect.prop(
    'refuses queued duplicate presses both before and after the receipt',
    { before: duplicates, after: duplicates },
    ({ before, after }) =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.ref.send(pressing('Book Arik', 'first'))
        const call = yield* Queue.take(made.calls)
        /** Acknowledged probes prove ignored events were processed, not merely queued. */
        const refuse = (commands: typeof before, path: 'Sending' | 'Sent') =>
          MachineTest.runCausalCommands(made.probe, commands, {
            initialModel: path,
            transition: (model) => Effect.succeed({ model, expected: model }),
            assert: ({ expected, result }) =>
              Predicate.isTagged(result, 'SendProcessed')
                ? Effect.sync(() => {
                    expect(result.step.handled).toBe(false)
                    expect(PressStates.matches(result.step.after, expected)).toBe(true)
                  })
                : Effect.fail(result._tag),
          })
        yield* refuse(before, 'Sending')
        yield* Deferred.succeed(call.answer, Result.succeed(undefined))
        yield* made.at('Sent')
        yield* refuse(after, 'Sent')
        expect(made.sent).toHaveLength(1)
        yield* made.probe.sendAndAwait(pressing('Book Arik', 'new-post', newPost))
        const next = yield* Queue.take(made.calls)
        expect(folds(newPost, pressOf((yield* made.at('Sending')).state))).toBe(true)
        expect(next.delivery.pressed.how).toEqual(
          Settling.Said({ words: 'Book Arik', key: 'new-post' }),
        )
      }),
    generated,
  )

  it.effect.prop(
    'reuses a lost receipt key only for the same words on the same post',
    { sameWords: Schema.Boolean, samePost: Schema.Boolean },
    ({ sameWords, samePost }) =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.probe.sendAndAwait(pressing('Book Arik', 'lost'))
        const first = yield* Queue.take(made.calls)
        yield* Deferred.succeed(first.answer, Result.fail(new SendRefused({ card: waiting.card })))
        yield* made.at('Unsent')
        const words = sameWords ? 'Book Arik' : 'Not now'
        yield* made.probe.sendAndAwait(pressing(words, 'fresh', samePost ? seen : newPost))
        const retry = yield* Queue.take(made.calls)
        expect(retry.delivery.pressed.how).toEqual(
          Settling.Said({ words, key: sameWords && samePost ? 'lost' : 'fresh' }),
        )
      }),
    generated,
  )
})
