import * as NodeVM from 'node:vm'
import { expect, it } from '@effect/vitest'
import { keyedFiles, keyedAppsVersion, keyedMcpVersion } from './keyed.ts'

/** Run the generated module body against stubbed `apps` exports. Hostile metadata must arrive
 * at defineProvider as the same string and execute nothing, including template interpolation
 * and the U+2028/U+2029 line separators that JSON.stringify leaves raw. */
it('generates keyed source that runs with public metadata as data, never as code', () => {
  const name = 'quotes " backticks ` ${globalThis.injected = true}\nnew line \u2028\u2029'
  const address = new URL('https://mcp.example.test/mcp')
  const host = 'mcp.example.test'
  const files = keyedFiles({ name, address, host, header: 'X-API-Key', prefix: '' })
  const source = files.find((file) => file.path === 'index.ts')
  if (source === undefined) return expect.fail('Missing MCP source')
  expect(source.content).not.toMatch(/[\u2028\u2029]/u)
  const seen: Array<unknown> = []
  const context = NodeVM.createContext({
    defineProvider: (provider: unknown) => seen.push(provider),
    defineApp: () => undefined,
    secrets: () => undefined,
    object: () => undefined,
    string: () => undefined,
  })
  const script = source.content.replace(/^import .*;\n/gmu, '').replace('export default ', '')
  new NodeVM.Script(script).runInContext(context)
  expect(seen).toMatchObject([{ name, hosts: [host] }])
  expect(NodeVM.runInContext('globalThis.injected', context)).toBeUndefined()
  const manifest = files.find((file) => file.path === 'package.json')
  if (manifest === undefined) return expect.fail('Missing manifest')
  expect(manifest.content).toContain(`"apps":"${keyedAppsVersion}"`)
  expect(manifest.content).toContain(`"@modelcontextprotocol/sdk":"${keyedMcpVersion}"`)
  return undefined
})
