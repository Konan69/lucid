import * as NodeCrypto from 'node:crypto'
import {
  ActionEffect,
  IntegrationPause,
  IntegrationResponse,
  ConnectionId,
  ServiceAuthorization,
  ServiceId,
  ServiceUnavailable,
  MakeIntegrationRequest,
  type MadeFile,
} from '@vivid/contracts'
import * as Config from 'effect/Config'
import * as Arr from 'effect/Array'
import * as Cache from 'effect/Cache'
import * as Clock from 'effect/Clock'
import * as Cause from 'effect/Cause'
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
import * as Record from 'effect/Record'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpBody from 'effect/http/HttpBody'

import { mcpCalls, McpCallOutcome, encodeIntegrationResponse } from './mcp.ts'
import { toolRejectionMessage, validationProblems } from './message.ts'
import { retainCatalog } from './catalog.ts'
import { accountBranch } from './envelope.ts'
import { requiredSetting, settingSecret } from '../config.ts'
import { ConnectionSource } from './address.ts'
import { keyedFiles, KeyedTransport } from './keyed.ts'
import { discordAppName, discordFiles, discordServiceId } from './discord.ts'
import { keyedService, keyedServices, keyedAddress, personalKeyAuthorization } from './curation.ts'
import { ExecutorSourceUnsupported, ExecutorImportQueryUnsupported } from './source.ts'

import {
  encodeGoogleClient,
  googleAppName,
  googleFiles,
  googleService,
  googleServices,
  GoogleState,
  decodeGoogleState,
  loadGoogleClient,
  type GoogleClient,
} from './google.ts'

export const AdoptionGroupId = Schema.NonEmptyString.pipe(Schema.brand('AdoptionGroupId'))
export const ExecutorAppId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAppId'))
export const ExecutorAccountId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorAccountId'))
/** The owned account survives reauthorization so Adopted removal never loses its cleanup identity. */
export const AdoptedSource = Schema.TaggedUnion({
  Public: {},
  Account: {
    original: Schema.NonEmptyString,
    adopted: Schema.NonEmptyString,
    account: ExecutorAccountId,
  },
})
const ExecutorVersionId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorVersionId'))
/** An app either needs no account or binds one exact requirement in its declared scope. */
export const ExecutorBinding = Schema.TaggedUnion({
  Public: {},
  Account: { requirement: Schema.NonEmptyString, scope: Schema.Literals(['app', 'user']) },
})
const ExecutorOrganizationId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorOrganizationId'))
const ExecutorProviderId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorProviderId'))
export const executorReconnectMessage = 'Remove this integration and connect it again.'
export const connectionSetupMessage = 'This integration is not set up on this Vivid yet.'
export const ExecutorOwnerId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorOwnerId'))
export const ExecutorAuthorizationId = Schema.NonEmptyString.pipe(
  Schema.brand('ExecutorAuthorizationId'),
)

/**
 * Which Executor user a Connection's app and account belong to, stored on its row
 * (`executor_principal` in `tables.ts`).
 *
 * `installation`: the user whose key is `VIVID_EXECUTOR_KEY`, the installation's owner. Every
 * Connection made before Persons had members, and every Company-shared one, is this: those apps
 * and accounts exist in Executor under that user and cannot be moved to another.
 *
 * `member`: the row's Person's own Executor member (`members.ts`). Executor's access rules then
 * keep the app and its personal account to that member: another member's key, and the owner's,
 * are refused its tools (executor@2.0.0-beta.23 `concepts/organizations-and-access.md`), so a
 * mistake in Vivid's own mapping cannot reach another Person's account.
 *
 * Adopted execution uses the member. `adopted-account` keeps its creator for Watches and status
 * because beta.23 requires personal-account access; `adopted-public` uses the member for both.
 * Management stays with the installation creator in either case.
 */
export const ExecutorPrincipal = Schema.Literals([
  'installation',
  'member',
  'adopted-account',
  'adopted-public',
])
export type ExecutorPrincipal = typeof ExecutorPrincipal.Type

/**
 * The credential one request to Executor is sent with, decided from a Connection's principal.
 * `Member` carries the stable Executor user identity and its key. Consumers do not need to read
 * provisioning state to address that member in Executor's public APIs.
 */
export const ExecutorUserId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorUserId'))
export const ExecutorCaller = Schema.TaggedUnion({
  Installation: {},
  Member: { user: ExecutorUserId, key: Schema.Redacted(Schema.String) },
})
export type ExecutorCaller = typeof ExecutorCaller.Type
/** The installation owner, for installation resources and for Connections it owns. */
export const installationCaller: ExecutorCaller = ExecutorCaller.cases.Installation.make({})

/**
 * Who a service says an account is: an address, else a username, else a display name. It names
 * the account on every screen and to Vivid, inside the account's whole name ("Gmail (…)"), which
 * the runtime accepts up to 200 characters, so one that is longer than 120, empty, padded or on
 * more than one line is not used as a name at all.
 */
export const AccountIdentity = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, 120),
  Schema.isPattern(/^[^\r\n]*$/u),
)
export type AccountIdentity = typeof AccountIdentity.Type
const decodeAccountIdentity = Schema.decodeUnknownOption(AccountIdentity)

/** Deletion authority is either a Vivid allocation, a proven migration copy, or access only. */
export const AdoptionFinalization = Schema.TaggedUnion({ Pending: {}, Completed: {} })
export const ExecutorAppOwnership = Schema.TaggedUnion({
  Dedicated: {},
  Adopted: { group: AdoptionGroupId, source: AdoptedSource, finalization: AdoptionFinalization },
  Copied: { original: ExecutorAppId },
  Unproven: {},
})

const referenceFields = {
  service: ServiceId,
  app: ExecutorAppId,
  owner: ExecutorOwnerId,
  binding: ExecutorBinding,
  appOwnership: ExecutorAppOwnership,
}

/** Exact resources survive refusal until the store can prove exclusive reclamation. */
export const ExecutorRetired = Schema.Struct({
  original: ExecutorAppId,
  ownership: Schema.Literals(['Dedicated', 'Unproven']),
  account: Schema.OptionFromNullOr(ExecutorAccountId),
  copies: Schema.Array(ExecutorAppId),
  authorization: Schema.OptionFromNullOr(ExecutorAuthorizationId),
})

/** Pending authorization has no account identity yet; status resolves it after completion. */
export const ExecutorReferences = Schema.TaggedUnion({
  Public: referenceFields,
  ReconnectRequired: {
    service: ServiceId,
    owner: ExecutorOwnerId,
    retired: ExecutorRetired,
    reason: Schema.Literals([
      'UnresolvedMigration',
      'RemovalPending',
      'AmbiguousMigration',
      'SharedSelection',
      'MigrationTargetMissing',
      'MigrationTargetNotReady',
      'MigrationTargetUnavailable',
    ]),
  },
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
  /** Durable bridge: original user links keep Installation calls valid until the principal commits. */
  Adopting: {
    ...referenceFields,
    account: ExecutorAccountId,
    group: AdoptionGroupId,
    original: Schema.NonEmptyString,
    adopted: Schema.NonEmptyString,
  },
})
export type ExecutorReferences = typeof ExecutorReferences.Type

export type ExecutorActiveReferences = Exclude<
  ExecutorReferences,
  { readonly _tag: 'ReconnectRequired' }
>
export const ExecutorServiceEntry = Schema.Struct({
  id: ServiceId,
  name: Schema.String,
  description: Schema.String,
  /** Only authored services have a known website. Beta.23 catalog icons name image resources,
   * not service domains, so catalog entries keep domain null and retain the image address. */
  domain: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
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
  output: Schema.Option(Schema.Json).pipe(Schema.withConstructorDefault(Effect.succeedNone)),
  effect: ActionEffect,
})
/**
 * How Executor is told a listed tool's account. `Direct`: the provider's input as it is. `Account`:
 * wrapped as `{ accountId, input }` with the Connection's own account, because Executor listed the
 * tool through its account router (`envelope.ts`). Discovery decides it from the listed schema and
 * the invocation snapshot keeps it beside the tool, so a call can never send a shape the listing
 * did not ask for, and the model only ever sees the provider's input.
 */
const ToolAccount = Schema.TaggedUnion({
  Direct: {},
  Account: { accountId: ExecutorAccountId },
})
/** A listed tool as Vivid shows it, with how Executor is told its account when it is called. */
interface ListedTool {
  readonly tool: typeof ExecutorTool.Type
  readonly account: typeof ToolAccount.Type
}
export const ExecutorCallOutcome = Schema.TaggedUnion({
  Paused: { pause: IntegrationPause },
  UncertainPause: {},
  Expired: {},
  Accepted: { value: Schema.Json },
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
class ExecutorInputInvalid extends Schema.TaggedError<ExecutorInputInvalid>()(
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
/** OAuth discovery/client setup can fail before reporting client-required.
 * Only finite SDK reasons cross this boundary; the original response can contain credentials.
 * See Executor packages/sdk/src/contracts/oauth.ts OAuthSetupFailed. */
const OAuthSetupReason = Schema.Literals([
  'service_unavailable',
  'rate_limited',
  'discovery_missing',
  'discovery_invalid',
  'discovery_blocked',
  'resource_mismatch',
  'client_not_approved',
  'client_registration_required',
  'client_metadata_rejected',
  'registration_rejected',
  'incompatible_response',
  'invalid_client',
  'invalid_redirect',
  'token_exchange',
  'unsupported',
])
class ExecutorOAuthSetupFailed extends Schema.TaggedError<ExecutorOAuthSetupFailed>()(
  'ExecutorOAuthSetupFailed',
  { ...errorContext, reason: OAuthSetupReason },
  { title: 'Integration sign-in setup failed' },
) {}

/** Active resources or changed revisions must be resolved before management writes are retried. */
export class ExecutorConflict extends Schema.TaggedError<ExecutorConflict>()(
  'ExecutorConflict',
  errorContext,
  { title: 'Connection resource conflict' },
) {}
/** A create-only install can lose a race to another Vivid process. Its exact name is safely
 * reread once; unrelated account conflicts must never trigger inventory recovery.
 */
class ExecutorAppNameTaken extends Schema.TaggedError<ExecutorAppNameTaken>()(
  'ExecutorAppNameTaken',
  errorContext,
  { title: 'Integration app name already installed' },
) {}
/** An upstream 5xx or ToolCallFailed can follow external effects. */
class ExecutorExecutionUncertain extends Schema.TaggedError<ExecutorExecutionUncertain>()(
  'ExecutorExecutionUncertain',
  {
    ...errorContext,
    cause: Schema.Literals(['Dispatch', 'Elicitation']).pipe(
      Schema.withConstructorDefault(Effect.succeed('Dispatch')),
    ),
  },
  { title: 'Connection outcome unknown' },
) {}
/** A sign-in cannot start without host configuration; preserve the pending foreign references. */
export class ExecutorSignInRequired extends Schema.TaggedError<ExecutorSignInRequired>()(
  'ExecutorSignInRequired',
  {
    references: ExecutorReferences,
    message: Schema.String,
    reason: Schema.Literals(['SetupRequired', 'OAuthClientUnavailable', 'Rejected']).pipe(
      Schema.withConstructorDefault(Effect.succeed('Rejected' as const)),
    ),
  },
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
  { ...errorContext, resource: Schema.Literals(['App', 'Version', 'Account']) },
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

/** The app account requirement changed. No credential or link is committed on this refusal. */
class ExecutorRequirementChanged extends Schema.TaggedError<ExecutorRequirementChanged>()(
  'ExecutorRequirementChanged',
  errorContext,
  { title: 'The app account requirement changed' },
) {}

/** The account connection was refused. No credential or link is committed on this refusal. */
class ExecutorConnectionRefused extends Schema.TaggedError<ExecutorConnectionRefused>()(
  'ExecutorConnectionRefused',
  errorContext,
  { title: 'The account connection was refused' },
) {}

/** Account choice is unsupported. No credential or link is committed on this refusal. */
class ExecutorAccountChoiceUnsupported extends Schema.TaggedError<ExecutorAccountChoiceUnsupported>()(
  'ExecutorAccountChoiceUnsupported',
  errorContext,
  { title: 'Account choice is unsupported' },
) {}

/** The OAuth client is unavailable. No credential or link is committed on this refusal. */
class ExecutorOAuthClientUnavailable extends Schema.TaggedError<ExecutorOAuthClientUnavailable>()(
  'ExecutorOAuthClientUnavailable',
  errorContext,
  { title: 'The OAuth client is unavailable' },
) {}

/** Select one OAuth client. No credential or link is committed on this refusal. */
class ExecutorOAuthClientAmbiguous extends Schema.TaggedError<ExecutorOAuthClientAmbiguous>()(
  'ExecutorOAuthClientAmbiguous',
  errorContext,
  { title: 'Select one OAuth client' },
) {}

/**
 * Executor's sign-in limit refused a member's provisioning (Better Auth answers 429 on its
 * sign-in routes). Nothing was changed; the same call later continues where it stopped.
 */
export class ExecutorRateLimited extends Schema.TaggedError<ExecutorRateLimited>()(
  'ExecutorRateLimited',
  errorContext,
  { title: 'Executor rate limited' },
) {}

export type ExecutorFailure =
  | ExecutorRateLimited
  | ExecutorRequirementChanged
  | ExecutorConnectionRefused
  | ExecutorAccountChoiceUnsupported
  | ExecutorOAuthClientUnavailable
  | ExecutorOAuthClientAmbiguous
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
  | ExecutorOAuthSetupFailed
  | ExecutorConflict
  | ExecutorAppNameTaken
  | ExecutorExecutionUncertain
  | ExecutorSignInRequired
  | ExecutorAuthorizationUnavailable
  | ExecutorResourceMissing
  | ExecutorApprovalUnsupported

/** Only authored source deployment exposes compiler diagnostics for the author to repair. */
export class ExecutorBuildFailed extends Schema.TaggedError<ExecutorBuildFailed>()(
  'ExecutorBuildFailed',
  { message: Schema.String },
  { title: 'ExecutorBuildFailed' },
) {}

const BeginInput = Schema.Struct({
  connectionId: ConnectionId,
  service: ServiceId,
  owner: ExecutorOwnerId,
  subject: Schema.NonEmptyString,
  /** What Executor files the account under in its own records: the service's name.
   * Vivid never reads it back. What a Person calls an account, and who the service says it is,
   * are Vivid's own columns (`connections/tables.ts`). */
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

/**
 * Everything Vivid does with one Connection's app and account, sent as one Executor caller.
 *
 * Vivid owns Person attribution; Executor owns who may use an app and an account, decided by the
 * user the request is authenticated as. Each Connection has a dedicated app and an exact
 * requirement link, and the caller (`ExecutorCaller`) says whose they are: the installation owner,
 * or the Person's own member, whose app and personal account no other key can call.
 */
export interface ExecutorConnectionOperations {
  /** Source redeployment retires pinned discovery snapshots before the next invocation. */
  readonly refresh: Effect.Effect<void>
  /** Read the event namespace through the same authenticated app transport as Connection setup. */
  readonly appSlug: (app: typeof ExecutorAppId.Type) => Effect.Effect<string, ExecutorFailure>
  readonly begin: (
    input: typeof BeginInput.Type,
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure>
  /** Register a URL source, then use the same app and authorization path as catalogue imports. */
  readonly add: (
    input: typeof BeginInput.Type & { readonly source: ConnectionSource },
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure>
  /** Authored apps have a repairable build failure outside ordinary Connection failures. */
  readonly make: (
    input: typeof BeginInput.Type & { readonly files: ReadonlyArray<MadeFile> },
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure | ExecutorBuildFailed>
  /** Source access is restricted to owned authored apps by the product store. */
  readonly readMade: (
    app: typeof ExecutorAppId.Type,
  ) => Effect.Effect<ReadonlyArray<MadeFile>, ExecutorFailure>
  readonly reviseMade: (
    app: typeof ExecutorAppId.Type,
    files: ReadonlyArray<MadeFile>,
  ) => Effect.Effect<void, ExecutorFailure | ExecutorBuildFailed>
  /** Renew authorization without allocating another app or account. */
  readonly reauthorize: (
    input: typeof BeginInput.Type & { readonly references: ExecutorReferences },
  ) => Effect.Effect<typeof ExecutorStep.Type, ExecutorFailure>
  readonly complete: (
    input: typeof CompleteInput.Type,
  ) => Effect.Effect<typeof ExecutorReferences.cases.Authorized.Type, ExecutorFailure>
  /** The application server hosts returnAddress and supplies the full callback URL, kept redacted. */
  readonly completeSignIn: (
    input: typeof SignInInput.Type,
  ) => Effect.Effect<typeof ExecutorReferences.cases.Authorized.Type, ExecutorFailure>
  readonly status: (
    references: ExecutorReferences,
  ) => Effect.Effect<typeof ExecutorStatus.Type, ExecutorFailure>
  /**
   * Who the service says the Connection's account is, asked of the service now. None for a
   * Connection with no account (a public service), for one whose app has no way to ask, and for
   * an answer that names nobody.
   */
  readonly identity: (
    references: ExecutorReferences,
  ) => Effect.Effect<Option.Option<AccountIdentity>, ExecutorFailure>
  /** A member's personal account can be removed only with that member's own key. */
  readonly remove: (references: ExecutorReferences) => Effect.Effect<void, ExecutorFailure>
  readonly tools: (
    references: ExecutorReferences,
  ) => Effect.Effect<readonly (typeof ExecutorTool.Type)[], ExecutorFailure>
  readonly call: (
    input: typeof CallInput.Type,
  ) => Effect.Effect<typeof ExecutorCallOutcome.Type, ExecutorFailure>
  readonly resume: (input: {
    readonly pause: IntegrationPause
    readonly effect: ActionEffect
    readonly response: IntegrationResponse
  }) => Effect.Effect<typeof ExecutorCallOutcome.Type, ExecutorFailure>
  /** Reclaim only resources the Connection store proved unreferenced under its database lock. */
  readonly prepareRetirement: (
    resources: typeof ExecutorRetired.Type,
  ) => Effect.Effect<typeof ExecutorRetired.Type, ExecutorFailure>
  readonly retire: (input: {
    readonly resources: typeof ExecutorRetired.Type
    readonly retainedApps: ReadonlyArray<typeof ExecutorAppId.Type>
    readonly retainedAccounts: ReadonlyArray<typeof ExecutorAccountId.Type>
  }) => Effect.Effect<void, ExecutorFailure>
}

/**
 * The Executor adapter. Installation-wide reads run as the installation owner; anything on one
 * Connection's app or account, its removal and reclamation included, runs as the caller the Connection's principal names,
 * passed explicitly to `as` so no request can fall back to another credential.
 */
export interface ExecutorService {
  /** Inspect public service setup without issuing an account grant or starting sign-in. */
  readonly authorization: (input: {
    readonly service: ServiceId
    readonly returnAddress: string
  }) => Effect.Effect<ServiceAuthorization, ExecutorFailure>
  readonly catalog: Effect.Effect<readonly (typeof ExecutorServiceEntry.Type)[], ExecutorFailure>
  /** The operations on one Connection's app and account, each sent as `caller`. */
  readonly as: (caller: ExecutorCaller) => ExecutorConnectionOperations
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
  scope: Schema.Literals(['app', 'user']),
  cardinality: Schema.Literals(['one', 'many']),
  provider: ExecutorProviderId,
  definition: Schema.Struct({ auth: Schema.Record(Schema.String, AuthorizationMethod) }),
})
const WireApp = Schema.Struct({
  id: ExecutorAppId,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Requirement) }),
})
// Inventory identifies app provenance only. Unrelated apps may use requirement shapes this
// adapter cannot authorize; decode requirements only on the selected app's detail endpoint.
const ExecutorInventory = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      id: ExecutorAppId,
      name: Schema.NonEmptyString,
      activeVersion: Schema.NullOr(ExecutorVersionId),
      copiedFrom: Schema.NullOr(Schema.Struct({ reference: Schema.NonEmptyString })),
    }),
  ),
  links: Schema.Array(Schema.Struct({ app: ExecutorAppId, account: ExecutorAccountId })),
  accounts: Schema.Array(Schema.Struct({ id: ExecutorAccountId })),
})
const WireSetup = Schema.Struct({
  mode: Schema.Literals(['automatic', 'client-required']),
  clients: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
})
const WireAccount = Schema.Struct({ id: ExecutorAccountId })
/**
 * `AccountHealth` in Executor's `packages/sdk/src/contracts/account.ts`: `info` is the upstream
 * identity the app's own check reported (`AccountInfo` in `packages/apps/src/contracts/provider.ts`),
 * null when the app has no check or the check named nobody. Only the three fields that can name an
 * account are read; its picture and profile addresses are left where they are.
 */
const WireHealth = Schema.Struct({
  info: Schema.NullOr(
    Schema.Struct({
      email: Schema.optionalKey(Schema.String),
      username: Schema.optionalKey(Schema.String),
      displayName: Schema.optionalKey(Schema.String),
    }),
  ),
})

const ConnectionFailure = Schema.TaggedUnion({
  OAuthSetupFailed: { reason: OAuthSetupReason },
  OAuthCompletionFailed: {},
  AccountConnectionRefused: {},
  AccountConnectionTargetChanged: {},
})
const savedConnectionFailure = Schema.optionalKey(Schema.Struct({ error: ConnectionFailure }))

const WireConnection = Schema.Struct({
  id: ExecutorAuthorizationId,
  reconnectAccount: Schema.NullOr(WireAccount),
  target: Schema.Struct({ app: ExecutorAppId, requirement: Schema.NonEmptyString }),
  state: Schema.Union([
    Schema.Struct({ status: Schema.Literal('pending'), failure: savedConnectionFailure }),
    Schema.Struct({ status: Schema.Literal('cancelled') }),
    Schema.Struct({ status: Schema.Literal('expired'), failure: savedConnectionFailure }),
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
const AccountSelections = Schema.Record(Schema.String, Schema.Array(ExecutorAccountId))
const WireTools = Schema.Struct({
  items: Schema.Array(WireTool),
  version: ExecutorVersionId,
  accounts: Schema.Struct({ app: AccountSelections, user: Schema.optionalKey(AccountSelections) }),
  routers: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      error: Schema.optionalKey(Schema.Struct({ _tag: Schema.NonEmptyString })),
    }),
  ),
  next: Schema.optionalKey(Schema.NonEmptyString),
})
const WireCatalogEntry = Schema.Struct({
  id: ServiceId,
  package: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  auth: Schema.Array(
    Schema.Struct({
      method: Schema.NonEmptyString,
      kind: Schema.Literals(['secrets', 'oauth2']),
    }),
  ),
  icons: Schema.Array(
    Schema.Struct({
      src: Schema.String,
      theme: Schema.optionalKey(Schema.Literals(['light', 'dark'])),
    }),
  ),
  category: Schema.optionalKey(Schema.String),
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
  Missing: { resource: Schema.Literals(['App', 'Version', 'Account']) },
  Conflict: {},
  Uncertain: {
    cause: Schema.Literals(['Dispatch', 'Elicitation']).pipe(
      Schema.withConstructorDefault(Effect.succeed('Dispatch')),
    ),
  },
  Rejected: { message: Schema.String },
  SetupRequired: {},
  ApprovalUnsupported: {},
  AppNameTaken: {},
  RequirementChanged: {},
  ConnectionRefused: {},
  AccountChoiceUnsupported: {},
  OAuthClientUnavailable: {},
  OAuthClientAmbiguous: {},
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
  VersionNotFound: FailureMode.cases.Missing.make({ resource: 'Version' }),
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
  AppNameTaken: FailureMode.cases.AppNameTaken.make({}),
  AppSlugTaken: conflict,
  AccountConnectionTargetChanged: FailureMode.cases.RequirementChanged.make({}),
  RequirementMismatch: FailureMode.cases.RequirementChanged.make({}),
  AccountConnectionRefused: FailureMode.cases.ConnectionRefused.make({}),
  AccountChoiceUnsupported: FailureMode.cases.AccountChoiceUnsupported.make({}),
  OAuthClientNotFound: FailureMode.cases.OAuthClientUnavailable.make({}),
  OAuthClientUnavailable: FailureMode.cases.OAuthClientUnavailable.make({}),
  AccountLinkedToApp: conflict,
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
  ToolElicitationFailed: FailureMode.cases.Uncertain.make({ cause: 'Elicitation' }),
  RequestInvalid: FailureMode.cases.Rejected.make({
    message: 'The request is invalid for this installation.',
  }),
  AccountFieldsInvalid: FailureMode.cases.Rejected.make({
    message: 'Complete the required key fields shown by this integration.',
  }),
  AuthMethodInvalid: FailureMode.cases.Rejected.make({
    message: 'The integration authorization method changed; start authorization again.',
  }),
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
  VersionBuildFailed: FailureMode.cases.Rejected.make({
    message: 'The imported service could not be built.',
  }),
  SourceError: FailureMode.cases.Rejected.make({
    message: 'The retained service source is unavailable or cannot be changed.',
  }),
  AppVersionChanged: conflict,
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
const WireInputInvalid = Schema.TaggedStruct('InputInvalid', {
  problems: Schema.Array(Schema.String),
})
const decodeInputInvalid = Schema.decodeUnknownEffect(WireInputInvalid)

/** Decode only the safe reason; never preserve OAuth's callback, diagnostics or supplied values. */
const WireOAuthSetupFailure = Schema.TaggedStruct('OAuthSetupFailed', {
  reason: OAuthSetupReason,
})
const isOAuthSetupFailure = Schema.is(Schema.TaggedStruct('OAuthSetupFailed', {}))
const decodeOAuthSetupFailure = Schema.decodeUnknownEffect(WireOAuthSetupFailure)

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
    RequirementChanged: (): ExecutorFailure => ExecutorRequirementChanged.make(context),
    ConnectionRefused: (): ExecutorFailure => ExecutorConnectionRefused.make(context),
    AccountChoiceUnsupported: (): ExecutorFailure => ExecutorAccountChoiceUnsupported.make(context),
    OAuthClientUnavailable: (): ExecutorFailure => ExecutorOAuthClientUnavailable.make(context),
    OAuthClientAmbiguous: (): ExecutorFailure => ExecutorOAuthClientAmbiguous.make(context),

    Conflict: (): ExecutorFailure => ExecutorConflict.make(context),
    Uncertain: ({ cause }): ExecutorFailure =>
      ExecutorExecutionUncertain.make({ ...context, cause }),
    Rejected: ({ message }): ExecutorFailure => ExecutorRejected.make({ ...context, message }),
  })
}

/** MCP carries the same failure vocabulary as REST, without trusting provider diagnostics. */
export function mcpFailure(code: string, tool: string | null, problems: readonly string[]) {
  if (code === 'InputInvalid' && tool !== null && problems.length > 0)
    return ExecutorInputInvalid.make({ service: 'connections', tool, problems })
  return isKnownFailureTag(code)
    ? translateFailure(code, tool)
    : ExecutorExecutionUncertain.make({ service: 'connections', tool })
}

/** Each decoder is compiled once per response shape at layer acquisition. No automatic retry is
 * installed: an accepted write or resume may have committed before the response was lost.
 */
function responseReader<E>(
  client: HttpClient.HttpClient,
  beforeFailure: (response: {
    readonly status: number
    readonly body: unknown
  }) => Effect.Effect<void, E>,
) {
  // The request Scope below releases each response, including the unread 401 body.
  const scoped = HttpClient.withScope(client)
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
        const response = yield* scoped
          .execute(prepared)
          .pipe(Effect.mapError(() => ExecutorTransportFailure.make(context)))
        if (response.status === 401) {
          return yield* ExecutorAccessDenied.make(context)
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
        yield* beforeFailure({ status: response.status, body })
        const failure = yield* decodeFailure(body).pipe(Effect.mapError(invalid))
        if (isOAuthSetupFailure(failure)) {
          const detail = yield* decodeOAuthSetupFailure(body).pipe(Effect.mapError(invalid))
          return yield* ExecutorOAuthSetupFailed.make({ ...context, reason: detail.reason })
        }
        if (isInputInvalid(failure) && tool !== null) {
          const detail = yield* decodeInputInvalid(body).pipe(
            Effect.mapError(() => translateFailure('InputInvalid', tool)),
          )
          return yield* ExecutorInputInvalid.make({
            ...context,
            problems: detail.problems,
          })
        }
        if (!isKnownFailureTag(failure._tag)) {
          if (response.status >= 500) return yield* ExecutorExecutionUncertain.make(context)
          return yield* ExecutorRejected.make({
            ...context,
            message:
              tool === null
                ? 'The Integration management request was refused.'
                : 'The Integration refused this request before running the tool.',
          })
        }
        return yield* translateFailure(failure._tag, tool)
      },
      (effect, _request, tool) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: '90 seconds',
            orElse: () =>
              Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool })),
          }),
        ),
    )
  }
}

/** Catalog auth is a list of declared methods. Installation learns the actual secret fields. */
function catalogAuthorization(entry: typeof WireCatalogEntry.Type) {
  if (keyedService(entry.id) !== undefined) return personalKeyAuthorization()
  if (entry.auth.length === 0) return ServiceAuthorization.cases.None.make({})
  if (entry.auth.some((method) => method.kind === 'oauth2'))
    return ServiceAuthorization.cases.SignIn.make({})
  return ServiceAuthorization.cases.KnownAfterInstall.make({})
}

/** Parse icon addresses once; invalid and non-HTTPS entries carry no rendering authority. */
const decodeIconAddress = Schema.decodeResult(Schema.URLFromString)

/** Prefer neutral/light HTTPS icons without inferring a website domain from an image URL. */
function catalogEntry(entry: typeof WireCatalogEntry.Type) {
  const icons = Arr.filterMap(entry.icons, (icon) => {
    const address = decodeIconAddress(icon.src)
    if (Result.isFailure(address) || address.success.protocol !== 'https:') return Result.failVoid
    return Result.succeed(icon)
  })
  const icon = icons.find((value) => value.theme === undefined || value.theme === 'light')
  return ExecutorServiceEntry.make({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    domain: null,
    icon: icon === undefined ? null : icon.src,
    authorization: catalogAuthorization(entry),
  })
}

/** HostedTool.readOnly and annotations.readOnlyHint carry the host's query category;
 * the OpenAPI adapter derives it from GET, HEAD and OPTIONS. Destructive wins.
 * Executor packages/apps/src/implementation/protocol-operations.ts protocolOperations
 * categorizes both absent readOnly and explicit false as mutation. host.ts inspect
 * then writes readOnly=false and readOnlyHint=false for both; HostedTool in
 * packages/apps/src/contracts/host.ts exposes no original-declaration provenance.
 * Thus false here cannot prove the source explicitly declared a write. Approval
 * callbacks and HTTP methods are absent from HostedTools.list; names never prove
 * safety. This projection keeps write for missing/conflicting evidence, but Jev
 * cannot distinguish a declared write from the host's conservative default. */
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

/** Only explicit provider acceptance evidence changes a synchronous answer into unfinished work.
 * MCP retains its structured envelope in beta.23. Google long-running operations omit `done`
 * until finished (Drive long-running-operations docs); an ordinary resource id proves no job.
 * OpenAPI HTTP status is discarded upstream, so only status exposed in the answer is usable. */
const pendingStatus = Schema.Literals([
  'accepted',
  'queued',
  'scheduled',
  'pending',
  'processing',
  'in_progress',
])
const acceptance = Schema.Union([
  Schema.Struct({ status: pendingStatus }),
  Schema.Struct({ status: Schema.Literal(202) }),
  Schema.Struct({ statusCode: Schema.Literal(202) }),
  Schema.Struct({ accepted: Schema.Literal(true) }),
  Schema.Struct({ jobId: Schema.NonEmptyString, status: Schema.optionalKey(pendingStatus) }),
  Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^operations\//u)),
    done: Schema.optionalKey(Schema.NullOr(Schema.Literal(false))),
  }),
])
const isAccepted = Schema.is(
  Schema.Union([acceptance, Schema.Struct({ structuredContent: acceptance })]),
)

/** A synchronous answer can reject the call, accept unfinished work, or confirm its result. */
function completedCall(value: Schema.Json) {
  if (isToolError(value))
    return ExecutorCallOutcome.cases.Rejected.make({ message: toolRejectionMessage })
  if (isAccepted(value)) return ExecutorCallOutcome.cases.Accepted.make({ value })
  return ExecutorCallOutcome.cases.Completed.make({ value })
}

/** Requirement routes carry the declared scope. A public app has no account route. */
function bindingPath(references: Pick<ExecutorActiveReferences, 'app' | 'binding'>) {
  return ExecutorBinding.match<Effect.Effect<string, ExecutorNotReady>>(references.binding, {
    Public: () => Effect.fail(ExecutorNotReady.make({ service: 'connections', tool: null })),
    Account: ({ scope, requirement }) =>
      Effect.succeed(`/apps/${query(references.app)}/accounts/${scope}/${query(requirement)}`),
  })
}

/** Centralized encoding leaves foreign identifiers opaque rather than interpreting their prefixes. */
const query = (value: string) => encodeURIComponent(value)
/** Body encoding happens before dispatch and contains no diagnostic/logging of secret fields. */
const post = (path: string, body: Schema.Json) => jsonBody(HttpClientRequest.post(path), body)

/** Carry only stable identity across state transitions; never copy another variant discriminator. */
function referenceIdentity(references: ExecutorActiveReferences) {
  return {
    service: references.service,
    app: references.app,
    binding: references.binding,
    appOwnership: references.appOwnership,
    owner: references.owner,
  }
}

const decodeMadeFiles = Schema.decodeEffect(MakeIntegrationRequest.fields.files)

const decodeBuildFailure = Schema.decodeUnknownOption(
  Schema.TaggedStruct('VersionBuildFailed', {
    message: Schema.String,
  }),
)

/** A rejected first build has no retained app (Executor VersionBuildFailed at 26d03a48).
 * Read diagnostics only here so existing keyed, Google and imported apps keep their failures. */
function deployReader<A, I>(client: HttpClient.HttpClient, schema: Schema.Codec<A, I>) {
  const read = responseReader(client, ({ status, body }) => {
    const build = decodeBuildFailure(body)
    if (status === 422 && Option.isSome(build))
      return Effect.fail(
        ExecutorBuildFailed.make({ message: build.value.message.trim().slice(0, 4000) }),
      )
    return Effect.void
  })(schema)
  return (request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>) =>
    read(request, null)
}

/** Compile the narrow foreign response schemas once for this authenticated client. */
function makeHttp(client: HttpClient.HttpClient, google: GoogleClient) {
  const read = responseReader(client, () => Effect.void)
  const readApp = read(WireApp)
  const readInventory = read(ExecutorInventory)
  const readLinks = read(
    Schema.Array(
      Schema.Struct({
        requirement: Schema.NonEmptyString,
        account: Schema.Struct({ id: ExecutorAccountId }),
      }),
    ),
  )
  const readConnection = read(WireConnection)
  const readAccount = read(WireAccount)
  const readCatalog = read(WireCatalog)
  const readTools = read(WireTools)
  const readCall = read(Schema.Json)
  const readSignIn = read(WireSignIn)
  const readRemoval = read(Schema.Json)
  return {
    google,
    readDeploy: deployReader(client, WireApp),
    readRevision: deployReader(client, Schema.Json),
    readSource: read(
      Schema.Struct({
        files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
      }),
    ),
    readSchedules: read(
      Schema.Array(
        Schema.Struct({
          name: Schema.NonEmptyString,
          scope: Schema.optionalKey(Schema.Literal('app')),
        }),
      ),
    ),
    readApp,
    readInventory,
    readConnection,
    readLinks,
    readAccount,
    readCatalog,
    readTools,
    readCall,
    readSignIn,
    readRemoval,
    readSetup: read(WireSetup),
    readHealth: read(WireHealth),
  }
}
type ExecutorHttp = ReturnType<typeof makeHttp>

/** Compare every scope and requirement, not just membership in a flattened account list. */
function validateSelections(
  references: ExecutorReferences,
  accounts: typeof WireTools.Type.accounts,
) {
  const actual = [
    ...Object.entries(accounts.app).map(([name, ids]) => ({ scope: 'app', name, ids })),
    ...Object.entries(accounts.user === undefined ? {} : accounts.user).map(([name, ids]) => ({
      scope: 'user',
      name,
      ids,
    })),
  ].filter((slot) => slot.ids.length > 0)
  const matches = ExecutorReferences.match(references, {
    Public: () => actual.length === 0,
    Adopting: (value) =>
      actual.length > 0 &&
      actual.every(
        (slot) =>
          slot.ids.length === 1 &&
          slot.ids[0] === value.account &&
          ((slot.scope === 'user' && slot.name === value.original) ||
            (slot.scope === 'app' && slot.name === value.adopted)),
      ),
    Authorized: (value) =>
      ExecutorBinding.match(value.binding, {
        Public: () => false,
        Account: (binding) =>
          actual.length === 1 &&
          actual.some(
            (slot) =>
              slot.scope === binding.scope &&
              slot.name === binding.requirement &&
              slot.ids.length === 1 &&
              slot.ids[0] === value.account,
          ),
      }),
    EnteringKey: () => false,
    SigningIn: () => false,
    OAuthSigningIn: () => false,
    GoogleSigningIn: () => false,
    ReconnectRequired: () => false,
  })
  return matches
    ? Effect.void
    : Effect.fail(ExecutorNotReady.make({ service: 'connections', tool: null }))
}

/** Pin all pages to the first version and refuse changed account selections or cursor cycles. */
function makeDiscovery(http: ExecutorHttp) {
  return Effect.fn('Executor.discover')(function* (references: ExecutorReferences) {
    if (ExecutorReferences.guards.ReconnectRequired(references))
      return yield* ExecutorNotReady.make({ service: 'connections', tool: null })
    const items: ListedTool[] = []
    let version = Option.none<typeof ExecutorVersionId.Type>()
    let cursor = Option.none<string>()
    const seen = new Set<string>()
    do {
      const params = new URLSearchParams()
      if (Option.isSome(version)) params.set('version', version.value)
      if (Option.isSome(cursor)) params.set('cursor', cursor.value)
      const page = yield* http.readTools(
        Effect.succeed(
          HttpClientRequest.get(`/apps/${query(references.app)}/tools?${params.toString()}`),
        ),
        null,
      )
      if (page.routers.some((router) => router.error !== undefined))
        return yield* ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'This integration could not list every tool. Retry discovery.',
        })
      yield* validateSelections(references, page.accounts)
      if (Option.isSome(version) && version.value !== page.version)
        return yield* ExecutorConflict.make({ service: 'connections', tool: null })
      version = Option.some(page.version)
      for (const tool of page.items) items.push(listedTool(references, tool))
      if (page.next !== undefined) {
        if (seen.has(page.next))
          return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
        seen.add(page.next)
      }
      cursor = Option.fromUndefinedOr(page.next)
    } while (Option.isSome(cursor))
    if (Option.isNone(version))
      return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
    return { items, version: version.value }
  })
}

/**
 * One listed tool as Vivid shows it. A tool Executor lists through its account router is shown
 * with the provider's own schemas from the Connection's account branch and remembers to wrap its
 * input again; any other tool is shown and called as listed. Only an Authorized Connection holds
 * an account, so only it can match a branch.
 */
function listedTool(references: ExecutorReferences, tool: typeof WireTool.Type): ListedTool {
  const listed = { input: tool.inputSchema, output: Option.fromUndefinedOr(tool.outputSchema) }
  const branch = ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references)
    ? Option.map(accountBranch(listed, references.account), (own) => ({
        own,
        account: ToolAccount.cases.Account.make({ accountId: references.account }),
      }))
    : Option.none()
  const schemas = Option.match(branch, { onNone: () => listed, onSome: ({ own }) => own })
  return {
    tool: ExecutorTool.make({
      name: tool.name,
      description: tool.description,
      input: schemas.input,
      output: schemas.output,
      effect: classifyTool(tool),
    }),
    account: Option.match(branch, {
      onNone: () => ToolAccount.cases.Direct.make({}),
      onSome: ({ account }) => account,
    }),
  }
}

/** Hide the invocation snapshot from product discovery; call retains it until dispatch. */
function makeTools(discover: ReturnType<typeof makeDiscovery>) {
  return Effect.fn('Executor.tools')(function* (references: ExecutorReferences) {
    return (yield* discover(references)).items.map((listed) => listed.tool)
  })
}

/** A single stored client is exact. Multiple client choices require operator selection. */
const oauthClient = Effect.fn('Executor.oauthClient')(function* (
  http: ExecutorHttp,
  appId: typeof ExecutorAppId.Type,
  method: string,
) {
  const app = yield* http.readApp(
    Effect.succeed(HttpClientRequest.get(`/apps/${query(appId)}`)),
    null,
  )
  const requirement = yield* accountRequirement(app)
  const setup = yield* http.readSetup(
    Effect.succeed(
      HttpClientRequest.get(
        `/providers/${query(requirement.provider)}/oauth/${query(method)}/setup`,
      ),
    ),
    null,
  )
  if (setup.mode === 'automatic') {
    const automatic: Schema.Json = { automatic: true }
    return automatic
  }
  const client = setup.clients[0]
  if (setup.clients.length === 1 && client !== undefined) {
    const selected: Schema.Json = { id: client.id }
    return selected
  }
  if (setup.clients.length > 1)
    return yield* ExecutorOAuthClientAmbiguous.make({ service: 'connections', tool: null })
  return yield* ExecutorSetupRequired.make({ service: 'connections', tool: null })
})

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
    // A Google service signs in with the installation's own Google client, sent on every start:
    // Executor keeps it encrypted under the owner, provider, callback and scopes it was used for
    // (`resolveSetup` and `beginOAuth` in its `packages/sdk/src/implementation/oauth.ts`).
    const installed = googleService(input.service)
    const submission = { method: methodName, label: input.label }
    const body = Option.isSome(installed)
      ? {
          ...submission,
          client: yield* encodeGoogleClient(http.google).pipe(
            Effect.mapError(() =>
              ExecutorResponseInvalid.make({ service: 'connections', tool: null }),
            ),
          ),
        }
      : { ...submission, client: yield* oauthClient(http, pending.app, methodName) }
    // Both setup refusals preserve the exact pending app for Resume and removal.
    const rejectSetup = (reason: 'SetupRequired' | 'OAuthClientUnavailable') =>
      recordSetupRequired(input.service).pipe(
        Effect.andThen(
          Effect.fail(
            ExecutorSignInRequired.make({
              references: pending,
              message: connectionSetupMessage,
              reason,
            }),
          ),
        ),
      )
    const result = yield* http
      .readSignIn(post(`/connections/${query(pending.authorization)}/oauth/start`, body), null)
      .pipe(
        Effect.catchTags({
          ExecutorSetupRequired: () => rejectSetup('SetupRequired'),
          ExecutorOAuthClientUnavailable: () => rejectSetup('OAuthClientUnavailable'),
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
            return yield* ExecutorSetupRequired.make({ service: 'connections', tool: null })
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

/** A pending request must still name this app's exact requirement. */
const validateConnectionTarget = Effect.fn('Executor.validateConnectionTarget')(function* (
  connection: typeof WireConnection.Type,
  references: Pick<ExecutorActiveReferences, 'app' | 'binding'>,
) {
  if (
    !ExecutorBinding.guards.Account(references.binding) ||
    connection.target.app !== references.app ||
    connection.target.requirement !== references.binding.requirement
  )
    return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
  return undefined
})

/** Completion atomically links the account to the dedicated app requirement. */
function makeAuthorize(
  http: ExecutorHttp,
  recordSetupRequired: (service: ServiceId) => Effect.Effect<void>,
) {
  const signIn = makeSignIn(http, recordSetupRequired)
  return Effect.fn('Executor.authorize')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    references: ExecutorActiveReferences,
    authorization: ServiceAuthorization,
  ) {
    const requirements = Object.entries(app.requirements.accounts)
    const first = requirements[0]
    if (requirements.length !== 1 || first === undefined)
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message:
          'This integration requires a configuration the integration adapter does not support.',
      })
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
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'The integration does not declare one compatible authorization method.',
      })
    const [methodName, method] = chosen
    const bound = {
      ...referenceIdentity(references),
      binding: ExecutorBinding.cases.Account.make({
        requirement,
        scope: definition.scope,
      }),
    }
    const path = yield* bindingPath(bound)
    const body: Schema.Json = ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references)
      ? { account: references.account }
      : {}
    const connection = isPending(references)
      ? { id: references.authorization }
      : yield* http
          .readConnection(post(`${path}/connections`, body), null)
          .pipe(Effect.tap((created) => validateConnectionTarget(created, bound)))
    return yield* AuthorizationMethod.match(method, {
      secrets: ({ fields }) => {
        const pending = ExecutorReferences.cases.EnteringKey.make({
          ...bound,
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
          ...bound,
          authorization: connection.id,
        })
        return yield* signIn(input, pending, methodName)
      }),
    })
  })
}

/**
 * Asks the service who the account is, through the app's own check.
 *
 * Executor runs an app's `health` function only when asked (`check` in `HostedAccounts`,
 * `apps/hosted/server/src/contracts/accounts.ts`: `POST …/accounts/:account/health`), never by
 * itself when an account is connected, so a Connection that has just become ready is asked here.
 * An app with no `health` answers with no `info`, which is most of the catalogue.
 *
 * The most specific name wins: an address tells two accounts apart where two display names often
 * do not. A value that cannot be a name (`AccountIdentity`) is passed over for the next.
 */
function makeIdentity(http: ExecutorHttp) {
  return Effect.fn('Executor.identity')(function* (references: ExecutorReferences) {
    if (!ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references))
      return Option.none<AccountIdentity>()
    const health = yield* http.readHealth(
      Effect.succeed(HttpClientRequest.post(`/accounts/${query(references.account)}/health`)),
      null,
    )
    if (health.info === null) return Option.none<AccountIdentity>()
    const { email, username, displayName } = health.info
    return Arr.findFirst([email, username, displayName], (candidate) =>
      decodeAccountIdentity(candidate),
    )
  })
}

/** Saved failures retain the same finite refusal vocabulary as their completion routes. */
function connectionFailure(failure: typeof ConnectionFailure.Type) {
  const context = { service: 'connections' as const, tool: null }
  return ConnectionFailure.match<Effect.Effect<never, ExecutorFailure>>(failure, {
    OAuthSetupFailed: ({ reason }) =>
      Effect.fail(ExecutorOAuthSetupFailed.make({ ...context, reason })),
    OAuthCompletionFailed: () =>
      Effect.fail(
        ExecutorRejected.make({
          ...context,
          message: 'Sign-in did not complete. Start authorization again.',
        }),
      ),
    AccountConnectionRefused: () => Effect.fail(ExecutorConnectionRefused.make(context)),
    AccountConnectionTargetChanged: () => Effect.fail(ExecutorRequirementChanged.make(context)),
  })
}

/** Readiness resolves pending account IDs, reconciles setup, then probes real authorization. */
function makeStatus(http: ExecutorHttp) {
  return Effect.fn('Executor.status')(
    function* (references: ExecutorReferences) {
      if (ExecutorReferences.guards.ReconnectRequired(references))
        return ExecutorStatus.cases.Failed.make({ reason: executorReconnectMessage })
      let resolved = references
      if (isPending(references)) {
        const connection = yield* http.readConnection(
          Effect.succeed(HttpClientRequest.get(`/connections/${query(references.authorization)}`)),
          null,
        )
        yield* validateConnectionTarget(connection, references)
        const state = connection.state
        if (WireConnection.fields.state.guards.pending(state)) {
          if (state.failure !== undefined) return yield* connectionFailure(state.failure.error)
          return ExecutorStatus.cases.NeedsAuthorization.make({ references })
        }
        if (!WireConnection.fields.state.guards.completed(state))
          return ExecutorStatus.cases.Failed.make({ reason: `Authorization ${state.status}` })
        resolved = ExecutorReferences.cases.Authorized.make({
          ...referenceIdentity(references),
          account: state.account.id,
        })
      }
      const page = yield* http.readTools(
        Effect.succeed(HttpClientRequest.get(`/apps/${query(resolved.app)}/tools`)),
        null,
      )
      yield* validateSelections(resolved, page.accounts)
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
          ExecutorRequirementChanged: () =>
            Effect.succeed(
              ExecutorStatus.cases.Failed.make({
                reason: 'Integration account setup changed. Reconnect it.',
              }),
            ),
          ExecutorConnectionRefused: () =>
            Effect.succeed(
              ExecutorStatus.cases.Failed.make({
                reason: 'Integration access does not allow connecting this account.',
              }),
            ),
          ExecutorOAuthSetupFailed: () =>
            Effect.succeed(
              ExecutorStatus.cases.Failed.make({
                reason: 'Integration sign-in setup failed. Review its configuration.',
              }),
            ),
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
  const decodeIdentity = Schema.decodeUnknownOption(Schema.Struct({ id: ServiceId }))
  return Effect.fn('Executor.catalog')(function* () {
    const entries = yield* http.readCatalog(Effect.succeed(HttpClientRequest.get('/catalog')), null)
    const rejected: Option.Option<{ readonly id: ServiceId }>[] = []
    const decoded = yield* Effect.forEach(
      entries,
      // Untraced: this runs once for each of about a thousand catalogue entries on every read,
      // and a span apiece was 27,000 spans an hour with one Person. `Executor.catalog` is the span.
      Effect.fnUntraced(
        function* (entry) {
          return [catalogEntry(yield* decodeCatalogEntry(entry))]
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
    return decoded.flat()
  })
}

/** Key names and labels come from the imported declaration, never a guessed catalog form. */
function keyFields(fields: typeof AuthorizationMethod.cases.secrets.fields.fields.Type) {
  return Object.entries(fields.properties).map(([name, field]) => ({
    name,
    label: keyLabel(name, field),
  }))
}

/** Executor's secrets method label does not title its token property. Keep the masked card
 * intelligible when a declaration omits the field title, including the proven PAT app. */
function keyLabel(name: string, field: typeof FieldSchema.Type) {
  if (field.title !== undefined) return field.title
  return name === 'token' ? 'Personal access token' : name
}

/** Only client-required establishes absent operator setup. A declared key remains usable when
 * sign-in is unavailable; automatic/saved sign-in retains priority for mixed services.
 */
function makeInspectSetup(http: ExecutorHttp) {
  return Effect.fn('Executor.inspectSetup')(function* (requirement: typeof Requirement.Type) {
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
      if (setup.mode === 'automatic' || setup.clients.length === 1)
        return ServiceAuthorization.cases.SignIn.make({})
    }
    if (key !== undefined && AuthorizationMethod.guards.secrets(key[1]))
      return ServiceAuthorization.cases.Key.make({ fields: keyFields(key[1].fields) })
    if (signIn === undefined)
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'This integration does not declare a supported sign-in or key method.',
      })
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
/** Bounds setup refusal retention while the provider offers no setup revision signal.
 * Source: unmeasured. Expiry invalidates inspection and the next read rechecks setup. */
const REFUSAL_TTL_MILLIS = 10 * 60 * 1000
/** Bounds one read-only setup exchange because Executor can leave it unanswered.
 * Source: unmeasured. Expiry returns ExecutorTransportFailure and retains the last display fact. */
const SETUP_EXCHANGE_LIMIT = '5 seconds'
/** Bounds successful setup fact staleness in the absence of a provider setup revision signal.
 * Source: unmeasured. Expiry makes the next read inspect again. */
const INSPECTION_SUCCESS_TTL = '10 minutes'
/** Bounds discovery metadata staleness when a provider deploy changes its tools.
 * Source: unmeasured. Expiry reloads on demand without interrupting a running tool. */
const TOOL_SNAPSHOT_TTL = '5 minutes'

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
    // Untraced: read once per catalogue entry on every list (see `refreshAvailability`).
    read: Effect.fnUntraced(function* (service: ServiceId) {
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
  catalog: () => ExecutorService['catalog'],
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
        return yield* ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: 'Choose an integration from the current catalog.',
        })
      if (keyedService(service) !== undefined) return personalKeyAuthorization()
      // Google signs in with the client Vivid sends on each start. Executor holds none until the
      // first one, so asking it about setup would answer `client-required` for a service that works.
      if (Option.isSome(googleService(service))) return entry.authorization
      const definition = HashMap.get(yield* Ref.get(definitions), service)
      if (Option.isNone(definition)) return entry.authorization
      const authorization = yield* permits.withPermits(1)(
        inspect(definition.value).pipe(
          Effect.timeoutOrElse({
            duration: SETUP_EXCHANGE_LIMIT,
            orElse: () =>
              Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
          }),
          Effect.catch(
            Effect.fn('Executor.unavailableSetup')(function* (error) {
              if (isSetupRequired(error)) {
                const unavailable = ServiceAuthorization.cases.SetupRequired.make({})
                return unavailable
              }
              yield* record(service, entry.authorization, Option.some(error._tag))
              return yield* error
            }),
          ),
        ),
      )
      return authorization
    }),
    {
      capacity: 1000,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? INSPECTION_SUCCESS_TTL : INSPECTION_FAILURE_TTL,
    },
  )
  const refusals = yield* makeSetupRefusals(inspections)
  const readInspection = makeInspectionReader({ inspections, refusals, publication, record })
  /** Refresh expired inspection entries in the owning scope while serving retained display facts. */
  // Untraced: one call per catalogue entry, about a thousand a read. A span each, with the
  // refusal read beneath, was 63,000 spans an hour; `Executor.availableCatalog` is the span.
  const refreshAvailability = Effect.fnUntraced(function* (
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
        Effect.timeoutOrElse({
          duration: SETUP_EXCHANGE_LIMIT,
          orElse: () =>
            Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
        }),
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
    catalog: Effect.gen(function* () {
      const entries = yield* catalog()
      const current = yield* Ref.get(facts)
      return yield* Effect.forEach(entries, (entry) => refreshAvailability(entry, current))
    }).pipe(Effect.withSpan('Executor.availableCatalog')),
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

/** packages/sdk/src/contracts/apps.ts AppName is bounded at 120 characters. Hash the Connection
 * identity so retries retain one dedicated app without sharing another Connection's accounts.
 */
function connectionAppName(connection: ConnectionId) {
  return `Vivid Integration ${NodeCrypto.createHash('sha256').update(connection).digest('hex')}`
}

/** Inventory matches only this Connection's app by its deterministic name. Full requirements enter
 * through that app's detail endpoint; ordinary provisioning never selects an account from inventory.
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

/** A name conflict is the sole proof another process may have installed this Connection's app.
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
    if (!isAppNameTaken(result.failure)) return yield* result.failure
    const winner = yield* find(name)
    if (Option.isSome(winner)) return winner.value
    return yield* result.failure
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
    name: string,
    install: (name: string) => Effect.Effect<typeof WireApp.Type, ExecutorFailure>,
  ) {
    const permit = yield* RcMap.get(locks, name)
    return yield* permit.withPermit(provision(name, install))
  }, Effect.scoped)
})

const isSetupRequired = Schema.is(ExecutorSetupRequired)

/** Install or deploy one dedicated app per Connection. A retry finds only that Connection's
 * deterministic app name; different Persons and accounts never share a provisioning lock.
 */
function makeBegin(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  install: Effect.Success<ReturnType<typeof makeInstall>>,
) {
  const configure = makeConfigure(http, availability)
  const addKeyed = makeKeyed(http, configure)
  const begin = Effect.fn('Executor.begin')(function* (input: typeof BeginInput.Type) {
    const keyed = keyedService(input.service)
    if (keyed !== undefined) return yield* addKeyed(input, keyed)
    const entry = (yield* availability.catalog).find((candidate) => candidate.id === input.service)
    if (entry === undefined)
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'Choose a supported Integration from the current catalog.',
      })
    // Catalog hints cannot override the installed app's requirements. Authored Google sources
    // retain their exact framework pin and get a different app for every Connection.
    const app = yield* Effect.acquireRelease(
      Option.match(googleService(input.service), {
        onNone: () =>
          input.service === discordServiceId
            ? install(`${discordAppName()} ${input.connectionId}`, (name) =>
                http.readApp(post('/apps/deploy', { name, files: discordFiles() }), null),
              )
            : install(connectionAppName(input.connectionId), (name) =>
                http.readApp(post('/apps/install', { entry: entry.id, name }), null),
              ),
        onSome: (google) =>
          install(`${googleAppName(google)} ${input.connectionId}`, (name) =>
            http.readApp(post('/apps/deploy', { name, files: googleFiles(google) }), null),
          ),
      }),
      compensateApp(http),
    )
    const authorization =
      Object.keys(app.requirements.accounts).length === 0
        ? ServiceAuthorization.cases.None.make({})
        : yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(authorization))
      return yield* ExecutorSetupRequired.make({ service: 'connections', tool: null })
    return yield* configure(
      input,
      app,
      ExecutorServiceEntry.make({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        domain: entry.domain,
        authorization,
      }),
    )
  }, Effect.scoped)
  return {
    begin,
    add: makeAdd(http, availability, configure, install),
    make: makeAuthored(http, availability, configure),
  }
}

/** A lost deploy answer may follow a committed app. Reclaim only this Connection's exact
 * inventory name, without evaluating the app again. Preserve the original failure if cleanup
 * itself is unavailable, matching compensateApp's logging and failure policy. */
function makeReclaimAuthored(http: ExecutorHttp) {
  const remove = makeRemoval(http)
  return Effect.fn('Executor.reclaimAuthored')(
    function* (name: string) {
      const inventory = yield* http.readInventory(
        Effect.succeed(HttpClientRequest.get('/inventory')),
        null,
      )
      const app = inventory.apps.find((candidate) => candidate.name === name)
      if (app !== undefined) yield* remove(`/apps/${query(app.id)}`, 'App')
    },
    (effect) =>
      effect.pipe(
        Effect.tapError((failure) =>
          Effect.logError('Integration deploy compensation failed', failure._tag),
        ),
        Effect.ignore,
      ),
  )
}

/** Authored sources own one app, including its schedules; failed configuration reclaims it. */
function makeAuthored(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  configure: ReturnType<typeof makeConfigure>,
) {
  const reclaim = makeReclaimAuthored(http)
  return Effect.fn('Executor.makeAuthored')(function* (
    input: typeof BeginInput.Type & { readonly files: ReadonlyArray<MadeFile> },
  ) {
    const name = connectionAppName(input.connectionId)
    const app = yield* Effect.acquireRelease(
      http
        .readDeploy(
          post('/apps/deploy', {
            name,
            files: input.files,
          }),
        )
        .pipe(
          Effect.tapErrorTag(['ExecutorTransportFailure', 'ExecutorExecutionUncertain'], () =>
            reclaim(name),
          ),
        ),
      compensateApp(http),
    )
    const schedules = yield* http.readSchedules(
      Effect.succeed(HttpClientRequest.get(`/apps/${query(app.id)}/schedules/definitions`)),
      null,
    )
    // User schedules would run as Vivid's Executor user, rather than the acting Person.
    yield* Effect.forEach(
      schedules.filter((schedule) => schedule.scope === 'app'),
      (schedule) =>
        http.readCall(
          jsonBody(
            HttpClientRequest.patch(`/apps/${query(app.id)}/schedules/${query(schedule.name)}`),
            { enabled: true, scope: 'app' },
          ),
          null,
        ),
    )
    const authorization =
      Object.keys(app.requirements.accounts).length === 0
        ? ServiceAuthorization.cases.None.make({})
        : yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(authorization))
      return yield* ExecutorSetupRequired.make({ service: 'connections', tool: null })
    return yield* configure(
      input,
      app,
      ExecutorServiceEntry.make({
        id: input.service,
        name: input.label,
        description: '',
        domain: null,
        authorization,
      }),
    )
  }, Effect.scoped)
}

/** Every registration owns one app. Account completion fills that app's declared requirement. */
function makeConfigure(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
) {
  const authorize = makeAuthorize(http, availability.recordSetupRequired)
  return Effect.fn('Executor.configure')(function* (
    input: typeof BeginInput.Type,
    app: typeof WireApp.Type,
    entry: typeof ExecutorServiceEntry.Type,
  ) {
    const references = ExecutorReferences.cases.Public.make({
      service: input.service,
      app: app.id,
      appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
      owner: input.owner,
      binding: ExecutorBinding.cases.Public.make({}),
    })
    if (Object.keys(app.requirements.accounts).length === 0)
      return ExecutorStep.cases.Done.make({ references })
    return yield* authorize(input, app, references, entry.authorization)
  })
}

const isRetainedSignIn = Schema.is(
  Schema.Union([ExecutorSignInRequired, ExecutorAuthorizationUnavailable]),
)

/** Failed installation releases only its dedicated app. A sign-in whose response was lost or
 * needs operator setup retains the app with its saved pending reference for Resume/removal.
 */
function compensateApp(http: ExecutorHttp) {
  const remove = makeRemoval(http)
  return <A, E>(created: typeof WireApp.Type, exit: Exit.Exit<A, E>) =>
    Exit.isSuccess(exit) ||
    exit.cause.reasons.some(
      (reason) => Cause.isFailReason(reason) && isRetainedSignIn(reason.error),
    )
      ? Effect.void
      : remove(`/apps/${query(created.id)}`, 'App').pipe(
          Effect.tapError((failure) =>
            Effect.logError('Integration app compensation failed', failure._tag),
          ),
          Effect.ignore,
        )
}

/** Deploy the two files proven in artifacts/research/github-token-proof.md, Route 2.
 * Code belongs to one Connection, so rollback/removal can delete it without affecting anyone
 * else's app. Configure/authorize/complete/discovery/call use the ordinary adapter path. */
function makeKeyed(http: ExecutorHttp, configure: ReturnType<typeof makeConfigure>) {
  return Effect.fn('Executor.addKeyed')(function* (
    input: typeof BeginInput.Type,
    transport: typeof KeyedTransport.Type,
  ) {
    // The key travels in a request header on every call; plain HTTP would expose it in transit.
    if (transport.address.protocol !== 'https:')
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'An Integration that needs a key must use an https address.',
      })
    const files = keyedFiles({
      name: input.label,
      address: transport.address,
      host: transport.host,
      header: transport.header,
      prefix: transport.prefix,
    })
    const app = yield* Effect.acquireRelease(
      http.readApp(
        post('/apps/deploy', { name: `Vivid Keyed ${input.connectionId}`, files }),
        null,
      ),
      compensateApp(http),
    )
    const step = yield* configure(
      input,
      app,
      ExecutorServiceEntry.make({
        id: input.service,
        name: input.label,
        description: '',
        domain: transport.host,
        authorization: personalKeyAuthorization(),
      }),
    )
    if (!ExecutorStep.guards.EnterKey(step))
      return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
    return ExecutorStep.cases.EnterKey.make({
      references: step.references,
      fields: personalKeyAuthorization().fields,
    })
  }, Effect.scoped)
}

/** A key is requested only when the service itself offers no sign-in Vivid can start: no OAuth
 * discovery, a client that must be registered or approved by hand, or an unsupported method.
 * Rejected metadata, registration, client or redirect also describe a fault in Vivid's or
 * Executor's own OAuth setup, where a key card could never work, so they stay failures. */
function keyInsteadOfOAuth(reason: typeof OAuthSetupReason.Type) {
  return [
    'discovery_missing',
    'client_not_approved',
    'client_registration_required',
    'unsupported',
  ].includes(reason)
}

/** HostedApps.importCustom keeps public URL imports on the same protocol path. Probe apps
 * are dedicated so an unsatisfiable OAuth import can be deleted without cascading other Connections.
 */
function makeAdd(
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  configure: ReturnType<typeof makeConfigure>,
  install: Effect.Success<ReturnType<typeof makeInstall>>,
) {
  const keyed = makeKeyed(http, configure)
  const remove = makeRemoval(http)
  return Effect.fn('Executor.add')(function* (
    input: typeof BeginInput.Type & { readonly source: ConnectionSource },
  ) {
    if (ConnectionSource.guards.OpenApi(input.source))
      return yield* new ExecutorSourceUnsupported({ source: 'OpenApi' })
    const address = URL.parse(input.source.address)
    if (address === null)
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'Enter a valid MCP server address.',
      })
    if (address.search.length > 0) return yield* new ExecutorImportQueryUnsupported({})
    const policy = keyedAddress(address)
    const transport =
      policy === undefined
        ? KeyedTransport.make({
            address,
            host: address.hostname,
            header: 'Authorization',
            prefix: 'Bearer ',
          })
        : policy
    // A curated key policy is the proven route for that address, so it does not depend on
    // which OAuth failure the service happens to report.
    if (policy !== undefined || input.source.authorization === 'apiKey')
      return yield* keyed(input, transport)
    const app = yield* Effect.acquireRelease(
      install(connectionAppName(input.connectionId), (name) => {
        // Executor resolves the inspected URL again; production requires public-only egress.
        const source = WireImportSource.make({ name, url: input.source.address })
        return http.readApp(post('/apps/import', { source }), null)
      }),
      compensateApp(http),
    )
    const authorization =
      Object.keys(app.requirements.accounts).length === 0
        ? ServiceAuthorization.cases.None.make({})
        : yield* availability
            .inspectApp(input, app)
            .pipe(
              Effect.catchTag('ExecutorOAuthSetupFailed', (error) =>
                keyInsteadOfOAuth(error.reason)
                  ? Effect.succeed(ServiceAuthorization.cases.SetupRequired.make({}))
                  : Effect.fail(error),
              ),
            )
    if (ServiceAuthorization.guards.SetupRequired(authorization)) {
      // The failed probe belongs only to this Connection; release it before deploying the key source.
      yield* remove(`/apps/${query(app.id)}`, 'App')
      return yield* keyed(input, transport)
    }
    return yield* configure(
      input,
      app,
      ExecutorServiceEntry.make({
        id: input.service,
        name: input.label,
        description: '',
        domain: null,
        authorization,
      }),
    )
  }, Effect.scoped)
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
    if (ExecutorReferences.guards.ReconnectRequired(input.references))
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: executorReconnectMessage,
      })
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
      ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references) ||
      ExecutorReferences.guards.Public(input.references)
    ) {
      const current = yield* status(references)
      if (
        ExecutorStatus.guards.Ready(current) &&
        ExecutorReferences.isAnyOf(['Public', 'Authorized'])(current.references)
      )
        return ExecutorStep.cases.Done.make({ references: current.references })
      if (ExecutorStatus.guards.Failed(current))
        return yield* ExecutorRejected.make({
          service: 'connections',
          tool: null,
          message: current.reason,
        })
    }
    const app = yield* http.readApp(
      Effect.succeed(HttpClientRequest.get(`/apps/${query(references.app)}`)),
      null,
    )
    const selected = yield* availability.inspectApp(input, app)
    if (ServiceAuthorization.guards.SetupRequired(selected))
      return yield* ExecutorSetupRequired.make({ service: 'connections', tool: null })
    return yield* authorize(input, app, references, selected)
  })
}

/** The response exposes account identity only; credentials are encoded once and never retained. */
function makeComplete(http: ExecutorHttp) {
  return Effect.fn('Executor.complete')(function* ({
    references,
    fields,
  }: typeof CompleteInput.Type) {
    if (!ExecutorReferences.guards.EnteringKey(references))
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'This integration is not waiting for key fields.',
      })
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
    return resolved
  })
}

/** Executor checks the stored OAuth state and redirect before exchanging the callback's code. */
function makeCompleteSignIn(http: ExecutorHttp) {
  return Effect.fn('Executor.completeSignIn')(function* ({
    references,
    callbackAddress,
  }: typeof SignInInput.Type) {
    if (!isSigningIn(references))
      return yield* ExecutorRejected.make({
        service: 'connections',
        tool: null,
        message: 'This integration is not waiting for sign-in.',
      })
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
    return resolved
  })
}

/** A deletion retry treats only its own missing resource as success. Other missing relations,
 * conflicts, and authority failures remain visible and cannot authorize deleting another resource.
 */
function makeRemoval(http: ExecutorHttp) {
  return Effect.fn('Executor.removeResource')((path: string, resource: 'Account' | 'App') =>
    http
      .readRemoval(Effect.succeed(HttpClientRequest.delete(path)), null)
      .pipe(
        Effect.catchTag('ExecutorResourceMissing', (error) =>
          error.resource === resource ? Effect.void : Effect.fail(error),
        ),
      ),
  )
}

/** Ordinary removal shares retirement's ownership and preflight policy. A shared original is
 * never deleted, and app/link failures cannot follow deletion of the selected credential.
 */
function makeRemove(http: ExecutorHttp) {
  const retire = makeRetire(http)
  const resolveRemovalAccount = makeResolveRemovalAccount(http)
  return Effect.fn('Executor.remove')(function* (references: ExecutorReferences) {
    if (ExecutorReferences.guards.ReconnectRequired(references)) return yield* Effect.void
    const account = yield* ExecutorReferences.match(references, {
      Public: () => Effect.succeedNone,
      ReconnectRequired: () => Effect.succeedNone,
      Authorized: (value) => Effect.succeedSome(value.account),
      Adopting: (value) => Effect.succeedSome(value.account),
      EnteringKey: resolveRemovalAccount,
      SigningIn: resolveRemovalAccount,
      OAuthSigningIn: resolveRemovalAccount,
      GoogleSigningIn: resolveRemovalAccount,
    })
    return yield* retire({
      resources: ExecutorRetired.make({ ...retirementOf(references), account }),
      retainedApps: [],
      retainedAccounts: [],
    })
  })
}

/** HostedAccounts reconnect keeps the saved account on reconnectAccount until completion.
 * Remove must revoke that exact account even while a replacement key/sign-in is pending.
 * New pending requests have no account; they expire after their dedicated app is removed.
 */
function makeResolveRemovalAccount(http: ExecutorHttp) {
  return Effect.fn('Executor.removalAccount')(function* (
    references: typeof ExecutorReferences.cases.EnteringKey.Type | typeof SignInReferences.Type,
  ) {
    const path = `/connections/${query(references.authorization)}`
    const saved = yield* http
      .readConnection(Effect.succeed(HttpClientRequest.get(path)), null)
      .pipe(
        Effect.asSome,
        Effect.catchTag('ExecutorResourceMissing', (error) =>
          error.resource === 'App' ? Effect.succeedNone : Effect.fail(error),
        ),
      )
    // App deletion precedes final credential revocation; a missing request on retry cannot
    // manufacture an account identity. Authorized references keep their exact account directly.
    if (Option.isNone(saved)) return Option.none<typeof ExecutorAccountId.Type>()
    const connection = saved.value
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

/** A discovery failure precedes dispatch and therefore leaves the call safe to correct or retry. */
function discoveryFailed() {
  return Effect.fail(
    ExecutorRejected.make({
      service: 'connections',
      tool: null,
      message: 'Tool discovery failed before the action was sent. Retry discovery.',
    }),
  )
}

/** REST preserves full results and a pinned version. Only a pre-execution approval refusal starts MCP. */
function makeCall(
  http: ExecutorHttp,
  discover: ReturnType<typeof makeDiscovery>,
  mcp: ReturnType<typeof mcpCalls>,
) {
  return Effect.fn('Executor.call')(
    function* ({ references, tool, input }: typeof CallInput.Type) {
      if (ExecutorReferences.guards.ReconnectRequired(references))
        return ExecutorCallOutcome.cases.NotReady.make({})
      const catalog = yield* discover(references).pipe(
        Effect.catchTags({
          ExecutorTransportFailure: discoveryFailed,
          ExecutorExecutionUncertain: discoveryFailed,
          ExecutorResponseInvalid: discoveryFailed,
        }),
      )
      const selected = catalog.items.find((candidate) => candidate.tool.name === tool)
      if (selected === undefined)
        return ExecutorCallOutcome.cases.Rejected.make({
          message: 'Tool not found. Discover the current tools.',
        })
      const routed = ToolAccount.match(selected.account, {
        Direct: () => input,
        Account: ({ accountId }) => ({ accountId, input }),
      })
      return yield* http
        .readCall(
          post(`/apps/${query(references.app)}/tools/call`, {
            version: catalog.version,
            kind: selected.tool.effect === 'read' ? 'query' : 'mutation',
            tool,
            input: routed,
          }),
          tool,
        )
        .pipe(
          Effect.map(completedCall),
          Effect.catchTag('ExecutorApprovalUnsupported', () =>
            callPaused(http, mcp, {
              references,
              tool,
              input: routed,
              effect: selected.tool.effect,
            }),
          ),
          Effect.catchTags({
            ExecutorInputInvalid: ({ problems }) =>
              Effect.succeed(
                ExecutorCallOutcome.cases.Rejected.make({
                  message: 'Input did not match the tool schema. Correct its input and retry.',
                  problems: validationProblems(problems, [
                    references.app,
                    catalog.version,
                    ...('account' in references ? [references.account] : []),
                  ]),
                }),
              ),
            // REST supplies no elicitation handler. App code may have acted before ctx.elicit failed; never issue it again.
            ExecutorExecutionUncertain: ({ cause }) =>
              Effect.succeed(
                cause === 'Elicitation'
                  ? ExecutorCallOutcome.cases.UncertainPause.make({})
                  : ExecutorCallOutcome.cases.OutcomeUnknown.make({}),
              ),
            ExecutorTransportFailure: () =>
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

/** The REST approval refusal precedes the selected handler, so the same pinned input may enter model-mode MCP once. */
const callPaused = Effect.fn('Executor.callPaused')(function* (
  http: ExecutorHttp,
  mcp: ReturnType<typeof mcpCalls>,
  call: {
    readonly references: ExecutorActiveReferences
    readonly tool: string
    readonly input: Schema.Json
    readonly effect: ActionEffect
  },
) {
  const app = yield* http.readApp(
    Effect.succeed(HttpClientRequest.get(`/apps/${query(call.references.app)}`)),
    call.tool,
  )
  const path = `tools[${JSON.stringify(app.slug)}]${call.tool
    .split('.')
    .map((part) => `[${JSON.stringify(part)}]`)
    .join('')}`
  return fromMcp(yield* mcp('call', { calls: { path, input: call.input } }, call.tool), call.effect)
})

/** Preserve pauses and expiry before interpreting an ordinary provider result. */
const fromMcp = (outcome: McpCallOutcome, effect: ActionEffect) =>
  McpCallOutcome.match<typeof ExecutorCallOutcome.Type>(outcome, {
    Truncated: ({ message }) =>
      effect === 'read'
        ? ExecutorCallOutcome.cases.Rejected.make({ message })
        : ExecutorCallOutcome.cases.Completed.make({ value: null }),
    Completed: ({ value }) => completedCall(value),
    Paused: ({ pause }) => ExecutorCallOutcome.cases.Paused.make({ pause }),
    Expired: () => ExecutorCallOutcome.cases.Expired.make({}),
    Uncertain: ({ reason }) =>
      reason === 'InvalidForm'
        ? ExecutorCallOutcome.cases.UncertainPause.make({})
        : ExecutorCallOutcome.cases.OutcomeUnknown.make({}),
  })

/** A response always names the saved request. Expiry and transport loss never start another call. */
function makeResume(mcp: ReturnType<typeof mcpCalls>) {
  return Effect.fn('Executor.resume')(function* ({
    pause,
    response,
    effect,
  }: Parameters<ExecutorConnectionOperations['resume']>[0]) {
    if (pause.expiresAt <= (yield* Clock.currentTimeMillis))
      return ExecutorCallOutcome.cases.Expired.make({})
    const encoded = yield* encodeIntegrationResponse(response).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
    return fromMcp(
      yield* mcp('resume', { requestId: pause.requestId, response: encoded }, null).pipe(
        Effect.catchTags({
          ExecutorExecutionUncertain: () => Effect.succeed(McpCallOutcome.cases.Uncertain.make({})),
          ExecutorTransportFailure: () => Effect.succeed(McpCallOutcome.cases.Uncertain.make({})),
          ExecutorResponseInvalid: () => Effect.succeed(McpCallOutcome.cases.Uncertain.make({})),
        }),
      ),
      effect,
    )
  })
}

/** Active app access carries separate deletion authority. Pending requests preserve their exact
 * correlation so retirement can discover a completed account without inventing a selection.
 */
export function retirementOf(references: ExecutorActiveReferences) {
  const app = ExecutorAppOwnership.match<
    Pick<typeof ExecutorRetired.Type, 'original' | 'ownership' | 'copies'>
  >(references.appOwnership, {
    Dedicated: () => ({ original: references.app, ownership: 'Dedicated' as const, copies: [] }),
    Adopted: () => ({ original: references.app, ownership: 'Dedicated' as const, copies: [] }),
    Copied: ({ original }) => ({
      original,
      ownership: 'Unproven' as const,
      copies: [references.app],
    }),
    Unproven: () => ({ original: references.app, ownership: 'Unproven' as const, copies: [] }),
  })
  return ExecutorRetired.make({
    ...app,
    account: ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references)
      ? Option.some(references.account)
      : Option.none(),
    authorization: ExecutorReferences.isAnyOf(['Public', 'Authorized', 'Adopting'])(references)
      ? Option.none()
      : Option.some(references.authorization),
  })
}

/** A migration copy proves provenance with copiedFrom.reference, never with a display name.
 * beta.23 packages/sdk/src/implementation/apps.ts:611-639 records `app:<original id>` on copyAs;
 * apps/hosted/server/src/implementation/profile-app-copies.ts:17-20 uses that exact operation.
 */
function migratedApps(
  inventory: typeof ExecutorInventory.Type,
  original: typeof ExecutorAppId.Type,
) {
  return inventory.apps.filter(
    (app) =>
      app.id === original ||
      (app.copiedFrom !== null && app.copiedFrom.reference === `app:${original}`),
  )
}

/** A completed request proves account ownership only on the original or a provenance copy. */
function retirementAccount(
  inventory: typeof ExecutorInventory.Type,
  resources: typeof ExecutorRetired.Type,
  saved: typeof WireConnection.Type,
) {
  const ours = migratedApps(inventory, resources.original).some(
    (app) => app.id === saved.target.app,
  )
  if (!ours) return Option.none<typeof ExecutorAccountId.Type>()
  if (WireConnection.fields.state.guards.completed(saved.state))
    return Option.some(saved.state.account.id)
  return Option.fromNullOr(saved.reconnectAccount).pipe(Option.map((account) => account.id))
}

/** Retain every known copy before deleting credentials. Inventory exposes exact copy lineage;
 * the selected account identifies additional copies even when the earlier refusal could not.
 */
function makePrepareRetirement(http: ExecutorHttp) {
  return Effect.fn('Executor.prepareRetirement')(function* (
    resources: typeof ExecutorRetired.Type,
  ) {
    const inventory = yield* http.readInventory(
      Effect.succeed(HttpClientRequest.get('/inventory')),
      null,
    )
    let account = resources.account
    if (Option.isNone(account) && Option.isSome(resources.authorization)) {
      const saved = yield* http
        .readConnection(
          Effect.succeed(
            HttpClientRequest.get(`/connections/${query(resources.authorization.value)}`),
          ),
          null,
        )
        .pipe(
          Effect.asSome,
          Effect.catchTags({
            ExecutorNotReady: () => Effect.succeedNone,
            ExecutorResourceMissing: () => Effect.succeedNone,
          }),
        )
      if (Option.isSome(saved)) account = retirementAccount(inventory, resources, saved.value)
    }
    const copies = migratedApps(inventory, resources.original)
      .filter(
        (app) =>
          app.id !== resources.original &&
          Option.isSome(account) &&
          inventory.links.some((link) => link.app === app.id && link.account === account.value),
      )
      .map((app) => app.id)
    return ExecutorRetired.make({
      ...resources,
      account,
      copies: [...new Set([...resources.copies, ...copies])],
    })
  })
}

/** Reclamation rereads links before unlinking exact credentials. App deletion requires a
 * dedicated original or explicit copy provenance and no remaining account links.
 */
function makeRetire(http: ExecutorHttp) {
  const remove = makeRemoval(http)
  const links = Effect.fn('Executor.retiredLinks')(function* (app: typeof ExecutorAppId.Type) {
    const groups = yield* Effect.forEach(
      ['app', 'user'] as const,
      Effect.fnUntraced(function* (scope) {
        const values = yield* http.readLinks(
          Effect.succeed(HttpClientRequest.get(`/apps/${query(app)}/accounts/${scope}`)),
          null,
        )
        return values.map((link) => ({
          requirement: link.requirement,
          account: link.account,
          scope,
        }))
      }),
    )
    return groups.flat()
  })
  /** A held app/account pair still belongs to another Connection. Private copies can unlink
   * a shared credential without revoking the credential another Connection still stores.
   */
  const unlink = Effect.fn('Executor.unlinkRetired')(function* (
    app: typeof ExecutorAppId.Type,
    input: Parameters<ExecutorConnectionOperations['retire']>[0],
    selected: Effect.Success<ReturnType<typeof links>>,
  ) {
    const { resources, retainedApps, retainedAccounts } = input
    if (Option.isNone(resources.account)) return
    const account = resources.account.value
    if (retainedApps.includes(app) && retainedAccounts.includes(account)) return
    for (const link of selected) {
      if (link.account.id === account)
        yield* remove(
          `/apps/${query(app)}/accounts/${link.scope}/${query(link.requirement)}/${query(account)}`,
          'Account',
        )
    }
  })
  return Effect.fn('Executor.retire')(function* ({
    resources,
    retainedApps,
    retainedAccounts,
  }: Parameters<ExecutorConnectionOperations['retire']>[0]) {
    const inventory = yield* http.readInventory(
      Effect.succeed(HttpClientRequest.get('/inventory')),
      null,
    )
    const targets = inventory.apps.filter(
      (app) =>
        app.id === resources.original ||
        (resources.copies.includes(app.id) &&
          app.copiedFrom !== null &&
          app.copiedFrom.reference === `app:${resources.original}`),
    )
    const eligible = targets.filter(
      (app) =>
        !retainedApps.includes(app.id) &&
        (app.id !== resources.original || resources.ownership === 'Dedicated'),
    )
    // Inspect every app before revocation. A provenance copy may have acquired unrelated links;
    // those links grant no deletion authority and are never a reason to strand the product row.
    const inspected = yield* Effect.forEach(
      targets,
      Effect.fnUntraced(function* (app) {
        return { app, selected: yield* links(app.id) }
      }),
    )
    for (const { app, selected } of inspected)
      yield* unlink(app.id, { resources, retainedApps, retainedAccounts }, selected)
    for (const { app, selected } of inspected) {
      if (!eligible.some((candidate) => candidate.id === app.id)) continue
      if (
        selected.some(
          (link) => Option.isNone(resources.account) || link.account.id !== resources.account.value,
        )
      )
        continue
      // Protect links added outside Vivid since inspection. Retain the app instead of refusing
      // after its credential was revoked; the exact account is deleted only after all app checks.
      if ((yield* links(app.id)).length > 0) continue
      yield* remove(`/apps/${query(app.id)}`, 'App')
    }
    if (Option.isSome(resources.account) && !retainedAccounts.includes(resources.account.value))
      yield* remove(`/accounts/${query(resources.account.value)}`, 'Account')
    return yield* Effect.void
  })
}

/** Cache version-pinned schemas while validating a saved account's current link on every use.
 * An outside link change can never turn a warm catalog into authority for another account.
 */
const makeToolCache = Effect.fn('Executor.toolCache')(function* (http: ExecutorHttp) {
  const snapshots = yield* Cache.makeWith(makeDiscovery(http), {
    capacity: 1000,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? TOOL_SNAPSHOT_TTL : 0),
  })
  const discover = Effect.fn('Executor.discoverCached')(function* (references: ExecutorReferences) {
    if (ExecutorReferences.isAnyOf(['Authorized', 'Adopting'])(references)) {
      const path = yield* bindingPath(references)
      const links = yield* http.readLinks(
        Effect.succeed(HttpClientRequest.get(path.slice(0, path.lastIndexOf('/')))),
        null,
      )
      const binding = references.binding
      if (
        !ExecutorBinding.guards.Account(binding) ||
        links.length !== 1 ||
        !links.some(
          (link) =>
            link.requirement === binding.requirement && link.account.id === references.account,
        )
      )
        return yield* ExecutorNotReady.make({ service: 'connections', tool: null })
    }
    return yield* Cache.get(snapshots, references)
  })
  return { snapshots, discover }
})

/** Read the active build, not the editor workspace, before and after a deployment. */
function makeReadMade(http: ExecutorHttp) {
  return Effect.fn('Executor.readMade')(function* (app: typeof ExecutorAppId.Type) {
    const source = yield* http.readSource(
      Effect.succeed(HttpClientRequest.get(`/apps/${query(app)}/source`)),
      null,
    )
    return yield* decodeMadeFiles(source.files.filter((file) => file.path !== 'package.json')).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
    )
  })
}

function makeAppSlug(http: ExecutorHttp) {
  return Effect.fn('Executor.appSlug')(function* (app: typeof ExecutorAppId.Type) {
    const record = yield* http.readApp(
      Effect.succeed(HttpClientRequest.get(`/apps/${query(app)}`)),
      null,
    )
    return record.slug
  })
}

// Vivid's own Google services lead the catalogue and need nothing from Executor to be listed,
// so they stay offered while its public catalogue feed is unavailable.
const googleCatalog = googleServices.map((service) =>
  ExecutorServiceEntry.make({
    id: service.service,
    name: service.name,
    description: service.description,
    domain: service.domain,
    authorization: ServiceAuthorization.cases.SignIn.make({}),
  }),
)
const keyedCatalog = keyedServices.map((entry) =>
  ExecutorServiceEntry.make({
    id: entry.id,
    name: entry.name,
    description: entry.policy.instruction,
    domain: entry.policy.host,
    authorization: personalKeyAuthorization(),
  }),
)

/**
 * Every operation on one Connection's app and account over one authenticated client. Each caller
 * gets its own set, so its tool snapshots and install locks are never served to another caller:
 * a snapshot warmed with one member's key cannot answer for another key that Executor would refuse.
 * Setup inspection (`availability`) describes the installation's catalogue and is shared.
 */
const makeConnectionOperations = Effect.fn('Executor.connectionOperations')(function* (
  http: ExecutorHttp,
  availability: Effect.Success<ReturnType<typeof makeAuthorization>>,
  publicOnly: boolean,
  mcp: ReturnType<typeof mcpCalls>,
) {
  const toolCache = yield* makeToolCache(http)
  const complete = makeComplete(http)
  const completeSignIn = makeCompleteSignIn(http)
  const remove = makeRemove(http)
  const call = makeCall(http, toolCache.discover, mcp)
  const install = yield* makeInstall(http)
  const registration = makeBegin(http, availability, install)
  const operations: ExecutorConnectionOperations = {
    resume: makeResume(mcp),
    refresh: Cache.invalidateAll(toolCache.snapshots),
    appSlug: makeAppSlug(http),
    begin: registration.begin,
    add: Effect.fn('Executor.addPublic')((input) =>
      publicOnly ? registration.add(input) : Effect.fail(ExecutorPublicAddressRequired.make({})),
    ),
    make: registration.make,
    readMade: makeReadMade(http),
    /** Deploy by ID preserves app data, schedules, event names, and every existing Watch. */
    reviseMade: Effect.fn('Executor.reviseMade')(function* (app, files) {
      yield* http.readRevision(post(`/apps/${query(app)}/deploy`, { files }))
      yield* Cache.invalidateAll(toolCache.snapshots)
    }),
    reauthorize: makeReauthorize(http, availability),
    complete: Effect.fn('Executor.completeCached')(function* (input: typeof CompleteInput.Type) {
      const references = yield* complete(input)
      yield* Cache.invalidate(toolCache.snapshots, input.references)
      return references
    }),
    completeSignIn: Effect.fn('Executor.completeSignInCached')(function* (
      input: typeof SignInInput.Type,
    ) {
      const references = yield* completeSignIn(input)
      yield* Cache.invalidate(toolCache.snapshots, input.references)
      return references
    }),
    status: makeStatus(http),
    identity: makeIdentity(http),
    remove: Effect.fn('Executor.removeCached')(function* (references: ExecutorReferences) {
      yield* remove(references)
      yield* Cache.invalidate(toolCache.snapshots, references)
    }),
    tools: makeTools(toolCache.discover),
    retire: makeRetire(http),
    prepareRetirement: makePrepareRetirement(http),
    call: Effect.fn('Executor.callCached')((input: typeof CallInput.Type) =>
      call(input).pipe(
        Effect.catchTag('ExecutorConflict', () =>
          Cache.invalidate(toolCache.snapshots, input.references).pipe(
            Effect.as(
              ExecutorCallOutcome.cases.Rejected.make({
                message: 'The integration changed; discover its tools again.',
              }),
            ),
          ),
        ),
        Effect.tap((outcome) =>
          ExecutorCallOutcome.guards.NotReady(outcome)
            ? Cache.invalidate(toolCache.snapshots, input.references)
            : Effect.void,
        ),
        Effect.tapError(() => Cache.invalidate(toolCache.snapshots, input.references)),
      ),
    ),
  }
  return operations
})

/** A member's operations outlive one request so its tool snapshots stay warm between calls.
 * Source: unmeasured; matches the tool snapshot lifetime, after which a reload is needed anyway. */
const MEMBER_OPERATIONS_IDLE = TOOL_SNAPSHOT_TTL

/**
 * Operations on one Connection's app and account, run with the caller's own set. A member's set is
 * built on first use and keyed by the member's key itself (`Redacted` compares by value), so the
 * credential a set sends is exactly the one it was looked up by.
 */
function connectionOperationsFor(
  installation: ExecutorConnectionOperations,
  members: RcMap.RcMap<Redacted.Redacted<string>, ExecutorConnectionOperations, never>,
) {
  return (caller: ExecutorCaller): ExecutorConnectionOperations => {
    if (ExecutorCaller.guards.Installation(caller)) return installation
    const run = <A, E>(use: (operations: ExecutorConnectionOperations) => Effect.Effect<A, E>) =>
      RcMap.get(members, caller.key).pipe(Effect.flatMap(use), Effect.scoped)
    return {
      refresh: run((operations) => operations.refresh),
      appSlug: (app) => run((operations) => operations.appSlug(app)),
      begin: (input) => run((operations) => operations.begin(input)),
      add: (input) => run((operations) => operations.add(input)),
      make: (input) => run((operations) => operations.make(input)),
      readMade: (app) => run((operations) => operations.readMade(app)),
      reviseMade: (app, files) => run((operations) => operations.reviseMade(app, files)),
      reauthorize: (input) => run((operations) => operations.reauthorize(input)),
      complete: (input) => run((operations) => operations.complete(input)),
      completeSignIn: (input) => run((operations) => operations.completeSignIn(input)),
      status: (references) => run((operations) => operations.status(references)),
      identity: (references) => run((operations) => operations.identity(references)),
      remove: (references) => run((operations) => operations.remove(references)),
      tools: (references) => run((operations) => operations.tools(references)),
      call: (input) => run((operations) => operations.call(input)),
      resume: (input) => run((operations) => operations.resume(input)),
      prepareRetirement: (resources) =>
        run((operations) => operations.prepareRetirement(resources)),
      retire: (input) => run((operations) => operations.retire(input)),
    }
  }
}

/** Acquire transport once and start the scoped catalog writer; tool discovery remains keyed. */
const makeExecutor = Effect.fn('Executor.make')(function* (
  url: string,
  key: Redacted.Redacted,
  organization: typeof ExecutorOrganizationId.Type,
) {
  const publicOnly = yield* Config.Boolean('VIVID_EXECUTOR_PUBLIC_ONLY').pipe(
    Config.withDefault(false),
  )
  const transport = yield* HttpClient.HttpClient
  const google = yield* loadGoogleClient()
  /** The one place a credential is put on a request: every client, the installation's and each
   * member's, is built here and differs only in the bearer it sends. */
  const httpWith = (bearer: Redacted.Redacted) =>
    makeHttp(
      HttpClient.mapRequest(transport, (request) =>
        request.pipe(
          HttpClientRequest.prependUrl(`${url}/api/organizations/${query(organization)}`),
          HttpClientRequest.bearerToken(bearer),
          HttpClientRequest.acceptJson,
        ),
      ),
      google,
    )
  const mcpWith = (bearer: Redacted.Redacted) =>
    mcpCalls(
      HttpClient.mapRequest(transport, (request) =>
        request.pipe(
          HttpClientRequest.prependUrl(url),
          HttpClientRequest.bearerToken(bearer),
          HttpClientRequest.setHeader('X-Executor-Organization', organization),
        ),
      ),
    )
  const http = httpWith(key)
  const remoteCatalog = yield* retainCatalog(makeCatalog(http)())
  const catalog = Effect.fn('Executor.installedCatalog')(function* () {
    const remote = yield* remoteCatalog().pipe(
      Effect.catchTag('ServiceUnavailable', () => Effect.succeed([])),
    )
    return [
      ...googleCatalog,
      ...keyedCatalog,
      ExecutorServiceEntry.make({
        id: discordServiceId,
        name: 'Discord',
        description:
          'Create a bot at discord.com/developers/applications, copy its token, and invite it to your server.',
        domain: 'discord.com',
        authorization: ServiceAuthorization.cases.Key.make({
          fields: [{ name: 'token', label: 'Bot token' }],
        }),
      }),
      ...remote.filter(
        (entry) =>
          Option.isNone(googleService(entry.id)) &&
          keyedService(entry.id) === undefined &&
          entry.id !== discordServiceId,
      ),
    ]
  })
  const availability = yield* makeAuthorization(http, catalog)
  const installation = yield* makeConnectionOperations(http, availability, publicOnly, mcpWith(key))
  // Each member inspects sign-in setup with its own key: Executor answers OAuth setup only for
  // a caller that can use an app requiring that provider, and a member's apps are "Only me", so
  // the installation key is refused for them. Catalog display facts stay on `availability`.
  const members = yield* RcMap.make({
    lookup: Effect.fn('Executor.memberOperations')(function* (member: Redacted.Redacted<string>) {
      const memberHttp = httpWith(member)
      const memberAvailability = yield* makeAuthorization(memberHttp, catalog)
      return yield* makeConnectionOperations(
        memberHttp,
        memberAvailability,
        publicOnly,
        mcpWith(member),
      )
    }),
    idleTimeToLive: MEMBER_OPERATIONS_IDLE,
  })
  return Executor.of({
    catalog: availability.catalog,
    authorization: availability.authorization,
    as: connectionOperationsFor(installation, members),
  })
})

/**
 * Requires HttpClient.HttpClient (provide FetchHttpClient.layer or NodeHttpClient.layerNodeHttp).
 *
 * Integrations are part of every running Vivid, so the three Executor settings are required while
 * the server is composed: a missing or malformed one stops launch naming the variable, and "no
 * Integrations on this server" is not a state a Person or the model can meet. Executor being down,
 * refusing or timing out is a different fact: it stays a typed failure on the call that met it
 * (`ExecutorFailure`), and the next call tries Executor again.
 */
/**
 * Where Executor answers and which organization every request names. The address is prefixed
 * onto request paths as text, so it is checked to be an absolute URL and kept as supplied. The
 * member provisioning in `members.ts` reads the same two.
 */
export const executorAddress = Effect.fn('Executor.address')(function* () {
  const url = yield* requiredSetting(
    'VIVID_EXECUTOR_URL',
    Schema.NonEmptyString.check(
      Schema.makeFilter((value) => URL.canParse(value) || 'an absolute URL'),
    ),
    "Executor's absolute URL",
  )
  // Every request path is scoped to one Executor organization; there is no default one.
  const organization = yield* requiredSetting(
    'VIVID_EXECUTOR_ORGANIZATION',
    ExecutorOrganizationId,
    'the Executor organization id',
  )
  return { url: url.replace(/\/$/u, ''), organization }
})

export const executorLayer = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const { url, organization } = yield* executorAddress()
    // The installation owner's credential; without it every installation call is refused.
    const key = yield* requiredSetting('VIVID_EXECUTOR_KEY', settingSecret, 'the Executor API key')
    return yield* makeExecutor(url, key, organization)
  }),
)
