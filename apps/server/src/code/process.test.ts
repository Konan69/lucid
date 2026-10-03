import * as NodeProcess from 'node:process'
import { ConfigProvider, Context, Layer, Logger } from 'effect'
import { programHost } from './host.ts'
import { describe, expect, it as standalone, layer } from '@effect/vitest'
import { ApprovalId, CodeFailure, CodeOutcome, ThreadId } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Ref, Option, type Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { CallOutcome, CodeProcess, codeProcessLayer, type Dispatch } from './process.ts'
import { budgets } from './budgets.ts'

const missingHost = programHost(Option.fromUndefinedOr(NodeProcess.env.XDG_RUNTIME_DIR))
if (Option.isSome(missingHost)) console.warn(`Skipping supervised programs: ${missingHost.value}`)

/** Compare observable variants without constructing partial domain records in matchers. */
function check(outcome: CodeOutcome, tag: CodeOutcome['_tag'], fields: Schema.JsonObject) {
  expect(outcome._tag).toBe(tag)
  expect(outcome).toMatchObject(fields)
}

interface RunningLoopsService {
  readonly fibers: readonly Fiber.Fiber<CodeOutcome>[]
}
/** Suite fixture owns two already-admitted real guests; the test owns the parent deadline and recovery. */
class RunningLoops extends Context.Service<RunningLoops, RunningLoopsService>()(
  'Test/RunningLoops',
) {}

/** Every execution here uses the production bwrap/cgroup child and published pi QuickJS interpreter. */
describe.skipIf(Option.isSome(missingHost))('Supervised programs', () => {
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

    it.effect('dispatches callable accounts once and awaits proxies without thenable calls', () =>
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
    )

    it.effect('keeps model source line numbers after the trusted prelude', () =>
      Effect.gen(function* () {
        const outcome = yield* run('const label="model";\nreturn new Error(label).stack;', reply)
        expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
        expect(outcome).toHaveProperty('result', expect.stringContaining('codemode.js:2'))
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
        yield* Effect.raceFirst(
          Deferred.await(entered),
          Fiber.join(first).pipe(Effect.flatMap((outcome) => Effect.die(outcome))),
        )
        check(yield* process.run(input, reply), 'Failed', {
          failure: CodeFailure.cases.Unavailable.make({}),
        })
        yield* Effect.raceFirst(
          Deferred.await(secondEntered),
          Fiber.join(second).pipe(Effect.flatMap((outcome) => Effect.die(outcome))),
        )
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
        // admitted guests. Keep both real cgroups alive in the suite scope until the test advances time.
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
    it.layer(loopsLayer)('Parent deadline', (deadline) => {
      deadline.effect(
        'stops synchronous and microtask loops and releases both interpreter slots',
        () =>
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
      )
    })

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
          yield* TestClock.adjust('301 seconds')
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
        const exhausted = yield* run('for(let i=0;i<101;i++) await tools.find_tools({});', refused)
        expect(exhausted).toHaveProperty('failure.limit', 'calls')
        expect(exhausted.calls).toHaveLength(100)
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
          // Heap exhaustion is the claim, not thousands of interpreter string-allocation turns.
          'const items=[]; while(true) items.push("x".repeat(1048576));',
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
            // Large transfers measure host output memory, without thousands of small WASM callbacks
            // consuming the test deadline before the lean executable reaches its cgroup ceiling.
            'const value="x".repeat(1048576); for(let i=0;i<1000;i++) text(value);',
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
            'await tools.find_tools({}); tools.use_tool({}); const value="x".repeat(1048576); for(let i=0;i<1000;i++) text(value);',
            dispatch,
          )
          expect(CodeOutcome.guards.OutcomeUnknown(outcome)).toBe(true)
          expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'unknown'])
        }),
      { timeout: 15_000 },
    )
  })
})

/** A missing runtime is diagnosed once during construction, independent of how many requests arrive. */
standalone.effect('logs absent program configuration once and refuses each request', () => {
  const messages: string[] = []
  const logger = Logger.make((entry) => messages.push(Logger.formatSimple.log(entry)))
  return Effect.gen(function* () {
    const process = yield* CodeProcess
    for (let index = 0; index < 2; index++) {
      const result = yield* process.run(
        {
          request: { code: 'return 1;', summary: 'Read' },
          boundary: ThreadId.make(crypto.randomUUID()),
        },
        () => Effect.die('Unavailable configuration must never dispatch'),
      )
      check(result, 'Failed', { failure: CodeFailure.cases.Unavailable.make({}) })
    }
    expect(messages.filter((message) => message.includes('XDG_RUNTIME_DIR'))).toHaveLength(1)
  }).pipe(
    Effect.provide(codeProcessLayer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provide(Logger.layer([logger])),
  )
})

/** A configured but unusable host is rejected during construction, before assets or guests launch. */
standalone.effect('logs unavailable isolation once and refuses configured program runs', () => {
  const messages: string[] = []
  const logger = Logger.make((entry) => messages.push(Logger.formatSimple.log(entry)))
  return Effect.gen(function* () {
    const process = yield* CodeProcess
    for (let index = 0; index < 2; index++) {
      const result = yield* process.run(
        {
          request: { code: 'return 1;', summary: 'Read' },
          boundary: ThreadId.make(crypto.randomUUID()),
        },
        () => Effect.die('Launch must not dispatch'),
      )
      check(result, 'Failed', { failure: CodeFailure.cases.Unavailable.make({}) })
    }
    expect(
      messages.filter((message) => message.includes('Programs are unavailable on this host')),
    ).toHaveLength(1)
    expect(messages.some((message) => message.includes('CodeIsolationUnavailable'))).toBe(true)
  }).pipe(
    Effect.provide(codeProcessLayer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_RUNTIME_DIR: '\0' }))),
    Effect.provide(Logger.layer([logger])),
  )
})
