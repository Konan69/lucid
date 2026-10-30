import * as RemovalPolicy from 'alchemy/RemovalPolicy'
import * as Output from 'alchemy/Output'
import * as Railway from 'alchemy/Railway'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import type { InfrastructureEnvironment } from './env.ts'
import type { DeploymentTarget } from './targets.ts'

/** celld deploy reads Worker bindings from config vars, never from its process environment. */
export const cellVariables = (environment: InfrastructureEnvironment, serverUrl: string) =>
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
      },
    })
    yield* Railway.Volume(`${node.id}Data`, { project, service, mountPath: '/var/lib/celld' })
  }
  return storage
})
