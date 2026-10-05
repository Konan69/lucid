import * as NodeVM from 'node:vm'
import { expect, it } from '@effect/vitest'
import { keyedFiles, keyedAppsVersion, keyedMcpVersion } from './keyed.ts'

/** Compile generated JavaScript after removing only its fixed module declarations. Malicious
 * input must remain a literal through actual parsing, including template interpolation syntax. */
it('generates parseable keyed source without letting public metadata become code', () => {
  const name = 'quotes " backticks ` ${globalThis.injected = true}\nnew line'
  const address = new URL('https://mcp.example.test/mcp')
  const host = 'mcp.example.test'
  const files = keyedFiles({ name, address, host, header: 'X-API-Key', prefix: '' })
  const source = files.find((file) => file.path === 'index.ts')
  if (source === undefined) return expect.fail('Missing MCP source')
  expect(source.content).toContain(`name: ${JSON.stringify(name)}`)
  expect(source.content).toContain(`url: ${JSON.stringify(address.href)}`)
  expect(source.content).toContain(`hosts: [${JSON.stringify(host)}]`)
  expect(source.content).toContain('["X-API-Key"]: "" + accounts.service.fields.token')
  const script = source.content.replace(/^import .*;\n/gmu, '').replace('export default ', '')
  expect(() => new NodeVM.Script(script)).not.toThrow()
  const manifest = files.find((file) => file.path === 'package.json')
  if (manifest === undefined) return expect.fail('Missing manifest')
  expect(manifest.content).toContain(`"apps":"${keyedAppsVersion}"`)
  expect(manifest.content).toContain(`"@modelcontextprotocol/sdk":"${keyedMcpVersion}"`)
  return undefined
})
