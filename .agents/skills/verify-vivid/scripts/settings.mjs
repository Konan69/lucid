import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { parseEnv } from 'node:util'
import { boot } from './process.mjs'

export const authSecret = 'Verify-Auth!0123456789-ABCDefghijklmnop'

import { hosts } from './hosts.mjs'
export async function host() {
  const devbox = process.env.VIVID_VERIFY_DEVBOX
  if (!Object.hasOwn(hosts, devbox) || hosts[devbox] !== process.env.BOAT_ID)
    throw new Error(
      'Selected devbox does not match this Boat sandbox; production and unknown hosts refused',
    )
  return {
    devbox,
    sandbox: process.env.BOAT_ID,
    hostname: os.hostname(),
    hostBoot: boot,
    hostSelection: 'devbox-pick; Boat sandbox id verified',
  }
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
  if (!env.OPENROUTER_API_KEY)
    throw new Error(
      'OPENROUTER_API_KEY is required by the server title model, including rehearsal runs',
    )
  return { model, source: sources.join(', ') || 'process environment', env }
}
