import { describe, expect, layer } from '@effect/vitest'
import { ApprovalId, CodeFailure, CodeOutcome, ThreadId } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Ref, type Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { CallOutcome, CodeProcess, codeProcessLayer, type Dispatch } from './process.ts'
import { budgets } from './budgets.ts'

/** Compare observable variants without constructing partial domain records in matchers. */
function check(outcome: CodeOutcome, tag: CodeOutcome['_tag'], fields: Schema.JsonObject) {
  expect(outcome._tag).toBe(tag)
  expect(outcome).toMatchObject(fields)
}

/** Every execution here uses the production bwrap/cgroup child and published pi QuickJS interpreter. */
describe('Supervised programs', () => {
  layer(codeProcessLayer)((it) => {
    const run = Effect.fn('Test.program')(function* (code: string, dispatch: Dispatch) {
      return yield* (yield* CodeProcess).run(
        {
          request: { code, summary: 'Test the program' },
          boundary: ThreadId.make(crypto.randomUUID()),
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

    it.effect(
      'composes dependent and Promise.all reads, filters intermediate records and combines a Computer receipt',
      () =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<string[]>([])
          const dispatch: Dispatch = Effect.fn('Test.composedCall')(function* (call) {
            yield* Ref.update(seen, (items) => items.concat(call.kind))
            const value =
              call.kind === 'run_command'
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
        const computer = await tools.run_command({command:"pwd"});
        return {selected:left.filter(x=>x.value>97).map(x=>x.value), count:right.length, exitCode:computer.exitCode};`,
            dispatch,
          )
          check(outcome, 'Completed', { result: { selected: [98, 99], count: 100, exitCode: 0 } })
          expect(yield* Ref.get(seen)).toEqual([
            'find_tools',
            'use_tool',
            'use_tool',
            'run_command',
          ])
          expect(outcome.calls.map((call) => call.end)).toEqual([
            'completed',
            'completed',
            'completed',
            'completed',
          ])
        }),
    )

    it.effect(
      'isolates process, filesystem, network, imports, host prototypes and persistent storage',
      () =>
        Effect.gen(function* () {
          const outcome = yield* run(
            `return {process:typeof process, require:typeof require, fetch:typeof fetch, bridge:typeof bridge,
        host:({}).constructor.constructor("return typeof process")(), stored:load("credential")===undefined,
        imported:await import("node:fs").then(()=>true,()=>false)};`,
            reply,
          )
          check(outcome, 'Completed', {
            result: {
              process: 'undefined',
              require: 'undefined',
              fetch: 'undefined',
              bridge: 'undefined',
              host: 'undefined',
              stored: true,
              imported: false,
            },
          })
        }),
    )

    it.effect(
      'starts every program with an empty store',
      () =>
        Effect.gen(function* () {
          expect((yield* run('store("credential", "private"); return 1;', reply))._tag).toBe(
            'Completed',
          )
          expect(yield* run('return load("credential")===undefined;', reply)).toMatchObject({
            result: true,
          })
        }),
      { timeout: 10_000 },
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
            `try {await Promise.allSettled([tools.use_tool({}),tools.use_tool({}),tools.run_command({})]);}
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

    it.effect(
      'preserves earlier receipts on a later throw and an unknown consequential outcome, without replay',
      () =>
        Effect.gen(function* () {
          check(
            yield* run('await tools.use_tool({}); throw new Error("stopped");', reply),
            'Failed',
            { calls: [{ end: 'completed' }] },
          )
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
    )

    it.effect('enforces UTF-8 source, call and final-result budgets', () =>
      Effect.gen(function* () {
        check(yield* run(`return "${'é'.repeat(8192)}";`, reply), 'Failed', {
          failure: CodeFailure.cases.OverLimit.make({ limit: 'data' }),
          calls: [],
        })
        check(
          yield* run('for(let i=0;i<26;i++) await tools.find_tools({query:"x"});', reply),
          'Failed',
          { failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }) },
        )
        check(yield* run('return "x".repeat(32768);', reply), 'Failed', {
          failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
        })
      }),
    )

    it.effect('accepts exactly 16 KiB source and 25 calls', () =>
      Effect.gen(function* () {
        const code = 'for(let i=0;i<25;i++) await tools.find_tools({}); return 1;'
        const outcome = yield* run(code.padEnd(budgets.source, ' '), reply)
        expect(outcome).toHaveProperty('result', 1)
        expect(outcome.calls).toHaveLength(budgets.calls)
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

    it.effect('late completion after the deadline cannot admit queued effects', () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const count = yield* Ref.make(0)
        const late: Dispatch = Effect.fn('Test.lateReceipt')(function* () {
          yield* Ref.update(count, (value) => value + 1)
          yield* Deferred.succeed(entered, undefined)
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
        yield* TestClock.adjust('31 seconds')
        yield* Deferred.succeed(release, undefined)
        const outcome = yield* Fiber.join(running)
        expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
        expect(yield* Ref.get(count)).toBe(1)
        expect(outcome.calls).toHaveLength(1)
        expect(outcome.calls[0]).toHaveProperty('end', 'unknown')
      }),
    )

    it.effect('refuses a second active program in the same Thread and a third globally', () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const dispatch: Dispatch = Effect.fn('Test.wait')(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return CallOutcome.cases.Returned.make({ value: true, summary: 'Read', end: 'completed' })
        })
        const process = yield* CodeProcess
        const input = {
          request: { code: 'return await tools.find_tools({});', summary: 'Read' },
          boundary: ThreadId.make('one-thread'),
        }
        const first = yield* Effect.forkChild(process.run(input, dispatch))
        yield* Deferred.await(entered)
        check(yield* process.run(input, reply), 'Failed', {
          failure: CodeFailure.cases.Unavailable.make({}),
        })
        const secondEntered = yield* Deferred.make<void>()
        const second = yield* Effect.forkChild(
          process.run(
            { ...input, boundary: ThreadId.make('second-thread') },
            Effect.fn('Test.second')(function* (call) {
              yield* Deferred.succeed(secondEntered, undefined)
              return yield* dispatch(call)
            }),
          ),
        )
        yield* Deferred.await(secondEntered)
        check(
          yield* process.run({ ...input, boundary: ThreadId.make('third-thread') }, reply),
          'Failed',
          {
            failure: CodeFailure.cases.Unavailable.make({}),
          },
        )
        yield* Deferred.succeed(release, undefined)
        expect(CodeOutcome.guards.Completed(yield* Fiber.join(first))).toBe(true)
        expect(CodeOutcome.guards.Completed(yield* Fiber.join(second))).toBe(true)
      }),
    )

    for (const loop of ['while(true) {}', 'while(true) await Promise.resolve();']) {
      it.effect(`parent deadline stops ${loop} and releases interpreter capacity`, () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const dispatch: Dispatch = Effect.fn('Test.loopStarted')(function* (call) {
            yield* Deferred.succeed(entered, undefined)
            return yield* reply(call)
          })
          const running = yield* Effect.forkChild(
            run(`await tools.find_tools({}); ${loop}`, dispatch),
          )
          yield* Deferred.await(entered)
          yield* TestClock.adjust('31 seconds')
          const outcome = yield* Fiber.join(running)
          expect(CodeOutcome.guards.Failed(outcome)).toBe(true)
          expect(outcome).toHaveProperty('failure._tag', 'TimedOut')
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed'])
          expect(yield* run('return 42;', reply)).toHaveProperty('result', 42)
        }),
      )
    }

    it.effect(
      'marks a timed-out consequential dispatch unknown and retains a previous completed receipt',
      () =>
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
          yield* TestClock.adjust('31 seconds')
          const outcome = yield* Fiber.join(running)
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'unknown'])
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
        const exhausted = yield* run('for(let i=0;i<26;i++) await tools.find_tools({});', refused)
        expect(exhausted).toHaveProperty('failure.limit', 'calls')
        expect(exhausted.calls).toHaveLength(25)
      }),
    )

    it.effect('rejects oversized bridge input despite a guest catch', () =>
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
          'for(let i=0;i<5;i++) await tools.find_tools({}); return 1;',
          large,
        )
        expect(aggregate).toHaveProperty('failure.limit', 'data')
        expect(aggregate.calls).toHaveLength(5)
      }),
    )

    it.effect('guest heap exhaustion reports a memory resource failure', () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          'const items=[]; while(true) items.push("x".repeat(1024));',
          reply,
        )
        expect(outcome).toHaveProperty('failure.limit', 'memory')
      }),
    )

    it.effect(
      'host output flooding hits the cgroup memory cap while the server remains usable',
      () =>
        Effect.gen(function* () {
          const outcome = yield* run(
            'const value="x".repeat(16384); for(let i=0;i<1000000;i++) text(value);',
            reply,
          )
          expect(outcome).toHaveProperty('failure.limit', 'memory')
          expect(yield* run('return 1;', reply)).toHaveProperty('result', 1)
        }),
      { timeout: 15_000 },
    )

    it.effect(
      'child resource death after dispatch preserves partial effects as unknown',
      () =>
        Effect.gen(function* () {
          const dispatch: Dispatch = Effect.fn('Test.lostChild')(function* (call) {
            if (call.id === 1) return yield* reply(call)
            return yield* Effect.never
          })
          const outcome = yield* run(
            'await tools.find_tools({}); tools.use_tool({}); const value="x".repeat(16384); for(let i=0;i<1000000;i++) text(value);',
            dispatch,
          )
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'unknown'])
        }),
      { timeout: 15_000 },
    )
  })
})
