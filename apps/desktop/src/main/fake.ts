import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as Option from 'effect/Option'
import type { ComputerCommand } from './computer.ts'

/**
 * How the tests start the stand-in Computer (`fake.mjs`): with the Node that runs the test. It is
 * never bundled into the app; only test files import it.
 */
export const fakeComputer: ComputerCommand = {
  engine: Option.none(),
  command: NodeProcess.execPath,
  args: [NodeURL.fileURLToPath(new URL('./fake.mjs', import.meta.url))],
}
