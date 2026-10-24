import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import { apk } from './apk.mjs'
import { command, json, root, checkout } from './process.mjs'
import { host } from './settings.mjs'

/** Warm the test APK before starting a server or emulator. Build receipts retain every spawned
 * command generation; the phone command later verifies and reuses the same bytes. */
export async function compile() {
  const selection = await host()
  const tree = await checkout()
  if (tree.dirty) throw new Error('APK build requires a clean committed checkout')
  const head = await command(['git', 'rev-parse', 'HEAD'])
  const evidence = root + '/.cache/android/' + head
  await NodeFSP.mkdir(evidence, { recursive: true })
  const commands = {}
  const record = async (process) => {
    commands[process.pid] = process
    await json(evidence + '/processes.json', commands)
  }
  const artifact = await apk({ head, evidence }, record)
  const result = { ...selection, hostname: NodeOS.hostname(), artifact, evidence }
  await json(evidence + '/result.json', result)
  console.log(JSON.stringify(result))
}

if (process.argv[1] === new URL(import.meta.url).pathname) await compile()
