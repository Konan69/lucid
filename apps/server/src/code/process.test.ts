import { Layer, Logger } from 'effect'
import { describe, expect, it as standalone, layer } from '@effect/vitest'
import {
  ApprovalId,
  CodeCall,
  CodeFailure,
  CodeOutcome,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { Deferred, Effect, Exit, Fiber, Ref, Option, Schema, Cause } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { CallOutcome, CodeProcess, codeProcessLayer, Execution, type Dispatch } from './process.ts'
import { discoveredTool } from './signatures.ts'
import { budgets } from './budgets.ts'

const person = PersonId.make('person-test')

/** Compare observable variants without constructing partial domain records in matchers. */
function check(outcome: CodeOutcome, tag: CodeOutcome['_tag'], fields: Schema.JsonObject) {
  expect(outcome._tag).toBe(tag)
  expect(outcome).toMatchObject(fields)
}

/**
 * Every execution here is the production supervisor and the production interpreter, in this
 * process. Only the check of each call as the Person (`calls.ts`) is replaced, by a `Dispatch`
 * the case supplies. Nothing here waits on a real clock.
 */
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

  /** Answers the first call and gives every later one to `later`. */
  const afterFirst = (later: Dispatch) =>
    Effect.gen(function* () {
      const count = yield* Ref.make(0)
      const dispatch: Dispatch = Effect.fn('Test.afterFirst')(function* (call) {
        return (yield* Ref.updateAndGet(count, (value) => value + 1)) === 1
          ? yield* reply(call)
          : yield* later(call)
      })
      return dispatch
    })

  layer(codeProcessLayer)((it) => {
    it.effect('round-trips production discovery expressions through the interpreter', () =>
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
            const tool = yield* discoveredTool({ account, name, input: {}, output: Option.none() })
            expected.push({ account, tool: name, input: {}, summary: 'Read', rationale: 'Test' })
            expressions.push(`await ${tool.call};`)
          }
        }
        // Keep each batch below source and call budgets; use the public supervised run seam.
        for (let offset = 0; offset < expressions.length; offset += 40) {
          const frames = yield* Ref.make<Schema.Json[]>([])
          const dispatch: Dispatch = Effect.fn('Test.exactDiscoveredCall')(function* (call) {
            expect(call.kind).toBe('use_tool')
            yield* Ref.update(frames, (items) => items.concat([call.input]))
            return CallOutcome.cases.Returned.make({ value: null, summary: 'Read', end: 'completed' })
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
    )

    it.effect('gives a program its tools and nothing of the server it runs in', () =>
      Effect.gen(function* () {
        for (const code of [
          'return process.env;',
          'return await import("node:fs");',
          'return require("node:child_process");',
          'return await fetch("http://127.0.0.1");',
          'return globalThis;',
          'return (() => {}).constructor("return process")();',
          'return ({}).__proto__;',
          'return eval("1");',
          'setTimeout(() => {}, 1); return 1;',
          'await new Promise(() => {});',
          'class A {}; return 1;',
          'return await tools.run_code({});',
        ]) {
          const outcome = yield* run(code, () => Effect.die('Nothing may be dispatched'))
          expect(outcome, code).toHaveProperty('failure._tag', 'Threw')
          expect(outcome.calls, code).toHaveLength(0)
        }
      }),
    )

    it.effect('says where in the source the model wrote a program failed', () =>
      Effect.gen(function* () {
        const outcome = yield* run('const label = "model";\nreturn missing + label;', reply)
        expect(outcome).toHaveProperty('failure.message', expect.stringContaining('line 2'))
      }),
    )

    it.effect('keeps ordered printed lines beside success and thrown failures', () =>
      Effect.gen(function* () {
        const completed = yield* run(
          'console.log("first", 1); console.log("second"); return {answer:42};',
          reply,
        )
        check(completed, 'Completed', {
          result: { answer: 42 },
          logs: ['first 1', 'second'],
          logsTruncated: false,
        })
        const failed = yield* run('console.log("before throw"); throw new Error("failed");', reply)
        check(failed, 'Failed', { logs: ['before throw'], logsTruncated: false })
        expect(failed).toHaveProperty('failure.message', expect.stringContaining('failed'))
      }),
    )

    it.effect(
      'bounds printed UTF-8 without splitting characters and counts logs in the final aggregate',
      () =>
        Effect.gen(function* () {
          const printed = yield* run('console.log("😀".repeat(3000)); return 1;', reply)
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
    )

    it.effect(
      'composes dependent and Promise.all reads, filters intermediate records and combines a Computer receipt',
      () =>
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
    )

    it.effect(
      'latches approval before catch/finally or queued Promise.allSettled calls can dispatch',
      () =>
        Effect.gen(function* () {
          const count = yield* Ref.make(0)
          const dispatch: Dispatch = Effect.fn('Test.ask')(function* () {
            yield* Ref.update(count, (value) => value + 1)
            return CallOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('approval-test'),
              summary: 'Send the message',
            })
          })
          const outcome = yield* run(
            `try {await Promise.allSettled([tools.use_tool({}),tools.use_tool({}),tools.browse({})]);}
        catch(e){await tools.use_tool({});} finally {await tools.use_tool({});} return "continued";`,
            dispatch,
          )
          check(outcome, 'ApprovalRequired', {
            approvalId: 'approval-test',
            calls: [{ end: 'needs approval' }],
          })
          expect(yield* Ref.get(count)).toBe(1)
        }),
    )

    it.effect('preserves earlier receipts on a later throw', () =>
      Effect.gen(function* () {
        check(
          yield* run('await tools.use_tool({}); throw new Error("stopped");', reply),
          'Failed',
          { calls: [{ end: 'completed' }] },
        )
      }),
    )

    it.effect('preserves earlier receipts on an unknown consequential outcome without replay', () =>
      Effect.gen(function* () {
        const unknown = yield* afterFirst(() =>
          Effect.succeed(CallOutcome.cases.Unknown.make({ summary: 'Second action' })),
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
    )

    it.effect('a call the program does not wait for still decides its end', () =>
      Effect.gen(function* () {
        const ask: Dispatch = () =>
          Effect.succeed(
            CallOutcome.cases.ApprovalRequired.make({
              approvalId: ApprovalId.make('approval-test'),
              summary: 'Send the message',
            }),
          )
        check(yield* run('tools.use_tool({}); return "finished";', ask), 'ApprovalRequired', {
          approvalId: 'approval-test',
          calls: [{ end: 'needs approval' }],
        })
      }),
    )


    it.effect('enforces the UTF-8 source budget before startup', () =>
      Effect.gen(function* () {
        check(yield* run(`return "${'é'.repeat(8192)}";`, reply), 'Failed', {
          failure: CodeFailure.cases.Threw.make({ message: 'Program source exceeds 16 KiB.' }),
          calls: [],
        })
      }),
    )

    it.effect('enforces the call budget', () =>
      Effect.gen(function* () {
        check(
          yield* run('for(let i=0;i<101;i++) await tools.find_tools({query:"x"});', reply),
          'Failed',
          { failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }) },
        )
      }),
    )

    it.effect('enforces the final-result budget', () =>
      Effect.gen(function* () {
        check(yield* run('return "x".repeat(32768);', reply), 'Failed', {
          failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
        })
      }),
    )

    it.effect('accepts exactly 16 KiB source and 100 calls', () =>
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
    )

    it.effect('keeps a completed value beside 100 receipts and clips only logs', () =>
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
    )

    it.effect('accepts an exact 256 KiB argument and result without altering either', () =>
      Effect.gen(function* () {
        const size = budgets.frame - 2 // The JSON string's two quotes are part of its byte budget.
        const outcome = yield* run(
          `return (await tools.find_tools("x".repeat(${size}))).length;`,
          reply,
        )
        expect(outcome).toHaveProperty('result', size)
        expect(outcome.calls).toHaveLength(1)
      }),
    )

    it.effect(
      'bounds the exact final aggregate including its receipts',
      () =>
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
      { timeout: 10_000 },
    )

    it.effect('runs the calls of one Promise.all at the same time', () =>
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
    )

    it.effect('refuses a second active program in one Thread and a fifth globally', () =>
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
        }
        for (const thread of ['thread-0', 'fifth-thread'])
          check(
            yield* process.run(
              { ...input, boundary: { person, thread: ThreadId.make(thread) } },
              reply,
            ),
            'Failed',
            { failure: CodeFailure.cases.Unavailable.make({}) },
          )
        yield* Deferred.succeed(release, undefined)
        for (const fiber of fibers)
          expect(CodeOutcome.guards.Completed(yield* Fiber.join(fiber))).toBe(true)
      }),
    )

    it.effect('charges failed calls against the quota', () =>
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
    )

    it.effect('rejects oversized arguments despite a catch in the program', () =>
      Effect.gen(function* () {
        const oversized = yield* run(
          'try {await tools.use_tool({input:"x".repeat(262144)});} catch(e){} return "caught";',
          reply,
        )
        expect(oversized).toHaveProperty('failure.limit', 'data')
        expect(oversized.calls).toHaveLength(0)
      }),
    )

    it.effect('bounds cumulative provider data independently of the per-call limit', () =>
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
    )

    it.effect('a program that keeps making data is ended by its work limit and keeps what it printed', () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          'console.log("filling"); const items=[]; const row="x".repeat(1000); while(true) items.push(row + items.length);',
          reply,
        )
        check(outcome, 'Failed', {
          failure: CodeFailure.cases.OverLimit.make({ limit: 'work' }),
          logs: ['filling'],
        })
      }),
    )

    it.effect('a program that never stops is ended by its work limit, whatever it catches', () =>
      Effect.gen(function* () {
        for (const loop of [
          'while(true) {}',
          'for(;;) {}',
          'while(true) await Promise.resolve();',
          'let n = 0; try { while(true) n++; } catch (e) { return "caught"; } finally { n = 0; }',
          'const spin = () => spin(); spin();',
        ]) {
          const outcome = yield* run(`await tools.find_tools({}); ${loop} return "after";`, reply)
          expect(outcome, loop).toHaveProperty('failure._tag', expect.stringMatching(/OverLimit|Threw/))
          expect(outcome, loop).not.toHaveProperty('result')
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed'])
        }
        expect(yield* run('return 42;', reply)).toHaveProperty('result', 42)
      }),
    )

    it.effect('one built-in cannot make a value larger than a program may hold', () =>
      Effect.gen(function* () {
        for (const code of [
          'return "x".repeat(2**29).length;',
          'return "".padStart(2**29).length;',
          'return Array.from({length: 2**30}).length;',
          'let s = "x".repeat(4000000); while (true) { s = s + s }',
          'const big = "x".repeat(1048576); for (let i = 0; i < 100000; i++) console.log(big, i); return 1;',
        ])
          expect(yield* run(code, reply), code).toHaveProperty(
            'failure',
            CodeFailure.cases.OverLimit.make({ limit: 'work' }),
          )
      }),
    )

    it.effect('cuts flooded printed output to its allowance and still finishes the program', () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          'const value="x".repeat(65536); for(let i=0;i<200;i++) console.log(value); return "done";',
          reply,
        )
        check(outcome, 'Completed', { result: 'done', logsTruncated: true })
        expect(Buffer.byteLength(JSON.stringify(outcome))).toBeLessThanOrEqual(budgets.result)
        const empty = yield* run('for (let i = 0; i < 90000; i++) console.log(); return 1;', reply)
        check(empty, 'Completed', { result: 1, logsTruncated: true })
        expect(Buffer.byteLength(JSON.stringify(empty))).toBeLessThanOrEqual(budgets.result)
      }),
    )

    it.effect('stops a program that starts calls without waiting, at the call limit', () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          'for (let i = 0; i < 100000; i++) tools.find_tools({}); return "started";',
          reply,
        )
        check(outcome, 'Failed', { failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }) })
        expect(outcome.calls.length).toBeLessThanOrEqual(budgets.calls)
      }),
    )
  })

  layer(codeProcessLayer)(
    'Clock for keeps logs when the 300-second parent deadline ends a waiting program',
    (it) => {
      it.effect('keeps logs when the 300-second parent deadline ends a waiting program', () =>
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
      )
    },
  )

  layer(codeProcessLayer)(
    'Clock for lets a call that was already running finish before an Approval is reported',
    (it) => {
      it.effect('lets a call that was already running finish before an Approval is reported', () =>
        Effect.gen(function* () {
          const order = yield* Ref.make(0)
          const secondRunning = yield* Deferred.make<void>()
          const asked = yield* Deferred.make<void>()
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
            // Held by the test clock, which moves only after the first call has asked.
            yield* Effect.sleep('1 second')
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
          yield* TestClock.adjust('1 second')
          const outcome = yield* Fiber.join(running)
          // The sibling's receipt is its real result, not the provisional unknown it had when the
          // first call asked.
          check(outcome, 'ApprovalRequired', {
            approvalId: 'approval-test',
            calls: [{ end: 'needs approval' }, { end: 'completed' }],
          })
        }),
      )
    },
  )

  layer(codeProcessLayer)(
    'Clock for reports an Approval when the last running call is interrupted',
    (it) => {
      it.effect('reports an Approval when the last running call is interrupted', () =>
        Effect.gen(function* () {
          const order = yield* Ref.make(0)
          const secondRunning = yield* Deferred.make<void>()
          const asked = yield* Deferred.make<void>()
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
            yield* Effect.sleep('1 second')
            return yield* Effect.interrupt
          })
          const running = yield* Effect.forkChild(
            run('return await Promise.all([tools.use_tool({}),tools.use_tool({})]);', dispatch),
          )
          yield* Deferred.await(asked)
          yield* TestClock.adjust('1 second')
          // The lost call keeps its honest unknown receipt, and the decision still arrives at once
          // instead of waiting for the deadline.
          check(yield* Fiber.join(running), 'ApprovalRequired', {
            approvalId: 'approval-test',
            calls: [{ end: 'needs approval' }, { end: 'unknown' }],
          })
        }),
      )
    },
  )

  layer(codeProcessLayer)(
    'Clock for a deadline leaves every running call unknown and admits nothing after it',
    (it) => {
      it.effect('a deadline leaves every running call unknown and admits nothing after it', () =>
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
      )
    },
  )

  layer(codeProcessLayer)(
    'Clock for marks a timed-out consequential dispatch unknown and retains a previous completed receipt',
    (it) => {
      it.effect(
        'marks a timed-out consequential dispatch unknown and retains a previous completed receipt',
        () =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>()
            const dispatch = yield* afterFirst(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            )
            const running = yield* Effect.forkChild(
              run('await tools.use_tool({}); await tools.use_tool({});', dispatch),
            )
            yield* Deferred.await(entered)
            yield* TestClock.adjust('301 seconds')
            const outcome = yield* Fiber.join(running)
            expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
            expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'unknown'])
          }),
      )
    },
  )
})

/** The false literal is one byte longer; clipping a near-full failure must reserve that byte. */
standalone.effect('keeps failed aggregate bytes within the limit when logs nearly fit', () =>
  Effect.sync(() => {
    const state = new Execution()
    state.calls.push(
      ...Array.from({ length: budgets.calls }, () =>
        CodeCall.make({ kind: 'find_tools', summary: 'x'.repeat(200), end: 'completed' }),
      ),
    )
    const failure = CodeFailure.cases.Threw.make({ message: 'Failed' })
    const base = CodeOutcome.cases.Failed.make({
      failure,
      calls: state.calls.slice(),
      logs: [],
      logsTruncated: false,
    })
    const line = 'x'.repeat(budgets.result - Buffer.byteLength(JSON.stringify(base)) - 1)
    state.printed([line])
    const outcome = state.failed(failure)
    expect(Buffer.byteLength(JSON.stringify(outcome))).toBeLessThanOrEqual(budgets.result)
    expect(outcome).toHaveProperty('logsTruncated', true)
  }),
)

/** Recovery is exercised without host prerequisites; the real supervisor uses this same transition. */
standalone.effect('supervision contains hostile causes and logs only bounded type facts', () => {
  const secret = 'PRIVATE-supervision-content'
  const circular = new Error(secret)
  circular.cause = circular
  const getter = Object.defineProperty(new Error(secret), 'message', {
    get: () => {
      throw new Error(secret)
    },
  })
  const messages: string[] = []
  const logger = Logger.make((entry) => messages.push(Logger.formatSimple.log(entry)))
  return Effect.gen(function* () {
    for (const failure of [circular, getter]) {
      const state = new Execution()
      const exit = yield* Effect.exit(state.supervise(Effect.die(failure)))
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit))
        check(exit.value, 'Failed', { failure: CodeFailure.cases.Unavailable.make({}) })
    }
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).toContain('Program supervision failed')
      expect(message).not.toContain(secret)
      expect(message.length).toBeLessThan(400)
    }
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
})

/** Safe diagnostics identify typed failures without rendering their payload or defect tags. */
standalone.effect('supervision logs typed Fail tags with bounded count and length', () => {
  const messages: string[] = []
  const logger = Logger.make((entry) => messages.push(Logger.formatSimple.log(entry)))
  return Effect.gen(function* () {
    const state = new Execution()
    yield* state.supervise(Effect.fail(Schema.TaggedStruct('CodeTestFailure', {}).make({})))
    expect(messages[0]).toContain('vivid.supervision.failures=CodeTestFailure')
    const reasons = Array.from({ length: 40 }, (_, index) =>
      Cause.makeFailReason(Schema.TaggedStruct(`Typed${index}`, {}).make({})),
    )
    yield* state.supervise(Effect.failCause(Cause.fromReasons(reasons)))
    expect(messages[1]).toContain('Typed15')
    expect(messages[1]).not.toContain('Typed16')
    const longest = Array.from({ length: 16 }, (_, index) =>
      Cause.makeFailReason(Schema.TaggedStruct(`T${index}`.padEnd(120, 'X'), {}).make({})),
    )
    yield* state.supervise(Effect.failCause(Cause.fromReasons(longest)))
    expect(messages[2]).toContain('T15'.padEnd(120, 'X'))
    const oversized = Schema.TaggedStruct('X'.repeat(121), {}).make({})
    yield* state.supervise(Effect.fail(oversized))
    expect(messages[3]).not.toContain('X'.repeat(121))
    const hostile = Object.defineProperty(new Error('Private message'), '_tag', {
      get: () => {
        throw new Error('Private tag getter')
      },
    })
    yield* state.supervise(Effect.fail(hostile))
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    yield* state.supervise(Effect.fail(revoked.proxy))
    yield* state.supervise(Effect.die(Schema.TaggedStruct('PrivateDefectTag', {}).make({})))
    for (const message of messages) {
      expect(message).not.toContain('Private')
      expect(message.length).toBeLessThan(2200)
    }
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
})
