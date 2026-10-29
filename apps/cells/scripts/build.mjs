import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { Result, Schema } from 'effect'

const Deployment = Schema.Struct({
  worker: Schema.Literal('vivid-cells'),
  version: Schema.NonEmptyString,
  location: Schema.String,
  dry_run: Schema.Boolean,
})

const decodeDeployment = Schema.decodeUnknownResult(Schema.fromJsonString(Deployment))

/** Build and deployment share celld's bundler, while only deployment can publish to a bucket. */
async function bundle({ action, config, receipt, flags }) {
  const project = NodeURL.fileURLToPath(new URL('../', import.meta.url))
  const require = NodeModule.createRequire(project + 'package.json')
  const execute = NodeUtil.promisify(NodeChildProcess.execFile)
  const binary = 'celld'
  const version = await execute(binary, ['--version'])
  if (version.stdout.trim() !== 'celld 0.6.2')
    throw new Error(
      'celld 0.6.2 is required on PATH: curl -fsSL https://celld.dev/install.sh | CELLD_VERSION=v0.6.2 sh',
    )

  /** celld owns bundling and its deployment format. Dry runs retain only a build receipt;
   * deploy writes the actual modules and manifest to the selected fleet bucket. */
  // Stream diagnostics so a verbose deploy cannot exhaust execFile's stderr buffer and kill celld.
  const child = NodeChildProcess.spawn(
    binary,
    [
      'deploy',
      config ? NodePath.resolve(config) : project + 'wrangler.jsonc',
      '--json',
      ...(action === 'build' ? ['--dry-run'] : flags),
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        CELLD_ESBUILD: NodePath.join(
          NodePath.dirname(require.resolve('esbuild/package.json')),
          'bin/esbuild',
        ),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const [code, signal] = await NodeEvents.once(child, 'close')
    if (code !== 0) throw new Error(`celld exited with ${signal ?? `code ${code}`}`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
  const output = Result.getOrThrow(decodeDeployment(Buffer.concat(chunks).toString('utf8')))
  if (output.dry_run !== (action === 'build'))
    throw new Error('Unexpected native cell deployment receipt')
  const destination = receipt ? NodePath.resolve(receipt) : project + 'dist/deployment.json'
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true })
  await NodeFSP.writeFile(destination, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(output))
}

/** Railway supplies private bindings through its own variables before the server takes traffic. */
async function main() {
  const [action = 'build', config, receipt, ...flags] = process.argv.slice(2)
  if (!['build', 'deploy'].includes(action)) throw new Error('Expected build or deploy')
  if (action === 'deploy' && !config) {
    // The infrastructure CLI owns the private config, then re-enters with explicit file paths.
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL('../../../infra/cli.mjs', import.meta.url)), 'deploy'],
      { stdio: 'inherit' },
    )
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    try {
      const [code, signal] = await NodeEvents.once(child, 'close')
      if (code !== 0) throw new Error(`Worker deployment exited with ${signal ?? `code ${code}`}`)
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    return
  }
  await bundle({ action, config, receipt, flags })
}

await main()
