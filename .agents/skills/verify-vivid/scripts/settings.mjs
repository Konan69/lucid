import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { parseEnv } from 'node:util'
import { boot } from './process.mjs'

/** These host identities are established over SSH from devbox-pick's allowed aliases. Refresh after replacement. */
const hosts = {
  'cloudbox-konan': 'box-node-a12c0c06aaf7d4a6',
  'cloudbox-konan2': 'box-node-0679eca2d05326b3',
  'cloudbox-konan3': 'box-node-b33a619732667f20',
}
export async function host() {
  const devbox = process.env.VIVID_VERIFY_DEVBOX
  if (!Object.hasOwn(hosts, devbox) || hosts[devbox] !== os.hostname())
    throw new Error(
      'Selected devbox does not match the actual host; production and unknown hosts refused',
    )
  return { devbox, hostBoot: boot, hostSelection: 'devbox-pick; SSH hostname verified' }
}

/** Credentials require an explicit file or environment; other tools' auth stores are never read. */
export async function provider() {
  const candidates = process.env.VIVID_VERIFY_KEY_FILE ? [process.env.VIVID_VERIFY_KEY_FILE] : []
  const names = ['EXPLABS_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY']
  const env = Object.fromEntries(
    names.flatMap((name) =>
      !candidates.length && process.env[name] ? [[name, process.env[name]]] : [],
    ),
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
  if (!env.EXPLABS_API_KEY)
    throw new Error(
      'EXPLABS_API_KEY is required by the real server memory and title model, including rehearsal runs',
    )
  return { model, source: sources.join(', ') || 'process environment', env }
}
