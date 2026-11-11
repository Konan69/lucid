import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Resource } from 'alchemy'
import { isResolved } from 'alchemy/Diff'
import * as Provider from 'alchemy/Provider'
import { RailwayEnvironment } from 'alchemy/Railway'
import * as Arr from 'effect/Array'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { fleetStorage, readPointer, type BucketStorage } from './pointer.ts'

const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))

/** The commit this checkout is at: what a release asks Railway to build (`releaseSource`). */
const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })

/**
 * The commit to release and the hash of every tracked file the server image is built from, at that
 * commit. `patterns` are the server's Railway watch paths (`serverInputs` in `infra/railway.ts`,
 * gitignore-style from the root); the hash takes git's blob ids, so it is the commit's content and
 * not the working tree's. It is the release's identity: a push that changes none of these files
 * plans `noop` and builds nothing, which is what the watch paths did when Railway deployed by itself.
 */
export const releaseSource = (patterns: ReadonlyArray<string>) => {
  const commit = git(['rev-parse', 'HEAD']).trim()
  const globs = patterns.map((pattern) => pattern.replace(/^\//, ''))
  const files = git(['ls-tree', '-r', '--full-tree', commit])
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
    .filter(([, path = '']) => globs.some((glob) => NodePath.matchesGlob(path, glob)))
    .map(([entry = '', path = '']) => `${entry.split(' ')[2]} ${path}`)
  const inputs = NodeCrypto.createHash('sha256').update(files.join('\n')).digest('hex')
  return { commit, inputs }
}

/**
 * One deployment of the server, of one commit, that Alchemy asked for and waited on. Railway's own
 * trigger is off for this service (`autoUpdates: false` in `infra/railway.ts`), so this is the
 * only way code reaches production, and a deploy that fails fails `alchemy deploy`.
 *
 * - `serviceId`, `environmentId` and `url` are the server `Railway.Service`'s outputs.
 * - `commit` and `inputs` come from `releaseSource`; only `inputs` and `cellWorkerVersion` decide
 *   whether a release is due.
 * - `cellWorkerVersion` is `Infra.CellWorker`'s version, and `versionVariable` the digest of the
 *   `VIVID_CELL_WORKER_VERSION` variable that carries it to the pre-deploy step; taking both as
 *   props orders this release after them.
 * - `storage` is the fleet bucket, for reading the pointer back.
 */
export interface ReleaseProps {
  readonly projectId: string
  readonly serviceId: string
  readonly environmentId: string
  readonly url?: string
  readonly commit: string
  readonly inputs: string
  readonly cellWorkerVersion: string
  readonly versionVariable: string
  readonly storage: BucketStorage
  readonly timeoutMinutes: number
}

/**
 * What the live deployment says about itself (`meta.serviceManifest.deploy` is what actually ran,
 * not what the service settings say now), plus the fleet's Worker. `read` answers the same shape
 * from Railway and the bucket, so a deploy Alchemy did not make, an edited start or pre-deploy
 * command, or a Worker that did not publish is drift (`infra/drift.mjs`). `inputs` is the one value
 * that cannot be observed and is carried from state.
 */
export interface ReleaseAttributes {
  readonly deploymentId: string
  readonly status: string
  readonly commit: string | null
  readonly inputs: string
  readonly cellWorkerVersion: string | null
  readonly preDeployCommand: ReadonlyArray<string> | null
  readonly startCommand: string | null
  readonly healthcheckPath: string | null
  readonly variables: Readonly<Record<string, string>>
}

export type Release = Resource<'Infra.Release', ReleaseProps, ReleaseAttributes>

export const Release = Resource<Release>('Infra.Release')

/** Railway's GraphQL API refused or could not be read; `operation` names which call. */
class ReleaseRefused extends Schema.TaggedError<ReleaseRefused>()(
  'ReleaseRefused',
  {
    operation: Schema.String,
    message: Schema.String,
    /** The tag of the failure this one was made from, when it was caught rather than decided here. */
    cause: Schema.optionalKey(Schema.String),
  },
  { title: 'Release refused' },
) {}

/** The deployment ended without serving: its status and the end of its logs. */
class ReleaseFailed extends Schema.TaggedError<ReleaseFailed>()(
  'ReleaseFailed',
  { deploymentId: Schema.String, status: Schema.String, logs: Schema.String },
  { title: 'Release failed' },
) {
  override get message() {
    return `Deployment ${this.deploymentId} ended ${this.status}:\n${this.logs}`
  }
}

/** The deployment was still not serving when the release's budget ran out. */
class ReleaseTimedOut extends Schema.TaggedError<ReleaseTimedOut>()(
  'ReleaseTimedOut',
  { deploymentId: Schema.String, minutes: Schema.Finite },
  { title: 'Release timed out' },
) {}

/** The deployment reports success, but a read from outside disagrees with what was released. */
class ReleaseUnverified extends Schema.TaggedError<ReleaseUnverified>()(
  'ReleaseUnverified',
  {
    check: Schema.Literals(['health', 'commit', 'worker'] as const),
    message: Schema.String,
    /** The tag of the failure this one was made from, when it was caught rather than decided here. */
    cause: Schema.optionalKey(Schema.String),
  },
  { title: 'Release unverified' },
) {}

const Status = Schema.Literals([
  'BUILDING',
  'CRASHED',
  'DEPLOYING',
  'FAILED',
  'INITIALIZING',
  'NEEDS_APPROVAL',
  'QUEUED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
  'SUCCESS',
  'WAITING',
] as const)
type Status = typeof Status.Type

/** Still on its way to serving or failing; anything else has ended. */
const inProgress = new Set<Status>(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING'])

/** The deployment fields a release reads; `meta` is Railway's JSON scalar. */
const Deployment = Schema.Struct({
  id: Schema.String,
  status: Status,
  meta: Schema.Struct({
    commitHash: Schema.OptionFromOptionalKey(Schema.String),
    serviceManifest: Schema.Struct({
      deploy: Schema.Struct({
        preDeployCommand: Schema.NullOr(Schema.Array(Schema.String)),
        startCommand: Schema.NullOr(Schema.String),
        healthcheckPath: Schema.NullOr(Schema.String),
      }),
    }),
  }),
})
type Deployment = typeof Deployment.Type

const deploymentFields = 'id status meta'

/** A GraphQL answer: the operation's `data`, or `errors` with Railway's messages. */
interface Answer<A> {
  readonly data: A | null
  readonly errors?: ReadonlyArray<{ readonly message: string }>
}

/** The answer decoder of one operation, compiled once at module scope. */
const answer = <A, I>(data: Schema.Codec<A, I>) =>
  Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.NullOr(data),
        errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
      }),
    ),
  )

const LogLines = Schema.Array(Schema.Struct({ message: Schema.String }))
const answers = {
  serviceInstance: answer(
    Schema.Struct({
      serviceInstance: Schema.Struct({ latestDeployment: Schema.NullOr(Deployment) }),
    }),
  ),
  deployment: answer(Schema.Struct({ deployment: Deployment })),
  variables: answer(Schema.Struct({ variables: Schema.Record(Schema.String, Schema.String) })),
  deploy: answer(Schema.Struct({ serviceInstanceDeployV2: Schema.String })),
  cancel: answer(Schema.Struct({ deploymentCancel: Schema.Boolean })),
  buildLogs: answer(Schema.Struct({ buildLogs: LogLines })),
  deploymentLogs: answer(Schema.Struct({ deploymentLogs: LogLines })),
}

/**
 * One call to Railway's public GraphQL API with the credential Alchemy's Railway providers resolved
 * (`RailwayEnvironment`, `alchemy/src/Railway/Environment.ts`). An account token goes as a bearer
 * token and a project token in its own header (`@distilled.cloud/railway` `credentials.ts`).
 */
const railway = <A>(
  operation: string,
  query: string,
  variables: Record<string, string>,
  decode: (body: string) => Effect.Effect<Answer<A>, Schema.SchemaError>,
) =>
  Effect.gen(function* () {
    const credentials = yield* yield* RailwayEnvironment
    const token = Redacted.value(credentials.token).trim()
    const client = yield* HttpClient.HttpClient
    const refused = (message: string) => new ReleaseRefused({ operation, message })
    const refusedBy = (error: { readonly _tag: string }, message: string) =>
      new ReleaseRefused({ operation, message, cause: error._tag })
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${credentials.apiBaseUrl.replace(/\/$/, '')}/graphql/v2`).pipe(
          HttpClientRequest.setHeaders(
            credentials.tokenKind === 'project'
              ? { 'Project-Access-Token': token }
              : { authorization: `Bearer ${token}` },
          ),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(Effect.mapError((error) => refusedBy(error, 'the request failed')))
    const body = yield* response.text.pipe(
      Effect.mapError((error) => refusedBy(error, 'no response body')),
    )
    const answered = yield* decode(body).pipe(
      Effect.mapError((error) => refusedBy(error, `unexpected answer, HTTP ${response.status}`)),
    )
    if (answered.errors !== undefined || answered.data === null)
      return yield* refused(
        answered.errors === undefined
          ? 'no data'
          : answered.errors.map((error) => error.message).join('; '),
      )
    return answered.data
  })

const latestDeployment = (serviceId: string, environmentId: string) =>
  railway(
    'serviceInstance',
    `query($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { latestDeployment { ${deploymentFields} } } }`,
    { environmentId, serviceId },
    answers.serviceInstance,
  ).pipe(Effect.map((data) => data.serviceInstance.latestDeployment))

const deployment = (id: string) =>
  railway(
    'deployment',
    `query($id: String!) { deployment(id: $id) { ${deploymentFields} } }`,
    { id },
    answers.deployment,
  ).pipe(Effect.map((data) => data.deployment))

/**
 * Read stored references rather than rendered values, just as Railway.Service.syncEnv does.
 * Only variable names and SHA-256 digests leave this boundary; plaintext never enters attributes.
 */
const variableDigests = Effect.fn('Infra.Release.variables')(function* (props: ReleaseProps) {
  const { variables } = yield* railway(
    'variables',
    'query($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }',
    { projectId: props.projectId, environmentId: props.environmentId, serviceId: props.serviceId },
    answers.variables,
  )
  return Object.fromEntries(
    Arr.sort(
      Object.entries(variables),
      Order.mapInput(Order.String, ([name]: readonly [string, string]) => name),
    ).map(([name, value]) => [name, NodeCrypto.createHash('sha256').update(value).digest('hex')]),
  )
})

/** The last lines a failed deployment wrote, build and deploy, for the deploy log. */
const failureLogs = Effect.fn('Infra.Release.logs')(function* (deploymentId: string) {
  const build = yield* railway(
    'buildLogs',
    'query($deploymentId: String!) { buildLogs(deploymentId: $deploymentId, limit: 100) { message } }',
    { deploymentId },
    answers.buildLogs,
  )
  const run = yield* railway(
    'deploymentLogs',
    'query($deploymentId: String!) { deploymentLogs(deploymentId: $deploymentId, limit: 100) { message } }',
    { deploymentId },
    answers.deploymentLogs,
  )
  return [...build.buildLogs, ...run.deploymentLogs].map((line) => line.message).join('\n')
})

/** Waits for one deployment to end, polling Railway, which has no push channel for it. */
const settled = Effect.fn('Infra.Release.settled')(function* (id: string, minutes: number) {
  return yield* deployment(id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced('10 seconds'),
      while: (current) => inProgress.has(current.status),
    }),
    Effect.timeoutOrElse({
      duration: Duration.minutes(minutes),
      orElse: () => Effect.fail(new ReleaseTimedOut({ deploymentId: id, minutes })),
    }),
  )
})

const attributes = (
  live: Deployment,
  inputs: string,
  worker: Option.Option<string>,
  variables: ReleaseAttributes['variables'],
): ReleaseAttributes => ({
  variables,
  deploymentId: live.id,
  status: live.status,
  commit: Option.getOrNull(live.meta.commitHash),
  inputs,
  cellWorkerVersion: Option.getOrNull(worker),
  preDeployCommand: live.meta.serviceManifest.deploy.preDeployCommand,
  startCommand: live.meta.serviceManifest.deploy.startCommand,
  healthcheckPath: live.meta.serviceManifest.deploy.healthcheckPath,
})

/**
 * Deploys `commit`, waits for it to serve, and reads three facts back from outside before the
 * release counts: `/health` answers 200 at the public address, the serving deployment was built
 * from `commit`, and the fleet pointer selects `cellWorkerVersion` (the pre-deploy step published
 * it; `infra/predeploy.mjs`). Railway keeps the previous deployment serving until the new one
 * passes its healthcheck, so a failed release leaves production as it was.
 */
const deploy = Effect.fn('Infra.Release.deploy')(function* (props: ReleaseProps) {
  // A deployment already in flight would run its own pre-deploy beside this one's; the server
  // Service starts one by itself when its settings change. Only this release should finish.
  const previous = yield* latestDeployment(props.serviceId, props.environmentId)
  if (previous !== null && inProgress.has(previous.status))
    yield* railway(
      'deploymentCancel',
      'mutation($id: String!) { deploymentCancel(id: $id) }',
      { id: previous.id },
      answers.cancel,
    )
  const { serviceInstanceDeployV2: id } = yield* railway(
    'serviceInstanceDeployV2',
    'mutation($environmentId: String!, $serviceId: String!, $commitSha: String) { serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId, commitSha: $commitSha) }',
    { environmentId: props.environmentId, serviceId: props.serviceId, commitSha: props.commit },
    answers.deploy,
  )
  const live = yield* settled(id, props.timeoutMinutes)
  if (live.status !== 'SUCCESS')
    return yield* new ReleaseFailed({
      deploymentId: id,
      status: live.status,
      logs: yield* failureLogs(id),
    })
  if (props.url === undefined)
    return yield* new ReleaseUnverified({ check: 'health', message: 'the server has no address' })
  const health = yield* HttpClient.get(`${props.url}/health`).pipe(
    Effect.mapError(
      (error) =>
        new ReleaseUnverified({
          check: 'health',
          message: '/health could not be reached',
          cause: error._tag,
        }),
    ),
  )
  if (health.status !== 200)
    return yield* new ReleaseUnverified({
      check: 'health',
      message: `/health answered HTTP ${health.status}`,
    })
  if (Option.getOrNull(live.meta.commitHash) !== props.commit)
    return yield* new ReleaseUnverified({
      check: 'commit',
      message: `deployment ${id} is not built from ${props.commit}`,
    })
  const worker = yield* readPointer(yield* fleetStorage(props.storage))
  if (Option.getOrNull(worker) !== props.cellWorkerVersion)
    return yield* new ReleaseUnverified({
      check: 'worker',
      message: `the fleet selects ${Option.getOrElse(worker, () => 'no Worker')}, the release carries ${props.cellWorkerVersion}`,
    })
  return attributes(live, props.inputs, worker, yield* variableDigests(props))
})

/** Provider of `Infra.Release`; it needs the Railway credential and HTTP client the Railway providers carry. */
export const ReleaseProvider = Provider.succeed(Release, {
  /** Due when the image's inputs or the Worker changed; a push that touches neither is a noop. */
  diff: ({ olds, news, output }) =>
    Effect.sync(() => {
      if (output === undefined) return undefined
      // Unresolved means an upstream changes in this deploy (the Worker, or the server's settings,
      // which need a deployment of their own to take effect): release, and read it back.
      if (!isResolved(news)) return { action: 'update' } as const
      const due = news.inputs !== olds.inputs || news.cellWorkerVersion !== olds.cellWorkerVersion
      return { action: due ? 'update' : 'noop' } as const
    }),
  reconcile: Effect.fn(function* ({ news }) {
    return yield* deploy(news)
  }),
  /** The deployment serving now and the Worker the fleet selects, for drift. */
  read: Effect.fn(function* ({ olds, output }) {
    if (output === undefined) return undefined
    const live = yield* latestDeployment(olds.serviceId, olds.environmentId)
    if (live === null) return undefined
    const worker = yield* readPointer(yield* fleetStorage(olds.storage))
    return attributes(live, output.inputs, worker, yield* variableDigests(olds))
  }),
  /** A release is history: removing the declaration leaves the server as it is. */
  delete: () => Effect.void,
})
