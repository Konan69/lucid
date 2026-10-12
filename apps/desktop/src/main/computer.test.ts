import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
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

/** An owned temporary directory, removed with the test's scope. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-computer-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

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
  it.effect('is the shipped pair on Windows, and nothing anywhere else', () =>
    Effect.gen(function* () {
      const root = yield* directory
      // The packaged layout (`electron-builder.yml`) and the development one, written out by
      // hand: the file names here are the vendored ones, not read from the module under test.
      const packaged = NodePath.join(root, 'resources', 'native', 'computer')
      const vendored = NodePath.join(root, 'dist', 'vendor', 'computer')
      const supervisorOnly = NodePath.join(root, 'half', 'native', 'computer')
      for (const pair of [packaged, vendored]) {
        NodeFS.mkdirSync(NodePath.join(pair, 'swift', 'x64'), { recursive: true })
        NodeFS.writeFileSync(NodePath.join(pair, 'codex-computer-use.exe'), '')
        NodeFS.writeFileSync(
          NodePath.join(pair, 'swift', 'x64', 'codex-computer-use-swift.exe'),
          '',
        )
      }
      NodeFS.mkdirSync(supervisorOnly, { recursive: true })
      NodeFS.writeFileSync(NodePath.join(supervisorOnly, 'codex-computer-use.exe'), '')
      const input = {
        packaged: true,
        resources: NodePath.join(root, 'resources'),
        bundle: NodePath.join(root, 'dist', 'main'),
        parent: 41,
      }

      expect(locateComputer({ ...input, platform: 'win32' })).toEqual(
        Option.some({
          command: NodePath.join(packaged, 'codex-computer-use.exe'),
          args: ['--parent-pid', '41'],
          engine: Option.some(
            NodePath.join(packaged, 'swift', 'x64', 'codex-computer-use-swift.exe'),
          ),
        }),
      )
      // In development the pair is the one vendored beside `dist`, never the packaged copy.
      expect(
        Option.map(
          locateComputer({ ...input, packaged: false, platform: 'win32' }),
          (found) => found.command,
        ),
      ).toEqual(Option.some(NodePath.join(vendored, 'codex-computer-use.exe')))
      // The same files on another system are not a Computer.
      expect(locateComputer({ ...input, platform: 'linux' })).toEqual(Option.none())
      expect(locateComputer({ ...input, platform: 'darwin' })).toEqual(Option.none())
      // A supervisor without its engine, or no files at all, is no Computer on Windows either.
      expect(
        locateComputer({ ...input, resources: NodePath.join(root, 'half'), platform: 'win32' }),
      ).toEqual(Option.none())
      expect(
        locateComputer({ ...input, resources: NodePath.join(root, 'absent'), platform: 'win32' }),
      ).toEqual(Option.none())
    }),
  )

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
