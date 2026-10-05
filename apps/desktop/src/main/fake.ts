import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import type { HelperCommand } from './helper.ts'

/**
 * How the tests start the stand-in helper (`fake.mjs`): with the Node that runs the test. It is
 * never bundled into the app; only test files import it.
 */
export const fakeHelper: HelperCommand = {
  command: NodeProcess.execPath,
  args: [NodeURL.fileURLToPath(new URL('./fake.mjs', import.meta.url))],
}
