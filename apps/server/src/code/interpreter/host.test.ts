/** Ported from opencode `packages/codemode/test/codemode.test.ts` at 3884062 (MIT). */
import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Schema } from 'effect'
import { Program, Tool, toolRefusal } from './index.ts'
import type { ToolCallStarted, ToolCallEnded } from './tools.ts'
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Program.Result))
type InvalidHostOutput = { readonly safe: string }

const run = (tool: Tool.Definition) =>
  Program.execute({
    tools: { host: { call: tool } },
    code: 'return await tools.host.call({})',
  })
class UnsafeHostError extends Schema.TaggedError<UnsafeHostError>()(
  'UnsafeHostError',
  {
    reason: Schema.String,
  },
  { title: 'Unsafe host test failure' },
) {}
describe('Program host failure boundary', () => {
  it.live('preserves explicit safe tool failures', () =>
    Effect.gen(function* () {
      const result = yield* run(
        Tool.make({
          description: 'Fail safely',
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => Effect.fail(toolRefusal('Authorized request was refused')),
        }),
      )
      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: 'ToolFailure',
        message: 'Authorized request was refused',
      })
    }),
  )
  it.live('sanitizes unknown host failures and defects', () =>
    Effect.gen(function* () {
      for (const failure of [
        Effect.fail(new UnsafeHostError({ reason: 'Authorization: Bearer typed-secret' })),
        Effect.die(new Error('postgres://user:defect-secret@example.invalid')),
      ]) {
        const result = yield* run(
          Tool.make({
            description: 'Fail internally',
            input: Schema.Struct({}),
            output: Schema.String,
            run: () => failure,
          }),
        )
        expect(result.ok ? undefined : result.error).toStrictEqual({
          kind: 'ToolFailure',
          message: 'Tool execution failed',
        })
        expect(JSON.stringify(result)).not.toMatch(
          /typed-secret|defect-secret|Authorization: Bearer/,
        )
      }
    }),
  )
  it.live('sanitizes invalid host output', () =>
    Effect.gen(function* () {
      const secret = 'invalid-output-secret'
      const result = yield* run(
        Tool.make({
          description: 'Return invalid output',
          input: Schema.Struct({}),
          output: Schema.Struct({ safe: Schema.String }),
          run: () =>
            Effect.succeed({ safe: 1, secret }).pipe(
              Effect.map((raw: unknown) => raw as InvalidHostOutput),
            ),
        }),
      )
      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: 'InvalidToolOutput',
        message: "Invalid output from tool 'host.call'.",
      })
      expect(JSON.stringify(result)).not.toMatch(/invalid-output-secret/)
    }),
  )
  it.live('sanitizes host output that throws while being copied', () =>
    Effect.gen(function* () {
      const result = yield* run(
        Tool.make({
          description: 'Return hostile output',
          input: Schema.Struct({}),
          output: Schema.Unknown,
          run: () =>
            Effect.succeed(
              new Proxy(
                {},
                {
                  ownKeys: () => {
                    throw new Error('host-output-secret')
                  },
                },
              ),
            ),
        }),
      )
      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: 'InvalidToolOutput',
        message: "Invalid output from tool 'host.call'.",
      })
      expect(JSON.stringify(result)).not.toMatch(/host-output-secret/)
    }),
  )
  it.live('caught tool failures are Error values in-program', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        tools: {
          host: {
            call: Tool.make({
              description: 'Refuse',
              input: Schema.Struct({}),
              output: Schema.String,
              run: () => Effect.fail(toolRefusal('Refused')),
            }),
          },
        },
        code: `
        try {
          await tools.host.call({})
          return "no"
        } catch (e) {
          return { isError: e instanceof Error, message: e.message }
        }
      `,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toStrictEqual({ isError: true, message: 'Refused' })
    }),
  )
  it.live('propagates host interruption instead of returning a diagnostic', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Program.execute({
          tools: {
            host: {
              call: Tool.make({
                description: 'Interrupt',
                input: Schema.Struct({}),
                output: Schema.String,
                run: () => Effect.interrupt,
              }),
            },
          },
          code: 'return await tools.host.call({})',
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
    }),
  )
})
describe('Program tool-call observation', () => {
  it.live('reports the tools actually invoked with decoded input', () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      const lookup = Tool.make({
        description: 'Look up a value',
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        run: ({ query }) => Effect.succeed(query),
      })
      const result = yield* Program.execute({
        tools: { context: { lookup } },
        onToolCallStart: (call: ToolCallStarted) => Effect.sync(() => calls.push(call)),
        code: `
        if (false) await tools.context.lookup({ query: "not called" })
        return await tools.context.lookup({ query: "deployment failure" })
      `,
      })
      expect(result.ok).toBe(true)
      expect(calls).toStrictEqual([
        { index: 0, name: 'context.lookup', input: { query: 'deployment failure' } },
      ])
    }),
  )
  it.live('observes settled calls with outcome and duration', () =>
    Effect.gen(function* () {
      const events: Array<{
        phase: string
        index: number
        name: string
        outcome?: string
        message?: string
      }> = []
      const lookup = Tool.make({
        description: 'Look up a value',
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        run: ({ query }) =>
          query === 'boom' ? Effect.fail(toolRefusal('Lookup refused')) : Effect.succeed(query),
      })
      const runtime = {
        tools: { context: { lookup } },
        onToolCallStart: (call: ToolCallStarted) =>
          Effect.sync(() => {
            events.push({ phase: 'start', index: call.index, name: call.name })
          }),
        onToolCallEnd: (call: ToolCallEnded) =>
          Effect.sync(() => {
            expect(call.durationMs).toBeGreaterThanOrEqual(0)
            const event: (typeof events)[number] = {
              phase: 'end',
              index: call.index,
              name: call.name,
              outcome: call.outcome,
            }
            if (call.message !== undefined) event.message = call.message
            events.push(event)
          }),
      }
      const success = yield* Program.execute({
        ...runtime,
        code: `return await tools.context.lookup({ query: "ok" })`,
      })
      expect(success.ok).toBe(true)
      const failure = yield* Program.execute({
        ...runtime,
        code: `return await tools.context.lookup({ query: "boom" })`,
      })
      expect(failure.ok).toBe(false)
      expect(events).toStrictEqual([
        { phase: 'start', index: 0, name: 'context.lookup' },
        { phase: 'end', index: 0, name: 'context.lookup', outcome: 'success' },
        { phase: 'start', index: 0, name: 'context.lookup' },
        {
          phase: 'end',
          index: 0,
          name: 'context.lookup',
          outcome: 'failure',
          message: 'Lookup refused',
        },
      ])
    }),
  )
})
describe('Program console capture', () => {
  it.live('captures console output as bounded result logs', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        const returned = console.log("Thread info:", { name: "Demo", count: 2 })
        console.warn("careful")
        return returned
      `,
      })
      expect(result).toStrictEqual({
        ok: true,
        value: null,
        logs: ['Thread info: {"name":"Demo","count":2}', '[warn] careful'],
        toolCalls: [],
      })
      expect(yield* decodeResult(JSON.stringify(result))).toStrictEqual(result)
    }),
  )
  it.live('keeps logs captured before failures', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.log("before failure")
        throw new Error("boom")
      `,
      })
      expect(result.ok ? undefined : result.logs).toStrictEqual(['before failure'])
      expect(result.ok ? undefined : result.error.message).toBe('Uncaught: boom')
    }),
  )
  it.live('prints NaN and Infinity literally instead of the JSON null', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.log(NaN)
        console.log(Infinity, -Infinity)
        console.log({ ratio: NaN, bounds: [Infinity] })
        return null
      `,
      })
      expect(result.ok).toBe(true)
      expect(result.logs).toStrictEqual([
        'NaN',
        'Infinity -Infinity',
        '{"ratio":NaN,"bounds":[Infinity]}',
      ])
    }),
  )
  it.live('renders sandbox values nested inside logged containers', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.log({ m: new Map([["a", 1]]), when: new Date(0), r: /ab/g, s: new Set([1, 2]) })
        console.log([new Date(0)])
        return null
      `,
      })
      expect(result.ok).toBe(true)
      expect(result.logs).toStrictEqual([
        '{"m":Map(1) [["a",1]],"when":1970-01-01T00:00:00.000Z,"r":/ab/g,"s":Set(2) [1,2]}',
        '[1970-01-01T00:00:00.000Z]',
      ])
    }),
  )
  it.live('console formatting is total: cycles and opaque references render as markers', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        const m = new Map()
        m.set("self", m)
        console.log({ box: m })
        console.log({ fn: (x) => x, ok: 1 })
        return null
      `,
      })
      expect(result.ok).toBe(true)
      expect(result.logs).toStrictEqual([
        '{"box":Map(1) [["self",[Circular]]]}',
        '{"fn":[Program reference],"ok":1}',
      ])
    }),
  )
  it.live('console.table renders sandbox value cells', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.table([{ when: new Date(0), n: NaN }])
        return null
      `,
      })
      expect(result.ok).toBe(true)
      expect(result.logs).toStrictEqual(['(index)\twhen\tn\n0\t1970-01-01T00:00:00.000Z\tNaN'])
    }),
  )
  it.live('captures console.dir and console.table output', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.dir({ nested: { ok: true } })
        console.table([
          { name: "Kit", count: 1, hidden: "x" },
          { name: "Olive", count: 2, hidden: "y" }
        ], ["name", "count"])
        return "done"
      `,
      })
      expect(result).toStrictEqual({
        ok: true,
        value: 'done',
        logs: ['{"nested":{"ok":true}}', '(index)\tname\tcount\n0\tKit\t1\n1\tOlive\t2'],
        toolCalls: [],
      })
    }),
  )
})
describe('Program output budget', () => {
  it.live('absent maxOutputBytes means no truncation at all', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `console.log("z".repeat(50_000)); return "x".repeat(100_000)`,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.truncated).toBeUndefined()
      expect(result.value).toBe('x'.repeat(100000))
      expect(result.logs).toStrictEqual(['z'.repeat(50000)])
    }),
  )
  it.live('truncates an oversized result value with a marker instead of failing', () =>
    Effect.gen(function* () {
      const limits: Program.ExecutionLimits = { maxOutputBytes: 40 }
      const result = yield* Program.execute({
        code: `return { data: "${'x'.repeat(200)}" }`,
        limits,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.truncated).toBe(true)
      expect(typeof result.value).toBe('string')
      expect(result.value).toMatch(
        /^\{"data":"x+ \[result truncated: \d+ bytes exceeds the 40-byte output limit; return a smaller value\]$/,
      )
      expect(yield* decodeResult(JSON.stringify(result))).toStrictEqual(result)
    }),
  )
  it.live('keeps leading logs within the remaining budget and marks the cut', () =>
    Effect.gen(function* () {
      const limits: Program.ExecutionLimits = { maxOutputBytes: 40 }
      const result = yield* Program.execute({
        code: `
        console.log("first line")
        console.log("${'y'.repeat(200)}")
        return "ok"
      `,
        limits,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toBe('ok')
      expect(result.truncated).toBe(true)
      expect(result.logs).toStrictEqual(['first line', '[logs truncated: showing 1 of 2 lines]'])
    }),
  )
  it.live('does not mark results within the budget', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `
        console.log("fits")
        return { fits: true }
      `,
      })
      expect(result).toStrictEqual({
        ok: true,
        value: { fits: true },
        logs: ['fits'],
        toolCalls: [],
      })
    }),
  )
})
describe('Program schema flexibility', () => {})
describe('Program public contract', () => {
  const lookup = Tool.make({
    description: 'Look up an order by ID',
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String, status: Schema.String }),
    run: ({ id }) => Effect.succeed({ id, status: 'open' }),
  })
  const tools = { orders: { lookup } }
  const source = `return await tools.orders.lookup({ id: "order_42" })`
  it.live('decodes tool input and output before exposing either side', () =>
    Effect.gen(function* () {
      const observed: Array<unknown> = []
      const transformed = Tool.make({
        description: 'Double a number',
        input: Schema.Struct({ value: Schema.FiniteFromString }),
        output: Schema.FiniteFromString,
        run: ({ value }) =>
          Effect.sync(() => {
            observed.push(value)
            return String(value * 2)
          }),
      })
      const success = yield* Program.execute({
        tools: { math: { double: transformed } },
        onToolCallStart: (call: ToolCallStarted) => Effect.sync(() => observed.push(call.input)),
        code: `return await tools.math.double({ value: "21" })`,
      })
      expect(success).toStrictEqual({ ok: true, value: 42, toolCalls: [{ name: 'math.double' }] })
      expect(observed).toStrictEqual([{ value: 21 }, 21])
      const invalid = yield* Program.execute({
        tools: { math: { double: transformed } },
        onToolCallStart: (call: ToolCallStarted) => Effect.sync(() => observed.push(call.input)),
        code: `return await tools.math.double({ value: 21 })`,
      })
      expect(invalid.ok).toBe(false)
      if (invalid.ok) return
      expect(invalid.error.kind).toBe('InvalidToolInput')
      expect(observed).toStrictEqual([{ value: 21 }, 21])
    }),
  )
  it.live('returns JSON-safe data and normalizes undefined to null', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        code: `return { top: undefined, nested: [1, undefined] }`,
      })
      expect(result).toStrictEqual({
        ok: true,
        value: { top: null, nested: [1, null] },
        toolCalls: [],
      })
      expect(yield* decodeResult(JSON.stringify(result))).toStrictEqual(result)
    }),
  )
  it.live('enforces the tool-call limit as a diagnostic', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({ tools, code: source, limits: { maxToolCalls: 0 } })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('ToolCallLimitExceeded')
    }),
  )
  it.live('timeoutMs and maxToolCalls have no defaults: absent means unlimited', () =>
    Effect.gen(function* () {
      // 150 tool calls would have exceeded the old default cap of 100; with no limits
      // provided, there is no cap and no timeout - budgets are host policy.
      const counter = Tool.make({
        description: 'Count invocations',
        input: Schema.Struct({}),
        output: Schema.Finite,
        run: () => Effect.succeed(1),
      })
      const result = yield* Program.execute({
        tools: { host: { count: counter } },
        code: `
        let total = 0
        for (let i = 0; i < 150; i += 1) total += await tools.host.count({})
        return total
      `,
      })
      expect(result).toMatchObject({ ok: true, value: 150 })
      if (result.ok) expect(result.toolCalls.length).toBe(150)
    }),
  )
  it.live('the timeout interrupts a busy loop without any operation budget', () =>
    Effect.gen(function* () {
      // Regression: timeout interruption must not depend on interpreter-side work accounting.
      // The Effect fiber runtime auto-yields between interpreter steps, so a pure `while
      // (true) {}` loop is interrupted by `timeoutMs` alone.
      const startedAt = Date.now()
      const result = yield* Program.execute({ code: 'while (true) {}', limits: { timeoutMs: 200 } })
      const elapsedMs = Date.now() - startedAt
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('TimeoutExceeded')
        expect(result.error.message).toContain('timed out after 200ms')
      }
      expect(elapsedMs).toBeLessThan(3000)
    }),
  )
})
