import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { parseEnv } from 'node:util'
import { boot } from './process.mjs'

export const authSecret = 'Verify-Auth!0123456789-ABCDefghijklmnop'

import { hosts, pc } from './hosts.mjs'

/** One host is selected explicitly: VIVID_VERIFY_HOST=pc or a devbox-pick alias in
 * VIVID_VERIFY_DEVBOX. Each is checked against a stable identity; production and unknown hosts
 * are refused. `devbox` stays the selected alias that phone and doctor receipts compare. */
export async function host() {
  if (process.env.VIVID_VERIFY_HOST !== undefined) return pcHost()
  const devbox = process.env.VIVID_VERIFY_DEVBOX
  if (!Object.hasOwn(hosts, devbox) || hosts[devbox] !== process.env.BOAT_ID)
    throw new Error(
      'Selected devbox does not match this Boat sandbox; production and unknown hosts refused',
    )
  return {
    hostKind: 'devbox',
    devbox,
    sandbox: process.env.BOAT_ID,
    hostname: os.hostname(),
    hostBoot: boot,
    hostSelection: 'devbox-pick; Boat sandbox id verified',
  }
}

/** A Boat sandbox never passes as the PC, even if its disk was forked from one. */
async function pcHost() {
  if (process.env.VIVID_VERIFY_HOST !== pc.alias || process.env.VIVID_VERIFY_DEVBOX !== undefined)
    throw new Error('Set VIVID_VERIFY_HOST=pc alone, or VIVID_VERIFY_DEVBOX alone')
  if (process.env.BOAT_ID !== undefined) throw new Error('PC host mode refused on a Boat sandbox')
  const release = await fs.readFile('/proc/sys/kernel/osrelease', 'utf8')
  const machineId = (await fs.readFile('/etc/machine-id', 'utf8')).trim()
  if (!release.includes('microsoft-standard-WSL2') || machineId !== pc.machineId)
    throw new Error('This machine is not the registered PC; unknown hosts refused')
  return {
    hostKind: 'pc',
    devbox: pc.alias,
    machineId,
    hostname: os.hostname(),
    hostBoot: boot,
    hostSelection: 'VIVID_VERIFY_HOST=pc; WSL machine id verified',
  }
}

/** Child commands re-run host(); they inherit the run's own selection, not the caller's shell. */
export function selection(state) {
  return state.hostKind === 'pc'
    ? { VIVID_VERIFY_HOST: pc.alias, VIVID_VERIFY_DEVBOX: undefined }
    : { VIVID_VERIFY_DEVBOX: state.devbox, VIVID_VERIFY_HOST: undefined }
}

/** Credentials require an explicit file or environment; other tools' auth stores are never read. */
export async function provider() {
  const candidates = process.env.VIVID_VERIFY_KEY_FILE ? [process.env.VIVID_VERIFY_KEY_FILE] : []
  const names = ['EXPLABS_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY']
  const env = Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  )
  const sources = []
  for (const file of new Set(candidates)) {
    const text = await fs.readFile(file, 'utf8')
    const parsed = parseEnv(text)
    for (const name of names)
      if (!env[name] && parsed[name]) {
        env[name] = parsed[name]
        sources.push(file)
      }
  }
  const model =
    process.env.VIVID_VERIFY_MODEL ??
    (env.OPENCODE_API_KEY
      ? 'opencode-go/glm-5.3-flash'
      : env.EXPLABS_API_KEY
        ? 'explabs/glm-5.3-flash'
        : env.OPENROUTER_API_KEY
          ? 'openrouter/z-ai/glm-5.3-flash'
          : null)
  if (!model)
    throw new Error(
      'No model credentials. Set VIVID_VERIFY_KEY_FILE or explicit provider environment variables; rehearsal requires VIVID_VERIFY_MODEL=rehearsal/script',
    )
  const key = model.startsWith('explabs/')
    ? 'EXPLABS_API_KEY'
    : model.startsWith('openrouter/')
      ? 'OPENROUTER_API_KEY'
      : 'OPENCODE_API_KEY'
  if (!model.startsWith('rehearsal/') && !env[key])
    throw new Error('Missing provider key for selected model')
  if (!env.EXPLABS_API_KEY && !env.OPENROUTER_API_KEY)
    throw new Error(
      'EXPLABS_API_KEY or OPENROUTER_API_KEY is required by the server memory and title model, including rehearsal runs',
    )
  env.VIVID_SERVER_MODEL_PROVIDER = env.EXPLABS_API_KEY ? 'explabs' : 'openrouter'
  return { model, source: sources.join(', ') || 'process environment', env }
}
