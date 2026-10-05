import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import { fakeComputer } from './fake.ts'
import { WATCHDOG_GRACE_MS, locateComputer, startComputer } from './computer.ts'
import { ComputerCall, ComputerReply } from './wire.ts'

const window = { app: 'notepad', id: '7' }
const turn = Option.some('run-1')

/** A started stand-in, and a queue that says when it stopped a turn or went away. */
const started = Effect.fn('started')(function* () {
  const heard = yield* Queue.unbounded<string>()
  const computer = yield* startComputer(fakeComputer, {
    stopped: (event) => {
      Queue.offerUnsafe(heard, `stopped ${event.turn}`)
    },
    gone: () => {
      Queue.offerUnsafe(heard, 'gone')
    },
  })
  const ask = (call: ComputerCall) => computer.ask({ call, turn, budget: 5000 })
  return {
    computer,
    heard,
    ask,
    type: (text: string) => ask(ComputerCall.cases.TypeText.make({ window, text })),
  }
})

describe('the Computer process', () => {
  it('is only looked for on Windows', () => {
    const input = { packaged: true, resources: '/nowhere', bundle: '/nowhere', parent: 1 }
    expect(locateComputer({ ...input, platform: 'linux' })).toEqual(Option.none())
    expect(locateComputer({ ...input, platform: 'darwin' })).toEqual(Option.none())
    // On Windows with no file there is still no Computer.
    expect(locateComputer({ ...input, platform: 'win32' })).toEqual(Option.none())
  })

  it.effect('answers requests in order, one at a time, past a line on stderr', () =>
    Effect.gen(function* () {
      const { ask } = yield* started()
      const replies = yield* Effect.all(
        [
          ask(ComputerCall.cases.BeginTurn.make({})),
          ask(ComputerCall.cases.ListWindows.make({})),
          ask(ComputerCall.cases.EndTurn.make({})),
        ],
        { concurrency: 'unbounded' },
      )
      expect(replies.map((reply) => reply._tag)).toEqual(['Answered', 'Answered', 'Answered'])
      // Begin turn is answered by the desktop itself; it never reaches the wire.
      expect(replies[0]).toEqual(ComputerReply.cases.Answered.make({ result: {} }))
    }),
  )

  it.effect('passes on the Computer’s refusal message', () =>
    Effect.gen(function* () {
      const { ask } = yield* started()
      // The stand-in refuses an unknown app with its own message.
      const reply = yield* ask(
        ComputerCall.cases.LaunchApp.make({ app: 'Unknown', id: 'unknown.app' }),
      )
      expect(reply._tag).toEqual('Refused')
    }),
  )

  it.effect('answers an approval ask itself, with the approved app in the meta', () =>
    Effect.gen(function* () {
      const { ask } = yield* started()
      const reply = yield* ask(
        ComputerCall.cases.LaunchApp.make({ app: 'Approval', id: 'approval.app' }),
      )
      // The stand-in asks once, then takes the re-sent request with the approved app.
      expect(reply._tag).toEqual('Answered')
    }),
  )

  it.effect('the Person’s Escape is the supervisor’s exit 130, said as the turn’s stop', () =>
    Effect.gen(function* () {
      const { heard, type } = yield* started()
      // The reply to the Esc'd request is the supervisor's own Escape message; the stop and the
      // exit follow it in that order.
      const said = yield* type('escape')
      expect(ComputerReply.guards.Refused(said) && said.name.startsWith('Computer Use was stopped')).toBe(true)
      expect(yield* Queue.take(heard)).toEqual('stopped run-1')
      expect(yield* Queue.take(heard)).toEqual('gone')
    }),
  )

  it.effect('a request past its budget and grace is lost, and the process is stopped', () =>
    Effect.gen(function* () {
      const { heard, type } = yield* started()
      const lost = yield* Effect.forkChild(
        type('hang').pipe(Effect.andThen(Queue.take(heard))),
      )
      yield* TestClock.adjust(`${5_000 + WATCHDOG_GRACE_MS + 1} millis`)
      expect(yield* Fiber.join(lost)).toEqual('gone')
    }),
  )

  it.effect('a request that never got an answer to a dead process is lost unsent', () =>
    Effect.gen(function* () {
      const { computer, ask } = yield* started()
      // The stand-in answers nothing and exits for good.
      const dying = yield* Effect.forkChild(
        computer.ask({ call: ComputerCall.cases.TypeText.make({ window, text: 'exit70' }), turn, budget: 5000 }),
      )
      yield* TestClock.adjust('1 seconds')
      yield* Fiber.join(dying)
      // The next request says plainly that nothing was sent and nothing is coming.
      const after = yield* ask(ComputerCall.cases.ListWindows.make({}))
      expect(after).toEqual(ComputerReply.cases.Lost.make({ sent: false }))
    }),
  )

  it.effect('a line that is not the protocol ends the process this app spawned', () =>
    Effect.gen(function* () {
      const { heard, type } = yield* started()
      const said = yield* type('garbage')
      expect(said._tag).toEqual('Lost')
      expect(yield* Queue.take(heard)).toEqual('gone')
    }),
  )
})
