import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
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
    const [code] = await NodeEvents.once(child, 'exit')
    if (code !== 0) throw new Error('celld exited unsuccessfully')
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

/**
 * celld 0.6.2 accepts vars only in the deployed config. Keep credentials out of argv, tracked
 * files and stdout. Native deploy owns bundling, Text modules, manifests and the current pointer.
 */
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode !== 'dev' && mode !== 'deploy') throw new Error('Expected dev or deploy')
  const variables = await Effect.runPromise(
    Config.Redacted('VIVID_CELL_VARS').pipe(
      Effect.flatMap((value) => decodeVariables(Redacted.value(value))),
    ),
  )
  const source = await NodeFSP.readFile(config, 'utf8')
  const configured = applyEdits(source, modify(source, ['vars'], variables, {}))
  await NodeFSP.writeFile(privateConfig, configured, { mode: 0o600, flag: 'wx' })
  try {
    if (mode === 'dev') {
      await run('celld', [mode, NodeURL.fileURLToPath(privateConfig), ...args])
      return
    }
    await run(process.execPath, [
      NodeURL.fileURLToPath(new URL('../apps/cells/scripts/build.mjs', import.meta.url)),
      'deploy',
      NodeURL.fileURLToPath(privateConfig),
      NodeURL.fileURLToPath(new URL('../.cache/cells-deployment.json', import.meta.url)),
      ...args,
    ])
  } finally {
    await NodeFSP.rm(privateConfig)
  }
}

await main().catch(() => {
  process.stderr.write('Native cell command failed. Check celld diagnostics and configuration.\n')
  process.exitCode = 1
})
