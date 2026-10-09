import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { CodeMode, Tool } from './index.ts'

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
  it.live('runs calls together and returns plain data', () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
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
      const result = yield* CodeMode.execute({
        tools,
        limits: { timeoutMs: 300 },
        code: `while (true) {}`,
      })
      expect(result).toMatchObject({ ok: false, error: { kind: 'TimeoutExceeded' } })
    }),
  )

  it.live('has no ambient authority', () =>
    Effect.gen(function* () {
      for (const code of ['return process.env', 'return await import("node:fs")', 'return fetch("http://x")', 'return globalThis', 'return (()=>{}).constructor("return process")()'])
        expect((yield* CodeMode.execute({ tools, code })).ok).toBe(false)
    }),
  )

  const limits = { timeoutMs: 20_000, maxSteps: 2_000_000, maxGrowth: 16_777_216 }

  it.live('a program that keeps making data is ended by its growth limit', () =>
    Effect.gen(function* () {
      const before = process.memoryUsage().heapUsed
      const started = Date.now()
      const result = yield* CodeMode.execute({
        tools,
        limits,
        code: `const a = []; let s = "x".repeat(1000); while (true) { a.push(s + a.length) }`,
      })
      console.log('GROWTH', Date.now() - started, 'ms', Math.round((process.memoryUsage().heapUsed - before) / 1048576), 'MB')
      expect(result).toMatchObject({ ok: false, error: { kind: 'WorkLimitExceeded' } })
    }),
  )

  it.live('a busy program is ended by its step limit, and cannot catch it', () =>
    Effect.gen(function* () {
      const started = Date.now()
      const result = yield* CodeMode.execute({
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
      for (const code of ['return "x".repeat(2**29).length', 'return "".padStart(2**29).length', 'return Array.from({length: 2**30}).length', 'let s = "x".repeat(4000000); while (true) { s = s + s }'])
        expect(yield* CodeMode.execute({ tools, limits, code })).toMatchObject({ ok: false, error: { kind: 'WorkLimitExceeded' } })
    }),
  )

  it.live('ordinary work fits', () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
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
