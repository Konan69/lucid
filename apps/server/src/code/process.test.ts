import { scopedCase } from '../../tests/case.ts'
import * as NodeCrypto from 'node:crypto'
import { Array as Arr, Context, Layer, Order } from 'effect'
import { describe, expect, it as standalone } from '@effect/vitest'
import {
  ApprovalId,
  CodeCallKind,
  CodeFailure,
  CodeOutcome,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { Deferred, Effect, Fiber, Ref, Option, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { CallOutcome, CodeProcess, codeProcessLayer, type Dispatch } from './process.ts'
import { discoveredTool } from './signatures.ts'
import { budgets } from './budgets.ts'
import { MachineOperationFailed } from '../computers/machine.ts'
import { localCodeComputer, localCodeComputerLayer } from './testing.ts'

/** Each standalone case acquires this real local Computer and supervisor in its own scope.
 * `it.effect` supplies its fresh clock before either Layer starts; see `testing.ts` for coverage. */
const supervised = codeProcessLayer.pipe(Layer.provide(localCodeComputerLayer))
const person = PersonId.make('person-test')

/** Compare observable variants without constructing partial domain records in matchers. */
function check(outcome: CodeOutcome, tag: CodeOutcome['_tag'], fields: Schema.JsonObject) {
  expect(outcome._tag).toBe(tag)
  expect(outcome).toMatchObject(fields)
}

interface RunningLoopsService {
  readonly fibers: readonly Fiber.Fiber<CodeOutcome>[]
}
/** The case fixture owns two already-admitted real guests; the test owns the parent deadline and recovery. */
class RunningLoops extends Context.Service<RunningLoops, RunningLoopsService>()(
  'Test/RunningLoops',
) {}

/** Every execution runs the production shell, Node process and worker, and awaits their receipts. */
describe('Supervised programs', () => {
  const run = Effect.fn('Test.program')(function* (code: string, dispatch: Dispatch) {
    return yield* (yield* CodeProcess).run(
      {
        request: { code, summary: 'Test the program' },
        boundary: { person, thread: ThreadId.make(crypto.randomUUID()) },
      },
      dispatch,
    )
  })

  const reply: Dispatch = Effect.fn('Test.reply')((call) =>
    Effect.succeed(
      CallOutcome.cases.Returned.make({
        value: call.input,
        summary: call.kind,
        end: 'completed',
      }),
    ),
  )

  standalone.effect('exposes exactly the server-authorized tool kinds in the real guest', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run('return Object.keys(tools).sort()', reply)
        check(outcome, 'Completed', { result: Arr.sort(CodeCallKind.literals, Order.String) })
      }),
      'inherited',
    ),
  )

  standalone.effect(
    'dispatches callable accounts once and awaits proxies without thenable calls',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const frames = yield* Ref.make<Schema.Json[]>([])
          const dispatch: Dispatch = Effect.fn('Test.accountCall')(function* (call) {
            expect(call.kind).toBe('use_tool')
            yield* Ref.update(frames, (items) => items.concat([call.input]))
            return CallOutcome.cases.Returned.make({
              value: { ok: true, output: 'sent' },
              summary: 'Send mail',
              end: 'completed',
            })
          })
          const outcome = yield* run(
            'await accounts; await accounts["x"]; if(accounts[Symbol.iterator]!==undefined || accounts["x"][Symbol.iterator]!==undefined) throw new Error("symbol exposed"); return await accounts["Work Gmail"].send_email({to:"Ada"},{summary:"Send mail",rationale:"Reply"});',
            dispatch,
          )
          check(outcome, 'Completed', { result: { ok: true, output: 'sent' } })
          expect(yield* Ref.get(frames)).toEqual([
            {
              account: 'Work Gmail',
              tool: 'send_email',
              input: { to: 'Ada' },
              summary: 'Send mail',
              rationale: 'Reply',
            },
          ])
        }),
        'inherited',
      ),
  )
  standalone.effect('round-trips production discovery expressions through the real guest', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const names = [
          'quote"',
          'back\\slash',
          'has.dot',
          '__proto__',
          'constructor',
          'toString',
          '123',
          '日本語',
          'not-an-identifier',
          'then',
          'line\u2028separator',
          'line\u2029separator',
        ]
        const expected: Schema.Json[] = []
        const expressions: string[] = []
        for (const account of names) {
          for (const name of names) {
            const tool = yield* discoveredTool({
              account,
              name,
              input: {},
              output: Option.none(),
            })
            expected.push({ account, tool: name, input: {}, summary: 'Read', rationale: 'Test' })
            expressions.push(
              account === 'then' || name === 'then'
                ? `await ${tool.call};`
                : `await ${tool.call}(input, {summary, rationale});`,
            )
          }
        }
        // Keep each batch below source and call budgets; use the public supervised run seam.
        for (let offset = 0; offset < expressions.length; offset += 40) {
          const frames = yield* Ref.make<Schema.Json[]>([])
          const dispatch: Dispatch = Effect.fn('Test.exactDiscoveredCall')(function* (call) {
            expect(call.kind).toBe('use_tool')
            yield* Ref.update(frames, (items) => items.concat([call.input]))
            return CallOutcome.cases.Returned.make({
              value: null,
              summary: 'Read',
              end: 'completed',
            })
          })
          const code =
            'const input={},summary="Read",rationale="Test";' +
            expressions.slice(offset, offset + 40).join('') +
            'return true;'
          const outcome = yield* run(code, dispatch)
          expect(outcome).toHaveProperty('result', true)
          expect(yield* Ref.get(frames)).toEqual(expected.slice(offset, offset + 40))
        }
      }),
      'inherited',
    ),
  )
  standalone.effect('names summary and rationale when account metadata is omitted', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run('return await accounts.Mail.read({});', reply)
        expect(outcome).toHaveProperty(
          'failure.message',
          expect.stringContaining('summary and rationale'),
        )
        expect(outcome.calls).toHaveLength(0)
      }),
      'inherited',
    ),
  )
  standalone.effect('keeps the line numbers of the source the model wrote', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run(
          'const label="model";\ntry {throw new Error(label);} catch(error) {return error.stack;}',
          reply,
        )
        expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
        expect(outcome).toHaveProperty('result', expect.stringContaining('program.js:2'))
      }),
      'inherited',
    ),
  )
  standalone.effect('keeps ordered printed lines beside success and thrown failures', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const completed = yield* run(
          'console.log("first", 1); text("second"); return {answer:42};',
          reply,
        )
        check(completed, 'Completed', {
          result: { answer: 42 },
          logs: ['first 1', 'second'],
          logsTruncated: false,
        })
        const failed = yield* run('console.log("before throw"); throw new Error("failed");', reply)
        check(failed, 'Failed', { logs: ['before throw'], logsTruncated: false })
        expect(failed).toHaveProperty('failure.message', 'failed')
      }),
      'inherited',
    ),
  )
  standalone.effect(
    'bounds printed UTF-8 without splitting characters and counts logs in the final aggregate',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const printed = yield* run('text("😀".repeat(3000)); return 1;', reply)
          expect(CodeOutcome.guards.Completed(printed)).toBe(true)
          if (!CodeOutcome.guards.Completed(printed)) return
          expect(printed.logsTruncated).toBe(true)
          expect(Buffer.byteLength(JSON.stringify(printed.logs))).toBeLessThanOrEqual(budgets.logs)
          expect(printed.logs.join('')).not.toContain('�')
          const aggregate = yield* run(
            'console.log("x".repeat(7000)); return "y".repeat(30000);',
            reply,
          )
          expect(aggregate).toHaveProperty('result', 'y'.repeat(30000))
          expect(aggregate).toHaveProperty('logsTruncated', true)
          expect(Buffer.byteLength(JSON.stringify(aggregate))).toBeLessThanOrEqual(budgets.result)
        }),
        'inherited',
      ),
  )
  standalone.effect(
    'composes dependent and Promise.all reads, filters intermediate records and combines a Computer receipt',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const seen = yield* Ref.make<string[]>([])
          const dispatch: Dispatch = Effect.fn('Test.composedCall')(function* (call) {
            yield* Ref.update(seen, (items) => items.concat(call.kind))
            const value =
              call.kind === 'browse'
                ? { exitCode: 0 }
                : Array.from({ length: 100 }, (_, index) => ({ value: index }))
            return CallOutcome.cases.Returned.make({
              value,
              summary: 'Read records',
              end: 'completed',
            })
          })
          const outcome = yield* run(
            `const first = await tools.find_tools({query:"records"});
        const [left, right] = await Promise.all([tools.use_tool({source:first[0].value}), tools.use_tool({source:first[1].value})]);
        const computer = await tools.browse({});
        return {selected:left.filter(x=>x.value>97).map(x=>x.value), count:right.length, exitCode:computer.exitCode};`,
            dispatch,
          )
          check(outcome, 'Completed', { result: { selected: [98, 99], count: 100, exitCode: 0 } })
          expect(yield* Ref.get(seen)).toEqual(['find_tools', 'use_tool', 'use_tool', 'browse'])
          expect(outcome.calls.map((call) => call.end)).toEqual([
            'completed',
            'completed',
            'completed',
            'completed',
          ])
        }),
        'inherited',
      ),
  )
  standalone.effect(
    'gives the program the Computer it runs on: its files and its Node modules',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const outcome = yield* run(
            `const files = await import("node:fs/promises");
        await files.writeFile("note.txt", "kept");
        return {note: await files.readFile("note.txt", "utf8"), node: typeof process.versions.node};`,
            reply,
          )
          check(outcome, 'Completed', { result: { note: 'kept', node: 'string' } })
          expect(outcome.calls).toHaveLength(0)
        }),
        'inherited',
      ),
  )
  standalone.effect('ends a program that waits on something nothing can settle', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run('console.log("waiting"); await new Promise(() => {});', reply)
        check(outcome, 'Failed', { logs: ['waiting'] })
        expect(outcome).toHaveProperty('failure.message', expect.stringContaining('never settles'))
      }),
      'inherited',
    ),
  )
  standalone.effect(
    'latches approval before catch/finally or queued Promise.allSettled calls can dispatch',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const count = yield* Ref.make(0)
          const dispatch: Dispatch = Effect.fn('Test.ask')(function* () {
            yield* Ref.update(count, (value) => value + 1)
            return CallOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('approval-test'),
              summary: 'Send the message',
            })
          })
          // Promise.all reaches catch; allSettled reaches finally. Both must lose authority
          // before any already-queued or recovery write reaches the provider.
          for (const aggregate of ['all', 'allSettled'] as const) {
            yield* Ref.set(count, 0)
            const outcome = yield* run(
              `try {await Promise.${aggregate}([tools.use_tool({}),tools.use_tool({}),tools.browse({})]);}
              catch(e){await tools.use_tool({});} finally {await tools.use_tool({});} return "continued";`,
              dispatch,
            )
            check(outcome, 'ApprovalRequired', {
              approvalId: 'approval-test',
              calls: [{ end: 'needs approval' }],
            })
            expect(yield* Ref.get(count)).toBe(1)
          }
        }),
        'inherited',
      ),
  )
  standalone.effect('preserves earlier receipts on a later throw', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        check(
          yield* run('await tools.use_tool({}); throw new Error("stopped");', reply),
          'Failed',
          {
            calls: [{ end: 'completed' }],
          },
        )
      }),
      'inherited',
    ),
  )
  standalone.effect(
    'preserves earlier receipts on an unknown consequential outcome without replay',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const unknown: Dispatch = Effect.fn('Test.unknown')((call) =>
            Effect.succeed(
              call.id === 1
                ? CallOutcome.cases.Returned.make({
                    value: { changed: true },
                    summary: 'First action',
                    end: 'completed',
                  })
                : CallOutcome.cases.Unknown.make({ summary: 'Second action' }),
            ),
          )
          check(
            yield* run(
              'await tools.use_tool({}); await tools.use_tool({}); await tools.use_tool({});',
              unknown,
            ),
            'OutcomeUnknown',
            { calls: [{ end: 'completed' }, { end: 'unknown' }] },
          )
        }),
        'inherited',
      ),
  )
  standalone.effect('enforces the UTF-8 source budget before startup', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        check(yield* run(`return "${'é'.repeat(8192)}";`, reply), 'Failed', {
          failure: CodeFailure.cases.Threw.make({ message: 'Program source exceeds 16 KiB.' }),
          calls: [],
        })
      }),
      'inherited',
    ),
  )
  standalone.effect('enforces the call budget', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        check(
          yield* run('for(let i=0;i<101;i++) await tools.find_tools({query:"x"});', reply),
          'Failed',
          { failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }) },
        )
      }),
      'inherited',
    ),
  )
  standalone.effect('enforces the final-result budget', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        check(yield* run('return "x".repeat(32768);', reply), 'Failed', {
          failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
        })
      }),
      'inherited',
    ),
  )
  standalone.effect('accepts exactly 16 KiB source and 100 calls', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const code = 'for(let i=0;i<100;i++) await tools.find_tools({}); return 1;'
        const unicode: Dispatch = Effect.fn('Test.unicodeReceipt')(() =>
          Effect.succeed(
            CallOutcome.cases.Returned.make({
              value: null,
              summary: '😀'.repeat(200),
              end: 'completed',
            }),
          ),
        )
        const outcome = yield* run(code.padEnd(budgets.source, ' '), unicode)
        expect(outcome).toHaveProperty('result', 1)
        expect(outcome.calls).toHaveLength(budgets.calls)
      }),
      'inherited',
    ),
  )
  standalone.effect('keeps a completed value beside 100 receipts and clips only logs', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const unicode: Dispatch = Effect.fn('Test.unicodeLogReceipt')(() =>
          Effect.succeed(
            CallOutcome.cases.Returned.make({
              value: null,
              summary: '😀'.repeat(200),
              end: 'completed',
            }),
          ),
        )
        const outcome = yield* run(
          'console.log("x".repeat(8000)); for(let i=0;i<100;i++) await tools.find_tools({}); return null;',
          unicode,
        )
        expect(outcome).toHaveProperty('result', null)
        expect(outcome.calls).toHaveLength(100)
        expect(outcome.calls.every((call) => call.end === 'completed')).toBe(true)
        expect(outcome).toHaveProperty('logsTruncated', true)
        expect(Buffer.byteLength(JSON.stringify(outcome))).toBeLessThanOrEqual(budgets.result)
      }),
      'inherited',
    ),
  )
  standalone.effect('accepts an exact 256 KiB argument and result without altering either', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const size = 262_142 // The JSON string's two quotes are part of its byte budget.
        const outcome = yield* run(
          `const {createHash}=await import("node:crypto"); return createHash("sha256").update(await tools.find_tools("x".repeat(${size}))).digest("hex");`,
          reply,
        )
        expect(outcome).toHaveProperty(
          'result',
          NodeCrypto.createHash('sha256').update('x'.repeat(size)).digest('hex'),
        )
        expect(outcome.calls).toHaveLength(1)
      }),
      'inherited',
    ),
  )
  standalone.effect('bounds the exact final aggregate including its receipts', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const empty = CodeOutcome.cases.Completed.make({
          result: '',
          calls: [],
          truncated: false,
          logs: [],
          logsTruncated: false,
        })
        const size = budgets.result - Buffer.byteLength(JSON.stringify(empty))
        const accepted = yield* run(`return "x".repeat(${size});`, reply)
        expect(CodeOutcome.guards.Completed(accepted)).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(accepted))).toBe(budgets.result)
        const refused = yield* run(`return "x".repeat(${size + 1});`, reply)
        expect(refused).toHaveProperty('failure.limit', 'result')
      }),
      'inherited',
    ),
  )
  standalone.effect('runs the calls of one Promise.all at the same time', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const entered = yield* Ref.make(0)
        const both = yield* Deferred.make<void>()
        // Each call returns only after the other has started. One-at-a-time dispatch would never
        // let the second start, so completion proves the two overlapped.
        const together: Dispatch = Effect.fn('Test.together')(function* () {
          const count = yield* Ref.updateAndGet(entered, (value) => value + 1)
          if (count === 2) yield* Deferred.succeed(both, undefined)
          yield* Deferred.await(both)
          return CallOutcome.cases.Returned.make({
            value: count,
            summary: 'Read a record',
            end: 'completed',
          })
        })
        const outcome = yield* run(
          'return (await Promise.all([tools.use_tool({}),tools.use_tool({})])).length;',
          together,
        )
        check(outcome, 'Completed', {
          result: 2,
          calls: [{ end: 'completed' }, { end: 'completed' }],
        })
      }),
      'inherited',
    ),
  )
  standalone.effect('refuses a second active program in one Thread and a fifth globally', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const process = yield* CodeProcess
        const input = {
          request: { code: 'return await tools.find_tools({});', summary: 'Read' },
          boundary: { person, thread: ThreadId.make('one-thread') },
        }
        const fibers: Fiber.Fiber<CodeOutcome>[] = []
        for (let index = 0; index < budgets.processes; index++) {
          const entered = yield* Deferred.make<void>()
          const dispatch: Dispatch = Effect.fn('Test.waitForSlot')(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return CallOutcome.cases.Returned.make({
              value: true,
              summary: 'Read',
              end: 'completed',
            })
          })
          const fiber = yield* Effect.forkChild(
            process.run(
              { ...input, boundary: { person, thread: ThreadId.make(`thread-${index}`) } },
              dispatch,
            ),
          )
          fibers.push(fiber)
          yield* Effect.raceFirst(
            Deferred.await(entered),
            Fiber.join(fiber).pipe(Effect.flatMap((outcome) => Effect.die(outcome))),
          )
          if (index === 0) {
            check(
              yield* process.run(
                { ...input, boundary: { person, thread: ThreadId.make('thread-0') } },
                reply,
              ),
              'Failed',
              {
                failure: CodeFailure.cases.Busy.make({
                  message: 'Vivid is busy with other work. Try again in a moment.',
                }),
              },
            )
          }
        }
        for (const thread of ['thread-0', 'fifth-thread'])
          check(
            yield* process.run(
              { ...input, boundary: { person, thread: ThreadId.make(thread) } },
              reply,
            ),
            'Failed',
            {
              failure: CodeFailure.cases.Busy.make({
                message: 'Vivid is busy with other work. Try again in a moment.',
              }),
            },
          )
        yield* Deferred.succeed(release, undefined)
        for (const fiber of fibers)
          expect(CodeOutcome.guards.Completed(yield* Fiber.join(fiber))).toBe(true)
      }),
      'inherited',
    ),
  )
  standalone.effect('charges failed calls against the quota', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const refused: Dispatch = Effect.fn('Test.refuse')(() =>
          Effect.succeed(
            CallOutcome.cases.Returned.make({
              value: { ok: false },
              summary: 'Invalid arguments',
              end: 'refused',
            }),
          ),
        )
        const exhausted = yield* run('for(let i=0;i<101;i++) await tools.find_tools({});', refused)
        expect(exhausted).toHaveProperty('failure.limit', 'calls')
        expect(exhausted.calls).toHaveLength(100)
      }),
      'inherited',
    ),
  )
  standalone.effect('rejects oversized bridge input despite a guest catch', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const oversized = yield* run(
          'try {await tools.use_tool({input:"x".repeat(262144)});} catch(e){} return "caught";',
          reply,
        )
        expect(oversized).toHaveProperty('failure.limit', 'data')
        expect(oversized.calls).toHaveLength(0)
      }),
      'inherited',
    ),
  )
  standalone.effect('bounds cumulative provider data independently of the per-call limit', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const large: Dispatch = Effect.fn('Test.largeData')(() =>
          Effect.succeed(
            CallOutcome.cases.Returned.make({
              value: 'x'.repeat(262_000),
              summary: 'Read records',
              end: 'completed',
            }),
          ),
        )
        const aggregate = yield* run(
          'for(let i=0;i<17;i++) await tools.find_tools({}); return 1;',
          large,
        )
        expect(aggregate).toHaveProperty('failure.limit', 'data')
        expect(aggregate.calls).toHaveLength(17)
      }),
      'inherited',
    ),
  )
  standalone.effect(
    'cuts flooded printed output to its allowance and still finishes the program',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const outcome = yield* run(
            'const value="x".repeat(1048576); for(let i=0;i<200;i++) text(value); return "done";',
            reply,
          )
          check(outcome, 'Completed', { result: 'done', logsTruncated: true })
          expect(Buffer.byteLength(JSON.stringify(outcome))).toBeLessThanOrEqual(budgets.result)
          expect(yield* run('return 1;', reply)).toHaveProperty('result', 1)
        }),
        'inherited',
      ),
  )
  standalone.effect(
    'a process that dies after dispatch leaves the call it was waiting for unknown',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const dispatch: Dispatch = Effect.fn('Test.lostProcess')(function* (call) {
            if (call.id === 2) return yield* Effect.never
            return yield* reply(call)
          })
          const outcome = yield* run(
            // The whole runner is killed, so no final message is printed: the server learns of the
            // end only from the process having ended. The third call is answered only after the
            // second was dispatched, so the kill cannot come before the call it must leave unknown.
            'await tools.find_tools({}); tools.use_tool({}); await tools.find_tools({}); process.kill(process.pid, "SIGKILL");',
            dispatch,
          )
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual([
            'completed',
            'unknown',
            'completed',
          ])
        }),
        'inherited',
      ),
  )
  standalone.effect('cuts a flood of empty printed lines like any other output', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run(
          'for (let i = 0; i < 90000; i++) console.log(); return 1;',
          reply,
        )
        check(outcome, 'Completed', { result: 1, logsTruncated: true })
        expect(Buffer.byteLength(JSON.stringify(outcome))).toBeLessThanOrEqual(budgets.result)
      }),
      'inherited',
    ),
  )
  standalone.effect('finishes a program that waits for its own write to standard output', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run(
          'await new Promise((written) => process.stdout.write("straight out\\n", written)); return 1;',
          reply,
        )
        check(outcome, 'Completed', { result: 1, logs: ['straight out'] })
      }),
      'inherited',
    ),
  )
  standalone.effect('ends the processes a program started when the program ends', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        // The first program leaves a child behind and says which. The second reads that process's
        // record: gone, or ended and waiting to be collected (state Z), is ended.
        const outcome = yield* run(
          'const {spawn} = await import("node:child_process"); return spawn(process.execPath, ["-e", "require(\'node:net\').createServer().listen(0, \'127.0.0.1\')"], {stdio:"ignore"}).pid;',
          reply,
        )
        const started = CodeOutcome.guards.Completed(outcome)
          ? Option.some(outcome.result)
          : Option.none()
        expect(Option.isSome(started)).toBe(true)
        const after = yield* run(
          `const files = await import("node:fs");
        try {
          const record = files.readFileSync("/proc/" + ${JSON.stringify(Option.getOrNull(started))} + "/stat", "utf8");
          return record.slice(record.lastIndexOf(")") + 2).startsWith("Z") ? "ended" : "running";
        } catch (gone) { return "ended"; }`,
          reply,
        )
        check(after, 'Completed', { result: 'ended' })
      }),
      'inherited',
    ),
  )
  standalone.effect('stops a program that starts calls without waiting, at the call limit', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const outcome = yield* run(
          'for (let i = 0; i < 100000; i++) tools.find_tools({}); await new Promise(() => {});',
          reply,
        )
        check(outcome, 'Failed', { failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }) })
        expect(outcome.calls.length).toBeLessThanOrEqual(budgets.calls)
      }),
      'inherited',
    ),
  )

  standalone.effect('keeps logs when the 300-second parent deadline cancels a waiting guest', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const dispatch: Dispatch = Effect.fn('Test.waitingRead')(function* () {
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        })
        const running = yield* Effect.forkChild(
          run('console.log("before timeout"); await tools.find_tools({});', dispatch),
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust('300 seconds')
        const outcome = yield* Fiber.join(running)
        check(outcome, 'Failed', {
          failure: CodeFailure.cases.TimedOut.make({ seconds: 300 }),
          logs: ['before timeout'],
          logsTruncated: false,
        })
      }),
      'inherited',
    ),
  )

  standalone.effect(
    'lets a call that was already running finish before an Approval is reported',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const order = yield* Ref.make(0)
          const secondRunning = yield* Deferred.make<void>()
          const asked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const dispatch: Dispatch = Effect.fn('Test.askBesideWork')(function* () {
            const position = yield* Ref.updateAndGet(order, (value) => value + 1)
            if (position === 1) {
              yield* Deferred.await(secondRunning)
              yield* Deferred.succeed(asked, undefined)
              return CallOutcome.cases.ApprovalRequired.make({
                approvalId: ApprovalId.make('approval-test'),
                summary: 'Send the message',
              })
            }
            yield* Deferred.succeed(secondRunning, undefined)
            // Hand-answer the sibling only after the Approval receipt is observed.
            yield* Deferred.await(release)
            return CallOutcome.cases.Returned.make({
              value: true,
              summary: 'Filed the note',
              end: 'completed',
            })
          })
          const running = yield* Effect.forkChild(
            run('return await Promise.all([tools.use_tool({}),tools.use_tool({})]);', dispatch),
          )
          yield* Deferred.await(asked)
          yield* Deferred.succeed(release, undefined)
          const outcome = yield* Fiber.join(running)
          // The sibling's receipt is its real result, not the provisional unknown it had when the
          // first call asked.
          check(outcome, 'ApprovalRequired', {
            approvalId: 'approval-test',
            calls: [{ end: 'needs approval' }, { end: 'completed' }],
          })
        }),
        'inherited',
      ),
  )

  standalone.effect('reports an Approval when the last running call is interrupted', () =>
    scopedCase(
      supervised,
      Effect.gen(function* () {
        const order = yield* Ref.make(0)
        const secondRunning = yield* Deferred.make<void>()
        const asked = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const dispatch: Dispatch = Effect.fn('Test.askBesideLoss')(function* () {
          const position = yield* Ref.updateAndGet(order, (value) => value + 1)
          if (position === 1) {
            yield* Deferred.await(secondRunning)
            yield* Deferred.succeed(asked, undefined)
            return CallOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('approval-test'),
              summary: 'Send the message',
            })
          }
          yield* Deferred.succeed(secondRunning, undefined)
          yield* Deferred.await(release)
          return yield* Effect.interrupt
        })
        const running = yield* Effect.forkChild(
          run('return await Promise.all([tools.use_tool({}),tools.use_tool({})]);', dispatch),
        )
        yield* Deferred.await(asked)
        yield* Deferred.succeed(release, undefined)
        // The lost call keeps its honest unknown receipt, and the decision still arrives at once
        // instead of waiting for the deadline.
        check(yield* Fiber.join(running), 'ApprovalRequired', {
          approvalId: 'approval-test',
          calls: [{ end: 'needs approval' }, { end: 'unknown' }],
        })
      }),
      'inherited',
    ),
  )

  standalone.effect(
    'a deadline leaves every running call unknown and admits nothing after it',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const count = yield* Ref.make(0)
          const late: Dispatch = Effect.fn('Test.lateReceipt')(function* () {
            const position = yield* Ref.updateAndGet(count, (value) => value + 1)
            if (position === 2) yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release).pipe(Effect.uninterruptible)
            return CallOutcome.cases.Returned.make({
              value: true,
              summary: 'Completed action',
              end: 'completed',
            })
          })
          const running = yield* Effect.forkChild(
            run('return await Promise.all([tools.use_tool({}),tools.use_tool({})]);', late),
          )
          yield* Deferred.await(entered)
          yield* TestClock.adjust('301 seconds')
          yield* Deferred.succeed(release, undefined)
          const outcome = yield* Fiber.join(running)
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          // Both calls of the Promise.all were already running when the deadline passed.
          expect(yield* Ref.get(count)).toBe(2)
          expect(outcome.calls.map((call) => call.end)).toEqual(['unknown', 'unknown'])
        }),
        'inherited',
      ),
  )

  const loopsLayer = Layer.effect(
    RunningLoops,
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const count = yield* Ref.make(0)
      const dispatch: Dispatch = Effect.fn('Test.loopsStarted')(function* (call) {
        if ((yield* Ref.updateAndGet(count, (value) => value + 1)) === 2)
          yield* Deferred.succeed(entered, undefined)
        return yield* reply(call)
      })
      // Startup is a fixture precondition, independent of how quickly a parent deadline must stop
      // admitted guests. Keep both real processes alive in the case scope until the test advances time.
      const fibers = yield* Effect.forEach(
        ['while(true) {}', 'while(true) await Promise.resolve();'],
        (loop) => Effect.forkScoped(run(`await tools.find_tools({}); ${loop}`, dispatch)),
      )
      yield* Effect.raceFirst(
        Deferred.await(entered),
        Effect.forEach(
          fibers,
          (fiber) => Fiber.join(fiber).pipe(Effect.flatMap((outcome) => Effect.die(outcome))),
          { concurrency: 'unbounded' },
        ),
      )
      return RunningLoops.of({ fibers })
    }),
  )

  standalone.effect(
    'stops synchronous and microtask loops and releases both interpreter slots',
    () =>
      scopedCase(
        supervised,
        scopedCase(
          loopsLayer,
          Effect.gen(function* () {
            const running = yield* RunningLoops
            yield* TestClock.adjust('301 seconds')
            for (const fiber of running.fibers) {
              const outcome = yield* Fiber.join(fiber)
              expect(CodeOutcome.guards.Failed(outcome)).toBe(true)
              expect(outcome).toHaveProperty('failure._tag', 'TimedOut')
              expect(outcome.calls.map((call) => call.end)).toEqual(['completed'])
            }
            const recovered = yield* Effect.forEach(
              [42, 43],
              (value) => run(`return ${value};`, reply),
              { concurrency: 'unbounded' },
            )
            expect(
              recovered.map((outcome) =>
                CodeOutcome.guards.Completed(outcome) ? outcome.result : outcome,
              ),
            ).toEqual([42, 43])
          }),
          'inherited',
        ),
        'inherited',
      ),
  )

  standalone.effect(
    'marks a timed-out consequential dispatch unknown and retains a previous completed receipt',
    () =>
      scopedCase(
        supervised,
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const dispatch: Dispatch = Effect.fn('Test.pendingEffect')(function* (call) {
            if (call.id === 1) return yield* reply(call)
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          })
          const running = yield* Effect.forkChild(
            run('await tools.use_tool({}); await tools.use_tool({});', dispatch),
          )
          yield* Deferred.await(entered)
          yield* TestClock.adjust('301 seconds')
          const outcome = yield* Fiber.join(running)
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'unknown'])
        }),
        'inherited',
      ),
  )
})

/** The Computer takes the program and its start, but an answer cannot be written to it. */
standalone.effect(
  'ends a program whose answer cannot reach the Computer, and keeps the receipt of the call',
  () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(
        codeProcessLayer.pipe(
          Layer.provide(
            localCodeComputer((attachment) => ({
              write: attachment.write,
              // The runner starts and hears its program; only answers cannot be written to it.
              converse: (input) =>
                attachment.converse(input).pipe(
                  Effect.map((spoken) => ({
                    ...spoken,
                    say: (text: string) =>
                      text.includes('"_tag":"Reply"')
                        ? Effect.fail(new MachineOperationFailed({ operation: 'say' }))
                        : spoken.say(text),
                  })),
                ),
            })),
          ),
        ),
      )
      return yield* Effect.gen(function* () {
        const process = yield* CodeProcess
        const outcome = yield* process.run(
          {
            request: { code: 'await tools.find_tools({}); return "answered";', summary: 'Read' },
            boundary: { person, thread: ThreadId.make(crypto.randomUUID()) },
          },
          (call) =>
            Effect.succeed(
              CallOutcome.cases.Returned.make({
                value: null,
                summary: call.kind,
                end: 'completed',
              }),
            ),
        )
        // The call was made and answered on the server; only the program never heard. It is told
        // to stop and reported, and is not left waiting until the deadline.
        check(outcome, 'Failed', {
          failure: CodeFailure.cases.Unavailable.make({}),
          calls: [{ kind: 'find_tools', end: 'completed' }],
        })
      }).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
)
