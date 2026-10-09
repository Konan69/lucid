import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema, SchemaTransformation } from 'effect'
import { Program, Tool } from './index.ts'

const tools = {
  orders: {
    lookup: Tool.make({
      description: 'Look up an order',
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String, status: Schema.String }),
      run: ({ id }) => Effect.succeed({ id, status: id === 'a' ? 'open' : 'done' }),
    }),
  },
}

describe('program interpreter', () => {
  /** A host schema whose transformation throws, as a schema written with a plain function can. */
  const Throwing = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (text: string): string => {
          throw new Error(`decode-secret /home/host/private/key.pem for ${text}`)
        },
        encode: (text: string) => text,
      }),
    ),
  )

  it.live(
    'a host schema that throws while decoding is an invalid input or output, not a leak',
    () =>
      Effect.gen(function* () {
        const ended: string[] = []
        const host = {
          input: Tool.make({
            description: 'Input decode throws',
            input: Throwing,
            run: () => Effect.succeed('unreached'),
          }),
          output: Tool.make({
            description: 'Output decode throws',
            input: Schema.Struct({}),
            output: Throwing,
            run: () => Effect.succeed('raw'),
          }),
        }
        const run = (code: string) =>
          Program.execute({
            tools: { host },
            code,
            onToolCallEnd: (call) => Effect.sync(() => ended.push(`${call.name}:${call.outcome}`)),
          })
        const output = yield* run('return await tools.host.output({})')
        expect(output).toMatchObject({
          ok: false,
          error: { kind: 'InvalidToolOutput', message: "Invalid output from tool 'host.output'." },
        })
        const caught = yield* run(
          'try { await tools.host.output({}) } catch (e) { return e.message }',
        )
        expect(caught).toMatchObject({ ok: true, value: "Invalid output from tool 'host.output'." })
        expect(yield* run('return await tools.host.input("x")')).toMatchObject({
          ok: false,
          error: { kind: 'InvalidToolInput' },
        })
        // The end of the call whose output could not be decoded is still observed.
        expect(ended).toEqual(['host.output:failure', 'host.output:failure'])
      }),
  )

  it.live(
    'a JSON Schema input shapes the signature only: the value reaches the tool as written',
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = []
        const result = yield* Program.execute({
          tools: {
            host: {
              echo: Tool.make({
                description: 'Echo',
                input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                run: (input) => Effect.sync(() => seen.push(input)),
              }),
            },
          },
          code: 'return await tools.host.echo({ id: 7, extra: true })',
        })
        expect(result.ok).toBe(true)
        expect(seen).toEqual([{ id: 7, extra: true }])
      }),
  )

  it('refuses limits that are not whole numbers in range', () => {
    for (const limits of [
      { timeoutMs: 0 },
      { maxToolCalls: -1 },
      { maxOutputBytes: 1.5 },
      { maxSteps: 0 },
      { maxGrowth: Number.NaN },
    ])
      expect(() => Program.execute({ code: 'return 1', limits })).toThrow(RangeError)
  })

  it.live('runs calls together and returns plain data', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        tools,
        code: `const all = await Promise.all(["a","b"].map((id) => tools.orders.lookup({ id })))
console.log("got", all.length)
return all.filter((o) => o.status === "open").map((o) => o.id)`,
      })
      expect(result).toMatchObject({ ok: true, value: ['a'], logs: ['got 2'] })
      expect(result.toolCalls).toHaveLength(2)
    }),
  )

  it.live('a busy loop is ended by the timeout', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        tools,
        limits: { timeoutMs: 300 },
        code: `while (true) {}`,
      })
      expect(result).toMatchObject({ ok: false, error: { kind: 'TimeoutExceeded' } })
    }),
  )

  it.live('has no ambient authority', () =>
    Effect.gen(function* () {
      for (const code of [
        'return process.env',
        'return await import("node:fs")',
        'return fetch("http://x")',
        'return globalThis',
        'return (()=>{}).constructor("return process")()',
      ])
        expect((yield* Program.execute({ tools, code })).ok).toBe(false)
    }),
  )

  const limits = { timeoutMs: 20_000, maxSteps: 2_000_000, maxGrowth: 16_777_216 }

  it.live('a program that keeps making data is ended by its growth limit', () =>
    Effect.gen(function* () {
      const before = process.memoryUsage().heapUsed
      const started = Date.now()
      const result = yield* Program.execute({
        tools,
        limits,
        code: `const a = []; let s = "x".repeat(1000); while (true) { a.push(s + a.length) }`,
      })
      console.log(
        'GROWTH',
        Date.now() - started,
        'ms',
        Math.round((process.memoryUsage().heapUsed - before) / 1048576),
        'MB',
      )
      expect(result).toMatchObject({ ok: false, error: { kind: 'WorkLimitExceeded' } })
    }),
  )

  it.live('a busy program is ended by its step limit, and cannot catch it', () =>
    Effect.gen(function* () {
      const started = Date.now()
      const result = yield* Program.execute({
        tools,
        limits,
        code: `let n = 0; try { while (true) { n++ } } catch (e) { return "caught" } finally { n = -1 }; return "after"`,
      })
      console.log('STEPS', Date.now() - started, 'ms')
      expect(result).toMatchObject({ ok: false, error: { kind: 'WorkLimitExceeded' } })
    }),
  )

  it.live('one built-in cannot make a huge value', () =>
    Effect.gen(function* () {
      for (const code of [
        'return "x".repeat(2**29).length',
        'return "".padStart(2**29).length',
        'return Array.from({length: 2**30}).length',
        'let s = "x".repeat(4000000); while (true) { s = s + s }',
      ])
        expect(yield* Program.execute({ tools, limits, code })).toMatchObject({
          ok: false,
          error: { kind: 'WorkLimitExceeded' },
        })
    }),
  )

  it.live('ordinary work fits', () =>
    Effect.gen(function* () {
      const result = yield* Program.execute({
        tools,
        limits,
        code: `const rows = []; for (let i = 0; i < 5000; i++) rows.push({ id: i, name: "row " + i, tags: ["a", "b"] })
const by = new Map(); for (const r of rows) by.set(r.id % 10, (by.get(r.id % 10) ?? 0) + 1)
return { n: rows.filter((r) => r.id % 2 === 0).map((r) => r.name).length, groups: by.size, text: JSON.stringify(rows).length }`,
      })
      expect(result).toMatchObject({ ok: true, value: { n: 2500, groups: 10 } })
    }),
  )
})
