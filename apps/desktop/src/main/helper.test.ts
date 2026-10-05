import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import { fakeHelper } from './fake.ts'
import { WATCHDOG_GRACE_MS, locateHelper, startHelper } from './helper.ts'
import { HelperCall, HelperReply } from './wire.ts'

const window = { app: 'notepad', id: 'session:1A:2B:3C:Notepad' }
const turn = Option.some('run-1')

/** A started stand-in, and a queue that says when it stopped a turn or went away. */
const started = Effect.fn('started')(function* () {
  const heard = yield* Queue.unbounded<string>()
  const helper = yield* startHelper(fakeHelper, {
    stopped: (event) => {
      Queue.offerUnsafe(heard, `stopped ${event.turn}`)
    },
    gone: () => {
      Queue.offerUnsafe(heard, 'gone')
    },
  })
  const ask = (call: HelperCall) => helper.ask({ call, turn, budget: 5000 })
  return {
    helper,
    heard,
    ask,
    type: (text: string) => ask(HelperCall.cases.TypeText.make({ window, text })),
  }
})

describe('the helper process', () => {
  it('is only looked for on Windows', () => {
    const input = { packaged: true, resources: '/nowhere', bundle: '/nowhere', parent: 1 }
    expect(locateHelper({ ...input, platform: 'linux' })).toEqual(Option.none())
    expect(locateHelper({ ...input, platform: 'darwin' })).toEqual(Option.none())
    // On Windows with no file there is still no helper.
    expect(locateHelper({ ...input, platform: 'win32' })).toEqual(Option.none())
  })

  it.effect('answers requests in order, one at a time, past a line on stderr', () =>
    Effect.gen(function* () {
      const { ask } = yield* started()
      const replies = yield* Effect.all(
        [
          ask(HelperCall.cases.BeginTurn.make({})),
          ask(HelperCall.cases.ListWindows.make({})),
          ask(HelperCall.cases.EndTurn.make({})),
        ],
        { concurrency: 'unbounded' },
      )
      expect(replies.map((reply) => reply._tag)).toEqual(['Answered', 'Answered', 'Answered'])
      expect(replies[0]).toEqual(HelperReply.cases.Answered.make({ result: { active: true } }))
    }),
  )

  it.effect('passes on the helper’s refusal by name and its stop event', () =>
    Effect.gen(function* () {
      const { ask, type, heard } = yield* started()
      yield* ask(HelperCall.cases.BeginTurn.make({}))
      const reply = yield* type('escape')
      expect(HelperReply.guards.Refused(reply) && reply.name).toBe('PersonStopped')
      expect(yield* Queue.take(heard)).toBe('stopped run-1')
    }),
  )

  it.effect('exit 70 with a request written ends it as lost and sent, never as an answer', () =>
    Effect.gen(function* () {
      const { ask, type, heard } = yield* started()
      yield* ask(HelperCall.cases.BeginTurn.make({}))
      expect(yield* type('exit70')).toEqual(HelperReply.cases.Lost.make({ sent: true }))
      expect(yield* Queue.take(heard)).toBe('gone')
      // Nothing is written to a process that is gone.
      expect(yield* ask(HelperCall.cases.Status.make({}))).toEqual(
        HelperReply.cases.Lost.make({ sent: false }),
      )
    }),
  )

  it.effect('a line that is not the protocol ends the request and the process', () =>
    Effect.gen(function* () {
      const { ask, type, heard } = yield* started()
      yield* ask(HelperCall.cases.BeginTurn.make({}))
      expect(yield* type('garbage')).toEqual(HelperReply.cases.Lost.make({ sent: true }))
      expect(yield* Queue.take(heard)).toBe('gone')
    }),
  )

  it.effect(
    'a request that outlives its budget and the grace is given up, and the process ended',
    () =>
      Effect.gen(function* () {
        const { ask, type, heard } = yield* started()
        yield* ask(HelperCall.cases.BeginTurn.make({}))
        const hanging = yield* Effect.forkChild(type('hang'))
        yield* TestClock.adjust(5000 + WATCHDOG_GRACE_MS)
        expect(yield* Fiber.join(hanging)).toEqual(HelperReply.cases.Lost.make({ sent: true }))
        expect(yield* Queue.take(heard)).toBe('gone')
      }),
  )

  it.effect('closing its scope ends the process, and waits until it is gone', () =>
    Effect.gen(function* () {
      // The release step kills the process and waits for Node to report it closed, so the scope
      // finishing closing is the proof: a process that survived would hang this test. Ending it
      // on purpose is not reported as the helper going away.
      const heard = yield* Effect.scoped(
        Effect.gen(function* () {
          const running = yield* started()
          yield* running.ask(HelperCall.cases.Status.make({}))
          return running.heard
        }),
      )
      expect(yield* Queue.size(heard)).toBe(0)
    }),
  )
})
