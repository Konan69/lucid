import * as Cloudflare from 'alchemy/Cloudflare'
import * as Command from 'alchemy/Command'
import * as Output from 'alchemy/Output'
import * as Railway from 'alchemy/Railway'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import { requiredSecret, type InfrastructureEnvironment } from './env.ts'
import type { DeploymentTarget } from './targets.ts'

/** celld deploy reads Worker bindings from config vars, never from its process environment. */
export const cellVariables = (environment: InfrastructureEnvironment, serverUrl: string) =>
  Redacted.make(
    JSON.stringify({
      VIVID_RUNTIME_TOKEN: Redacted.value(environment.runtimeToken),
      VIVID_SERVER_URL: serverUrl,
      VIVID_MODEL: environment.model,
      OPENCODE_API_KEY: Redacted.value(environment.openCodeKey),
      EXPLABS_API_KEY: Redacted.value(environment.modelGatewayKey),
      ...Option.match(environment.openRouterKey, {
        onNone: () => ({}),
        onSome: (key) => ({ OPENROUTER_API_KEY: Redacted.value(key) }),
      }),
    }),
  )

/** Each service advertises its own address; celld owns membership, placement and node sessions. */
const nodes = [
  { id: 'CellsA', name: 'cells-a' },
  { id: 'CellsB', name: 'cells-b' },
] as const

export const cellsUrl = 'http://cells-a.railway.internal:5173'

/**
 * Native deployments precede the first node start. Mapping the deployment dependency to the
 * unchanged bucket URI orders creation without restarting nodes when only the Worker changes.
 * Alchemy beta.81 owns R2, Railway and the finite native deploy command.
 */
export const railwayCells = Effect.fn('railwayCells')(function* (
  project: Railway.Project,
  target: DeploymentTarget,
  environment: InfrastructureEnvironment,
) {
  const accessKey = yield* requiredSecret('VIVID_CELLS_ACCESS_KEY_ID')
  const secretKey = yield* requiredSecret('VIVID_CELLS_SECRET_ACCESS_KEY')
  const bucket = yield* Cloudflare.R2.Bucket('CellsStorage', { name: `${target.stackName}-cells` })
  const storage = {
    CELLD_BUCKET: Output.map(bucket.bucketName, (name) => `s3://${name}`),
    S3_ENDPOINT: Output.map(bucket.accountId, (id) => `https://${id}.r2.cloudflarestorage.com`),
    AWS_REGION: 'auto',
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
  }
  /** Qualify storage on first use or changed credentials, independently of Worker source updates. */
  const diagnosis = yield* Command.Exec('CellsStorageCheck', {
    command: 'celld diagnose --json',
    cwd: '.',
    env: storage,
    memo: { include: [], lockfile: false },
  })
  const program = yield* Command.Exec('CellsProgram', {
    command: 'pnpm --filter @vivid/cells exec node ../../infra/cli.mjs deploy',
    cwd: '.',
    env: {
      ...storage,
      CELLD_BUCKET: Output.all(bucket.bucketName, diagnosis.hash.input).pipe(
        Output.map(([name]) => `s3://${name}`),
      ),
      VIVID_CELL_VARS: cellVariables(environment, 'http://vivid-server.railway.internal:8787'),
    },
    memo: {
      include: [
        'apps/cells/**',
        'packages/agent/runtime/**',
        'packages/agent/skills/**',
        'packages/contracts/**',
        'infra/cli.mjs',
        'tsconfig.base.json',
      ],
      lockfile: true,
    },
  })
  const deployedBucket = Output.all(bucket.bucketName, program.hash.input).pipe(
    Output.map(([name]) => `s3://${name}`),
  )
  for (const node of nodes) {
    const service = yield* Railway.Service(node.id, {
      project,
      name: node.name,
      image: 'ghcr.io/denoland/celld:v0.6.2',
      port: 5173,
      publicDomain: false,
      healthcheckPath: '/.well-known/celld/health',
      env: {
        ...storage,
        CELLD_BUCKET: deployedBucket,
        CELLD_ADDR: '[::]:5173',
        CELLD_INTERNAL_ADDR: '[::]:8081',
        CELLD_ADVERTISE: `${node.name}.railway.internal:8081`,
        CELLD_WATCH: '/var/lib/celld',
      },
    })
    yield* Railway.Volume(`${node.id}Data`, { project, service, mountPath: '/var/lib/celld' })
  }
})
