import * as NodeChildProcess from 'node:child_process'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { Resource } from 'alchemy'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import * as RemovalPolicy from 'alchemy/RemovalPolicy'
import * as Output from 'alchemy/Output'
import * as Railway from '@alchemy.run/railway'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import type { InfrastructureEnvironment } from './env.ts'
import { fleetStorage, readPointer, type BucketStorage } from './pointer.ts'
import type { DeploymentTarget } from './targets.ts'

/**
 * celld deploy reads Worker bindings from config vars, never from its process environment.
 *
 * Every value is concrete. The vars enter celld's Worker version, which `CellWorker` computes here
 * and the pre-deploy step recomputes inside Railway; a Railway reference (`${{...}}`) would be
 * rendered on one side only, so the two versions would never match and every release would stop.
 */
export const cellVariables = (
  environment: InfrastructureEnvironment,
  serverUrl: string,
  environmentName: string,
) =>
  Redacted.make(
    JSON.stringify({
      VIVID_RUNTIME_TOKEN: Redacted.value(environment.runtimeToken),
      VIVID_SERVER_URL: serverUrl,
      VIVID_MODEL: environment.model,
      OPENCODE_API_KEY: Redacted.value(environment.openCodeKey),
      OPENROUTER_API_KEY: Redacted.value(environment.openRouterKey),
      // Learning in the cell asks Jev first; absent means the cell's own default, which is off.
      ...Option.match(environment.decisions, {
        onNone: () => ({}),
        onSome: (value) => ({ VIVID_DECISIONS: value }),
      }),
      // The cell reports its own failures to the server's Sentry project, under the deploy
      // target's stage, which is the Railway environment the server reports as.
      ...Option.match(environment.observability, {
        onNone: () => ({}),
        onSome: ({ dsn }) => ({
          SENTRY_DSN: dsn,
          VIVID_ENVIRONMENT: environmentName,
        }),
      }),
    }),
  )

/** Each service advertises its own address; celld owns membership, placement and node sessions. */
const nodes = [
  { id: 'CellsA', name: 'cells-a' },
  { id: 'CellsB', name: 'cells-b' },
] as const

/** Every node's private address: the server moves to the next one when a node cannot be reached. */
export const cellsUrl = nodes.map(({ name }) => `http://${name}.railway.internal:5173`).join(',')

/**
 * The Person-cell Worker the fleet must run. Its identity is celld's version: a deterministic hash
 * of the bundle and its vars (the same code and vars gave the same version twice; a changed var
 * changed it), computed by a dry run that writes nothing (`infra/cli.mjs build`).
 *
 * `vars` must be the server's `VIVID_CELL_VARS` exactly, because they enter the hash and the
 * pre-deploy step bundles with the server's copy. `storage` is the fleet bucket.
 */
interface CellWorkerProps {
  readonly vars: Redacted.Redacted
  readonly storage: BucketStorage
}

export type CellWorker = Resource<'Infra.CellWorker', CellWorkerProps, { version: string }>

/**
 * The Worker as a resource the stack can order and read back. It does not publish: publishing
 * must happen as close to the new server taking traffic as possible, which is the server's
 * pre-deploy step (`infra/predeploy.mjs`), after the build and before the start. So `reconcile`
 * only answers the version the release must carry (`Infra.Release` takes it as a prop, so it
 * orders after this), and `read` answers what the fleet pointer selects. A release whose publish
 * did not land therefore shows as drift here (`infra/drift.mjs`) instead of nowhere, which is how
 * the Worker of 30 October 2026 stayed in production for 59 deploys.
 */
export const CellWorker = Resource<CellWorker>('Infra.CellWorker')

/** celld could not bundle the Worker, so it has no version to compare or release. */
class CellWorkerUnbuilt extends Schema.TaggedError<CellWorkerUnbuilt>()(
  'CellWorkerUnbuilt',
  {
    message: Schema.String,
    /** The tag of the failure this one was made from, when it was caught rather than decided here. */
    cause: Schema.optionalKey(Schema.String),
  },
  { title: 'Cell Worker unbuilt' },
) {}

const cli = NodeURL.fileURLToPath(new URL('./cli.mjs', import.meta.url))
const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const execFile = NodeUtil.promisify(NodeChildProcess.execFile)
const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })),
)

/**
 * The version a publish of this checkout's Worker with `vars` would write. The vars travel in the
 * child's environment, never in argv; celld's diagnostics go to its stderr and the receipt is the
 * last line of stdout (`apps/cells/scripts/build.mjs`).
 */
const workerVersion = Effect.fn('Infra.CellWorker.version')(function* (vars: Redacted.Redacted) {
  const { stdout } = yield* Effect.tryPromise({
    try: () =>
      execFile(process.execPath, [cli, 'build'], {
        cwd: root,
        env: { ...process.env, VIVID_CELL_VARS: Redacted.value(vars) },
      }),
    catch: () => new CellWorkerUnbuilt({ message: 'celld could not bundle the Worker' }),
  })
  const receipt = yield* decodeReceipt(stdout.trim().split('\n').pop()).pipe(
    Effect.mapError(
      (error) =>
        new CellWorkerUnbuilt({
          message: 'celld printed no deployment receipt',
          cause: error._tag,
        }),
    ),
  )
  return receipt.version
})

/** Provider of `Infra.CellWorker`; it needs the HTTP client the Railway providers carry. */
export const CellWorkerProvider = Provider.succeed(CellWorker, {
  /** Only the code and vars decide the version, so storage outputs need not be known yet. */
  diff: Effect.fn(function* ({ news, output }) {
    if (output === undefined || !isResolved(news)) return undefined
    const version = yield* workerVersion(news.vars)
    return { action: version === output.version ? 'noop' : 'update' } as const
  }),
  reconcile: Effect.fn(function* ({ news }) {
    return { version: yield* workerVersion(news.vars) }
  }),
  /** What the fleet runs. No pointer yet reads as missing, so drift reports it. */
  read: Effect.fn(function* ({ olds }) {
    const selected = yield* readPointer(yield* fleetStorage(olds.storage))
    return Option.match(selected, {
      onNone: () => undefined,
      onSome: (version) => ({ version }),
    })
  }),
  /** The fleet keeps its Worker; a removed declaration must not unpublish production. */
  delete: () => Effect.void,
})

/**
 * Infrastructure owns storage and nodes. The server's pre-deploy step publishes the Worker.
 * The bucket is Railway's own, in the services' region, so a deploy needs no second cloud account:
 * celld only asks of it S3 conditional writes (`celld diagnose`, proved on 30 October 2026).
 */
export const railwayCells = Effect.fn('railwayCells')(function* (
  project: Railway.Project,
  target: DeploymentTarget,
) {
  const bucket = yield* Railway.Bucket('CellsStorage', {
    project,
    name: `${target.stackName}-cells`,
    region: 'ams',
  }).pipe(RemovalPolicy.retain())
  const storage = {
    CELLD_BUCKET: Output.map(bucket.s3BucketName, (name) => `s3://${name}`),
    S3_ENDPOINT: bucket.endpoint,
    AWS_REGION: bucket.s3Region,
    AWS_ACCESS_KEY_ID: bucket.accessKeyId,
    AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
  }
  for (const node of nodes) {
    const service = yield* Railway.Service(node.id, {
      project,
      name: node.name,
      image: 'ghcr.io/denoland/celld:v0.6.2',
      port: 5173,
      publicDomain: false,
      // Railway refuses a dotted path, and the Worker's own liveness answers without opening a cell.
      healthcheckPath: '/health',
      env: {
        ...storage,
        CELLD_ADDR: '[::]:5173',
        CELLD_INTERNAL_ADDR: '[::]:8081',
        CELLD_ADVERTISE: `${node.name}.railway.internal:8081`,
        CELLD_WATCH: '/var/lib/celld',
        // Unset, an idle cell leaves memory only under pressure or at the residency cap
        // (celld docs/README.md, "A resident cell"), so every opened Person stays loaded and
        // billed. Five quiet minutes hibernate it; its next request wakes it on the same node.
        CELLD_IDLE_EVICT_S: '300',
      },
    })
    yield* Railway.Volume(`${node.id}Data`, { project, service, mountPath: '/var/lib/celld' })
  }
  return storage
})
