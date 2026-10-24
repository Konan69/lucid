import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ApprovalId, CodeOutcome, PersonId, ThreadId } from '@vivid/contracts'
import { Deferred, Duration, Effect, Layer, Ref, Option, Schema } from 'effect'
import { proofComputer } from '../computers/tests/proof.ts'
import { Machine, MachineKey } from '../computers/machine.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { CodeComputer, installRunner, loadRunner, openGuest } from './computer.ts'
import { CallOutcome, CodeProcess, codeProcessLayer, type Dispatch } from './process.ts'

const decodeGuestPid = Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Int }))

// Explicit live opt-in authorizes creation and destruction of a disposable proof machine.
// The shared fixture rejects both adoption settings before any provider or guest work.
const enabled =
  testDatabaseConfigured &&
  Object.hasOwn(NodeProcess.env, 'VIVID_BOAT_API_KEY') &&
  NodeProcess.env.VIVID_LIVE_PROGRAM_COMPUTER === '1'

/** Each file's owned machine key keeps the runner available across its two scoped programs. */
const key = MachineKey.make(NodeCrypto.randomUUID())
const boat = Layer.effect(
  Machine,
  Effect.gen(function* () {
    return (yield* proofComputer(key)).machine
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)))

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
  layer(supervised, { excludeTestServices: true })((it) => {
    it.effect(
      'runs on the Computer, has two calls answered at the same time, and returns what it computed',
      () =>
        Effect.gen(function* () {
          const process = yield* CodeProcess
          const asked = yield* Ref.make<ReadonlyArray<string>>([])
          const bothEntered = yield* Deferred.make<void>()
          const machine = yield* Machine
          const proofFile = `/tmp/vivid-code-proof-${NodeCrypto.randomUUID()}.txt`
          yield* Effect.addFinalizer(() =>
            machine.exec({ key, command: `rm -f -- '${proofFile}'`, timeoutSeconds: 30 }).pipe(
              Effect.catch(() =>
                Effect.sync(() => expect.fail('Could not remove owned proof file')),
              ),
              Effect.asVoid,
            ),
          )
          const dispatch: Dispatch = Effect.fn('Live.answer')(function* (call) {
            const entered = yield* Ref.updateAndGet(asked, (kinds) => kinds.concat([call.kind]))
            if (entered.length === 2) yield* Deferred.succeed(bothEntered, undefined)
            yield* Deferred.await(bothEntered).pipe(
              Effect.timeoutOrElse({
                duration: '30 seconds',
                orElse: () => Effect.die('Both calls must enter dispatch together'),
              }),
            )
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
await files.writeFile(${JSON.stringify(proofFile)}, found.asked.query + " " + page.asked.address);
console.log("wrote the file");
const file = await files.readFile(${JSON.stringify(proofFile)}, "utf8");
await files.rm(${JSON.stringify(proofFile)});
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
        }).pipe(Effect.scoped),
      15 * 60_000,
    )

    it.effect(
      'stops the program on the Computer when a call needs an Approval, and leaves nothing of it running',
      () =>
        Effect.gen(function* () {
          const process = yield* CodeProcess
          const machine = yield* Machine
          const pid = yield* Ref.make(Option.none<number>())
          const dispatch: Dispatch = Effect.fn('Live.approval')(function* (call) {
            const input = yield* decodeGuestPid(call.input).pipe(
              Effect.catch(() => Effect.sync(() => expect.fail('Guest PID required'))),
            )
            yield* Ref.set(pid, Option.some(input.pid))
            return CallOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('approval-live'),
              summary: 'Send the message',
            })
          })
          const outcome = yield* timed(
            'approval',
            process.run(
              {
                request: {
                  summary: 'Prove a decision stops the program',
                  code: 'try { await tools.use_tool({pid:process.pid}); } catch (error) {} await new Promise((done) => setTimeout(done, 600000)); return "continued";',
                },
                boundary: boundary(),
              },
              dispatch,
            ),
          )
          expect(CodeOutcome.guards.ApprovalRequired(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['needs approval'])
          const captured = yield* Ref.get(pid)
          if (Option.isNone(captured)) expect.fail('Guest did not report its PID')
          const left = yield* machine.exec({
            key,
            command: `test ! -d /proc/${captured.value}`,
            timeoutSeconds: 30,
          })
          expect(left.exitCode).toBe(0)
        }),
      15 * 60_000,
    )
  })
})
