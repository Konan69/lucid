import {
  ActionEffect,
  ConnectionId,
  ServiceAuthorization,
  ServiceId,
  ServiceUnavailable,
} from '@vivid/contracts'
import * as Config from 'effect/Config'
import * as Arr from 'effect/Array'
import * as Cache from 'effect/Cache'
import * as Exit from 'effect/Exit'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as HashMap from 'effect/HashMap'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Record from 'effect/Record'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpBody from 'effect/unstable/http/HttpBody'

import { toolMessage } from './message.ts'
import { retainCatalog } from './catalog.ts'

export const ExecutorAppId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAppId'))
export const ExecutorAccountId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAccountId'))
export const ExecutorDeploymentId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorDeploymentId'))
export const ExecutorProfileId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProfileId'))
const ExecutorProviderId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProviderId'))
export const connectionSetupMessage = 'This service is not set up on this Vivid yet.'
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
/** Installation authority failures propagate as unavailable, never as a tool policy refusal. */
export class ExecutorAccessDenied extends Schema.TaggedError<ExecutorAccessDenied>()(
  'ExecutorAccessDenied',
  errorContext,
  { title: 'Connection access denied' },
) {}
/** Missing selections and expired OAuth grants require renewed authorization. */
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
/** Missing installation OAuth setup is distinct from a refused sign-in or invalid input. */
export class ExecutorSetupRequired extends Schema.TaggedError<ExecutorSetupRequired>()(
  'ExecutorSetupRequired',
  errorContext,
  { title: 'Connection setup required' },
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

/** Deleted foreign resources cannot be repaired by entering credentials again. */
export class ExecutorResourceMissing extends Schema.TaggedError<ExecutorResourceMissing>()(
  'ExecutorResourceMissing',
  { ...errorContext, resource: Schema.Literals(['App', 'Profile', 'Deployment', 'Account']) },
  { title: 'Connection resource missing' },
) {}
/** Every domain path explains permanent deletion consistently without upstream diagnostics. */
export function resourceReason(resource: ExecutorResourceMissing['resource']) {
  return `The saved ${resource.toLowerCase()} no longer exists.`
}
/** A failed compensation retains enough opaque identity for cleanup or a convergent begin retry. */
export class ExecutorCopyRetained extends Schema.TaggedError<ExecutorCopyRetained>()(
  'ExecutorCopyRetained',
  {
    references: Schema.TaggedUnion({
      Located: { service: ServiceId, app: ExecutorAppId, owner: ExecutorOwnerId },
      Named: { service: ServiceId, name: Schema.String, owner: ExecutorOwnerId },
    }),
  },
  { title: 'Connection copy retained' },
) {}

export type ExecutorFailure =
  | ServiceUnavailable
  | ExecutorTransportFailure
  | ExecutorResponseInvalid
  | ExecutorAccessDenied
  | ExecutorNotReady
  | ExecutorRejected
  | ExecutorSetupRequired
  | ExecutorConflict
  | ExecutorExecutionUncertain
  | ExecutorSignInRequired
  | ExecutorResourceMissing
  | ExecutorCopyRetained

const BeginInput = Schema.Struct({
  connectionId: ConnectionId,
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
const ResumeInput = Schema.Struct({
  references: ExecutorReferences,
  requestId: ExecutorRequestId,
  accept: Schema.Boolean,
})
const SignInInput = Schema.Struct({
  references: ExecutorReferences,
  callbackAddress: Schema.Redacted(Schema.String),
})

/** Owner is Executor's storage/filter identity, not permission. Subject independently attributes a
 * profile to the acting Person. The caller supplies both; this adapter never chooses their mapping.
 * See the SDK profile contract and the ownership evidence in findings-executor section 4.
 */
export interface ExecutorService {
  /** Inspect public service setup without issuing an account grant or starting sign-in. */
  readonly authorization: (input: {
    readonly service: ServiceId
    readonly returnAddress: string
  }) => Effect.Effect<ServiceAuthorization, ExecutorFailure>
  readonly catalog: () => Effect.Effect<
    readonly (typeof ExecutorServiceEntry.Type)[],
    ExecutorFailure
  >
  readonly begin: (
    input: typeof BeginInput.Type,
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure>
  /** Renew authorization without allocating another app, profile, or account. */
  readonly reauthorize: (
    input: typeof BeginInput.Type & { readonly references: ExecutorReferences },
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
const WireCatalogApp = Schema.Struct({
  id: ExecutorAppId,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({
        provider: ExecutorProviderId,
        definition: Requirement.fields.definition,
      }),
    ),
  }),
})
const WireSetup = Schema.Struct({
  mode: Schema.Literals(['automatic', 'saved', 'client-required']),
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
const WireCatalogEntry = Schema.Struct({
  id: ServiceId,
  kind: Schema.Literals(['openapi', 'mcp', 'graphql', 'cli']),
  name: Schema.String,
  description: Schema.String,
  connectUrl: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
  popularity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
const WireCatalog = Schema.Array(Schema.Unknown)
const decodeCatalogEntry = Schema.decodeUnknownEffect(WireCatalogEntry)
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
  Missing: { resource: Schema.Literals(['App', 'Profile', 'Deployment', 'Account']) },
  Conflict: {},
  Uncertain: {},
  Rejected: { message: Schema.String },
  SetupRequired: {},
})
const notReady = FailureMode.cases.NotReady.make({})
const conflict = FailureMode.cases.Conflict.make({})
const uncertain = FailureMode.cases.Uncertain.make({})
const denied = FailureMode.cases.AccessDenied.make({})
/** This table is the sole remote error vocabulary; wire decoding derives its finite tags from it.
 * Messages are owned here because upstream diagnostics must not reflect submitted secrets.
 */
const failureModes = {
  AppNotFound: FailureMode.cases.Missing.make({ resource: 'App' }),
  AppNotDeployed: notReady,
  DeploymentNotFound: FailureMode.cases.Missing.make({ resource: 'Deployment' }),
  AccountNotFound: FailureMode.cases.Missing.make({ resource: 'Account' }),
  AccountRequired: notReady,
  AccountSelectionInvalid: notReady,
  OAuthReconnectRequired: notReady,
  ProfileNotFound: FailureMode.cases.Missing.make({ resource: 'Profile' }),
  ProviderNotFound: notReady,
  AccountConnectionNotFound: notReady,
  AccountConnectionClosed: notReady,
  ToolBlocked: FailureMode.cases.Rejected.make({
    message: 'The service policy blocked this tool.',
  }),
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
  OAuthClientUnavailable: FailureMode.cases.SetupRequired.make({}),
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
const knownFailureTag = Schema.Literals(Record.keys(failureModes))
const isKnownFailureTag = Schema.is(knownFailureTag)
const WireFailure = Schema.Struct({ _tag: Schema.NonEmptyString })
const decodeFailure = Schema.decodeUnknownEffect(WireFailure)

/** Remote tags determine recovery; arbitrary messages and credential-bearing diagnostics are dropped. */
function translateFailure(tag: typeof knownFailureTag.Type, tool: string | null) {
  const context = { service: 'connections' as const, tool }
  return FailureMode.match(failureModes[tag], {
    NotReady: (): ExecutorFailure => ExecutorNotReady.make(context),
    SetupRequired: (): ExecutorFailure => ExecutorSetupRequired.make(context),
    Missing: ({ resource }): ExecutorFailure =>
      ExecutorResourceMissing.make({ ...context, resource }),
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
        if (response.status === 401) {
          return yield* Effect.fail(ExecutorAccessDenied.make(context))
        }
        if (response.status >= 500)
          return yield* Effect.fail(ExecutorExecutionUncertain.make(context))
        const body = yield* response.json.pipe(
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
        if (response.status >= 200 && response.status < 300) {
          return yield* decode(body).pipe(
            Effect.mapError(() => ExecutorResponseInvalid.make(context)),
          )
        }
        const failure = yield* decodeFailure(body).pipe(
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
        if (!isKnownFailureTag(failure._tag))
          return yield* Effect.fail(
            ExecutorRejected.make({
              ...context,
              message: 'The service refused this request before running the tool.',
            }),
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
 * These are method hints; cached setup inspection selects a usable method before a service is
 * offered or a Connection begins. Mixed imports retain both methods during inspection.
 */
function catalogEntry(entry: typeof WireCatalogEntry.Type) {
  if (entry.kind !== 'mcp' || entry.connectUrl === undefined || entry.auth === undefined) return []
  const authorization = Match.value(entry.auth.kind).pipe(
    Match.when('none', () => ServiceAuthorization.cases.None.make({})),
    Match.whenOr('oauth', 'mixed', () => ServiceAuthorization.cases.SignIn.make({})),
    Match.when('api_key', () => ServiceAuthorization.cases.Key.make({ fields: [] })),
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
    return ExecutorCallOutcome.cases.Rejected.make({ message: toolMessage(result.value) })
  return ExecutorCallOutcome.cases.Completed.make({ value: result.value })
}

/** Reconciliation, discovery and invocation have no Executor owner predicate. Their tenancy
 * boundary is Vivid's scoped Connection lookup; resume additionally checks the stored owner.
 */
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
  const readApps = read(Schema.Array(WireApp))
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
    readApps,
    readProfile,
    readConnection,
    readAccount,
    readCatalog,
    readTools,
    readCall,
    readResume,
    readSignIn,
    readRemoval,
    readCatalogApp: read(WireCatalogApp),
    readCatalogApps: read(Schema.Array(WireCatalogApp)),
    readSetup: read(WireSetup),
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
        onNone: () =>
          `/v1/tools?app=${query(references.app)}&profile=${query(references.profile)}&limit=2000`,
        onSome: ({ deployment, revision }) =>
          `/v1/tools?app=${query(references.app)}&profile=${query(references.profile)}&deployment=${query(deployment)}&expectedProfileRevision=${revision}&limit=2000`,
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
function makeTools(discover: ReturnType<typeof makeDiscovery>) {
  return Effect.fn('Executor.tools')(function* (references: ExecutorReferences) {
    return (yield* discover(references)).items
  })
}

/** Native targeted requests atomically select the saved account into the exact profile. */
function makeAuthorize(
  http: ExecutorHttp,
  recordSetupRequired: (service: ServiceId) => Effect.Effect<void>,
) {
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
      SetupRequired: () => [],
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
    // Pending requests are reusable; reconnects bind the existing account so completion cannot duplicate it.
    const connection = ExecutorReferences.isAnyOf(['EnteringKey', 'SigningIn'])(references)
      ? { id: references.authorization }
      : yield* http.readConnection(
          post(
            '/v1/account-connections',
            ExecutorReferences.guards.Authorized(references)
              ? {
                  owner: input.owner,
                  target: { app: app.id, profile: references.profile, requirement },
                  account: references.account,
                }
              : {
                  owner: input.owner,
                  target: { app: app.id, profile: references.profile, requirement },
                },
          ),
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
        const labels = keyFields(fields)
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
            Effect.catchTags({
              ExecutorSetupRequired: () =>
                recordSetupRequired(input.service).pipe(
                  Effect.andThen(
                    Effect.fail(
                      ExecutorSignInRequired.make({
                        references: pending,
                        message: connectionSetupMessage,
                      }),
                    ),
                  ),
                ),
              ExecutorRejected: ({ message }) =>
                Effect.fail(ExecutorSignInRequired.make({ references: pending, message })),
            }),
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
          ExecutorResourceMissing: ({ resource }) =>
            Effect.succeed(
              ExecutorStatus.cases.Failed.make({
                reason: resourceReason(resource),
              }),
            ),
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

/** Catalog decoding isolates unsupported kinds, while malformed entries of a known kind still
 * fail honestly. One cached snapshot serves both discovery and Connection setup.
 */
function makeCatalog(http: ExecutorHttp) {
  const decodeKind = Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.String }))
  const knownKind = Schema.is(WireCatalogEntry.fields.kind)
  return Effect.fn('Executor.catalog')(function* () {
    const entries = yield* http.readCatalog(
      Effect.succeed(HttpClientRequest.get('/dashboard/api/catalog?limit=2000')),
      null,
    )
    const decoded = yield* Effect.forEach(
      entries,
      Effect.fn('Executor.catalogEntry')(function* (entry) {
        const { kind } = yield* decodeKind(entry).pipe(
          Effect.mapError(() =>
            ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
          ),
        )
        if (!knownKind(kind)) return []
        const value = yield* decodeCatalogEntry(entry).pipe(
          Effect.mapError(() =>
            ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
          ),
        )
        return catalogEntry(value).map((service) => ({
          service,
          popularity: Option.fromNullishOr(value.popularity),
        }))
      }),
    )
    return Arr.sort(decoded.flat(), comparePopularity).map((entry) => entry.service)
  })
}

/** The live catalog carries numbers on curated entries, one explicit null, and omitted keys
 * elsewhere. Numeric popularity sorts first, descending; ties and absent values retain wire order.
 */
function comparePopularity(
  left: { readonly popularity: Option.Option<number> },
  right: { readonly popularity: Option.Option<number> },
) {
  if (Option.isNone(left.popularity)) return Option.isSome(right.popularity) ? 1 : 0
  if (Option.isNone(right.popularity)) return -1
  return Order.Number(right.popularity.value, left.popularity.value)
}

/** Key names and labels come from the imported declaration, never a guessed catalog form. */
function keyFields(fields: typeof AuthorizationMethod.cases.secrets.fields.fields.Type) {
  return Object.entries(fields.properties).map(([name, field]) => ({
    name,
    label: field.title === undefined ? name : field.title,
  }))
}

/** Register only a public provider definition. The deterministic name recovers a lost import
 * response; this temporary app never contains an account, profile or credential.
 */
function makeCatalogTemplate(http: ExecutorHttp) {
  return Effect.fn('Executor.catalogTemplate')(function* (entry: typeof ExecutorServiceEntry.Type) {
    const name = `Vivid catalog ${entry.id}`
    const inventory = Effect.succeed(
      HttpClientRequest.get(`/v1/apps?owner=local&name=${query(name)}`),
    )
    const previous = (yield* http.readCatalogApps(inventory, null))[0]
    if (previous !== undefined) return previous
    return yield* http
      .readCatalogApp(
        post('/dashboard/api/catalog/import', {
          entry: entry.id,
          name,
          mcpAuth: 'auto',
        }),
        null,
      )
      .pipe(
        Effect.catch(
          Effect.fn('Executor.recoverCatalogTemplate')(function* (error) {
            const imported = (yield* http.readCatalogApps(inventory, null))[0]
            if (imported !== undefined) return imported
            return yield* Effect.fail(error)
          }),
        ),
      )
  })
}

/** Only client-required establishes absent operator setup. A declared key remains usable when
 * sign-in is unavailable; automatic/saved sign-in retains priority for mixed services.
 */
function makeInspectSetup(http: ExecutorHttp) {
  return Effect.fn('Executor.inspectSetup')(function* (
    requirement: (typeof WireCatalogApp.Type)['requirements']['accounts'][string],
    returnAddress: string,
  ) {
    const methods = Object.entries(requirement.definition.auth)
    const signIn = methods.find(([, method]) => AuthorizationMethod.guards.oauth2(method))
    const key = methods.find(([, method]) => AuthorizationMethod.guards.secrets(method))
    if (signIn !== undefined) {
      const setup = yield* http.readSetup(
        post('/v1/account-connections/oauth/setup', {
          owner: 'local',
          provider: requirement.provider,
          method: signIn[0],
          redirectUri: returnAddress,
        }),
        null,
      )
      if (setup.mode !== 'client-required') return ServiceAuthorization.cases.SignIn.make({})
    }
    if (key !== undefined && AuthorizationMethod.guards.secrets(key[1]))
      return ServiceAuthorization.cases.Key.make({ fields: keyFields(key[1].fields) })
    if (signIn === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This service does not declare a supported sign-in or key method.',
        }),
      )
    return ServiceAuthorization.cases.SetupRequired.make({})
  })
}

/** Metadata registration is deduplicated per service. Removing the temporary app keeps the
 * shared provider definition registered (SDK apps.remove), so subsequent inspection is read-only.
 * A failed delete remains a typed failure; the same name lets a retry recover the public app.
 */
function makeCatalogDefinition(http: ExecutorHttp, catalog: ExecutorService['catalog']) {
  const template = makeCatalogTemplate(http)
  return Effect.fn('Executor.catalogDefinition')(function* (service: ServiceId) {
    const entry = (yield* catalog()).find((candidate) => candidate.id === service)
    if (entry === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Choose a service from the current catalog.',
        }),
      )
    const app = yield* template(entry)
    const requirements = Object.values(app.requirements.accounts)
    const requirement = requirements[0]
    yield* http.readRemoval(
      Effect.succeed(HttpClientRequest.make('DELETE')(`/v1/apps/${query(app.id)}?owner=local`)),
      null,
    )
    if (requirements.length !== 1 || requirement === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This service does not declare one supported account.',
        }),
      )
    return requirement
  })
}

/** Inspection is shared across callers and bounded at the complete service operation (including
 * definition import/delete). Failures become negative availability for ten minutes, rather than
 * failing catalog readers. The retained facts are a snapshot, never a request-triggered lookup.
 */
const makeAuthorization = Effect.fn('Executor.authorizationCache')(function* (
  http: ExecutorHttp,
  catalog: ExecutorService['catalog'],
) {
  const inspect = makeInspectSetup(http)
  const permits = yield* Semaphore.make(4)
  const facts = yield* Ref.make(HashMap.empty<ServiceId, ServiceAuthorization>())
  const failures = yield* Ref.make(HashMap.empty<ServiceId, string>())
  const definitions = yield* Cache.makeWith(makeCatalogDefinition(http, catalog), {
    capacity: 1000,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? '10 minutes' : 0),
  })
  /** Publish each completed inspection separately so a slow service never delays its peers.
   * Log only the service identity and typed failure tag, once on entering failed availability.
   */
  const record = Effect.fn('Executor.recordAvailability')(function* (
    service: ServiceId,
    authorization: ServiceAuthorization,
    failure: Option.Option<string>,
  ) {
    yield* Ref.update(facts, (current) => HashMap.set(current, service, authorization))
    const previous = yield* Ref.modify(failures, (current) => [
      HashMap.get(current, service),
      Option.match(failure, {
        onNone: () => HashMap.remove(current, service),
        onSome: (tag) => HashMap.set(current, service, tag),
      }),
    ])
    if (Option.isSome(failure) && Option.isNone(previous)) {
      yield* Effect.logWarning('Connection setup inspection failed').pipe(
        Effect.annotateLogs({ serviceId: service, failure: failure.value }),
      )
    }
  })
  const inspections = yield* Cache.makeWith(
    Effect.fn('Executor.inspectAuthorization')(function* (input: {
      readonly service: ServiceId
      readonly returnAddress: string
    }) {
      const entry = (yield* catalog()).find((candidate) => candidate.id === input.service)
      if (entry === undefined)
        return yield* Effect.fail(
          ExecutorRejected.make({
            service: 'connections',
            tool: null,
            message: 'Choose a service from the current catalog.',
          }),
        )
      if (ServiceAuthorization.guards.None(entry.authorization)) return entry.authorization
      const authorization = yield* permits.withPermits(1)(
        Effect.gen(function* () {
          return yield* inspect(yield* Cache.get(definitions, input.service), input.returnAddress)
        }).pipe(
          Effect.timeout('5 seconds'),
          Effect.tap((value) => record(input.service, value, Option.none())),
          Effect.catch(
            Effect.fn('Executor.unavailableSetup')(function* (error) {
              const unavailable = ServiceAuthorization.cases.SetupRequired.make({})
              yield* record(input.service, unavailable, Option.some(error._tag))
              return unavailable
            }),
          ),
        ),
      )
      return authorization
    }),
    {
      capacity: 1000,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? '10 minutes' : 0),
    },
  )
  return {
    authorization: Effect.fn('Executor.authorization')(
      (input: { readonly service: ServiceId; readonly returnAddress: string }) =>
        Cache.get(inspections, input),
    ),
    catalog: Effect.fn('Executor.availableCatalog')(function* () {
      const entries = yield* catalog()
      const current = yield* Ref.get(facts)
      return entries.map((entry) =>
        HashMap.get(current, entry.id).pipe(
          Option.match({
            onNone: () => entry,
            onSome: (authorization) => ExecutorServiceEntry.make({ ...entry, authorization }),
          }),
        ),
      )
    }),
    recordSetupRequired: Effect.fn('Executor.recordSetupRequired')((service: ServiceId) =>
      record(service, ServiceAuthorization.cases.SetupRequired.make({}), Option.none()),
    ),
  }
})

/** A failed copy response is not proof of refusal. Recover its exact opaque identity; if the
 * inventory is also unavailable, retain the owner/name predicate for a later convergent retry.
 */
function makeRecoverCopy(http: ExecutorHttp) {
  return Effect.fn('Executor.recoverCopy')(function* (
    input: typeof BeginInput.Type,
    name: string,
    error: ExecutorFailure,
  ) {
    const retained = yield* http
      .readApps(
        Effect.succeed(
          HttpClientRequest.get(`/v1/apps?owner=${query(input.owner)}&name=${query(name)}`),
        ),
        null,
      )
      .pipe(
        Effect.mapError(() =>
          ExecutorCopyRetained.make({
            references: ExecutorCopyRetained.fields.references.cases.Named.make({
              service: input.service,
              owner: input.owner,
              name,
            }),
          }),
        ),
      )
    const app = retained[0]
    if (app !== undefined) return app
    return yield* Effect.fail(error)
  })
}

/** Deterministic names recover a copied app after a lost copy response. Exact owner/name lookup
 * is essential: the installation client itself may list resources belonging to every owner.
 */
function makeCopy(http: ExecutorHttp) {
  const recover = makeRecoverCopy(http)
  return Effect.fn('Executor.copy')(function* (
    input: typeof BeginInput.Type,
    entry: typeof ExecutorServiceEntry.Type,
  ) {
    const name = `Vivid Connection ${input.connectionId}`
    const existing = yield* http.readApps(
      Effect.succeed(
        HttpClientRequest.get(`/v1/apps?owner=${query(input.owner)}&name=${query(name)}`),
      ),
      null,
    )
    const previous = existing[0]
    const templateName = `Vivid template ${input.connectionId}`
    const templates = yield* http
      .readApps(
        Effect.succeed(HttpClientRequest.get(`/v1/apps?owner=local&name=${query(templateName)}`)),
        null,
      )
      .pipe(
        Effect.mapError((error) =>
          previous === undefined
            ? error
            : ExecutorCopyRetained.make({
                references: ExecutorCopyRetained.fields.references.cases.Located.make({
                  service: input.service,
                  app: previous.id,
                  owner: input.owner,
                }),
              }),
        ),
      )
    const template = templates[0]
    if (previous !== undefined) {
      if (template !== undefined)
        yield* http
          .readRemoval(
            Effect.succeed(
              HttpClientRequest.make('DELETE')(`/v1/apps/${query(template.id)}?owner=local`),
            ),
            null,
          )
          .pipe(
            Effect.mapError(() =>
              ExecutorCopyRetained.make({
                references: ExecutorCopyRetained.fields.references.cases.Located.make({
                  service: input.service,
                  app: previous.id,
                  owner: input.owner,
                }),
              }),
            ),
          )
      return previous
    }
    const imported =
      template === undefined
        ? yield* http.readApp(
            post('/dashboard/api/catalog/import', {
              entry: entry.id,
              name: templateName,
              mcpAuth: yield* importAuthorization(entry.authorization),
            }),
            null,
          )
        : template
    const app = yield* http
      .readApp(
        post('/v1/apps/copies', {
          from: imported.id,
          owner: input.owner,
          name,
        }),
        null,
      )
      .pipe(Effect.catch((error) => recover(input, name, error)))
    // Cleanup failures carry the copy identity; the same Connection id recovers it on retry.
    yield* http
      .readRemoval(
        Effect.succeed(
          HttpClientRequest.make('DELETE')(`/v1/apps/${query(imported.id)}?owner=local`),
        ),
        null,
      )
      .pipe(
        Effect.mapError(() =>
          ExecutorCopyRetained.make({
            references: ExecutorCopyRetained.fields.references.cases.Located.make({
              service: input.service,
              app: app.id,
              owner: input.owner,
            }),
          }),
        ),
      )
    return app
  })
}

const isSignInRequired = Schema.is(ExecutorSignInRequired)

/** A setup failure cannot strand an unreferenced owner copy. If compensation also fails, retain
 * its opaque identity in a typed error instead of pretending cleanup succeeded.
 */
function makeCompensation(http: ExecutorHttp) {
  return Effect.fn('Executor.compensate')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    error: ExecutorFailure,
  ) {
    if (isSignInRequired(error)) return yield* Effect.fail(error)
    yield* http
      .readRemoval(
        Effect.succeed(
          HttpClientRequest.make('DELETE')(`/v1/apps/${query(app.id)}?owner=${query(input.owner)}`),
        ),
        null,
      )
      .pipe(
        Effect.mapError(() =>
          ExecutorCopyRetained.make({
            references: ExecutorCopyRetained.fields.references.cases.Located.make({
              service: input.service,
              app: app.id,
              owner: input.owner,
            }),
          }),
        ),
      )
    return yield* Effect.fail(error)
  })
}

/** Profile creation uses the caller's Connection id as its idempotency key. Post-copy failures
 * either preserve a pending authorization or remove the copy before reporting the failure.
 */
function makeBegin(
  http: ExecutorHttp,
  catalog: ExecutorService['catalog'],
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
) {
  const reconcile = makeReconcile(http)
  const authorize = makeAuthorize(http, availability.recordSetupRequired)
  const copy = makeCopy(http)
  const compensate = makeCompensation(http)
  const configure = Effect.fn('Executor.configureCopy')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    entry: typeof ExecutorServiceEntry.Type,
  ) {
    const profile = yield* http.readProfile(
      post(`/v1/apps/${query(app.id)}/profiles`, {
        owner: input.owner,
        subject: input.subject,
        accounts: {},
        idempotencyKey: input.connectionId,
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
      const state = yield* reconcile(references)
      if (state.status !== 'ready')
        return yield* Effect.fail(ExecutorNotReady.make({ service: 'connections', tool: null }))
      return ExecutorStep.cases.Done.make({ references })
    }
    return yield* authorize(input, app, references, entry.authorization)
  })
  return Effect.fn('Executor.begin')(function* (input: typeof BeginInput.Type) {
    const entry = (yield* catalog()).find((candidate) => candidate.id === input.service)
    if (entry === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Choose a supported service from the current catalog.',
        }),
      )
    const selected = yield* availability.authorization({
      service: input.service,
      returnAddress: input.returnAddress,
    })
    if (ServiceAuthorization.guards.SetupRequired(selected))
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: connectionSetupMessage,
        }),
      )
    const resolved = ExecutorServiceEntry.make({ ...entry, authorization: selected })
    const app = yield* copy(input, resolved)
    return yield* configure(input, app, resolved).pipe(
      Effect.catch((error) => compensate(input, app, error)),
    )
  })
}

/** Read the saved target first. Closed pending requests are cancelled before replacement;
 * completed requests resolve to their existing account and reconnect through that same identity.
 */
function makeReauthorize(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
) {
  const authorize = makeAuthorize(http, availability.recordSetupRequired)
  const status = makeStatus(http)
  const cancel = makeResolveRemovalAccount(http)
  return Effect.fn('Executor.reauthorize')(function* (
    input: typeof BeginInput.Type & { readonly references: ExecutorReferences },
  ) {
    let references = input.references
    if (ExecutorReferences.isAnyOf(['EnteringKey', 'SigningIn'])(references)) {
      const pending = yield* http.readConnection(
        Effect.succeed(
          HttpClientRequest.get(
            `/v1/account-connections/${query(references.authorization)}?owner=${query(references.owner)}`,
          ),
        ),
        null,
      )
      if (WireConnection.fields.state.guards.completed(pending.state)) {
        references = ExecutorReferences.cases.Authorized.make({
          ...referenceIdentity(references),
          account: pending.state.account.id,
        })
      } else if (!WireConnection.fields.state.guards.pending(pending.state)) {
        yield* cancel(references)
        references = ExecutorReferences.cases.Public.make(referenceIdentity(references))
      }
    }
    if (!ExecutorReferences.isAnyOf(['EnteringKey', 'SigningIn'])(references)) {
      const current = yield* status(references)
      if (
        ExecutorStatus.guards.Ready(current) &&
        ExecutorReferences.isAnyOf(['Public', 'Authorized'])(current.references)
      )
        return ExecutorStep.cases.Done.make({ references: current.references })
      if (ExecutorStatus.guards.Failed(current))
        return yield* Effect.fail(
          ExecutorRejected.make({ service: 'connections', tool: null, message: current.reason }),
        )
    }
    const selected = yield* availability.authorization({
      service: input.service,
      returnAddress: input.returnAddress,
    })
    if (ServiceAuthorization.guards.SetupRequired(selected))
      return yield* Effect.fail(ExecutorSetupRequired.make({ service: 'connections', tool: null }))
    const app = yield* http.readApp(
      Effect.succeed(
        HttpClientRequest.get(`/v1/apps/${query(references.app)}?owner=${query(references.owner)}`),
      ),
      null,
    )
    return yield* authorize(input, app, references, selected)
  })
}

/** Unavailable choices fail before import rather than becoming an invented import method. */
function importAuthorization(authorization: ServiceAuthorization) {
  return ServiceAuthorization.match<Effect.Effect<string, ExecutorRejected>>(authorization, {
    SignIn: () => Effect.succeed('auto'),
    Key: () => Effect.succeed('apiKey'),
    None: () => Effect.succeed('none'),
    SetupRequired: () =>
      Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: connectionSetupMessage,
        }),
      ),
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
function makeCall(http: ExecutorHttp, discover: ReturnType<typeof makeDiscovery>) {
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
            ExecutorTransportFailure: () =>
              Effect.succeed(ExecutorCallOutcome.cases.OutcomeUnknown.make({})),
            ExecutorExecutionUncertain: () =>
              Effect.succeed(ExecutorCallOutcome.cases.OutcomeUnknown.make({})),
            ExecutorResponseInvalid: () =>
              Effect.succeed(ExecutorCallOutcome.cases.OutcomeUnknown.make({})),
          }),
        )
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          ExecutorNotReady: () => Effect.succeed(ExecutorCallOutcome.cases.NotReady.make({})),
          ExecutorRejected: ({ message }) =>
            Effect.succeed(ExecutorCallOutcome.cases.Rejected.make({ message })),
        }),
      ),
  )
}

/** Consent resumes only the saved invocation. Lost execution results are never replayed. */
function makeResume(http: ExecutorHttp) {
  return Effect.fn('Executor.resume')(
    function* ({ references, requestId, accept }: typeof ResumeInput.Type) {
      const response = accept
        ? { action: 'accept', content: {} }
        : { action: 'decline', content: {} }
      const result = yield* http.readResume(
        post('/v1/tools/resume', { owner: references.owner, requestId, response }),
        null,
      )
      return WireResume.match(result, {
        completed: ({ value, toolError }) =>
          toolError === true
            ? ExecutorResumeOutcome.cases.Failed.make({ reason: toolMessage(value) })
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

/** Acquire transport once and start the scoped catalog writer; tool discovery remains keyed. */
const makeConfigured = Effect.fn('Executor.configure')(function* (
  url: string,
  key: Redacted.Redacted,
) {
  const transport = yield* HttpClient.HttpClient
  const client = HttpClient.mapRequest(transport, (request) =>
    request.pipe(
      HttpClientRequest.prependUrl(url),
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.acceptJson,
    ),
  )
  const http = makeHttp(client)
  const catalog = yield* retainCatalog(
    makeCatalog(http)().pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({ service: 'connections', message: 'The catalog is unavailable.' }),
      ),
    ),
  )
  const snapshots = yield* Cache.makeWith(makeDiscovery(http), {
    capacity: 1000,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? '5 minutes' : 0),
  })
  const availability = yield* makeAuthorization(http, catalog)
  const discover = Effect.fn('Executor.discoverCached')((references: ExecutorReferences) =>
    Cache.get(snapshots, references),
  )
  const complete = makeComplete(http)
  const completeSignIn = makeCompleteSignIn(http)
  const remove = makeRemove(http)
  const call = makeCall(http, discover)
  return Executor.of({
    catalog: availability.catalog,
    authorization: availability.authorization,
    begin: makeBegin(http, catalog, availability),
    reauthorize: makeReauthorize(http, availability),
    complete: Effect.fn('Executor.completeCached')(function* (input: typeof CompleteInput.Type) {
      const references = yield* complete(input)
      yield* Cache.invalidate(snapshots, input.references)
      return references
    }),
    completeSignIn: Effect.fn('Executor.completeSignInCached')(function* (
      input: typeof SignInInput.Type,
    ) {
      const references = yield* completeSignIn(input)
      yield* Cache.invalidate(snapshots, input.references)
      return references
    }),
    status: makeStatus(http),
    remove: Effect.fn('Executor.removeCached')(function* (references: ExecutorReferences) {
      yield* remove(references)
      yield* Cache.invalidate(snapshots, references)
    }),
    tools: makeTools(discover),
    call: Effect.fn('Executor.callCached')((input: typeof CallInput.Type) =>
      call(input).pipe(
        Effect.catchTag('ExecutorConflict', () =>
          Cache.invalidate(snapshots, input.references).pipe(
            Effect.as(
              ExecutorCallOutcome.cases.Rejected.make({
                message: 'The Connection changed; discover its tools again.',
              }),
            ),
          ),
        ),
        Effect.tap((outcome) =>
          ExecutorCallOutcome.guards.NotReady(outcome)
            ? Cache.invalidate(snapshots, input.references)
            : Effect.void,
        ),
        Effect.tapError(() => Cache.invalidate(snapshots, input.references)),
      ),
    ),
    resume: makeResume(http),
  })
})

/** Requires HttpClient.HttpClient (provide FetchHttpClient.layer or NodeHttpClient.layerNodeHttp).
 * Missing configuration is an expected installation state. Acquisition succeeds and every operation
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
        authorization: Effect.fn('Executor.authorization')(() => unavailable),
        begin: Effect.fn('Executor.begin')(() => unavailable),
        reauthorize: Effect.fn('Executor.reauthorize')(() => unavailable),
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
)
