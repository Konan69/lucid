import * as NodeFSP from 'node:fs/promises'
import { expect, it } from 'vitest'

/** Review11c EX1: merge b3374201 lost a020c7be's single-entry host structure.
 * Keep this source audit beside the real TCP/faux-provider serve.test.ts proof. */
it('uses only the Promise package entry in the runnable host', async () => {
  const source = await NodeFSP.readFile(new URL('./serve.ts', import.meta.url), 'utf8')
  const imports = Array.from(
    source.matchAll(/from ['"](@vivid\/durable(?:\/[^'"]+)?)['"]/gu),
    (match) => match[1],
  )
  expect(imports).toEqual(['@vivid/durable'])
  expect(source).not.toContain('Effect.promise(() => route(')
})
