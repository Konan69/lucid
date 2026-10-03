import * as NodeVM from 'node:vm'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, type Schema } from 'effect'
import { bytes } from './budgets.ts'
import { callableTool, discoveredTool } from './signatures.ts'

/** Discovery must retain exact property access and actual input/output types without executable comments. */
describe('Integration signatures', () => {
  it.effect(
    'renders an expression that resolves quoted accounts and non-identifier tool names',
    () =>
      Effect.gen(function* () {
        const account = 'Work "Mail"\\Archive'
        const name = 'send-email'
        const tool = yield* discoveredTool({
          account,
          name,
          input: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
          output: Option.some({
            type: 'object',
            properties: { sent: { type: 'boolean' } },
            required: ['sent'],
          }),
        })
        const target = { identity: 'exact tool' }
        expect(
          NodeVM.runInNewContext(tool.call, { accounts: { [account]: { [name]: target } } }),
        ).toBe(target)
        expect(tool.signature).toContain('(input: { to: string; }, about:')
        expect(tool.signature).toContain('output: { sent: boolean; }')
        expect(
          (yield* discoveredTool({ account, name: 'send_email', input: {}, output: Option.none() }))
            .call,
        ).toBe(`accounts[${JSON.stringify(account)}].send_email`)
        expect(tool).not.toHaveProperty('input')
      }),
  )

  it.effect(
    'keeps complete declarations inside the model boundary when both schema types are large',
    () =>
      Effect.gen(function* () {
        const large = { type: 'object', properties: { ['field'.repeat(500)]: { type: 'string' } } }
        const tool = yield* discoveredTool({
          account: 'Mail',
          name: 'send',
          input: large,
          output: Option.some(large),
        })
        expect(bytes(tool.signature)).toBeLessThanOrEqual(4000)
        expect(tool.signature).toContain('input: unknown')
        expect(tool.signature).toContain('output: { field')
        expect(tool.signature.endsWith('| {ok: false; reason: string}>')).toBe(true)
        const missing = yield* discoveredTool({
          account: 'Mail',
          name: 'send',
          input: large,
          output: Option.none(),
        })
        expect(missing.signature).toContain('output: Json')
      }),
  )

  it.effect(
    'confines descriptions to comments and bounds each rendered schema with pi truncation',
    () =>
      Effect.gen(function* () {
        const tool = yield* discoveredTool({
          output: Option.none(),
          account: 'Mail',
          name: 'send',
          input: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: '*/\nthrow new Error("injected")\n\u2028return 1',
              },
            },
          },
        })
        expect(tool.signature).toContain('// */ throw new Error("injected")')
        expect(tool.signature).toContain('output: Json')
        const huge = { type: 'object', properties: { ['x'.repeat(16_001)]: { type: 'string' } } }
        const bounded = yield* discoveredTool({
          account: 'Mail',
          name: 'send',
          input: huge,
          output: Option.some(huge),
        })
        expect(bounded.signature).toContain('input: unknown')
        expect(bounded.signature).toContain('output: unknown')
      }),
  )
  it.effect('contains malformed references and excessively deep schemas within their types', () =>
    Effect.gen(function* () {
      let deep: Schema.Json = { type: 'string' }
      for (let i = 0; i < 20_000; i++) deep = { type: 'array', items: deep }
      for (const input of [{ $ref: '#/%' }, deep]) {
        const tool = yield* discoveredTool({
          account: 'Mail',
          name: 'read',
          input,
          output: Option.some(input),
        })
        expect(tool.signature).toContain('input: unknown')
        expect(tool.signature).toContain('output: unknown')
      }
    }),
  )

  it.effect('keeps lone CR and other comment terminators on one comment line', () =>
    Effect.gen(function* () {
      const tool = yield* discoveredTool({
        output: Option.none(),
        account: 'Mail',
        name: 'read',
        input: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'before\rafter\u0085next\vnext\fnext\u2028next\u2029end',
            },
          },
        },
      })
      expect(tool.signature).toContain('// before after next next next next end')
      for (const separator of ['\r', '\u0085', '\v', '\f', '\u2028', '\u2029'])
        expect(tool.signature).not.toContain(separator)
    }),
  )

  it.effect('bounds multibyte schemas in UTF-8 and escapes separators in property access', () =>
    Effect.gen(function* () {
      const tool = yield* discoveredTool({
        output: Option.none(),
        account: 'Mail\u2028archive',
        name: 'read\u2029mail',
        input: {
          type: 'object',
          properties: { ['界'.repeat(1500)]: { type: 'string' } },
        },
      })
      expect(bytes(tool.signature)).toBeLessThanOrEqual(4_000)
      expect(tool.signature).toContain('input: unknown')
      expect(tool.call).toContain('\\u2028')
      expect(tool.call).toContain('\\u2029')
      expect(tool.call).not.toMatch(/[\u2028\u2029]/u)
    }),
  )

  it.effect('renders then names through the single-object use_tool bridge', () =>
    Effect.gen(function* () {
      for (const names of [
        { account: 'then', name: 'read' },
        { account: 'Mail', name: 'then' },
      ]) {
        const tool = yield* discoveredTool({
          output: Option.none(),
          ...names,
          input: { type: 'string' },
        })
        expect(tool.call).toContain('tools.use_tool({account:')
        expect(tool.signature).toContain('(args: {account:')
        expect(tool.signature).toContain('input: string; summary: string; rationale: string}')
      }
    }),
  )

  it.effect('rejects empty and overlong names but accepts contract boundaries', () =>
    Effect.sync(() => {
      for (const names of [
        { account: '', name: 'read' },
        { account: 'Mail', name: '' },
        { account: 'x'.repeat(301), name: 'read' },
        { account: 'Mail', name: 'x'.repeat(201) },
      ])
        expect(callableTool(names)).toBe(false)
      expect(callableTool({ account: 'x'.repeat(300), name: 'x'.repeat(200) })).toBe(true)
    }),
  )
})
