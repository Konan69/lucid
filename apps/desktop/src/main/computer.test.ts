import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'
import { fakeComputer } from './fake.ts'
import { WATCHDOG_GRACE_MS, startComputer } from './computer.ts'
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
  it.effect('gives each request its own answer, in the order asked, past a line on stderr', () =>
    Effect.gen(function* () {
      const { ask, type } = yield* started()
      const replies = yield* Effect.all(
        [
          ask(ComputerCall.cases.BeginTurn.make({})),
          ask(ComputerCall.cases.ListWindows.make({})),
          ask(ComputerCall.cases.ListApps.make({})),
          ask(ComputerCall.cases.EndTurn.make({})),
        ],
        { concurrency: 'unbounded' },
      )
      // Begin turn is answered by the desktop itself; the others get the answer to their own
      // request, which a reply matched to the wrong waiter would swap.
      expect(replies).toEqual([
        ComputerReply.cases.Answered.make({ result: {} }),
        ComputerReply.cases.Answered.make({
          result: [{ app: 'notepad', id: 7, title: 'Untitled - Notepad' }],
        }),
        ComputerReply.cases.Answered.make({
          result: [
            { id: 'Microsoft.Notepad_8wekyb3d8bbwe!App', displayName: 'Notepad' },
            { id: 'machine:Terminal.lnk' },
            { id: 'machine:Nameless.lnk', displayName: '' },
          ],
        }),
        ComputerReply.cases.Answered.make({ result: {} }),
      ])
      // What the process itself received: begin turn never reached it, and the rest arrived
      // numbered in the order they were asked.
      expect(yield* type('heard')).toEqual(
        ComputerReply.cases.Answered.make({
          result: { heard: ['1 list_windows', '2 list_apps', '3 end_turn'] },
        }),
      )
    }),
  )

  it.effect('passes on the Computer’s refusal message', () =>
    Effect.gen(function* () {
      const { ask } = yield* started()
      // The stand-in refuses an unknown app with its own message.
      const reply = yield* ask(
        ComputerCall.cases.LaunchApp.make({ app: 'Unknown', id: 'unknown.app' }),
      )
      expect(reply).toEqual(
        ComputerReply.cases.Refused.make({
          name: 'app is not in the inventory',
          delivered: Option.none(),
          reason: Option.none(),
        }),
      )
    }),
  )

  it.effect('answers an approval ask itself, with the approved app in the meta', () =>
    Effect.gen(function* () {
      const { ask, type } = yield* started()
      const reply = yield* ask(
        ComputerCall.cases.LaunchApp.make({ app: 'Approval', id: 'approval.app' }),
      )
      // The stand-in asks once, and takes the re-sent request only with the approved app in its
      // meta; its answer says which app that was.
      expect(reply).toEqual(
        ComputerReply.cases.Answered.make({ result: { approved: 'approval.app' } }),
      )
      // The re-send is the same numbered request again, not a new one.
      expect(yield* type('heard')).toEqual(
        ComputerReply.cases.Answered.make({ result: { heard: ['1 launch_app', '1 launch_app'] } }),
      )
    }),
  )

  it.effect('the Person’s Escape is the supervisor’s exit 130, said as the turn’s stop', () =>
    Effect.gen(function* () {
      const { heard, type } = yield* started()
      // The reply to the Esc'd request is the supervisor's own Escape message; the stop and the
      // exit follow it in that order.
      const said = yield* type('escape')
      expect(
        ComputerReply.guards.Refused(said) && said.name.startsWith('Computer Use was stopped'),
      ).toBe(true)
      expect(yield* Queue.take(heard)).toEqual('stopped run-1')
      expect(yield* Queue.take(heard)).toEqual('gone')
    }),
  )

  it.effect('a request past its budget and grace is lost, and the process is stopped', () =>
    Effect.gen(function* () {
      const { heard, type } = yield* started()
      const lost = yield* Effect.forkChild(type('hang').pipe(Effect.andThen(Queue.take(heard))))
      yield* TestClock.adjust(`${5_000 + WATCHDOG_GRACE_MS + 1} millis`)
      expect(yield* Fiber.join(lost)).toEqual('gone')
    }),
  )

  it.effect('a request that never got an answer to a dead process is lost unsent', () =>
    Effect.gen(function* () {
      const { computer, ask } = yield* started()
      // The stand-in answers nothing and exits for good.
      const dying = yield* Effect.forkChild(
        computer.ask({
          call: ComputerCall.cases.TypeText.make({ window, text: 'exit70' }),
          turn,
          budget: 5000,
        }),
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
