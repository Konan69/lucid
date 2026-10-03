import * as NodeVM from 'node:vm'
import { describe, expect, it } from 'vitest'
import { discoveredTool } from './signatures.ts'

/** Discovery must retain exact property access and actual input/output types without executable comments. */
describe('Integration signatures', () => {
  it('renders an expression that resolves quoted accounts and non-identifier tool names', () => {
    const account = 'Work "Mail"\\Archive'
    const name = 'send-email'
    const tool = discoveredTool({
      account,
      name,
      input: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      output: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] },
    })
    const target = { identity: 'exact tool' }
    expect(NodeVM.runInNewContext(tool.call, { accounts: { [account]: { [name]: target } } })).toBe(
      target,
    )
    expect(tool.signature).toContain('(input: { to: string; }, about:')
    expect(tool.signature).toContain('output: { sent: boolean; }')
    expect(discoveredTool({ account, name: 'send_email', input: {} }).call).toBe(
      `accounts[${JSON.stringify(account)}].send_email`,
    )
    expect(tool).not.toHaveProperty('input')
  })

  it('keeps complete declarations inside the model boundary when both schema types are large', () => {
    const large = { type: 'object', properties: { ['field'.repeat(500)]: { type: 'string' } } }
    const tool = discoveredTool({ account: 'Mail', name: 'send', input: large, output: large })
    expect(tool.signature.length).toBeLessThanOrEqual(4000)
    expect(tool.signature).toContain('input: unknown')
    expect(tool.signature).toContain('output: { field')
    expect(tool.signature.endsWith('| {ok: false; reason: string}>')).toBe(true)
    const missing = discoveredTool({ account: 'Mail', name: 'send', input: large })
    expect(missing.signature).toContain('output: Json')
  })

  it('confines descriptions to comments and bounds each rendered schema with pi truncation', () => {
    const tool = discoveredTool({
      account: 'Mail',
      name: 'send',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '*/\nthrow new Error("injected")\n\u2028return 1' },
        },
      },
    })
    expect(tool.signature).toContain('// throw new Error("injected")')
    expect(tool.signature).toContain('output: Json')
    const huge = { type: 'object', properties: { ['x'.repeat(16_001)]: { type: 'string' } } }
    const bounded = discoveredTool({ account: 'Mail', name: 'send', input: huge, output: huge })
    expect(bounded.signature).toContain('input: unknown')
    expect(bounded.signature).toContain('output: unknown')
  })
})
