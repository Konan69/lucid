import * as NodeCrypto from 'node:crypto'
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
import * as Clock from 'effect/Clock'
import * as Exit from 'effect/Exit'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as RcMap from 'effect/RcMap'
import * as Result from 'effect/Result'
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

import { toolRejectionMessage, validationProblems } from './message.ts'
import { retainCatalog } from './catalog.ts'
import { ConnectionSource } from './address.ts'
import { ExecutorSourceUnsupported, ExecutorImportQueryUnsupported } from './source.ts'
export { ExecutorSourceUnsupported, ExecutorImportQueryUnsupported } from './source.ts'
import {
  encodeGoogleClient,
  googleApp,
  GoogleState,
  decodeGoogleState,
  loadGoogleInstallation,
  type GoogleInstallation,
} from './google.ts'

export const ExecutorAppId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAppId'))
export const ExecutorAccountId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAccountId'))
export const ExecutorDeploymentId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorDeploymentId'))
export const ExecutorProfileId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProfileId'))
const ExecutorOrganizationId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorOrganizationId'))
const ExecutorProviderId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProviderId'))
export const connectionSetupMessage = 'This integration is not set up on this Vivid yet.'
export const ExecutorOwnerId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorOwnerId'))
export const ExecutorAuthorizationId = Schema.NonEmptyString.pipe(
  Schema.brand('ExecutorAuthorizationId'),
)

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
  /** Vivid retains a one-way callback correlation only after Executor supplies its provider URL. */
  OAuthSigningIn: {
    ...referenceFields,
    authorization: ExecutorAuthorizationId,
    stateHash: Schema.NonEmptyString,
  },
  /** Google has a registered fixed callback and must persist its exact protocol correlation. */
  GoogleSigningIn: {
    ...referenceFields,
    authorization: ExecutorAuthorizationId,
    googleState: GoogleState,
  },
  Authorized: { ...referenceFields, account: ExecutorAccountId },
})
export type ExecutorReferences = typeof ExecutorReferences.Type

export const ExecutorServiceEntry = Schema.Struct({
  id: ServiceId,
  name: Schema.String,
  description: Schema.String,
  authorization: ServiceAuthorization,
})
const SignInReferences = Schema.Union([
  ExecutorReferences.cases.SigningIn,
  ExecutorReferences.cases.OAuthSigningIn,
  ExecutorReferences.cases.GoogleSigningIn,
])
const isSigningIn = ExecutorReferences.isAnyOf(['SigningIn', 'OAuthSigningIn', 'GoogleSigningIn'])
const isPending = ExecutorReferences.isAnyOf([
  'EnteringKey',
  'SigningIn',
  'OAuthSigningIn',
  'GoogleSigningIn',
])

export const ExecutorStep = Schema.TaggedUnion({
  OpenSignIn: { references: SignInReferences, address: Schema.String },
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
  // An omitted provider schema is genuine absence; schema constructors normalize it to None.
  output: Schema.Option(Schema.Json).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  effect: ActionEffect,
})
export const ExecutorCallOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  Rejected: {
    message: Schema.String,
    problems: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  },
  NotReady: {},
  OutcomeUnknown: {},
})
const errorContext = { service: Schema.Literal('connections'), tool: Schema.NullOr(Schema.String) }
/** MCP and OpenAPI URL registration need Executor's own public-only egress, since it resolves
 * the checked URL again. The operator must disable loopback access and private-origin exceptions
 * before declaring VIVID_EXECUTOR_PUBLIC_ONLY and enabling either import kind.
 */
export class ExecutorPublicAddressRequired extends Schema.TaggedError<ExecutorPublicAddressRequired>()(
  'ExecutorPublicAddressRequired',
  {},
  { title: 'Public integration address enforcement required' },
) {}

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
/** HostedTools.call (apps/hosted/server/src/contracts/tools.ts) returns SDK InputInvalid
 * (packages/sdk/src/contracts/tools.ts): problems is an array of safe validation summaries.
 * Keep that failure distinct from policy/transport refusal so input can be corrected and retried.
 * Foreign identities are intentionally excluded; summaries are filtered against call references before projection.
 */
export class ExecutorInputInvalid extends Schema.TaggedError<ExecutorInputInvalid>()(
  'ExecutorInputInvalid',
  { ...errorContext, problems: Schema.Array(Schema.String) },
  { title: 'Integration tool input invalid' },
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
/** A create-only install can lose a race to another Vivid process. Its exact name is safely
 * reread once; unrelated profile/account conflicts must never trigger inventory recovery.
 */
export class ExecutorAppNameTaken extends Schema.TaggedError<ExecutorAppNameTaken>()(
  'ExecutorAppNameTaken',
  errorContext,
  { title: 'Integration app name already installed' },
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

/** Lost sign-in responses retain the pending target so Resume can resolve it rather than duplicate it. */
export class ExecutorAuthorizationUnavailable extends Schema.TaggedError<ExecutorAuthorizationUnavailable>()(
  'ExecutorAuthorizationUnavailable',
  { references: ExecutorReferences.cases.SigningIn },
  { title: 'Connection authorization unavailable' },
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
/** Hosted approval responses have no resumable request; Vivid must refuse without inventing one.
 * Management failures have no tool context; neither path invents a resumable request.
 */
export class ExecutorApprovalUnsupported extends Schema.TaggedError<ExecutorApprovalUnsupported>()(
  'ExecutorApprovalUnsupported',
  { tool: Schema.NullOr(Schema.String) },
  { title: 'Integration approval unsupported' },
) {}

export type ExecutorFailure =
  | ExecutorSourceUnsupported
  | ExecutorImportQueryUnsupported
  | ExecutorPublicAddressRequired
  | ServiceUnavailable
  | ExecutorTransportFailure
  | ExecutorResponseInvalid
  | ExecutorAccessDenied
  | ExecutorNotReady
  | ExecutorRejected
  | ExecutorInputInvalid
  | ExecutorSetupRequired
  | ExecutorConflict
  | ExecutorAppNameTaken
  | ExecutorExecutionUncertain
  | ExecutorSignInRequired
  | ExecutorAuthorizationUnavailable
  | ExecutorResourceMissing
  | ExecutorApprovalUnsupported

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
const SignInInput = Schema.Struct({
  references: ExecutorReferences,
  callbackAddress: Schema.Redacted(Schema.String),
})

/** Owner and subject remain caller inputs for the later owner-to-organization mapping, but are
 * never sent to Executor. HostedProfiles in apps/hosted/server/src/contracts/profiles.ts
 * derives both from authenticated membership.
 * Until tenancy moves there, Vivid isolates Connections by sending only their saved app/profile/
 * account references; it never discovers an account by name or selects one from inventory.
 */
export interface ExecutorService {
  /** Installation absence is stable and must not start background network workers. */
  readonly configured: boolean
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
  /** Register a URL source, then use the same profile and authorization path as catalogue imports. */
  readonly add: (
    input: typeof BeginInput.Type & { readonly source: ConnectionSource },
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
  provider: ExecutorProviderId,
  definition: Schema.Struct({ auth: Schema.Record(Schema.String, AuthorizationMethod) }),
})
const WireApp = Schema.Struct({
  id: ExecutorAppId,
  name: Schema.NonEmptyString,
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Requirement) }),
})
// Inventory identifies shared code only. Unrelated apps may use requirement shapes this
// adapter cannot authorize; decode requirements only on the selected app's detail endpoint.
const WireInventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: ExecutorAppId, name: Schema.NonEmptyString })),
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
  reconnectAccount: Schema.NullOr(WireAccount),
  target: Schema.NullOr(Schema.Struct({ app: ExecutorAppId, profile: ExecutorProfileId })),
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
  outputSchema: Schema.optionalKey(Schema.Json),
  readOnly: Schema.optionalKey(Schema.Boolean),
  annotations: Schema.optionalKey(
    Schema.Struct({
      readOnlyHint: Schema.optionalKey(Schema.Boolean),
      destructiveHint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})
const WireTools = Schema.Struct({
  profile: ExecutorProfileId,
  items: Schema.Array(WireTool),
  deployment: ExecutorDeploymentId,
  profileRevision: Schema.Int,
  next: Schema.optionalKey(Schema.NonEmptyString),
})
const WireCatalogEntry = Schema.Struct({
  id: ServiceId,
  kind: Schema.Literals(['app', 'openapi', 'mcp', 'graphql', 'cli']),
  name: Schema.String,
  description: Schema.String,
  connectUrl: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
  popularity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
const WireCatalog = Schema.Array(Schema.Unknown)
const decodeCatalogEntry = Schema.decodeUnknownEffect(WireCatalogEntry)
/** packages/catalog/src/contracts/imports.ts CustomAppInput accepts only MCP name and URL.
 * Method detection belongs to Executor; the hosted contract has neither auth nor OpenAPI input.
 */
const WireImportSource = Schema.Struct({
  kind: Schema.tag('mcp'),
  name: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
})
// HostedTools.call returns arbitrary Json, including plain OpenAPI values. The MCP isError
// discriminator changes only the product outcome, never the preserved successful payload.
const isToolError = Schema.is(Schema.Struct({ isError: Schema.Literal(true) }))
const WireSignIn = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('redirect'),
    authorizationUrl: Schema.URLFromString,
    redirectUri: Schema.URLFromString,
  }),
  Schema.Struct({ status: Schema.Literal('completed'), account: WireAccount }),
]).pipe(Schema.toTaggedUnion('status'))
const KeySubmission = Schema.Struct({
  method: Schema.String,
  label: Schema.String,
  fields: Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String)),
})
const SignInSubmission = Schema.Struct({
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
  ApprovalUnsupported: {},
  AppNameTaken: {},
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
  // No selected account requires authorization; never select another account implicitly.
  AccountRequired: notReady,
  // packages/sdk/src/contracts/oauth.ts OAuthRenewalFailed preserves the grant on renewal failure. Reject the dispatch so a
  // retry/setup repair is possible without falsely asking the Person to replace credentials.
  OAuthRenewalFailed: FailureMode.cases.Rejected.make({
    message: 'This Integration could not renew access. Retry or review its sign-in setup.',
  }),
  AccountSelectionInvalid: notReady,
  OAuthReconnectRequired: notReady,
  ProfileNotFound: FailureMode.cases.Missing.make({ resource: 'Profile' }),
  ProviderNotFound: notReady,
  AccountConnectionNotFound: notReady,
  AccountConnectionClosed: notReady,
  ToolBlocked: FailureMode.cases.Rejected.make({
    message: 'The integration policy blocked this tool.',
  }),
  CredentialsError: denied,
  DashboardForbidden: denied,
  DashboardUnauthorized: denied,
  // Hosted principal/membership refusal is installation authority, not a Person's tool input.
  Unauthorized: denied,
  Forbidden: denied,
  OrganizationForbidden: denied,
  AuthenticationUnavailable: denied,
  ProfileConflict: conflict,
  AppNameTaken: FailureMode.cases.AppNameTaken.make({}),
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
  ToolApprovalRequired: FailureMode.cases.ApprovalUnsupported.make({}),
  // A kind mismatch proves dispatch was refused; discovery must determine the current kind.
  ToolKindMismatch: FailureMode.cases.Rejected.make({
    message: 'This Integration tool changed; discover its tools again.',
  }),
  // Provider evaluation and listing timeouts precede invocation. Rejection lets discovery retry
  // without presenting them as missing credentials or replaying an uncertain external action.
  AppProviderFailed: FailureMode.cases.Rejected.make({
    message: 'This Integration could not prepare its tools. Review its setup.',
  }),
  ToolListingTimedOut: FailureMode.cases.Rejected.make({
    message: 'This Integration took too long to list its tools. Retry discovery.',
  }),
  // Build resource exhaustion is setup rejection, with the same recovery as a failed build.
  BuildMemoryExceeded: FailureMode.cases.Rejected.make({
    message: 'This Integration could not be built within the available memory.',
  }),
  ToolElicitationFailed: uncertain,
  RequestInvalid: FailureMode.cases.Rejected.make({
    message: 'The request is invalid for this installation.',
  }),
  AccountFieldsInvalid: FailureMode.cases.Rejected.make({
    message: 'Complete the required key fields shown by this integration.',
  }),
  AuthMethodInvalid: FailureMode.cases.Rejected.make({
    message: 'The integration authorization method changed; start authorization again.',
  }),
  OAuthClientUnavailable: FailureMode.cases.SetupRequired.make({}),
  OAuthSetupFailed: FailureMode.cases.Rejected.make({
    message: 'The integration could not prepare sign-in. Review its OAuth configuration.',
  }),
  // Callback exchange failed before a usable account exists; restart or correct sign-in.
  OAuthCompletionFailed: FailureMode.cases.Rejected.make({
    message: 'Sign-in did not complete. Review the callback or start a new authorization.',
  }),
  AppEvaluationFailed: FailureMode.cases.Rejected.make({
    message: 'The integration could not load its tools. Check its deployment and authorization.',
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
/** Only the validation failure carries safe field detail worth decoding. */
const isInputInvalid = Match.type<typeof WireFailure.Type>().pipe(
  Match.tag('InputInvalid', () => true),
  Match.orElse(() => false),
)
/** Decode only InputInvalid detail. Other failure diagnostics may contain credentials and are
 * never projected. HostedTools.call imports this exact InputInvalid shape from the SDK.
 */
const WireInputInvalid = Schema.Struct({
  _tag: Schema.Literal('InputInvalid'),
  problems: Schema.Array(Schema.String),
})
const decodeInputInvalid = Schema.decodeUnknownEffect(WireInputInvalid)

/** Remote tags determine recovery; arbitrary messages and credential-bearing diagnostics are dropped. */
function translateFailure(tag: typeof knownFailureTag.Type, tool: string | null) {
  const context = { service: 'connections' as const, tool }
  return FailureMode.match(failureModes[tag], {
    NotReady: (): ExecutorFailure => ExecutorNotReady.make(context),
    ApprovalUnsupported: (): ExecutorFailure => ExecutorApprovalUnsupported.make({ tool }),
    SetupRequired: (): ExecutorFailure => ExecutorSetupRequired.make(context),
    Missing: ({ resource }): ExecutorFailure =>
      ExecutorResourceMissing.make({ ...context, resource }),
    AccessDenied: (): ExecutorFailure => ExecutorAccessDenied.make(context),
    AppNameTaken: (): ExecutorFailure => ExecutorAppNameTaken.make(context),
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
        // Hosted discovery failures use 502/504 with precise tags. Decode those before the
        // generic 5xx classification; an unrecognized server failure remains outcome-uncertain.
        const invalid = () =>
          response.status >= 500
            ? ExecutorExecutionUncertain.make(context)
            : ExecutorResponseInvalid.make(context)
        const body = yield* response.json.pipe(Effect.mapError(invalid))
        if (response.status >= 200 && response.status < 300) {
          return yield* decode(body).pipe(
            Effect.mapError(() => ExecutorResponseInvalid.make(context)),
          )
        }
        const failure = yield* decodeFailure(body).pipe(Effect.mapError(invalid))
        if (isInputInvalid(failure) && tool !== null) {
          const detail = yield* decodeInputInvalid(body).pipe(
            Effect.mapError(() => translateFailure('InputInvalid', tool)),
          )
          return yield* Effect.fail(
            ExecutorInputInvalid.make({
              ...context,
              problems: detail.problems,
            }),
          )
        }
        if (!isKnownFailureTag(failure._tag)) {
          if (response.status >= 500)
            return yield* Effect.fail(ExecutorExecutionUncertain.make(context))
          return yield* Effect.fail(
            ExecutorRejected.make({
              ...context,
              message:
                tool === null
                  ? 'The Integration management request was refused.'
                  : 'The Integration refused this request before running the tool.',
            }),
          )
        }
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

/** Supported catalogue entries remain discoverable even when this installation cannot authorize them.
 * Absent auth is learned after installation; an unknown declared hint requires operator setup.
 * Hosted CatalogImport quick-add supports app/MCP only; OpenAPI/GraphQL/CLI remain excluded.
 * These are method hints; cached setup inspection selects a usable method before a service is
 * offered or a Connection begins. Mixed imports retain both methods during inspection.
 */
function catalogEntry(entry: typeof WireCatalogEntry.Type) {
  if (entry.kind !== 'app' && (entry.kind !== 'mcp' || entry.connectUrl === undefined)) return []
  const authorization =
    entry.auth === undefined
      ? ServiceAuthorization.cases.KnownAfterInstall.make({})
      : Match.value(entry.auth.kind).pipe(
          Match.when('none', () => ServiceAuthorization.cases.None.make({})),
          Match.whenOr('oauth', 'mixed', () => ServiceAuthorization.cases.SignIn.make({})),
          Match.when('api_key', () => ServiceAuthorization.cases.Key.make({ fields: [] })),
          Match.orElse(() => ServiceAuthorization.cases.SetupRequired.make({})),
        )
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
 * exposed by HostedTools.list, so they cannot establish read safety; undeclared/conflicting hints
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
function completedCall(value: Schema.Json) {
  if (isToolError(value))
    return ExecutorCallOutcome.cases.Rejected.make({ message: toolRejectionMessage })
  return ExecutorCallOutcome.cases.Completed.make({ value })
}

/** Hosted paths keep app/profile opaque and explicit; the authenticated organization is prefixed
 * once at client acquisition (apps/hosted/server/src/contracts/profiles.ts HostedProfiles).
 */
const target = (references: ExecutorReferences) =>
  `/apps/${encodeURIComponent(references.app)}/profiles/${encodeURIComponent(references.profile)}`
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
function makeHttp(client: HttpClient.HttpClient, google: Option.Option<GoogleInstallation>) {
  const read = responseReader(client)
  const readApp = read(WireApp)
  const readInventory = read(WireInventory)
  const readProfile = read(WireProfile)
  const readConnection = read(WireConnection)
  const readAccount = read(WireAccount)
  const readCatalog = read(WireCatalog)
  const readTools = read(WireTools)
  const readCall = read(Schema.Json)
  const readSignIn = read(WireSignIn)
  const readRemoval = read(Schema.Json)
  return {
    google,
    readApp,
    readInventory,
    readProfile,
    readConnection,
    readAccount,
    readCatalog,
    readTools,
    readCall,
    readSignIn,
    readRemoval,
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
        onNone: () => `/apps/${query(references.app)}/tools?profile=${query(references.profile)}`,
        onSome: ({ deployment, revision }) =>
          `/apps/${query(references.app)}/tools?profile=${query(references.profile)}&deployment=${query(deployment)}&expectedProfileRevision=${revision}`,
      })
      const address = Option.match(cursor, {
        onNone: () => base,
        onSome: (value) => `${base}&cursor=${query(value)}`,
      })
      const page = yield* http.readTools(Effect.succeed(HttpClientRequest.get(address)), null)
      if (
        page.profile !== references.profile ||
        (Option.isSome(snapshot) &&
          (snapshot.value.deployment !== page.deployment ||
            snapshot.value.revision !== page.profileRevision))
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
            output: Option.fromUndefinedOr(tool.outputSchema),
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

/** Starting OAuth may allocate protocol state before responding. Retain its targeted request on
 * refusal or transport loss so management can resolve it instead of losing its identity.
 */
function makeSignIn(
  http: ExecutorHttp,
  recordSetupRequired: (service: ServiceId) => Effect.Effect<void>,
) {
  return Effect.fn('Executor.startSignIn')(function* (
    input: typeof BeginInput.Type,
    pending: typeof ExecutorReferences.cases.SigningIn.Type,
    methodName: string,
  ) {
    const installed = googleApp(http.google, input.service)
    const submission = { method: methodName, label: input.label }
    const body =
      Option.isSome(installed) && Option.isSome(http.google)
        ? {
            ...submission,
            client: yield* encodeGoogleClient(http.google.value.client).pipe(
              Effect.mapError(() =>
                ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
              ),
            ),
          }
        : submission
    const result = yield* http
      .readSignIn(post(`/connections/${query(pending.authorization)}/oauth/start`, body), null)
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
          ExecutorTransportFailure: () =>
            Effect.fail(ExecutorAuthorizationUnavailable.make({ references: pending })),
          ExecutorExecutionUncertain: () =>
            Effect.fail(ExecutorAuthorizationUnavailable.make({ references: pending })),
          ExecutorResponseInvalid: () =>
            Effect.fail(ExecutorAuthorizationUnavailable.make({ references: pending })),
        }),
      )
    return yield* WireSignIn.match(result, {
      redirect: ({ authorizationUrl, redirectUri }) =>
        Effect.gen(function* () {
          // HostedAccounts.startOAuth binds deployment-wide redirectUri and ignores per-request
          // overrides. Refuse mismatches before handing the Person an unusable provider URL.
          if (redirectUri.href !== input.returnAddress) {
            yield* recordSetupRequired(input.service)
            return yield* Effect.fail(
              ExecutorSetupRequired.make({ service: 'connections', tool: null }),
            )
          }
          if (Option.isNone(installed))
            return ExecutorStep.cases.OpenSignIn.make({
              references: pending,
              address: authorizationUrl.href,
            })
          const state = yield* decodeGoogleState(authorizationUrl.searchParams.get('state')).pipe(
            Effect.mapError(() => ExecutorAuthorizationUnavailable.make({ references: pending })),
          )
          return ExecutorStep.cases.OpenSignIn.make({
            references: ExecutorReferences.cases.GoogleSigningIn.make({
              ...referenceIdentity(pending),
              authorization: pending.authorization,
              googleState: state,
            }),
            address: authorizationUrl.href,
          })
        }),
      completed: ({ account }) =>
        Effect.succeed(
          ExecutorStep.cases.Done.make({
            references: ExecutorReferences.cases.Authorized.make({
              ...referenceIdentity(pending),
              account: account.id,
            }),
          }),
        ),
    })
  })
}

/** Hosted AccountConnection.target is authoritative for a pending flow. A changed profile/app
 * cannot be followed or removed through this Connection. Untargeted reconnects are legitimate
 * only when their saved reconnectAccount supplies the original account identity.
 */
const validateConnectionTarget = Effect.fn('Executor.validateConnectionTarget')(function* (
  connection: typeof WireConnection.Type,
  references: ExecutorReferences,
) {
  const selection = connection.target
  if (selection === null) {
    if (connection.reconnectAccount === null)
      yield* Effect.fail(ExecutorResponseInvalid.make({ service: 'connections', tool: null }))
    return
  }
  if (selection.profile !== references.profile || selection.app !== references.app)
    yield* Effect.fail(ExecutorResponseInvalid.make({ service: 'connections', tool: null }))
})

/** Native targeted requests atomically select the saved account into the exact profile. */
function makeAuthorize(
  http: ExecutorHttp,
  recordSetupRequired: (service: ServiceId) => Effect.Effect<void>,
) {
  const signIn = makeSignIn(http, recordSetupRequired)
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
          message:
            'This integration requires a configuration the integration adapter does not support.',
        }),
      )
    const [requirement, definition] = first
    const methods = Object.entries(definition.definition.auth)
    const matching = ServiceAuthorization.match(authorization, {
      SignIn: () => methods.filter(([, method]) => AuthorizationMethod.guards.oauth2(method)),
      Key: () => methods.filter(([, method]) => AuthorizationMethod.guards.secrets(method)),
      None: () => [],
      SetupRequired: () => [],
      // Absent catalogue hints follow the mixed-entry rule: OAuth takes precedence over keys.
      KnownAfterInstall: () => {
        const oauth = methods.filter(([, method]) => AuthorizationMethod.guards.oauth2(method))
        return oauth.length > 0
          ? oauth
          : methods.filter(([, method]) => AuthorizationMethod.guards.secrets(method))
      },
    })
    const chosen = matching[0]
    if (matching.length !== 1 || chosen === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'The integration does not declare one compatible authorization method.',
        }),
      )
    const [methodName, method] = chosen
    // HostedAccounts reconnects the exact saved account. New Connections target the exact
    // app/profile slot; neither lists or chooses another account. See HostedAccounts in
    // apps/hosted/server/src/contracts/accounts.ts.
    const connection = isPending(references)
      ? { id: references.authorization }
      : yield* http
          .readConnection(
            ExecutorReferences.guards.Authorized(references)
              ? Effect.succeed(
                  HttpClientRequest.post(`/accounts/${query(references.account)}/connections`),
                )
              : post(`/apps/${query(references.app)}/connections`, {
                  requirement,
                  profile: references.profile,
                }),
            null,
          )
          .pipe(Effect.tap((created) => validateConnectionTarget(created, references)))
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
      oauth2: Effect.fn('Executor.authorizeSignIn')(function* () {
        const pending = ExecutorReferences.cases.SigningIn.make({
          ...referenceIdentity(references),
          authorization: connection.id,
        })
        return yield* signIn(input, pending, methodName)
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
      if (isPending(references)) {
        const connection = yield* http.readConnection(
          Effect.succeed(HttpClientRequest.get(`/connections/${query(references.authorization)}`)),
          null,
        )
        yield* validateConnectionTarget(connection, references)
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
      // HostedProfiles.get reads the saved selection without scheduling setup work on every
      // healthy status check. Reconcile only a profile that has not reached ready yet.
      const saved = yield* http.readProfile(
        Effect.succeed(HttpClientRequest.get(target(resolved))),
        null,
      )
      const profile = saved.status === 'ready' ? saved : yield* reconcile(resolved)
      if (profile.status !== 'ready') {
        if (profile.failure === 'accounts')
          return ExecutorStatus.cases.NeedsAuthorization.make({ references: resolved })
        return ExecutorStatus.cases.Failed.make({ reason: `Service setup is ${profile.status}` })
      }
      const page = yield* http.readTools(
        Effect.succeed(
          HttpClientRequest.get(
            `/apps/${query(resolved.app)}/tools?profile=${query(resolved.profile)}`,
          ),
        ),
        null,
      )
      if (page.profile !== resolved.profile)
        return yield* Effect.fail(
          ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
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

/** Third-party rows are independent: reject malformed entries without losing healthy services.
 * A refresh emits one credential-free summary, with identities only when their schema decodes.
 */
function makeCatalog(http: ExecutorHttp) {
  const decodeKind = Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.String }))
  const knownKind = Schema.is(WireCatalogEntry.fields.kind)
  const decodeIdentity = Schema.decodeUnknownOption(Schema.Struct({ id: ServiceId }))
  return Effect.fn('Executor.catalog')(function* () {
    const entries = yield* http.readCatalog(Effect.succeed(HttpClientRequest.get('/catalog')), null)
    const rejected: Option.Option<{ readonly id: ServiceId }>[] = []
    const decoded = yield* Effect.forEach(
      entries,
      Effect.fn('Executor.catalogEntry')(
        function* (entry) {
          const { kind } = yield* decodeKind(entry)
          if (!knownKind(kind)) return []
          const value = yield* decodeCatalogEntry(entry)
          return catalogEntry(value).map((service) => ({
            service,
            popularity: Option.fromNullishOr(value.popularity),
          }))
        },
        (effect, entry) =>
          effect.pipe(
            Effect.catchTag('SchemaError', () => {
              rejected.push(decodeIdentity(entry))
              return Effect.succeed([])
            }),
          ),
      ),
    )
    if (rejected.length > 0)
      yield* Effect.logWarning('Malformed Connection catalog entries skipped').pipe(
        Effect.annotateLogs({
          count: rejected.length,
          serviceIds: Arr.getSomes(rejected).map((entry) => entry.id),
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

/** Only client-required establishes absent operator setup. A declared key remains usable when
 * sign-in is unavailable; automatic/saved sign-in retains priority for mixed services.
 */
function makeInspectSetup(http: ExecutorHttp) {
  return Effect.fn('Executor.inspectSetup')(function* (requirement: typeof Requirement.Type) {
    if (
      Option.isSome(http.google) &&
      http.google.value.apps.some((app) => app.provider === requirement.provider)
    )
      return ServiceAuthorization.cases.SignIn.make({})
    const methods = Object.entries(requirement.definition.auth)
    const signIn = methods.find(([, method]) => AuthorizationMethod.guards.oauth2(method))
    const key = methods.find(([, method]) => AuthorizationMethod.guards.secrets(method))
    if (signIn !== undefined) {
      const setup = yield* http.readSetup(
        Effect.succeed(
          HttpClientRequest.get(
            `/providers/${query(requirement.provider)}/oauth/${query(signIn[0])}/setup`,
          ),
        ),
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
          message: 'This integration does not declare a supported sign-in or key method.',
        }),
      )
    return ServiceAuthorization.cases.SetupRequired.make({})
  })
}

/** A single requirement keeps authorization targeted; incompatible definitions remain typed failures. */
function accountRequirement(app: typeof WireApp.Type) {
  const requirements = Object.values(app.requirements.accounts)
  const requirement = requirements[0]
  if (requirements.length !== 1 || requirement === undefined)
    return Effect.fail(
      ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'This integration does not declare one supported account.',
      }),
    )
  return Effect.succeed(requirement)
}

/** Retain successful display facts and report only transitions into inspection failure. */
function makeAvailabilityRecorder(
  facts: Ref.Ref<HashMap.HashMap<ServiceId, ServiceAuthorization>>,
  failures: Ref.Ref<HashMap.HashMap<ServiceId, string>>,
) {
  /** Publish each completed inspection separately so a slow service never delays its peers.
   * Log only the integration identity and typed failure tag, once on entering failed availability.
   */
  return Effect.fn('Executor.recordAvailability')(function* (
    service: ServiceId,
    authorization: ServiceAuthorization,
    failure: Option.Option<string>,
  ) {
    if (Option.isNone(failure))
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
}

/** Thirty seconds bounds repeated outage traffic while allowing prompt recovery after a 5s timeout. */
const INSPECTION_FAILURE_TTL = '30 seconds'
const REFUSAL_TTL_MILLIS = 10 * 60 * 1000
const SetupRefusal = Schema.Struct({
  authorization: ServiceAuthorization.cases.SetupRequired,
  expiresAtMillis: Schema.Finite,
})

/** Refusals are stronger evidence than inspection and own their expiry independently. rc.116
 * Cache.get's observer (effect/src/Cache.ts:626-638) owns lookup completion, and checkCapacity
 * evicts entries regardless of their TTL. Neither may modify these refusal-only facts.
 * Read/record run under the publication permit, including expiry removal.
 * Expiry invalidates ordinary inspection so the next read re-inspects the provider.
 */
const makeSetupRefusals = Effect.fn('Executor.setupRefusals')(function* (
  inspections: Cache.Cache<ServiceId, ServiceAuthorization, ExecutorFailure>,
) {
  const refusals = yield* Ref.make(HashMap.empty<ServiceId, typeof SetupRefusal.Type>())
  return {
    read: Effect.fn('Executor.readSetupRefusal')(function* (service: ServiceId) {
      const now = yield* Clock.currentTimeMillis
      const refusal = yield* Ref.get(refusals).pipe(
        Effect.map((current) => HashMap.get(current, service)),
      )
      if (Option.isNone(refusal)) return Option.none<ServiceAuthorization>()
      if (now < refusal.value.expiresAtMillis) return Option.some(refusal.value.authorization)
      yield* Ref.update(refusals, (current) => HashMap.remove(current, service))
      yield* Cache.invalidate(inspections, service)
      return Option.none<ServiceAuthorization>()
    }),
    record: Effect.fn('Executor.retainSetupRefusal')(function* (service: ServiceId) {
      const refusal = SetupRefusal.make({
        authorization: ServiceAuthorization.cases.SetupRequired.make({}),
        expiresAtMillis: (yield* Clock.currentTimeMillis) + REFUSAL_TTL_MILLIS,
      })
      yield* Ref.update(refusals, (current) => HashMap.set(current, service, refusal))
      return refusal.authorization
    }),
  }
})

/** Refusal reads and publication share the writer's permit. Both successful and failed older
 * lookups must yield to a retained refusal before publishing or returning their result.
 */
function makeInspectionReader(input: {
  readonly inspections: Cache.Cache<ServiceId, ServiceAuthorization, ExecutorFailure>
  readonly refusals: Effect.Success<ReturnType<typeof makeSetupRefusals>>
  readonly publication: Semaphore.Semaphore
  readonly record: ReturnType<typeof makeAvailabilityRecorder>
}) {
  return Effect.fn('Executor.readInspection')(function* (service: ServiceId) {
    const retained = yield* input.publication.withPermit(input.refusals.read(service))
    if (Option.isSome(retained)) return retained.value
    const loaded = yield* Cache.get(input.inspections, service).pipe(Effect.result)
    return yield* input.publication.withPermit(
      Effect.gen(function* () {
        const refusal = yield* input.refusals.read(service)
        if (Option.isSome(refusal)) return refusal.value
        const authorization = yield* Effect.fromResult(loaded)
        yield* input.record(service, authorization, Option.none())
        return authorization
      }),
    )
  })
}

/** Inspection is read-only and bounded. Transient failures retain their failed lookup briefly
 * and leave the last known display fact intact. Capacity eviction affects only ordinary
 * inspection facts: they are re-inspected on the next read, without discarding refusals.
 */
const makeAuthorization = Effect.fn('Executor.authorizationCache')(function* (
  http: ExecutorHttp,
  catalog: ExecutorService['catalog'],
) {
  const inspect = makeInspectSetup(http)
  const scope = yield* Effect.scope
  const publication = yield* Semaphore.make(1)
  const permits = yield* Semaphore.make(4)
  const facts = yield* Ref.make(HashMap.empty<ServiceId, ServiceAuthorization>())
  const failures = yield* Ref.make(HashMap.empty<ServiceId, string>())
  // Definitions enter only through explicit Begin/Resume; there is no catalog-detail endpoint.
  const definitions = yield* Ref.make(HashMap.empty<ServiceId, typeof Requirement.Type>())
  const record = makeAvailabilityRecorder(facts, failures)
  const inspections = yield* Cache.makeWith(
    Effect.fn('Executor.inspectAuthorization')(function* (service: ServiceId) {
      const entry = (yield* catalog()).find((candidate) => candidate.id === service)
      if (entry === undefined)
        return yield* Effect.fail(
          ExecutorRejected.make({
            service: 'connections',
            tool: null,
            message: 'Choose an integration from the current catalog.',
          }),
        )
      if (ServiceAuthorization.guards.None(entry.authorization)) return entry.authorization
      const definition = HashMap.get(yield* Ref.get(definitions), service)
      if (Option.isNone(definition)) return entry.authorization
      const authorization = yield* permits.withPermits(1)(
        inspect(definition.value).pipe(
          Effect.timeout('5 seconds'),
          Effect.catchTag('TimeoutError', () =>
            Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
          ),
          Effect.catch(
            Effect.fn('Executor.unavailableSetup')(function* (error) {
              if (isSetupRequired(error)) {
                const unavailable = ServiceAuthorization.cases.SetupRequired.make({})
                return unavailable
              }
              yield* record(service, entry.authorization, Option.some(error._tag))
              return yield* Effect.fail(error)
            }),
          ),
        ),
      )
      return authorization
    }),
    {
      capacity: 1000,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? '10 minutes' : INSPECTION_FAILURE_TTL),
    },
  )
  const refusals = yield* makeSetupRefusals(inspections)
  const readInspection = makeInspectionReader({ inspections, refusals, publication, record })
  /** Refresh expired inspection entries in the owning scope while serving retained display facts. */
  const refreshAvailability = Effect.fn('Executor.refreshAvailability')(function* (
    entry: typeof ExecutorServiceEntry.Type,
    current: HashMap.HashMap<ServiceId, ServiceAuthorization>,
  ) {
    const refusal = yield* publication.withPermit(refusals.read(entry.id))
    if (Option.isSome(refusal))
      return ExecutorServiceEntry.make({ ...entry, authorization: refusal.value })
    const previous = HashMap.get(current, entry.id)
    if (Option.isNone(previous)) return entry
    if (!(yield* Cache.has(inspections, entry.id))) {
      yield* readInspection(entry.id).pipe(
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
      )
    }
    return ExecutorServiceEntry.make({ ...entry, authorization: previous.value })
  })
  return {
    /** Explicit management already owns an app; retain its public definition without another import. */
    inspectApp: Effect.fn('Executor.inspectApp')(function* (
      input: typeof BeginInput.Type,
      app: typeof WireApp.Type,
    ) {
      const requirement = yield* accountRequirement(app)
      const alreadyKnown = yield* Ref.modify(definitions, (current) => [
        HashMap.has(current, input.service),
        HashMap.set(current, input.service, requirement),
      ])
      // A pre-definition read can cache only catalogue metadata. Replace it once the actual
      // requirement arrives; subsequent Begin calls must preserve a refused sign-in's TTL.
      if (!alreadyKnown) yield* Cache.invalidate(inspections, input.service)
      // Custom MCP imports and their renewals have a service identity outside the catalogue.
      // They inspect the saved app directly, but share refusal ordering with catalogue entries.
      const entry = (yield* catalog()).find((candidate) => candidate.id === input.service)
      if (entry !== undefined) return yield* readInspection(input.service)
      const retained = yield* publication.withPermit(refusals.read(input.service))
      if (Option.isSome(retained)) return retained.value
      const inspected = yield* inspect(requirement).pipe(
        Effect.timeout('5 seconds'),
        Effect.catchTag('TimeoutError', () =>
          Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
        ),
      )
      return yield* publication.withPermit(
        Effect.gen(function* () {
          const refusal = yield* refusals.read(input.service)
          if (Option.isSome(refusal)) return refusal.value
          yield* record(input.service, inspected, Option.none())
          return inspected
        }),
      )
    }),
    authorization: Effect.fn('Executor.authorization')((input: { readonly service: ServiceId }) =>
      readInspection(input.service),
    ),
    /** Display reads use retained facts immediately. Cache.has also sees pending entries;
     * expired/missing inspections start in the owning layer scope without blocking the list.
     * Inspection failures are logged by the lookup and retain the last successful display fact.
     */
    catalog: Effect.fn('Executor.availableCatalog')(function* () {
      const entries = yield* catalog()
      const current = yield* Ref.get(facts)
      return yield* Effect.forEach(entries, (entry) => refreshAvailability(entry, current))
    }),
    /** Retain refused sign-in for ten minutes, independent of inspection completion or eviction. */
    recordSetupRequired: Effect.fn('Executor.recordSetupRequired')(function* (service: ServiceId) {
      yield* publication.withPermit(
        Effect.gen(function* () {
          const unavailable = yield* refusals.record(service)
          yield* record(service, unavailable, Option.none())
        }),
      )
    }),
  }
})

/** packages/sdk/src/contracts/apps.ts AppName is bounded at 120 characters. Hash the Integration
 * identity so arbitrary URL lengths share a stable name across Connections without truncation.
 */
function integrationAppName(service: ServiceId) {
  return `Vivid Integration ${NodeCrypto.createHash('sha256').update(service).digest('hex')}`
}

/** Inventory matches only shared app code by its deterministic name. Full requirements enter
 * through that app's detail endpoint; profiles and accounts are never selected from inventory.
 */
function makeFindInstalled(http: ExecutorHttp) {
  return Effect.fn('Executor.findInstalled')(function* (name: string) {
    const inventory = yield* http.readInventory(
      Effect.succeed(HttpClientRequest.get('/inventory')),
      null,
    )
    const existing = inventory.apps.find((app) => app.name === name)
    if (existing === undefined) return Option.none<typeof WireApp.Type>()
    return Option.some(
      yield* http.readApp(
        Effect.succeed(HttpClientRequest.get(`/apps/${query(existing.id)}`)),
        null,
      ),
    )
  })
}

const isAppNameTaken = Schema.is(ExecutorAppNameTaken)

/** A name conflict is the sole proof another process may have installed this shared app.
 * Reread once and return that exact winner; absence preserves the original conflict.
 */
function makeProvision(http: ExecutorHttp) {
  const find = makeFindInstalled(http)
  return Effect.fn('Executor.provision')(function* (
    name: string,
    install: (name: string) => Effect.Effect<typeof WireApp.Type, ExecutorFailure>,
  ) {
    const existing = yield* find(name)
    if (Option.isSome(existing)) return existing.value
    const result = yield* Effect.result(install(name))
    if (Result.isSuccess(result)) return result.success
    if (!isAppNameTaken(result.failure)) return yield* Effect.fail(result.failure)
    const winner = yield* find(name)
    if (Option.isSome(winner)) return winner.value
    return yield* Effect.fail(result.failure)
  })
}

/** HostedApps.install/import are create-only. A reference-counted semaphore per deterministic
 * app name serializes only competing installs; other Integrations remain independent. RcMap
 * retains a lock while callers use/wait for it, then releases it without evicting a live lock.
 * A cross-process AppNameTaken rereads exactly once, never retries a consequential install.
 */
const makeInstall = Effect.fn('Executor.installLocks')(function* (http: ExecutorHttp) {
  const locks = yield* RcMap.make({ lookup: (_name: string) => Semaphore.make(1) })
  const provision = makeProvision(http)
  return Effect.fn('Executor.install')(function* (
    service: ServiceId,
    install: (name: string) => Effect.Effect<typeof WireApp.Type, ExecutorFailure>,
  ) {
    const name = integrationAppName(service)
    const permit = yield* RcMap.get(locks, name)
    return yield* permit.withPermit(provision(name, install))
  }, Effect.scoped)
})

const isSetupRequired = Schema.is(ExecutorSetupRequired)

/** HostedApps.install deploys the catalog entry directly into the organization. Shared code is
 * retained on setup failure: deleting it would break every other Connection's profile.
 */
function makeBegin(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  install: Effect.Success<ReturnType<typeof makeInstall>>,
) {
  const configure = makeConfigure(http, availability)
  const begin = Effect.fn('Executor.begin')(function* (input: typeof BeginInput.Type) {
    const entry = (yield* availability.catalog()).find(
      (candidate) => candidate.id === input.service,
    )
    if (entry === undefined)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Choose a supported Integration from the current catalog.',
        }),
      )
    // Hosted CatalogEntry omits auth. Explicit Begin installs first, then its real requirements
    // establish authorization; absent catalog hints never grant unauthenticated access.
    const app = yield* install(input.service, (name) =>
      http.readApp(post('/apps/install', { entry: entry.id, name }), null),
    )
    const authorization =
      Object.keys(app.requirements.accounts).length === 0
        ? ServiceAuthorization.cases.None.make({})
        : yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(authorization))
      return yield* Effect.fail(ExecutorSetupRequired.make({ service: 'connections', tool: null }))
    return yield* configure(input, app, ExecutorServiceEntry.make({ ...entry, authorization }))
  })
  return { begin, add: makeAdd(http, availability, configure, install) }
}

/** HostedProfiles.create uses ConnectionId as its idempotency key. Each Connection holds its
 * own account selection on shared code; membership supplies owner and subject on the host.
 * Scope registers rollback before authorization. Any later failure releases only this profile;
 * cleanup failure is logged by tag and never replaces the original failure or deletes shared code.
 */
function makeConfigure(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
) {
  const reconcile = makeReconcile(http)
  const authorize = makeAuthorize(http, availability.recordSetupRequired)
  return Effect.fn('Executor.configureProfile')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    entry: typeof ExecutorServiceEntry.Type,
  ) {
    const profile = yield* Effect.acquireRelease(
      http.readProfile(
        post(`/apps/${query(app.id)}/profiles`, {
          name: input.label,
          accounts: {},
          idempotencyKey: input.connectionId,
        }),
        null,
      ),
      (created, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : http
              .readRemoval(
                Effect.succeed(
                  HttpClientRequest.delete(`/apps/${query(app.id)}/profiles/${query(created.id)}`),
                ),
                null,
              )
              .pipe(
                Effect.tapError((failure) =>
                  Effect.logError('Integration profile compensation failed', failure._tag),
                ),
                Effect.ignore,
              ),
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
  }, Effect.scoped)
}

/** HostedApps.importCustom accepts the existing checked URL source contract. The organization
 * keeps one shared app; credentials still enter solely through the targeted Connection flow.
 */
function makeAdd(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  configure: ReturnType<typeof makeConfigure>,
  install: Effect.Success<ReturnType<typeof makeInstall>>,
) {
  return Effect.fn('Executor.add')(function* (
    input: typeof BeginInput.Type & { readonly source: ConnectionSource },
  ) {
    if (ConnectionSource.guards.OpenApi(input.source))
      return yield* Effect.fail(new ExecutorSourceUnsupported({ source: 'OpenApi' }))
    const address = URL.parse(input.source.address)
    if (address === null)
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Enter a valid MCP server address.',
        }),
      )
    if (address.search.length > 0) return yield* Effect.fail(new ExecutorImportQueryUnsupported({}))
    const app = yield* install(input.service, (name) => {
      // Executor resolves the inspected URL again; production requires public-only egress.
      const source = WireImportSource.make({ name, url: input.source.address })
      return http.readApp(post('/apps/import', { source }), null)
    })
    const authorization =
      Object.keys(app.requirements.accounts).length === 0
        ? ServiceAuthorization.cases.None.make({})
        : yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(authorization))
      return yield* Effect.fail(ExecutorSetupRequired.make({ service: 'connections', tool: null }))
    return yield* configure(
      input,
      app,
      ExecutorServiceEntry.make({
        id: input.service,
        name: input.label,
        description: '',
        authorization,
      }),
    )
  })
}

/** Read the saved request before renewal. HostedAccounts has no cancel route: closed requests
 * stay closed and unfinished ones expire. Completed requests retain their exact account identity.
 */
function makeReauthorize(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
) {
  const authorize = makeAuthorize(http, availability.recordSetupRequired)
  const status = makeStatus(http)
  return Effect.fn('Executor.reauthorize')(function* (
    input: typeof BeginInput.Type & { readonly references: ExecutorReferences },
  ) {
    let references = input.references
    if (isPending(references)) {
      const pending = yield* http.readConnection(
        Effect.succeed(HttpClientRequest.get(`/connections/${query(references.authorization)}`)),
        null,
      )
      yield* validateConnectionTarget(pending, references)
      if (WireConnection.fields.state.guards.completed(pending.state)) {
        references = ExecutorReferences.cases.Authorized.make({
          ...referenceIdentity(references),
          account: pending.state.account.id,
        })
      } else if (!WireConnection.fields.state.guards.pending(pending.state)) {
        references =
          pending.reconnectAccount === null
            ? ExecutorReferences.cases.Public.make(referenceIdentity(references))
            : ExecutorReferences.cases.Authorized.make({
                ...referenceIdentity(references),
                account: pending.reconnectAccount.id,
              })
      }
    }
    if (
      ExecutorReferences.guards.Authorized(references) ||
      ExecutorReferences.guards.Public(input.references)
    ) {
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
    const app = yield* http.readApp(
      Effect.succeed(HttpClientRequest.get(`/apps/${query(references.app)}`)),
      null,
    )
    const selected = yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(selected))
      return yield* Effect.fail(ExecutorSetupRequired.make({ service: 'connections', tool: null }))
    return yield* authorize(input, app, references, selected)
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
          message: 'This integration is not waiting for key fields.',
        }),
      )
    const body = yield* encodeKey({
      method: references.method,
      label: references.label,
      fields,
    }).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
    const account = yield* http.readAccount(
      post(`/connections/${query(references.authorization)}/submit`, body),
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

/** Executor checks the stored OAuth state and redirect before exchanging the callback's code. */
function makeCompleteSignIn(http: ExecutorHttp) {
  const reconcile = makeReconcile(http)
  return Effect.fn('Executor.completeSignIn')(function* ({
    references,
    callbackAddress,
  }: typeof SignInInput.Type) {
    if (!isSigningIn(references))
      return yield* Effect.fail(
        ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This integration is not waiting for sign-in.',
        }),
      )
    const body = yield* encodeSignIn({
      callbackUrl: callbackAddress,
    }).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
    const account = yield* http.readAccount(
      post(`/connections/${query(references.authorization)}/oauth/complete`, body),
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

/** A deletion retry treats only its own missing resource as success. Other missing relations,
 * conflicts, and authority failures remain visible and cannot authorize deleting another resource.
 */
function makeRemoval(http: ExecutorHttp) {
  return Effect.fn('Executor.removeResource')((path: string, resource: 'Profile' | 'Account') =>
    http
      .readRemoval(Effect.succeed(HttpClientRequest.delete(path)), null)
      .pipe(
        Effect.catchTag('ExecutorResourceMissing', (error) =>
          error.resource === resource ? Effect.void : Effect.fail(error),
        ),
      ),
  )
}

/** Remove only the Connection's profile, then its dedicated account. Hosted app code is shared
 * and must remain. Executor's active-resource conflicts protect other live account users.
 */
function makeRemove(http: ExecutorHttp) {
  const remove = makeRemoval(http)
  const resolveRemovalAccount = makeResolveRemovalAccount(http)
  return Effect.fn('Executor.remove')(function* (references: ExecutorReferences) {
    const account = yield* ExecutorReferences.match(references, {
      Public: () => Effect.succeed(Option.none<Schema.Schema.Type<typeof ExecutorAccountId>>()),
      Authorized: (value) => Effect.succeed(Option.some(value.account)),
      EnteringKey: resolveRemovalAccount,
      SigningIn: resolveRemovalAccount,
      OAuthSigningIn: resolveRemovalAccount,
      GoogleSigningIn: resolveRemovalAccount,
    })
    yield* remove(target(references), 'Profile')
    if (Option.isSome(account)) yield* remove(`/accounts/${query(account.value)}`, 'Account')
  })
}

/** HostedAccounts reconnect keeps the saved account on reconnectAccount until completion.
 * Remove must revoke that exact account even while a replacement key/sign-in is pending.
 * New pending requests have no account; they expire after their target profile is removed.
 */
function makeResolveRemovalAccount(http: ExecutorHttp) {
  return Effect.fn('Executor.removalAccount')(function* (
    references: typeof ExecutorReferences.cases.EnteringKey.Type | typeof SignInReferences.Type,
  ) {
    const path = `/connections/${query(references.authorization)}`
    const connection = yield* http.readConnection(Effect.succeed(HttpClientRequest.get(path)), null)
    yield* validateConnectionTarget(connection, references)
    const reconnect = Option.map(
      Option.fromNullOr(connection.reconnectAccount),
      (account) => account.id,
    )
    return WireConnection.fields.state.match(connection.state, {
      completed: ({ account }) => Option.some(account.id),
      pending: () => reconnect,
      cancelled: () => reconnect,
      expired: () => reconnect,
    })
  })
}

/** Discovery faults prove no tool invocation was sent and remain safe to retry. */
function discoveryFailed() {
  return Effect.fail(
    ExecutorRejected.make({
      service: 'connections',
      tool: null,
      message: 'Tool discovery failed before the action was sent. Retry discovery.',
    }),
  )
}

/** Discover before dispatch to classify response loss; the named profile is always explicit. */
function makeCall(http: ExecutorHttp, discover: ReturnType<typeof makeDiscovery>) {
  return Effect.fn('Executor.call')(
    function* ({ references, tool, input }: typeof CallInput.Type) {
      const catalog = yield* discover(references).pipe(
        Effect.catchTags({
          ExecutorTransportFailure: discoveryFailed,
          ExecutorExecutionUncertain: discoveryFailed,
          ExecutorResponseInvalid: discoveryFailed,
        }),
      )
      const selected = catalog.items.find((candidate) => candidate.name === tool)
      if (selected === undefined)
        return ExecutorCallOutcome.cases.Rejected.make({
          message: 'Tool not found. Discover the current tools.',
        })
      return yield* http
        .readCall(
          post(`/apps/${query(references.app)}/tools/call`, {
            profile: references.profile,
            deployment: catalog.deployment,
            expectedProfileRevision: catalog.revision,
            tool,
            input,
          }),
          tool,
        )
        .pipe(
          Effect.map(completedCall),
          Effect.catchTag('ExecutorInputInvalid', ({ problems }) =>
            Effect.succeed(
              ExecutorCallOutcome.cases.Rejected.make({
                message: 'Input did not match the tool schema. Correct its input and retry.',
                problems: validationProblems(problems, [
                  references.app,
                  catalog.deployment,
                  references.profile,
                  ...ExecutorReferences.match(references, {
                    Public: () => [],
                    Authorized: ({ account }) => [account],
                    EnteringKey: () => [],
                    SigningIn: () => [],
                    OAuthSigningIn: () => [],
                    GoogleSigningIn: () => [],
                  }),
                ]),
              }),
            ),
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

/** Acquire transport once and start the scoped catalog writer; tool discovery remains keyed. */
const makeConfigured = Effect.fn('Executor.configure')(function* (
  url: string,
  key: Redacted.Redacted,
  organization: typeof ExecutorOrganizationId.Type,
) {
  const publicOnly = yield* Config.Boolean('VIVID_EXECUTOR_PUBLIC_ONLY').pipe(
    Config.withDefault(false),
  )
  const transport = yield* HttpClient.HttpClient
  const client = HttpClient.mapRequest(transport, (request) =>
    request.pipe(
      HttpClientRequest.prependUrl(
        `${url.replace(/\/$/u, '')}/api/organizations/${query(organization)}`,
      ),
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.acceptJson,
    ),
  )
  const google = yield* loadGoogleInstallation()
  const http = makeHttp(client, google)
  const remoteCatalog = yield* retainCatalog(
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
  const catalog = Effect.fn('Executor.installedCatalog')(function* () {
    const installed = Option.match(google, {
      onNone: () => [],
      onSome: (value) =>
        value.apps.map((app) =>
          ExecutorServiceEntry.make({
            id: app.service,
            name: app.name,
            description: app.name,
            authorization: ServiceAuthorization.cases.SignIn.make({}),
          }),
        ),
    })
    const remote = yield* remoteCatalog().pipe(
      Effect.catchTag('ServiceUnavailable', (error) =>
        installed.length > 0 ? Effect.succeed([]) : Effect.fail(error),
      ),
    )
    return [...installed, ...remote.filter((entry) => Option.isNone(googleApp(google, entry.id)))]
  })
  const availability = yield* makeAuthorization(http, catalog)
  const discover = Effect.fn('Executor.discoverCached')((references: ExecutorReferences) =>
    Cache.get(snapshots, references),
  )
  const complete = makeComplete(http)
  const completeSignIn = makeCompleteSignIn(http)
  const remove = makeRemove(http)
  const call = makeCall(http, discover)
  const install = yield* makeInstall(http)
  const registration = makeBegin(http, availability, install)
  return Executor.of({
    configured: true,
    catalog: availability.catalog,
    authorization: availability.authorization,
    begin: registration.begin,
    add: Effect.fn('Executor.addPublic')((input) =>
      publicOnly ? registration.add(input) : Effect.fail(ExecutorPublicAddressRequired.make({})),
    ),
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
                message: 'The integration changed; discover its tools again.',
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
          message: 'Configure VIVID_EXECUTOR_URL and VIVID_EXECUTOR_KEY to use integrations',
        }),
      )
      return Executor.of({
        configured: false,
        catalog: Effect.fn('Executor.catalog')(() => unavailable),
        authorization: Effect.fn('Executor.authorization')(() => unavailable),
        begin: Effect.fn('Executor.begin')(() => unavailable),
        add: Effect.fn('Executor.add')(() => unavailable),
        reauthorize: Effect.fn('Executor.reauthorize')(() => unavailable),
        complete: Effect.fn('Executor.complete')(() => unavailable),
        completeSignIn: Effect.fn('Executor.completeSignIn')(() => unavailable),
        status: Effect.fn('Executor.status')(() => unavailable),
        remove: Effect.fn('Executor.remove')(() => unavailable),
        tools: Effect.fn('Executor.tools')(() => unavailable),
        call: Effect.fn('Executor.call')(() => unavailable),
      })
    }
    const organization = yield* Config.schema(ExecutorOrganizationId, 'VIVID_EXECUTOR_ORGANIZATION')
    return yield* makeConfigured(url.value, key.value, organization)
  }),
)
