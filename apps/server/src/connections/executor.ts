import { NodeCrypto } from '@effect/platform-node'
import { ActionEffect, ServiceAuthorization, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Record from 'effect/Record'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpBody from 'effect/unstable/http/HttpBody'

export const ExecutorAppId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAppId'))
export const ExecutorAccountId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAccountId'))
export const ExecutorDeploymentId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorDeploymentId'))
export const ExecutorProfileId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProfileId'))
export const ExecutorOwnerId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorOwnerId'))
export const ExecutorAuthorizationId = Schema.NonEmptyString.pipe(
  Schema.brand('ExecutorAuthorizationId'),
)
export const ExecutorRequestId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorRequestId'))

const referenceFields = {
  service: ServiceId,
  app: ExecutorAppId,
  profile: ExecutorProfileId,
  owner: ExecutorOwnerId,
}
/** Pending authorization has no account identity yet; status resolves it after completion. */
export const ExecutorReferences = Schema.TaggedUnion({
  Public: referenceFields,
  EnteringKey: {
    ...referenceFields,
    authorization: ExecutorAuthorizationId,
    method: Schema.NonEmptyString,
    label: Schema.NonEmptyString,
  },
  SigningIn: { ...referenceFields, authorization: ExecutorAuthorizationId },
  Authorized: { ...referenceFields, account: ExecutorAccountId },
})
export type ExecutorReferences = typeof ExecutorReferences.Type

export const ExecutorServiceEntry = Schema.Struct({
  id: ServiceId,
  name: Schema.String,
  description: Schema.String,
  authorization: ServiceAuthorization,
})
export const ExecutorStep = Schema.TaggedUnion({
  OpenSignIn: { references: ExecutorReferences.cases.SigningIn, address: Schema.String },
  EnterKey: {
    references: ExecutorReferences.cases.EnteringKey,
    fields: ServiceAuthorization.cases.Key.fields.fields,
  },
  Done: {
    references: Schema.Union([
      ExecutorReferences.cases.Public,
      ExecutorReferences.cases.Authorized,
    ]),
  },
})
export const ExecutorStatus = Schema.TaggedUnion({
  Ready: { references: ExecutorReferences },
  NeedsAuthorization: { references: ExecutorReferences },
  Failed: { reason: Schema.String },
})
export const ExecutorTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  input: Schema.Json,
  effect: ActionEffect,
})
export const ExecutorCallOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  ApprovalRequired: { requestId: ExecutorRequestId, expiresAt: Schema.Number },
  Rejected: { message: Schema.String },
  NotReady: {},
  OutcomeUnknown: {},
})
export const ExecutorResumeOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  Denied: {},
  Failed: { reason: Schema.String },
  AlreadyConsumed: {},
  /** Resume claims consent before dispatch; lost responses cannot safely be retried. */
  OutcomeUnknown: {},
})

const errorContext = { service: Schema.Literal('connections'), tool: Schema.NullOr(Schema.String) }
/** Connectivity failures are retryable only before a consequential invocation is dispatched. */
export class ExecutorTransportFailure extends Schema.TaggedError<ExecutorTransportFailure>()(
  'ExecutorTransportFailure',
  errorContext,
  { title: 'Connection transport failed' },
) {}
/** A malformed response cannot be mistaken for proof that an invocation did not run. */
export class ExecutorResponseInvalid extends Schema.TaggedError<ExecutorResponseInvalid>()(
  'ExecutorResponseInvalid',
  errorContext,
  { title: 'Connection response invalid' },
) {}
/** A bad installation key or a tool policy denial requires an authority decision. */
export class ExecutorAccessDenied extends Schema.TaggedError<ExecutorAccessDenied>()(
  'ExecutorAccessDenied',
  errorContext,
  { title: 'Connection access denied' },
) {}
/** Missing selections and expired OAuth grants require authorization, never another identity. */
export class ExecutorNotReady extends Schema.TaggedError<ExecutorNotReady>()(
  'ExecutorNotReady',
  errorContext,
  { title: 'Connection not ready' },
) {}
/** Safe instructions describe failures known to precede tool execution. */
export class ExecutorRejected extends Schema.TaggedError<ExecutorRejected>()(
  'ExecutorRejected',
  { ...errorContext, message: Schema.String },
  { title: 'Connection request rejected' },
) {}
/** Active resources or changed revisions must be resolved before management writes are retried. */
export class ExecutorConflict extends Schema.TaggedError<ExecutorConflict>()(
  'ExecutorConflict',
  errorContext,
  { title: 'Connection resource conflict' },
) {}
/** An upstream 5xx or ToolCallFailed can follow external effects. */
export class ExecutorExecutionUncertain extends Schema.TaggedError<ExecutorExecutionUncertain>()(
  'ExecutorExecutionUncertain',
  errorContext,
  { title: 'Connection outcome unknown' },
) {}
/** A sign-in cannot start without host configuration; preserve the pending foreign references. */
export class ExecutorSignInRequired extends Schema.TaggedError<ExecutorSignInRequired>()(
  'ExecutorSignInRequired',
  { references: ExecutorReferences, message: Schema.String },
  { title: 'Connection sign-in setup required' },
) {}

export type ExecutorFailure =
  | ServiceUnavailable
  | ExecutorTransportFailure
  | ExecutorResponseInvalid
  | ExecutorAccessDenied
  | ExecutorNotReady
  | ExecutorRejected
  | ExecutorConflict
  | ExecutorExecutionUncertain
  | ExecutorSignInRequired

const BeginInput = Schema.Struct({
  service: ServiceId,
  owner: ExecutorOwnerId,
  subject: Schema.NonEmptyString,
  label: Schema.NonEmptyString.check(Schema.isMaxLength(40)),
  returnAddress: Schema.NonEmptyString,
})
const CompleteInput = Schema.Struct({
  references: ExecutorReferences,
  fields: Schema.Record(Schema.String, Schema.Redacted(Schema.String)),
})
const CallInput = Schema.Struct({
  references: ExecutorReferences,
  tool: Schema.NonEmptyString,
  input: Schema.Json,
})
const ResumeInput = Schema.Struct({ requestId: ExecutorRequestId, accept: Schema.Boolean })
const SignInInput = Schema.Struct({
  references: ExecutorReferences,
  callbackAddress: Schema.Redacted(Schema.String),
})

/** Owner is Executor's storage/filter identity, not permission. Subject independently attributes a
 * profile to the acting Person. The caller supplies both; this adapter never chooses their mapping.
 * See the SDK profile contract and the ownership evidence in findings-executor section 4.
 */
export interface ExecutorService {
  readonly catalog: () => Effect.Effect<
    readonly (typeof ExecutorServiceEntry.Type)[],
    ExecutorFailure
  >
  readonly begin: (
    input: typeof BeginInput.Type,
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure>
  readonly complete: (
    input: typeof CompleteInput.Type,
  ) => Effect.Effect<ExecutorReferences, ExecutorFailure>
  /** The application server hosts returnAddress and supplies the full callback URL, kept redacted. */
  readonly completeSignIn: (
    input: typeof SignInInput.Type,
  ) => Effect.Effect<ExecutorReferences, ExecutorFailure>
  readonly status: (
    references: ExecutorReferences,
  ) => Effect.Effect<typeof ExecutorStatus.Type, ExecutorFailure>
  readonly remove: (references: ExecutorReferences) => Effect.Effect<void, ExecutorFailure>
  readonly tools: (
    references: ExecutorReferences,
  ) => Effect.Effect<readonly (typeof ExecutorTool.Type)[], ExecutorFailure>
  readonly call: (
    input: typeof CallInput.Type,
  ) => Effect.Effect<typeof ExecutorCallOutcome.Type, ExecutorFailure>
  readonly resume: (
    input: typeof ResumeInput.Type,
  ) => Effect.Effect<typeof ExecutorResumeOutcome.Type, ExecutorFailure>
}
/** Only the server holds this installation-wide authority; product permission belongs above it. */
export class Executor extends Context.Service<Executor, ExecutorService>()('vivid/Executor') {}

const FieldSchema = Schema.Struct({ title: Schema.optionalKey(Schema.String) })
const AuthorizationMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('secrets'),
    fields: Schema.Struct({ properties: Schema.Record(Schema.String, FieldSchema) }),
  }),
  Schema.Struct({ type: Schema.Literal('oauth2') }),
]).pipe(Schema.toTaggedUnion('type'))
const Requirement = Schema.Struct({
  definition: Schema.Struct({ auth: Schema.Record(Schema.String, AuthorizationMethod) }),
})
const WireApp = Schema.Struct({
  id: ExecutorAppId,
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Requirement) }),
})
const WireAccount = Schema.Struct({ id: ExecutorAccountId })
const WireProfile = Schema.Struct({
  id: ExecutorProfileId,
  status: Schema.Literals([
    'pending',
    'ready',
    'needs-setup',
    'failed',
    'disabled',
    'removing',
    'removed',
  ]),
  failure: Schema.NullOr(
    Schema.Literals([
      'accounts',
      'configuration',
      'registration',
      'cleanup',
      'access',
      'deployment',
    ]),
  ),
})
const WireConnection = Schema.Struct({
  id: ExecutorAuthorizationId,
  state: Schema.Union([
    Schema.Struct({ status: Schema.Literal('pending') }),
    Schema.Struct({ status: Schema.Literal('cancelled') }),
    Schema.Struct({ status: Schema.Literal('expired') }),
    Schema.Struct({ status: Schema.Literal('completed'), account: WireAccount }),
  ]).pipe(Schema.toTaggedUnion('status')),
})
const WireTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  inputSchema: Schema.Json,
  readOnly: Schema.optionalKey(Schema.Boolean),
  annotations: Schema.optionalKey(
    Schema.Struct({
      readOnlyHint: Schema.optionalKey(Schema.Boolean),
      destructiveHint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})
const WireTools = Schema.Struct({
  items: Schema.Array(WireTool),
  deployment: ExecutorDeploymentId,
  profileRevision: Schema.Int,
  next: Schema.optionalKey(Schema.NonEmptyString),
})
const WireCatalog = Schema.Array(
  Schema.Struct({
    id: ServiceId,
    kind: Schema.Literals(['openapi', 'mcp', 'graphql', 'cli']),
    name: Schema.String,
    description: Schema.String,
    connectUrl: Schema.optionalKey(Schema.String),
    auth: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
  }),
)
const WireCompleted = Schema.Struct({
  status: Schema.Literal('completed'),
  value: Schema.Json,
  toolError: Schema.optionalKey(Schema.Literal(true)),
})
const WireCall = Schema.Union([
  WireCompleted,
  Schema.Struct({
    status: Schema.Literal('approval-required'),
    requestId: ExecutorRequestId,
    expiresAt: Schema.Number,
  }),
]).pipe(Schema.toTaggedUnion('status'))
const WireResume = Schema.Union([
  WireCompleted,
  Schema.Struct({ status: Schema.Literal('denied') }),
  Schema.Struct({ status: Schema.Literal('cancelled') }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    reason: Schema.Literals(['expired', 'context-changed', 'execution-failed']),
  }),
  Schema.Struct({ status: Schema.Literal('already-consumed') }),
]).pipe(Schema.toTaggedUnion('status'))
const WireSignIn = Schema.Union([
  Schema.Struct({ status: Schema.Literal('redirect'), authorizationUrl: Schema.String }),
  Schema.Struct({ status: Schema.Literal('completed'), account: WireAccount }),
]).pipe(Schema.toTaggedUnion('status'))
const KeySubmission = Schema.Struct({
  connection: ExecutorAuthorizationId,
  owner: ExecutorOwnerId,
  method: Schema.String,
  label: Schema.String,
  fields: Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String)),
})
const SignInSubmission = Schema.Struct({
  connection: ExecutorAuthorizationId,
  owner: ExecutorOwnerId,
  callbackUrl: Schema.RedactedFromValue(Schema.String),
})
const encodeKey = Schema.encodeEffect(KeySubmission)
const encodeSignIn = Schema.encodeEffect(SignInSubmission)
const jsonBody = HttpClientRequest.schemaBodyJson(Schema.Json)

const FailureMode = Schema.TaggedUnion({
  NotReady: {},
  AccessDenied: {},
  Conflict: {},
  Uncertain: {},
  Rejected: { message: Schema.String },
})
const notReady = FailureMode.cases.NotReady.make({})
const conflict = FailureMode.cases.Conflict.make({})
const uncertain = FailureMode.cases.Uncertain.make({})
const denied = FailureMode.cases.AccessDenied.make({})
/** This table is the sole remote error vocabulary; wire decoding derives its finite tags from it.
 * Messages are owned here because upstream diagnostics must not reflect submitted secrets.
 */
const failureModes = {
  AppNotFound: notReady,
  AppNotDeployed: notReady,
  DeploymentNotFound: notReady,
  AccountNotFound: notReady,
  AccountRequired: notReady,
  AccountSelectionInvalid: notReady,
  OAuthReconnectRequired: notReady,
  ProfileNotFound: notReady,
  ProviderNotFound: notReady,
  AccountConnectionNotFound: notReady,
  AccountConnectionClosed: notReady,
  ToolBlocked: denied,
  CredentialsError: denied,
  DashboardForbidden: denied,
  DashboardUnauthorized: denied,
  ProfileConflict: conflict,
  AppNameTaken: conflict,
  AppSlugTaken: conflict,
  AccountConnectionTargetChanged: conflict,
  AppWorkflowsActive: conflict,
  AppWebhooksActive: conflict,
  AccountWebhooksActive: conflict,
  AccountWorkflowsActive: conflict,
  ToolCallFailed: uncertain,
  StorageError: uncertain,
  CatalogUnavailable: uncertain,
  ToolApprovalNotFound: FailureMode.cases.Rejected.make({
    message: 'The approval no longer exists; do not repeat the original action.',
  }),
  InputInvalid: FailureMode.cases.Rejected.make({
    message: 'Input did not match the tool schema. Inspect the current tool and correct its input.',
  }),
  ToolNotFound: FailureMode.cases.Rejected.make({
    message: 'This tool is unavailable. Discover the current tools before calling again.',
  }),
  ToolPolicyFailed: FailureMode.cases.Rejected.make({
    message: 'The tool policy could not decide; the tool did not run.',
  }),
  ToolApprovalRequired: FailureMode.cases.Rejected.make({
    message: 'This tool requires a supported approval request.',
  }),
  ToolElicitationFailed: uncertain,
  RequestInvalid: FailureMode.cases.Rejected.make({
    message: 'The request is invalid for this installation.',
  }),
  AccountFieldsInvalid: FailureMode.cases.Rejected.make({
    message: 'Complete the required key fields shown by this service.',
  }),
  AuthMethodInvalid: FailureMode.cases.Rejected.make({
    message: 'The service authorization method changed; start authorization again.',
  }),
  OAuthClientUnavailable: FailureMode.cases.Rejected.make({
    message: 'Configure an OAuth client on the trusted host before starting sign-in.',
  }),
  OAuthSetupFailed: FailureMode.cases.Rejected.make({
    message: 'The service could not prepare sign-in. Review its OAuth configuration.',
  }),
  OAuthCompletionFailed: FailureMode.cases.Rejected.make({
    message: 'Sign-in did not complete. Review the callback or start a new authorization.',
  }),
  AppEvaluationFailed: FailureMode.cases.Rejected.make({
    message: 'The service could not load its tools. Check its deployment and authorization.',
  }),
  CatalogImportFailed: FailureMode.cases.Rejected.make({
    message: 'This catalog entry could not be imported. Check its published configuration.',
  }),
  DeploymentBuildFailed: FailureMode.cases.Rejected.make({
    message: 'The imported service could not be built.',
  }),
  SourceError: FailureMode.cases.Rejected.make({
    message: 'The retained service source is unavailable or cannot be changed.',
  }),
  AppDeploymentChanged: conflict,
  SkillDefinitionInvalid: FailureMode.cases.Rejected.make({
    message: 'The imported service declaration is invalid.',
  }),
} as const
const WireFailure = Schema.Struct({ _tag: Schema.Literals(Record.keys(failureModes)) })
const decodeFailure = Schema.decodeUnknownEffect(WireFailure)

/** Remote tags determine recovery; arbitrary messages and credential-bearing diagnostics are dropped. */
function translateFailure(tag: (typeof WireFailure.Type)['_tag'], tool: string | null) {
  const context = { service: 'connections' as const, tool }
  return FailureMode.match(failureModes[tag], {
    NotReady: (): ExecutorFailure => ExecutorNotReady.make(context),
    AccessDenied: (): ExecutorFailure => ExecutorAccessDenied.make(context),
    Conflict: (): ExecutorFailure => ExecutorConflict.make(context),
    Uncertain: (): ExecutorFailure => ExecutorExecutionUncertain.make(context),
    Rejected: ({ message }): ExecutorFailure => ExecutorRejected.make({ ...context, message }),
  })
}

/** Each decoder is compiled once per response shape at layer acquisition. No automatic retry is
 * installed: an accepted write or resume may have committed before the response was lost.
 */
function responseReader(client: HttpClient.HttpClient) {
  return <A, I>(schema: Schema.Codec<A, I>) => {
    const decode = Schema.decodeUnknownEffect(schema)
    return Effect.fn('Executor.request')(
      function* (
        request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>,
        tool: string | null,
      ) {
        const context = { service: 'connections' as const, tool }
        const prepared = yield* request.pipe(
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
        const response = yield* client
          .execute(prepared)
          .pipe(Effect.mapError(() => ExecutorTransportFailure.make(context)))
        if (response.status === 401 || response.status === 403) {
          return yield* Effect.fail(ExecutorAccessDenied.make(context))
        }
        const body = yield* response.json.pipe(
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
        if (response.status >= 200 && response.status < 300) {
          return yield* decode(body).pipe(
            Effect.mapError(() => ExecutorResponseInvalid.make(context)),
          )
        }
        const failure = yield* decodeFailure(body).pipe(
          Effect.mapError(() =>
            response.status >= 500
              ? ExecutorExecutionUncertain.make(context)
              : ExecutorResponseInvalid.make(context),
          ),
        )
        return yield* Effect.fail(translateFailure(failure._tag, tool))
      },
      (effect, _request, tool) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeout('90 seconds'),
          Effect.catchTag('TimeoutError', () =>
            Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool })),
          ),
        ),
    )
  }
}

/** Only MCP entries with declared auth are honest before import. Unknown auth and unsupported
 * GraphQL/CLI/OpenAPI imports are excluded rather than advertised as unauthenticated services.
 * For mixed MCP entries OAuth is the single chosen method; key alternatives remain host-owned.
 */
function catalogEntry(entry: (typeof WireCatalog.Type)[number]) {
  if (entry.kind !== 'mcp' || entry.connectUrl === undefined || entry.auth === undefined) return []
  const authorization = Match.value(entry.auth.kind).pipe(
    Match.when('none', () => ServiceAuthorization.cases.None.make({})),
    Match.whenOr('oauth', 'mixed', () => ServiceAuthorization.cases.SignIn.make({})),
    Match.when('api_key', () =>
      ServiceAuthorization.cases.Key.make({ fields: [{ name: 'token', label: 'API key' }] }),
    ),
    Match.orElse(() => null),
  )
  if (authorization === null) return []
  return [
    ExecutorServiceEntry.make({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      authorization,
    }),
  ]
}

/** HostedTool.readOnly and annotations.readOnlyHint carry queries and imported MCP read hints;
 * the OpenAPI adapter derives readOnly from GET, HEAD, and OPTIONS (SDK apps openapi implementation).
 * annotations.destructiveHint carries imported MCP destructive hints. Destructive wins. Approval callbacks and raw HTTP methods are NOT
 * exposed by GET /v1/tools, so they cannot establish read safety; undeclared/conflicting hints
 * conservatively mean write. Names such as "read_*" never establish safety.
 */
function classifyTool(tool: typeof WireTool.Type) {
  if (tool.annotations !== undefined && tool.annotations.destructiveHint === true)
    return 'destructive' as const
  if (tool.readOnly === false) return 'write' as const
  if (tool.annotations !== undefined && tool.annotations.readOnlyHint === false)
    return 'write' as const
  if (tool.readOnly === true) return 'read' as const
  if (tool.annotations !== undefined && tool.annotations.readOnlyHint === true)
    return 'read' as const
  return 'write' as const
}

/** A completed semantic error is actionable, not a successful tool value. */
function completedCall(result: typeof WireCompleted.Type) {
  if (result.toolError === true)
    return ExecutorCallOutcome.cases.Rejected.make({ message: JSON.stringify(result.value) })
  return ExecutorCallOutcome.cases.Completed.make({ value: result.value })
}

/** Unknown external effects survive transport failures. Read-only calls can report safe retry advice. */
function lostCall(effect: typeof ActionEffect.Type) {
  if (effect === 'read')
    return ExecutorCallOutcome.cases.Rejected.make({
      message: 'The read did not return a usable response. You may try the read again.',
    })
  return ExecutorCallOutcome.cases.OutcomeUnknown.make({})
}

/** Query identifiers are percent-encoded; the owner remains an independent lookup predicate. */
const target = (references: ExecutorReferences) =>
  `/v1/apps/${encodeURIComponent(references.app)}/profiles/${encodeURIComponent(references.profile)}`
/** Centralized encoding leaves foreign identifiers opaque rather than interpreting their prefixes. */
const query = (value: string) => encodeURIComponent(value)
/** Body encoding happens before dispatch and contains no diagnostic/logging of secret fields. */
const post = (path: string, body: typeof Schema.Json.Type) =>
  jsonBody(HttpClientRequest.post(path), body)

/** Carry only stable identity across state transitions; never copy another variant discriminator. */
function referenceIdentity(references: ExecutorReferences) {
  return {
    service: references.service,
    app: references.app,
    profile: references.profile,
    owner: references.owner,
  }
}

/** Compile the narrow foreign response schemas once for this authenticated client. */
function makeHttp(client: HttpClient.HttpClient) {
  const read = responseReader(client)
  const readApp = read(WireApp)
  const readProfile = read(WireProfile)
  const readConnection = read(WireConnection)
  const readAccount = read(WireAccount)
  const readCatalog = read(WireCatalog)
  const readTools = read(WireTools)
  const readCall = read(WireCall)
  const readResume = read(WireResume)
  const readSignIn = read(WireSignIn)
  const readRemoval = read(Schema.Json)
  return {
    readApp,
    readProfile,
    readConnection,
    readAccount,
    readCatalog,
    readTools,
    readCall,
    readResume,
    readSignIn,
    readRemoval,
  }
}
type ExecutorHttp = ReturnType<typeof makeHttp>

/** Reconciliation is a typed setup operation; pending profiles are not assumed ready. */
function makeReconcile(http: ExecutorHttp) {
  return Effect.fn('Executor.reconcile')(function* (references: ExecutorReferences) {
    return yield* http.readProfile(
      Effect.succeed(HttpClientRequest.post(`${target(references)}/reconcile`)),
      null,
    )
  })
}

/** Discovery is paginated: a Connection cannot silently lose tools after the first page. */
function makeDiscovery(http: ExecutorHttp) {
  return Effect.fn('Executor.discover')(function* (references: ExecutorReferences) {
    const items: (typeof ExecutorTool.Type)[] = []
    let snapshot: Option.Option<{
      deployment: typeof ExecutorDeploymentId.Type
      revision: number
    }> = Option.none()
    let cursor: Option.Option<string> = Option.none()
    const seen = new Set<string>()
    do {
      const base = Option.match(snapshot, {
        onNone: () => `/v1/tools?app=${query(references.app)}&profile=${query(references.profile)}`,
        onSome: ({ deployment, revision }) =>
          `/v1/tools?app=${query(references.app)}&profile=${query(references.profile)}&deployment=${query(deployment)}&expectedProfileRevision=${revision}`,
      })
      const address = Option.match(cursor, {
        onNone: () => base,
        onSome: (value) => `${base}&cursor=${query(value)}`,
      })
      const page = yield* http.readTools(Effect.succeed(HttpClientRequest.get(address)), null)
      if (
        Option.isSome(snapshot) &&
        (snapshot.value.deployment !== page.deployment ||
          snapshot.value.revision !== page.profileRevision)
      ) {
        return yield* Effect.fail(ExecutorConflict.make({ service: 'connections', tool: null }))
      }
      snapshot = Option.some({ deployment: page.deployment, revision: page.profileRevision })
      for (const tool of page.items)
        items.push(
          ExecutorTool.make({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            effect: classifyTool(tool),
          }),
        )
      if (page.next !== undefined) {
        if (seen.has(page.next))
          return yield* Effect.fail(
            ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
          )
        seen.add(page.next)
      }
      cursor = Option.fromUndefinedOr(page.next)
    } while (Option.isSome(cursor))
    if (Option.isNone(snapshot))
      return yield* Effect.fail(
        ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
      )
    return { items, deployment: snapshot.value.deployment, revision: snapshot.value.revision }
  })
}

/** Hide the invocation snapshot from product discovery; call retains it until dispatch. */
function makeTools(http: ExecutorHttp) {
  const discover = makeDiscovery(http)
  return Effect.fn('Executor.tools')(function* (references: ExecutorReferences) {
    return (yield* discover(references)).items
  })
}

/** Native targeted requests atomically select the saved account into the exact profile. */
function makeAuthorize(http: ExecutorHttp) {
  return Effect.fn('Executor.authorize')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    references: ExecutorReferences,
    authorization: typeof ServiceAuthorization.Type,
  ) {
    const requirements = Object.entries(app.requirements.accounts)
    const first = requirements[0]
    if (requirements.length !== 1 || first === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This service requires a configuration the Connection adapter does not support.',
        }),
      )
    const [requirement, definition] = first
    const methods = Object.entries(definition.definition.auth)
    const matching = ServiceAuthorization.match(authorization, {
      SignIn: () => methods.filter(([, method]) => AuthorizationMethod.guards.oauth2(method)),
      Key: () => methods.filter(([, method]) => AuthorizationMethod.guards.secrets(method)),
      None: () => [],
    })
    const chosen = matching[0]
    if (matching.length !== 1 || chosen === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'The service does not declare one compatible authorization method.',
        }),
      )
    const [methodName, method] = chosen
    const connection = yield* http.readConnection(
      post('/v1/account-connections', {
        owner: input.owner,
        target: { app: app.id, profile: references.profile, requirement },
      }),
      null,
    )
    return yield* AuthorizationMethod.match(method, {
      secrets: ({ fields }) => {
        const pending = ExecutorReferences.cases.EnteringKey.make({
          ...referenceIdentity(references),
          authorization: connection.id,
          method: methodName,
          label: input.label,
        })
        const labels = Object.entries(fields.properties).map(([name, field]) => ({
          name,
          label: field.title === undefined ? name : field.title,
        }))
        return Effect.succeed(
          ExecutorStep.cases.EnterKey.make({ references: pending, fields: labels }),
        )
      },
      oauth2: Effect.fn('Executor.startSignIn')(function* () {
        const pending = ExecutorReferences.cases.SigningIn.make({
          ...referenceIdentity(references),
          authorization: connection.id,
        })
        const result = yield* http
          .readSignIn(
            post('/v1/account-connections/oauth/start', {
              connection: connection.id,
              owner: input.owner,
              method: methodName,
              label: input.label,
              redirectUri: input.returnAddress,
            }),
            null,
          )
          .pipe(
            Effect.catchTag('ExecutorRejected', ({ message }) =>
              Effect.fail(ExecutorSignInRequired.make({ references: pending, message })),
            ),
          )
        return WireSignIn.match(result, {
          redirect: ({ authorizationUrl }) =>
            ExecutorStep.cases.OpenSignIn.make({ references: pending, address: authorizationUrl }),
          completed: ({ account }) =>
            ExecutorStep.cases.Done.make({
              references: ExecutorReferences.cases.Authorized.make({
                ...referenceIdentity(references),
                account: account.id,
              }),
            }),
        })
      }),
    })
  })
}

/** Readiness resolves pending account IDs, reconciles setup, then probes real authorization. */
function makeStatus(http: ExecutorHttp) {
  const reconcile = makeReconcile(http)
  return Effect.fn('Executor.status')(
    function* (references: ExecutorReferences) {
      let resolved = references
      if (ExecutorReferences.isAnyOf(['EnteringKey', 'SigningIn'])(references)) {
        const connection = yield* http.readConnection(
          Effect.succeed(
            HttpClientRequest.get(
              `/v1/account-connections/${query(references.authorization)}?owner=${query(references.owner)}`,
            ),
          ),
          null,
        )
        const state = connection.state
        if (WireConnection.fields.state.guards.pending(state))
          return ExecutorStatus.cases.NeedsAuthorization.make({ references })
        if (!WireConnection.fields.state.guards.completed(state))
          return ExecutorStatus.cases.Failed.make({ reason: `Authorization ${state.status}` })
        resolved = ExecutorReferences.cases.Authorized.make({
          ...referenceIdentity(references),
          account: state.account.id,
        })
      }
      const profile = yield* reconcile(resolved)
      if (profile.status !== 'ready') {
        if (profile.failure === 'accounts')
          return ExecutorStatus.cases.NeedsAuthorization.make({ references: resolved })
        return ExecutorStatus.cases.Failed.make({ reason: `Service setup is ${profile.status}` })
      }
      yield* http.readTools(
        Effect.succeed(
          HttpClientRequest.get(
            `/v1/tools?app=${query(resolved.app)}&profile=${query(resolved.profile)}&limit=1`,
          ),
        ),
        null,
      )
      return ExecutorStatus.cases.Ready.make({ references: resolved })
    },
    (effect, references) =>
      effect.pipe(
        Effect.catchTags({
          ExecutorNotReady: () =>
            Effect.succeed(ExecutorStatus.cases.NeedsAuthorization.make({ references })),
          ExecutorRejected: ({ message }) =>
            Effect.succeed(ExecutorStatus.cases.Failed.make({ reason: message })),
          ExecutorConflict: () =>
            Effect.succeed(
              ExecutorStatus.cases.Failed.make({
                reason: 'The saved service selection changed or is inactive',
              }),
            ),
        }),
      ),
  )
}

/** Catalog imports use the host's fixed local owner. A copy transfers deployment into the supplied
 * storage owner before profile creation; the temporary local template is then removed.
 */
function makeBegin(http: ExecutorHttp, crypto: Crypto.Crypto) {
  const reconcile = makeReconcile(http)
  const authorize = makeAuthorize(http)
  return Effect.fn('Executor.begin')(function* (input: typeof BeginInput.Type) {
    const entries = (yield* http.readCatalog(
      Effect.succeed(HttpClientRequest.get('/dashboard/api/catalog')),
      null,
    )).flatMap(catalogEntry)
    const entry = entries.find((candidate) => candidate.id === input.service)
    if (entry === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Choose a supported service from the current catalog.',
        }),
      )
    const nonce = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({
          service: 'connections',
          message: 'Could not allocate a Connection identity',
        }),
      ),
    )
    const mcpAuth = ServiceAuthorization.match(entry.authorization, {
      SignIn: () => 'oauth',
      Key: () => 'apiKey',
      None: () => 'none',
    })
    const name = `Vivid Connection ${nonce}`
    const imported = yield* http.readApp(
      post('/dashboard/api/catalog/import', { entry: entry.id, name, mcpAuth }),
      null,
    )
    const app = yield* http.readApp(
      post('/v1/apps/copies', { from: imported.id, owner: input.owner, name }),
      null,
    )
    yield* http.readRemoval(
      Effect.succeed(HttpClientRequest.make('DELETE')(`/v1/apps/${query(imported.id)}`)),
      null,
    )
    const profile = yield* http.readProfile(
      post(`/v1/apps/${query(app.id)}/profiles`, {
        owner: input.owner,
        subject: input.subject,
        accounts: {},
        idempotencyKey: nonce,
      }),
      null,
    )
    const references = ExecutorReferences.cases.Public.make({
      service: input.service,
      app: app.id,
      profile: profile.id,
      owner: input.owner,
    })
    if (Object.keys(app.requirements.accounts).length === 0) {
      const profileState = yield* reconcile(references)
      if (profileState.status !== 'ready')
        return yield* Effect.fail(ExecutorNotReady.make({ service: 'connections', tool: null }))
      return ExecutorStep.cases.Done.make({ references })
    }
    return yield* authorize(input, app, references, entry.authorization)
  })
}

/** The response exposes account identity only; credentials are encoded once and never retained. */
function makeComplete(http: ExecutorHttp) {
  const reconcile = makeReconcile(http)
  return Effect.fn('Executor.complete')(function* ({
    references,
    fields,
  }: typeof CompleteInput.Type) {
    if (!ExecutorReferences.guards.EnteringKey(references))
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This Connection is not waiting for key fields.',
        }),
      )
    const body = yield* encodeKey({
      connection: references.authorization,
      owner: references.owner,
      method: references.method,
      label: references.label,
      fields,
    }).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
    const account = yield* http.readAccount(post('/v1/account-connections/submit', body), null)
    const resolved = ExecutorReferences.cases.Authorized.make({
      ...referenceIdentity(references),
      account: account.id,
    })
    yield* reconcile(resolved)
    return resolved
  })
}

/** Executor checks the stored OAuth state and redirect before exchanging the callback's code. */
function makeCompleteSignIn(http: ExecutorHttp) {
  const reconcile = makeReconcile(http)
  return Effect.fn('Executor.completeSignIn')(function* ({
    references,
    callbackAddress,
  }: typeof SignInInput.Type) {
    if (!ExecutorReferences.guards.SigningIn(references))
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This Connection is not waiting for sign-in.',
        }),
      )
    const body = yield* encodeSignIn({
      connection: references.authorization,
      owner: references.owner,
      callbackUrl: callbackAddress,
    }).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
    const account = yield* http.readAccount(
      post('/v1/account-connections/oauth/complete', body),
      null,
    )
    const resolved = ExecutorReferences.cases.Authorized.make({
      ...referenceIdentity(references),
      account: account.id,
    })
    yield* reconcile(resolved)
    return resolved
  })
}

/** Resolve completed pending requests before removing the profile/app, then its dedicated account.
 * Other live account users are protected by Executor's resource conflict errors.
 */
function makeRemove(http: ExecutorHttp) {
  const resolveRemovalAccount = makeResolveRemovalAccount(http)
  return Effect.fn('Executor.remove')(function* (references: ExecutorReferences) {
    const account = yield* ExecutorReferences.match(references, {
      Public: () => Effect.succeed(Option.none<Schema.Schema.Type<typeof ExecutorAccountId>>()),
      Authorized: (value) => Effect.succeed(Option.some(value.account)),
      EnteringKey: resolveRemovalAccount,
      SigningIn: resolveRemovalAccount,
    })
    yield* http.readRemoval(
      Effect.succeed(
        HttpClientRequest.make('DELETE')(
          `/v1/apps/${query(references.app)}?owner=${query(references.owner)}`,
        ),
      ),
      null,
    )
    if (Option.isSome(account))
      yield* http.readRemoval(
        Effect.succeed(
          HttpClientRequest.make('DELETE')(
            `/v1/accounts/${query(account.value)}?owner=${query(references.owner)}`,
          ),
        ),
        null,
      )
  })
}

/** Cancelling an unfinished request prevents a late callback from recreating a removed Connection. */
function makeResolveRemovalAccount(http: ExecutorHttp) {
  return Effect.fn('Executor.removalAccount')(function* (
    references:
      | typeof ExecutorReferences.cases.EnteringKey.Type
      | typeof ExecutorReferences.cases.SigningIn.Type,
  ) {
    const path = `/v1/account-connections/${query(references.authorization)}`
    const connection = yield* http.readConnection(
      Effect.succeed(HttpClientRequest.post(`${path}/cancel?owner=${query(references.owner)}`)),
      null,
    )
    return WireConnection.fields.state.match(connection.state, {
      completed: ({ account }) => Option.some(account.id),
      pending: () => Option.none(),
      cancelled: () => Option.none(),
      expired: () => Option.none(),
    })
  })
}

/** Discover before dispatch to classify response loss; the named profile is always explicit. */
function makeCall(http: ExecutorHttp) {
  const discover = makeDiscovery(http)
  return Effect.fn('Executor.call')(
    function* ({ references, tool, input }: typeof CallInput.Type) {
      const catalog = yield* discover(references)
      const selected = catalog.items.find((candidate) => candidate.name === tool)
      if (selected === undefined)
        return ExecutorCallOutcome.cases.Rejected.make({
          message: 'Tool not found. Discover the current tools.',
        })
      return yield* http
        .readCall(
          post('/v1/tools/call', {
            app: references.app,
            profile: references.profile,
            deployment: catalog.deployment,
            expectedProfileRevision: catalog.revision,
            tool,
            input,
          }),
          tool,
        )
        .pipe(
          Effect.map((result) =>
            WireCall.match(result, {
              completed: completedCall,
              'approval-required': ({ requestId, expiresAt }) =>
                ExecutorCallOutcome.cases.ApprovalRequired.make({ requestId, expiresAt }),
            }),
          ),
          Effect.catchTags({
            ExecutorTransportFailure: () => Effect.succeed(lostCall(selected.effect)),
            ExecutorExecutionUncertain: () => Effect.succeed(lostCall(selected.effect)),
            ExecutorResponseInvalid: () => Effect.succeed(lostCall(selected.effect)),
          }),
        )
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          ExecutorNotReady: () => Effect.succeed(ExecutorCallOutcome.cases.NotReady.make({})),
          ExecutorRejected: ({ message }) =>
            Effect.succeed(ExecutorCallOutcome.cases.Rejected.make({ message })),
          ExecutorAccessDenied: () =>
            Effect.succeed(
              ExecutorCallOutcome.cases.Rejected.make({
                message: 'The installation or tool policy denied this action.',
              }),
            ),
        }),
      ),
  )
}

/** Consent resumes only the saved invocation. Lost execution results are never replayed. */
function makeResume(http: ExecutorHttp) {
  return Effect.fn('Executor.resume')(
    function* ({ requestId, accept }: typeof ResumeInput.Type) {
      const response = accept
        ? { action: 'accept', content: {} }
        : { action: 'decline', content: {} }
      const result = yield* http.readResume(post('/v1/tools/resume', { requestId, response }), null)
      return WireResume.match(result, {
        completed: ({ value, toolError }) =>
          toolError === true
            ? ExecutorResumeOutcome.cases.Failed.make({ reason: JSON.stringify(value) })
            : ExecutorResumeOutcome.cases.Completed.make({ value }),
        denied: () => ExecutorResumeOutcome.cases.Denied.make({}),
        cancelled: () => ExecutorResumeOutcome.cases.Denied.make({}),
        failed: ({ reason }) => ExecutorResumeOutcome.cases.Failed.make({ reason }),
        'already-consumed': () => ExecutorResumeOutcome.cases.AlreadyConsumed.make({}),
      })
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          ExecutorTransportFailure: () =>
            Effect.succeed(ExecutorResumeOutcome.cases.OutcomeUnknown.make({})),
          ExecutorExecutionUncertain: () =>
            Effect.succeed(ExecutorResumeOutcome.cases.OutcomeUnknown.make({})),
          ExecutorResponseInvalid: () =>
            Effect.succeed(ExecutorResumeOutcome.cases.OutcomeUnknown.make({})),
          ExecutorRejected: ({ message }) =>
            Effect.succeed(ExecutorResumeOutcome.cases.Failed.make({ reason: message })),
        }),
      ),
  )
}

/** Acquire network and cryptographic authority once and hide both behind the product seam. */
const makeConfigured = Effect.fn('Executor.configure')(function* (
  url: string,
  key: Redacted.Redacted,
) {
  const transport = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const client = HttpClient.mapRequest(transport, (request) =>
    request.pipe(
      HttpClientRequest.prependUrl(url),
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.acceptJson,
    ),
  )
  const http = makeHttp(client)
  return Executor.of({
    catalog: Effect.fn('Executor.catalog')(function* () {
      return (yield* http.readCatalog(
        Effect.succeed(HttpClientRequest.get('/dashboard/api/catalog')),
        null,
      )).flatMap(catalogEntry)
    }),
    begin: makeBegin(http, crypto),
    complete: makeComplete(http),
    completeSignIn: makeCompleteSignIn(http),
    status: makeStatus(http),
    remove: makeRemove(http),
    tools: makeTools(http),
    call: makeCall(http),
    resume: makeResume(http),
  })
})

/** Missing configuration is an expected installation state. Acquisition succeeds and every operation
 * fails with the same contract error without contacting any network dependency.
 */
export const executorLayer = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const url = yield* Config.option(Config.String('VIVID_EXECUTOR_URL'))
    const key = yield* Config.option(Config.Redacted('VIVID_EXECUTOR_KEY'))
    if (Option.isNone(url) || Option.isNone(key)) {
      const unavailable = Effect.fail(
        ServiceUnavailable.make({
          service: 'connections',
          message: 'Configure VIVID_EXECUTOR_URL and VIVID_EXECUTOR_KEY to use Connections',
        }),
      )
      return Executor.of({
        catalog: Effect.fn('Executor.catalog')(() => unavailable),
        begin: Effect.fn('Executor.begin')(() => unavailable),
        complete: Effect.fn('Executor.complete')(() => unavailable),
        completeSignIn: Effect.fn('Executor.completeSignIn')(() => unavailable),
        status: Effect.fn('Executor.status')(() => unavailable),
        remove: Effect.fn('Executor.remove')(() => unavailable),
        tools: Effect.fn('Executor.tools')(() => unavailable),
        call: Effect.fn('Executor.call')(() => unavailable),
        resume: Effect.fn('Executor.resume')(() => unavailable),
      })
    }
    return yield* makeConfigured(url.value, key.value)
  }),
).pipe(Layer.provide([FetchHttpClient.layer, NodeCrypto.layer]))
