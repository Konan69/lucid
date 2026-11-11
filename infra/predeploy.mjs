import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { Effect, Option, Redacted, Result, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { readPointer } from './pointer.ts'

/**
 * The server's pre-deploy step, as one program with no shell (`preDeploy.command` in
 * `infra/railway.ts` is `node infra/predeploy.mjs`). Railway runs it in the freshly built image,
 * on the private network, with the service's variables, after the build and before the new
 * deployment takes traffic; a non-zero exit keeps the previous deployment serving and fails the
 * release (Railway, "Pre-deploy command").
 *
 * It replaced `migrate && sentry-upload && build.mjs deploy`. That chain's last step never ran in
 * 59 deploys from 30 October 2026, the fleet kept a Worker that refused every send, and nothing
 * read the result back. Here every step prints `predeploy: <step> ok <evidence>` or exits 1 with
 * `predeploy: <step> failed: <reason>`, and the Worker step reads the fleet pointer back.
 *
 * Steps, in order:
 * 1. `migrate`: auth tables, then product tables (`scripts/migrate.mjs`).
 * 2. `maps`: source maps of the web app and the phone update to Sentry. Required whenever Sentry is
 *    configured (`SENTRY_DSN` set); with Sentry off the step says so and moves on. The image build
 *    has already stamped the debug IDs (`apps/server/Dockerfile`), because files this step writes
 *    are gone when it ends.
 * 3. `worker`: the Worker version Alchemy computed (`VIVID_CELL_WORKER_VERSION`, set by the stack
 *    from `Infra.CellWorker`) must equal what this image bundles with these vars; then the pointer
 *    is read and, unless it already selects that version, the Worker is published and the pointer
 *    read again. A rerun after a partial failure therefore converges without a second publish.
 */
const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const receipt = new URL('../apps/cells/dist/deployment.json', import.meta.url)
const decodeReceipt = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })),
)

/** Runs one child with this process's environment and output; a non-zero exit fails the step. */
async function run(args, environment = NodeProcess.env) {
  const child = NodeChildProcess.spawn(NodeProcess.execPath, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  })
  const [code, signal] = await NodeEvents.once(child, 'exit')
  if (code !== 0) throw new Error(`${args[0]} exited with ${signal ?? `code ${code}`}`)
}

/** The version celld wrote to its receipt for the last `infra/cli.mjs build` or `deploy`. */
/** The fleet storage as celld reads it from this process's environment (`FleetStorage`). */
function storageFromEnvironment() {
  const names = [
    'CELLD_BUCKET',
    'S3_ENDPOINT',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ]
  const missing = names.filter((name) => !NodeProcess.env[name])
  if (missing.length > 0) throw new Error(`fleet storage settings missing: ${missing.join(', ')}`)
  return {
    bucket: NodeProcess.env.CELLD_BUCKET,
    endpoint: NodeProcess.env.S3_ENDPOINT,
    region: NodeProcess.env.AWS_REGION,
    accessKeyId: Redacted.make(NodeProcess.env.AWS_ACCESS_KEY_ID),
    secretAccessKey: Redacted.make(NodeProcess.env.AWS_SECRET_ACCESS_KEY),
  }
}

/** The version the fleet selects, or null; the program's edge, so the Effect runs here. */
async function selected(storage) {
  // oxlint-disable-next-line vivid/no-runpromise-in-library
  const pointer = await Effect.runPromise(
    readPointer(storage).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((error) => new Error(`the fleet pointer is unreadable: ${error.reason}`)),
    ),
  )
  return Option.getOrNull(pointer)
}

async function receiptVersion() {
  const decoded = decodeReceipt(await NodeFSP.readFile(receipt, 'utf8'))
  if (Result.isFailure(decoded)) throw new Error('the cell receipt is not a celld receipt')
  return decoded.success.version
}

const migrate = async () => {
  await run(['scripts/migrate.mjs', 'server'])
  return 'auth and product migrations applied'
}

const maps = async () => {
  if (!NodeProcess.env.SENTRY_DSN) return 'skipped: Sentry is not configured (no SENTRY_DSN)'
  await run(['scripts/sentry-upload.mjs', '--required', 'vivid-web', 'apps/web/dist'])
  await run(['scripts/sentry-upload.mjs', '--required', 'vivid-mobile', 'apps/mobile/updates'])
  return 'vivid-web and vivid-mobile maps uploaded'
}

const worker = async () => {
  const expected = NodeProcess.env.VIVID_CELL_WORKER_VERSION
  if (!expected) throw new Error('VIVID_CELL_WORKER_VERSION is not set by the stack')
  const storage = storageFromEnvironment()
  await run(['infra/cli.mjs', 'build'])
  const built = await receiptVersion()
  if (built !== expected)
    throw new Error(
      `this image bundles Worker ${built}, the stack expected ${expected}: the bundle or its vars differ between the deploying machine and the image`,
    )
  if ((await selected(storage)) === expected) return `${expected} already selected by the fleet`
  await run(['infra/cli.mjs', 'deploy'])
  const published = await receiptVersion()
  const current = await selected(storage)
  if (published !== expected || current !== expected)
    throw new Error(
      `published ${published}, the fleet pointer selects ${current ?? 'nothing'}, expected ${expected}`,
    )
  return `${expected} published and selected by the fleet`
}

/**
 * Read-back evidence each step must return before the following step can run. Exported for the
 * policy check that reads this table from source (`scripts/gate/readback.mjs`).
 * @public
 */
export const predeploySteps = [
  { name: 'migrate', step: migrate, readBack: 'Drizzle auth and product migration journal' },
  { name: 'maps', step: maps, readBack: 'Sentry CLI upload receipt for each project' },
  { name: 'worker', step: worker, readBack: 'fleet pointer equals the expected Worker version' },
]

for (const { name, step } of predeploySteps) {
  // The step's own reason, or the bare fact that it failed: a thrown value is never printed whole.
  const outcome = await step().then(
    (evidence) => ({ ok: true, evidence }),
    (error) => ({
      ok: false,
      evidence: error instanceof Error ? error.message : 'failed without a reason',
    }),
  )
  if (!outcome.ok) {
    NodeProcess.stderr.write(`predeploy: ${name} failed: ${outcome.evidence}\n`)
    NodeProcess.exit(1)
  }
  NodeProcess.stdout.write(`predeploy: ${name} ok ${outcome.evidence}\n`)
}
NodeProcess.stdout.write('predeploy: done\n')
