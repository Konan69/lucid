import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeURL from 'node:url'
import { Config, Effect, Redacted, Schema } from 'effect'
import { applyEdits, modify } from 'jsonc-parser'

/** The config stays beside its source so native relative paths and dev watching keep their meaning. */
const config = new URL('../apps/cells/wrangler.jsonc', import.meta.url)
const privateConfig = new URL(`.env.celld-${NodeCrypto.randomUUID()}.json`, config)
const decodeVariables = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

/** Forward shutdown only to the child this invocation owns, then let the caller remove its config. */
async function run(command, args) {
  const child = NodeChildProcess.spawn(command, args, { stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const [code, signal] = await NodeEvents.once(child, 'exit')
    if (code !== 0) throw new Error(`Native cell command exited with ${signal ?? `code ${code}`}`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

/**
 * celld 0.6.2 accepts vars only in the deployed config. Keep credentials out of argv, tracked
 * files and stdout. Native deploy owns bundling, Text modules, manifests and the current pointer.
 */
export async function withPrivateConfig(command) {
  const variables = await Effect.runPromise(
    Config.Redacted('VIVID_CELL_VARS').pipe(
      Effect.flatMap((value) => decodeVariables(Redacted.value(value))),
      Effect.mapError(
        () => new Error('VIVID_CELL_VARS must encode a JSON object of string bindings'),
      ),
    ),
  )
  const source = await NodeFSP.readFile(config, 'utf8')
  const configured = applyEdits(source, modify(source, ['vars'], variables, {}))
  const cleanup = () => NodeFS.rmSync(privateConfig, { force: true })
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  try {
    await NodeFSP.writeFile(privateConfig, configured, { mode: 0o600, flag: 'wx' })
    return await command(NodeURL.fileURLToPath(privateConfig))
  } finally {
    cleanup()
    process.off('exit', cleanup)
    process.off('SIGINT', cleanup)
    process.off('SIGTERM', cleanup)
  }
}

/** Keep the local dev entry and explicit deploy entry on the same private-config lifecycle. */
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode !== 'dev' && mode !== 'deploy') throw new Error('Expected dev or deploy')
  await withPrivateConfig(async (path) => {
    if (mode === 'dev') {
      await run('celld', [mode, path, ...args])
      return
    }
    await run(process.execPath, [
      NodeURL.fileURLToPath(new URL('../apps/cells/scripts/build.mjs', import.meta.url)),
      'deploy',
      path,
      NodeURL.fileURLToPath(new URL('../.cache/cells-deployment.json', import.meta.url)),
      ...args,
    ])
  })
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    let reason = error instanceof Error ? error.message : String(error)
    for (const [name, value] of Object.entries(process.env))
      if (/KEY|TOKEN|SECRET|VARS/.test(name) && value)
        reason = reason.replaceAll(value, '[redacted]')
    process.stderr.write(`Native cell command failed: ${reason}\n`)
    process.exitCode = 1
  })
}
