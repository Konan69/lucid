/** Ported from opencode `packages/codemode/test/enumeration.test.ts` at 3884062 (MIT). */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { Program, Tool } from './index.ts'
// Key enumeration: Object.keys and for...in share one surface over plain objects, arrays
// (index strings), and tool references (namespace/tool names from the host tool tree), so a
// model can discover what it may call instead of guessing names from the instructions. The
// motivating transcript: `Object.keys(tools)` failed with the generic plain-objects-only
// message and `for (const key in tools)` was unsupported syntax, forcing blind guesses.
const echo = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    run: ({ value }) => Effect.succeed(value),
  })
const tools = {
  github: { list_issues: echo('List issues'), get_issue: echo('Get one issue') },
  memory: { search: echo('Search memory') },
  playwright: { navigate: echo('Navigate somewhere') },
}
const run = (code: string) => Program.execute({ tools, code })
const value = (code: string) =>
  Effect.gen(function* () {
    const result = yield* run(code)
    if (!result.ok)
      throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
    return result.value
  })
const error = (code: string) =>
  Effect.gen(function* () {
    const result = yield* run(code)
    if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
    return result.error
  })
describe('Object.keys over tool references', () => {
  it.live('enumerates top-level namespaces (the transcript program)', () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const namespaces = Object.keys(tools)
      return { namespaces, count: namespaces.length }
    `),
      ).toEqual({ namespaces: ['github', 'memory', 'playwright'], count: 3 })
    }),
  )
  it.live('enumerates tool names at a nested namespace', () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.keys(tools.github)`)).toEqual(['list_issues', 'get_issue'])
    }),
  )
  it.live('a callable tool is a leaf and enumerates as []', () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.keys(tools.github.list_issues)`)).toEqual([])
    }),
  )
  it.live('an unknown namespace is an UnknownTool error pointing at the discovery idioms', () =>
    Effect.gen(function* () {
      const failure = yield* error(`return Object.keys(tools.nonexistent)`)
      expect(failure.kind).toBe('UnknownTool')
      expect(failure.message).toContain("Unknown tool namespace 'nonexistent'")
      expect(failure.suggestions?.join(' ')).toContain('Object.keys(tools)')
    }),
  )
  it.live('Object.values/entries on a tool reference explain the working idioms', () =>
    Effect.gen(function* () {
      for (const method of ['values', 'entries'] as const) {
        const failure = yield* error(`return Object.${method}(tools)`)
        expect(failure.kind).toBe('InvalidDataValue')
        expect(failure.message).toContain(
          `Object.${method}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or tools.find_tools({query}) for signatures.`,
        )
      }
      const nested = yield* error(`return Object.entries(tools.github)`)
      expect(nested.message).toContain('Use Object.keys(tools) for names')
    }),
  )
})
describe('Object.keys over arrays', () => {
  it.live('returns index strings, like JS', () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.keys(["a", "b", "c"])`)).toEqual(['0', '1', '2'])
      expect(yield* value(`return Object.keys([])`)).toEqual([])
    }),
  )
  it.live('objects keep their own enumerable keys', () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.keys({ a: 1, b: 2 })`)).toEqual(['a', 'b'])
    }),
  )
  it.live('non-object inputs still fail clearly', () =>
    Effect.gen(function* () {
      const failure = yield* error(`return Object.keys("nope")`)
      expect(failure.message).toContain('Object.keys expects a data object or array')
    }),
  )
})
describe('for...in', () => {
  it.live('iterates own enumerable keys of a plain object with break/continue', () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const seen = []
      for (const key in { a: 1, b: 2, c: 3, d: 4 }) {
        if (key === "b") continue
        if (key === "d") break
        seen.push(key)
      }
      return seen
    `),
      ).toEqual(['a', 'c'])
    }),
  )
  it.live('iterates index strings over arrays', () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const indexes = []
      for (const i in ["x", "y", "z"]) {
        if (i === "2") break
        indexes.push(i)
      }
      return indexes
    `),
      ).toEqual(['0', '1'])
    }),
  )
  it.live('supports let declarations and bare identifiers', () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      let last = ""
      for (let key in { a: 1, b: 2 }) last = key
      return last
    `),
      ).toBe('b')
      expect(
        yield* value(`
      let key = "before"
      for (key in { only: 1 }) {}
      return key
    `),
      ).toBe('only')
    }),
  )
  it.live('enumerates namespaces and tools from the callable tool tree', () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const names = []
      for (const ns in tools) {
        for (const name in tools[ns]) names.push(ns + "." + name)
      }
      return names
    `),
      ).toEqual(['github.list_issues', 'github.get_issue', 'memory.search', 'playwright.navigate'])
    }),
  )
  it.live('unsupported values fail with a hint at for...of and Object.keys', () =>
    Effect.gen(function* () {
      for (const expression of [`"text"`, 'new Map([[1, 2]])', 'new Set([1])', '42', 'null']) {
        const failure = yield* error(`for (const key in ${expression}) {}; return "no"`)
        expect(failure.message).toContain(
          'for...in requires a plain object, array, or tools reference',
        )
        expect(failure.message).toContain(
          'Use for...of for arrays/strings/Maps/Sets, or Object.keys(value)',
        )
      }
    }),
  )
})
