import { describe, expect, it } from '@effect/vitest'
import {
  DeviceAnswer,
  RunId,
  WindowAction,
  WindowId,
  type DeviceAnswer as Answer,
} from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import { NoticeState } from '../shared/notice.ts'
import { fakeComputer } from './fake.ts'
import { turns } from './turn.ts'

const first = RunId.make('run-1')
const second = RunId.make('run-2')
const w1 = WindowId.make('w1')
const stopped = Option.some(DeviceAnswer.cases.Declined.make({ reason: 'Stopped' }))

/**
 * The turn keeper over the stand-in Computer process (`fake.mjs`), with the notice as a queue of
 * what it was told to show. Taking from that queue is how a test waits: nothing sleeps.
 */
const fixture = Effect.fn('fixture')(function* () {
  const shown = yield* Queue.unbounded<string>()
  const keeper = yield* turns({
    computer: Option.some(fakeComputer),
    notice: (state) => {
      Queue.offerUnsafe(
        shown,
        NoticeState.guards.WorkingIn(state) ? `WorkingIn ${state.app}` : state._tag,
      )
    },
  })
  // Each piece of work has thirty seconds from when it is sent, as the server gives it.
  const act = (runId: RunId, action: WindowAction) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => keeper.execute({ runId, action, expiresAt: now + 30_000 })),
    )
  const tagOf = (answer: Option.Option<Answer>) =>
    Option.match(answer, {
      onNone: () => 'no answer',
      onSome: (given) => (DeviceAnswer.guards.Did(given) ? given.result._tag : given._tag),
    })
  return {
    keeper,
    shown,
    notice: Queue.take(shown),
    act,
    tagOf,
    list: (runId: RunId) => act(runId, WindowAction.cases.ListWindows.make({})),
    look: (runId: RunId) => act(runId, WindowAction.cases.Look.make({ window: w1 })),
    type: (runId: RunId, text: string) =>
      act(runId, WindowAction.cases.Type.make({ window: w1, text })),
  }
})

describe('Vivid’s turn on the Person’s computer', () => {
  it.effect('begins with a Run’s first work, names the app once seen, and ends with the Run', () =>
    Effect.gen(function* () {
      const { keeper, notice, list, look, tagOf } = yield* fixture()
      expect(tagOf(yield* list(first))).toBe('Windows')
      expect(yield* notice).toBe('Working')
      expect(tagOf(yield* look(first))).toBe('Seen')
      expect(yield* notice).toBe('WorkingIn notepad')
      // Another Run ending is not this turn's business.
      yield* keeper.ended(second)
      yield* keeper.ended(first)
      expect(yield* notice).toBe('Hidden')
    }),
  )

  it.effect('work of another Run ends the turn in progress first', () =>
    Effect.gen(function* () {
      const { notice, list, tagOf } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      // The stand-in refuses a second turn while one is active, as the Computer does.
      expect(tagOf(yield* list(second))).toBe('Windows')
      expect(yield* notice).toBe('Hidden')
      expect(yield* notice).toBe('Working')
    }),
  )

  it.effect('ends after a minute with no work, and not while work keeps coming', () =>
    Effect.gen(function* () {
      const { shown, notice, list } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      yield* TestClock.adjust('59 seconds')
      yield* list(first)
      yield* TestClock.adjust('59 seconds')
      expect(yield* Queue.size(shown)).toBe(0)
      yield* TestClock.adjust('1 second')
      expect(yield* notice).toBe('Hidden')
    }),
  )

  it.effect(
    'Escape during work declines it as stopped; that Run is over, a new one works at once',
    () =>
      Effect.gen(function* () {
        const { keeper, notice, list, type, tagOf } = yield* fixture()
        yield* list(first)
        expect(yield* notice).toBe('Working')
        expect(yield* type(first, 'escape')).toEqual(stopped)
        expect(yield* notice).toBe('Hidden')
        // It was answered, so it is not also reported.
        expect(yield* Queue.size(keeper.stops)).toBe(0)
        expect(yield* list(first)).toEqual(stopped)
        expect(tagOf(yield* list(second))).toBe('Windows')
        expect(yield* notice).toBe('Working')
      }),
  )

  it.effect('Escape between two actions is reported at once', () =>
    Effect.gen(function* () {
      const { keeper, notice, list, type, tagOf } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      // The stand-in sends its stop line just after this action's own answer.
      expect(tagOf(yield* type(first, 'escape later'))).toBe('Typed')
      expect(yield* notice).toBe('WorkingIn notepad')
      expect(yield* Queue.take(keeper.stops)).toBe(first)
      expect(yield* notice).toBe('Hidden')
    }),
  )

  it.effect('Stop on the notice ends work the Computer is still doing', () =>
    Effect.gen(function* () {
      const { keeper, notice, list, type, tagOf } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      const hanging = yield* Effect.forkChild(type(first, 'hang'))
      keeper.stop()
      expect(yield* Fiber.join(hanging)).toEqual(stopped)
      expect(yield* notice).toBe('Stopping')
      // A stop ends that Run's turn and nothing more: another Run works at once.
      expect(tagOf(yield* list(second))).toBe('Windows')
    }),
  )

  it.effect('Stop on the notice between two actions is reported, and the notice comes down', () =>
    Effect.gen(function* () {
      const { keeper, notice, list } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      keeper.stop()
      expect(yield* Queue.take(keeper.stops)).toBe(first)
      expect(yield* notice).toBe('Stopping')
      expect(yield* notice).toBe('Hidden')
      expect(yield* list(first)).toEqual(stopped)
    }),
  )

  it.effect('a change the Computer died on is not answered, and the next work starts it again', () =>
    Effect.gen(function* () {
      const { notice, list, type, tagOf } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      // Exit 70: the input may have gone in. Not done, not declined, not failed.
      expect(tagOf(yield* type(first, 'exit70'))).toBe('no answer')
      expect(yield* notice).toBe('Hidden')
      expect(tagOf(yield* list(first))).toBe('Windows')
      expect(yield* notice).toBe('Working')
    }),
  )

  it.effect('a change refused before anything was sent fails plainly', () =>
    Effect.gen(function* () {
      const { list, type, tagOf } = yield* fixture()
      yield* list(first)
      expect(tagOf(yield* type(first, 'unsent'))).toBe('Failed')
    }),
  )

  it.effect('work past its deadline is not started and not answered', () =>
    Effect.gen(function* () {
      const { keeper, shown } = yield* fixture()
      yield* TestClock.adjust('31 seconds')
      const answer = yield* keeper.execute({
        runId: first,
        action: WindowAction.cases.ListWindows.make({}),
        expiresAt: 30_000,
      })
      expect(answer).toEqual(Option.none())
      expect(yield* Queue.size(shown)).toBe(0)
    }),
  )

  it.effect('the link ending takes the notice down and lets the Computer go', () =>
    Effect.gen(function* () {
      const { keeper, notice, list, tagOf } = yield* fixture()
      yield* list(first)
      expect(yield* notice).toBe('Working')
      yield* keeper.unlinked
      expect(yield* notice).toBe('Hidden')
      // Linked again, the same Run's work starts a new Computer and a new turn.
      expect(tagOf(yield* list(first))).toBe('Windows')
      expect(yield* notice).toBe('Working')
    }),
  )

  it.effect('a computer with no Computer says apps are unsupported and starts nothing', () =>
    Effect.gen(function* () {
      const keeper = yield* turns({ computer: Option.none(), notice: () => undefined })
      expect(keeper.apps).toBe(false)
      const answer = yield* keeper.execute({
        runId: first,
        action: WindowAction.cases.ListWindows.make({}),
        expiresAt: 30_000,
      })
      expect(answer).toEqual(
        Option.some(DeviceAnswer.cases.Declined.make({ reason: 'Unsupported' })),
      )
    }),
  )
})
