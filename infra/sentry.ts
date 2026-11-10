import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { Resource } from 'alchemy'
import * as Provider from 'alchemy/Provider'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const script = NodePath.join(root, 'scripts/monitoring.mjs')
const origin = 'https://us.sentry.io/api/0/organizations/vivid-7t'

/**
 * The alert policy as code: the hash of `scripts/monitoring.mjs`, which owns what the rules say
 * (issue alerts on new and regressed errors, repeated-error and latency monitors, issue-owner
 * email routing). A change to that file is a change to the policy and re-applies it.
 */
export const alertPolicy = () =>
  NodeCrypto.createHash('sha256').update(NodeFS.readFileSync(script)).digest('hex')

/** The rules as they are live, reduced to the fields the policy sets, in a stable order. */
const Rule = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['workflow', 'monitor'] as const),
  settings: Schema.Array(Schema.String),
})

export type SentryAlerts = Resource<
  'Infra.SentryAlerts',
  { readonly policy: string },
  { readonly rules: ReadonlyArray<typeof Rule.Type> }
>

/**
 * Sentry's alert rules for production as a resource with a read. `reconcile` runs the policy
 * (`scripts/monitoring.mjs --apply`, which writes and reads each rule back); `read` fetches the
 * same rules and reduces them to the policy's fields, so an edit made in Sentry's UI is drift
 * (`infra/drift.mjs`). It replaced a `Command.Exec` that was skipped whenever its token was
 * missing and that nothing could read back.
 *
 * The management token is `SENTRY_MANAGEMENT_TOKEN`, required: a deploy without it fails here.
 */
export const SentryAlerts = Resource<SentryAlerts>('Infra.SentryAlerts')

/** Sentry refused, could not be reached, or answered something the policy does not describe. */
class SentryAlertsUnread extends Schema.TaggedError<SentryAlertsUnread>()(
  'SentryAlertsUnread',
  { message: Schema.String },
  { title: 'Sentry alerts unread' },
) {}

const Workflow = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  environment: Schema.NullOr(Schema.String),
  config: Schema.Struct({ frequency: Schema.Finite }),
  triggers: Schema.Struct({ conditions: Schema.Array(Schema.Struct({ type: Schema.String })) }),
  actionFilters: Schema.Array(
    Schema.Struct({
      actions: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          status: Schema.String,
          config: Schema.Struct({ targetType: Schema.String }),
        }),
      ),
    }),
  ),
})

const Monitor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  workflowIds: Schema.Array(Schema.String),
  conditionGroup: Schema.Struct({
    conditions: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        comparison: Schema.Finite,
        conditionResult: Schema.Finite,
      }),
    ),
  }),
  dataSources: Schema.Array(
    Schema.Struct({
      queryObj: Schema.Struct({
        snubaQuery: Schema.Struct({
          aggregate: Schema.String,
          query: Schema.String,
          timeWindow: Schema.Finite,
          environment: Schema.NullOr(Schema.String),
        }),
      }),
    }),
  ),
})

/** The receipt `monitoring.mjs --apply` writes: which rules it applied. */
const Receipt = Schema.fromJsonString(
  Schema.Struct({
    workflows: Schema.Array(Schema.Struct({ id: Schema.String })),
    monitors: Schema.Array(Schema.Struct({ actual: Schema.Struct({ id: Schema.String }) })),
  }),
)

const token = Config.Redacted('SENTRY_MANAGEMENT_TOKEN').pipe(
  Effect.mapError(() => new SentryAlertsUnread({ message: 'SENTRY_MANAGEMENT_TOKEN is not set' })),
)

/** One rule from Sentry's API, decoded, or a typed failure naming only the path. */
const fetchRule = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const bearer = yield* token
    const unread = (why: string) => new SentryAlertsUnread({ message: `${path}: ${why}` })
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(`${origin}${path}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(bearer)),
      ),
    ).pipe(Effect.mapError(() => unread('the request failed')))
    if (response.status !== 200) return yield* unread(`HTTP ${response.status}`)
    const body = yield* response.text.pipe(Effect.mapError(() => unread('no body')))
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(() => unread('not the rule the policy describes')),
    )
  })

/** The live rules, each reduced to the settings the policy owns, sorted for comparison. */
const observe = Effect.fn('Infra.SentryAlerts.observe')(function* (
  ids: ReadonlyArray<typeof Rule.Type>,
) {
  return yield* Effect.forEach(ids, (rule) =>
    rule.kind === 'workflow'
      ? fetchRule(`/workflows/${rule.id}/`, Workflow).pipe(
          Effect.map((workflow) => ({
            id: workflow.id,
            kind: rule.kind,
            settings: [
              `enabled:${workflow.enabled}`,
              `environment:${workflow.environment}`,
              `frequency:${workflow.config.frequency}`,
              ...workflow.triggers.conditions.map((condition) => `trigger:${condition.type}`),
              ...workflow.actionFilters.flatMap((filter) =>
                filter.actions.map(
                  (action) => `action:${action.type}:${action.config.targetType}:${action.status}`,
                ),
              ),
            ].sort(),
          })),
        )
      : fetchRule(`/detectors/${rule.id}/`, Monitor).pipe(
          Effect.map((monitor) => ({
            id: monitor.id,
            kind: rule.kind,
            settings: [
              `name:${monitor.name}`,
              `enabled:${monitor.enabled}`,
              ...monitor.workflowIds.map((id) => `workflow:${id}`),
              ...monitor.dataSources.map(
                ({ queryObj: { snubaQuery: source } }) =>
                  `source:${source.aggregate}|${source.query}|${source.timeWindow}|${source.environment}`,
              ),
              ...monitor.conditionGroup.conditions.map(
                (condition) =>
                  `condition:${condition.type}:${condition.comparison}:${condition.conditionResult}`,
              ),
            ].sort(),
          })),
        ),
  )
})

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)

/** Applies the policy with its own read-back, then answers the rules as they are live. */
const apply = Effect.fn('Infra.SentryAlerts.apply')(function* () {
  const bearer = yield* token
  const receipt = NodePath.join(
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-sentry-')),
      catch: () => new SentryAlertsUnread({ message: 'no temporary directory for the receipt' }),
    }),
    'receipt.json',
  )
  yield* Effect.tryPromise({
    try: () =>
      execFile(process.execPath, [script, '--apply'], {
        cwd: root,
        env: {
          ...process.env,
          SENTRY_AUTH_TOKEN: Redacted.value(bearer),
          VIVID_SENTRY_ALERT_RECEIPT: receipt,
        },
      }),
    catch: () => new SentryAlertsUnread({ message: 'scripts/monitoring.mjs --apply failed' }),
  })
  const applied = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(receipt, 'utf8'),
    catch: () => new SentryAlertsUnread({ message: 'scripts/monitoring.mjs wrote no receipt' }),
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Receipt)),
    Effect.mapError(() => new SentryAlertsUnread({ message: 'the alert receipt does not decode' })),
  )
  return yield* observe([
    ...applied.workflows.map(({ id }) => ({ id, kind: 'workflow' as const, settings: [] })),
    ...applied.monitors.map(({ actual }) => ({
      id: actual.id,
      kind: 'monitor' as const,
      settings: [],
    })),
  ])
})

/** Provider of `Infra.SentryAlerts`; it needs an HTTP client (the Railway providers carry one). */
export const SentryAlertsProvider = Provider.succeed(SentryAlerts, {
  reconcile: Effect.fn(function* () {
    return { rules: yield* apply() }
  }),
  read: Effect.fn(function* ({ output }) {
    if (output === undefined) return undefined
    return { rules: yield* observe(output.rules) }
  }),
  /** Removing the declaration leaves the rules in Sentry; they guard production. */
  delete: () => Effect.void,
})
