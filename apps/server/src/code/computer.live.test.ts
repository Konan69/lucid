import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ApprovalId, CodeOutcome, PersonId, ThreadId } from '@vivid/contracts'
import { Duration, Effect, Layer, Ref } from 'effect'
import { boatMachineLayer } from '../computers/boat.ts'
import { Machine, MachineKey } from '../computers/machine.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { CodeComputer, installRunner, loadRunner, openGuest } from './computer.ts'
import { CallOutcome, CodeProcess, codeProcessLayer, type Dispatch } from './process.ts'

// A machine costs money and this test must never make one: it runs only when the installation
// names the machine it already has (`VIVID_BOAT_MACHINE`), which the Boat Layer then takes instead
// of creating. Read presence only; a key's value is never printed.
const enabled =
  testDatabaseConfigured &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_MACHINE') &&
  NodeProcess.env.VIVID_LIVE_PROGRAM_COMPUTER === '1'

const boat = boatMachineLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)),
)

/** The machine's key for this run, so a test can look at the Computer after a program ended. */
const key = MachineKey.make(NodeCrypto.randomUUID())

/**
 * The real provider under the real runner. Only the Computer store is left out: its waking and
 * takeover rules need a Person's rows and have their own tests, and the machine here is woken once
 * for the file. In the isolated database nobody holds the machine yet, so this key takes it.
 */
const onBoat = Layer.effect(
  CodeComputer,
  Effect.gen(function* () {
    const machine = yield* Machine
    const runner = yield* loadRunner
    yield* machine.ensure(key)
    const attachment: ComputerAttachment = {
      converse: (input) => machine.converse({ key, directory: '.', ...input }),
      write: (input) => machine.write({ key, ...input }),
    }
    yield* installRunner(attachment, runner)
    return CodeComputer.of({ open: () => openGuest(attachment, runner, Effect.void) })
  }),
)
const supervised = codeProcessLayer.pipe(Layer.provideMerge(onBoat), Layer.provideMerge(boat))

const boundary = () => ({
  person: PersonId.make('person-live'),
  thread: ThreadId.make(NodeCrypto.randomUUID()),
})

/** Timings only: never a program's output, an answer or anything of the machine's. */
const timed = <A, E, R>(step: string, program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const [duration, result] = yield* Effect.timed(program)
    yield* Effect.sync(() =>
      NodeProcess.stdout.write(
        `${JSON.stringify({ step, milliseconds: Math.round(Duration.toMillis(duration)) })}\n`,
      ),
    )
    return result
  })

describe.skipIf(!enabled)('Programs on a real Boat machine', () => {
  // One Layer for both: the machine is woken once, and the second program finds the runner
  // the first one installed.
  // The real clock: the machine is waited for and the provider answers in real time.
  layer(supervised, { timeout: '10 minutes', excludeTestServices: true })((it) => {
    it.effect(
      'runs on the Computer, has two calls answered at the same time, and returns what it computed',
      () =>
        Effect.gen(function* () {
          const process = yield* CodeProcess
          const asked = yield* Ref.make<ReadonlyArray<string>>([])
          const dispatch: Dispatch = Effect.fn('Live.answer')(function* (call) {
            yield* Ref.update(asked, (kinds) => kinds.concat([call.kind]))
            return CallOutcome.cases.Returned.make({
              value: { asked: call.input },
              summary: call.kind,
              end: 'completed',
            })
          })
          const outcome = yield* timed(
            'program',
            process.run(
              {
                request: {
                  summary: 'Prove a program runs on the Computer',
                  code: `const files = await import("node:fs/promises");
const [found, page] = await Promise.all([
  tools.find_tools({query: "records"}),
  tools.read_page({address: "https://example.com/"}),
]);
await files.writeFile("vivid-program-proof.txt", found.asked.query + " " + page.asked.address);
console.log("wrote the file");
const file = await files.readFile("vivid-program-proof.txt", "utf8");
await files.rm("vivid-program-proof.txt");
return {file, platform: process.platform};`,
                },
                boundary: boundary(),
              },
              dispatch,
            ),
          )
          expect(outcome).toEqual(
            CodeOutcome.cases.Completed.make({
              result: { file: 'records https://example.com/', platform: 'linux' },
              calls: [
                { kind: 'find_tools', summary: 'find_tools', end: 'completed' },
                { kind: 'read_page', summary: 'read_page', end: 'completed' },
              ],
              truncated: false,
              logs: ['wrote the file'],
              logsTruncated: false,
            }),
          )
          expect((yield* Ref.get(asked)).toSorted()).toEqual(['find_tools', 'read_page'])
        }),
      15 * 60_000,
    )

    it.effect(
      'stops the program on the Computer when a call needs an Approval, and leaves nothing of it running',
      () =>
        Effect.gen(function* () {
          const process = yield* CodeProcess
          const machine = yield* Machine
          const dispatch: Dispatch = () =>
            Effect.succeed(
              CallOutcome.cases.ApprovalRequired.make({
                approvalId: ApprovalId.make('approval-live'),
                summary: 'Send the message',
              }),
            )
          const outcome = yield* timed(
            'approval',
            process.run(
              {
                request: {
                  summary: 'Prove a decision stops the program',
                  code: 'try { await tools.use_tool({}); } catch (error) {} await new Promise((done) => setTimeout(done, 600000)); return "continued";',
                },
                boundary: boundary(),
              },
              dispatch,
            ),
          )
          expect(CodeOutcome.guards.ApprovalRequired(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['needs approval'])
          // The program was waiting on a ten-minute timer. Closing its command ended the runner
          // on the Computer; the bracket keeps the search from finding its own command line.
          const left = yield* machine.exec({
            key,
            command: "pgrep -f '[v]ivid/computer/program-' | wc -l",
            timeoutSeconds: 30,
          })
          expect(left.output.trim()).toBe('0')
        }),
      15 * 60_000,
    )
  })
})
