import { Result } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { readAccount } from './phonewire.mjs'

/** Re-snapshot before every interaction. Refs are selected from the current accessibility tree,
 * never remembered across a transition or guessed from screen coordinates. */
export async function target(run, label) {
  await run(['wait', 'text', label, '60000'])
  const snapshot = await run(['snapshot', '-i'])
  const lines = snapshot
    .split('\n')
    .filter((line) => line.includes(label) && /@e\d+ \[(button|text-field)\]/u.test(line))
  NodeAssert.equal(lines.length, 1, 'Expected one interactive ref for ' + label + '\n' + snapshot)
  return lines[0].match(/@e\d+/u)[0]
}

/** The ordinary email controls authenticate the same disposable Person the public proof uses.
 * agent-device state stays private because its journal can include synthetic form values. */
export async function enter(state, run) {
  const account = Result.getOrThrow(
    readAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  await run(['press', await target(run, 'Log in')])
  // Android's interactive snapshot names the input by its visible placeholder.
  await run(['fill', await target(run, 'name@example.com'), account.email])
  await run(['press', await target(run, 'Continue')])
  await run(['fill', await target(run, 'Password'), account.password], [account.password])
  await run(['press', await target(run, 'Sign in')])
  await run(['wait', 'text', 'Open menu', '60000'])
  return account
}
