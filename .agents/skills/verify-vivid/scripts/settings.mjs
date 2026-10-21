import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseEnv } from 'node:util'
import { root, command, boot } from './process.mjs'

/** These host identities are established over SSH from devbox-pick's allowed aliases. Refresh after replacement. */
const hosts = {
  'cloudbox-konan': 'box-node-a12c0c06aaf7d4a6',
  'cloudbox-konan2': 'box-node-c59a06f7f0a631f1',
  'cloudbox-konan3': 'box-node-b33a619732667f20',
}
export async function host() {
  const devbox = process.env.VIVID_VERIFY_DEVBOX
  if (devbox === 'local') {
    if (os.hostname() !== 'Konan')
      throw new Error('Local fallback is allowed only on the known developer PC')
    await fs.access(os.homedir() + '/bin/devbox-pick')
    try {
      await command([os.homedir() + '/bin/devbox-pick'])
    } catch (error) {
      if (!error.message.includes('no devbox reachable')) throw error
      return { devbox, hostBoot: boot, hostSelection: 'no devbox reachable' }
    }
    throw new Error('A devbox is reachable; local verification refused')
  }
  if (!Object.hasOwn(hosts, devbox) || hosts[devbox] !== os.hostname())
    throw new Error(
      'Selected devbox does not match the actual host; production and unknown hosts refused',
    )
  return { devbox, hostBoot: boot, hostSelection: 'devbox-pick; SSH hostname verified' }
}

/** Read only provider keys, never a database URL or Computer authority from an application env. */
export async function provider() {
  const common = await command(['git', 'rev-parse', '--git-common-dir'])
  const candidates = process.env.VIVID_VERIFY_KEY_FILE
    ? [process.env.VIVID_VERIFY_KEY_FILE]
    : [
        root + '/.env',
        path.resolve(root, common, '..', '.env'),
        os.homedir() + '/.config/vivid/verify.env',
      ]
  const names = ['EXPLABS_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY']
  const env = Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  )
  const sources = []
  for (const file of new Set(candidates)) {
    const text = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const parsed = parseEnv(text)
    for (const name of names)
      if (!env[name] && parsed[name]) {
        env[name] = parsed[name]
        sources.push(file)
      }
  }
  const model =
    process.env.VIVID_VERIFY_MODEL ??
    (env.EXPLABS_API_KEY
      ? 'explabs/glm-5.3-flash'
      : env.OPENCODE_API_KEY
        ? 'opencode-go/glm-5.3-flash'
        : env.OPENROUTER_API_KEY
          ? 'openrouter/z-ai/glm-5.3-flash'
          : 'rehearsal/script')
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
