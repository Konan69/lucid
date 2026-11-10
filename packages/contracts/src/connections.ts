import { Effect, Match, Option, Schema } from 'effect'
import { ActionApplied, ActionReceipt, ToolCallId } from './actions.js'
import { ActionEffect } from './approvals.js'
import { RuleDecision } from './rules.js'
import { ApprovalId, InputRequestId, ConnectionId, PersonSummary, ServiceId } from './identity.js'

/**
 * Whose account a Connection is.
 *
 * - `Personal`: one Person's own account. Vivid uses it only when acting for that Person, and in a
 *   shared Thread asks them first.
 * - `Shared`: an account the Company set up for everyone. Every Member's Threads can read through
 *   it; nobody's Thread can write through it, so every change is made by a real Person's account.
 */
export const ConnectionOwnership = Schema.TaggedUnion({
  Personal: { owner: PersonSummary },
  Shared: {},
})
export type ConnectionOwnership = typeof ConnectionOwnership.Type

/** Whether a Connection can be used right now. */
export const ConnectionState = Schema.TaggedUnion({
  Ready: {},
  /** Authorization was started and not finished, or has lapsed and must be renewed. */
  NeedsAuthorization: {},
  Failed: { reason: Schema.String },
})
export type ConnectionState = typeof ConnectionState.Type

/** OAuth scope evidence is observed authority, never the list requested at sign-in. */
export const OAuthScope = Schema.NonEmptyString.pipe(Schema.brand('OAuthScope'))
export type OAuthScope = typeof OAuthScope.Type
export const ScopeEvidence = Schema.TaggedUnion({
  Known: { values: Schema.Array(OAuthScope) },
  Unreported: {},
  NotApplicable: {},
})
export type ScopeEvidence = typeof ScopeEvidence.Type

/** Operational readiness and the certainty of its authorization observation are separate facts. */
export const ConnectionGrant = Schema.TaggedUnion({
  Unverified: {},
  NotRequired: {},
  Pending: {},
  Granted: { scopes: ScopeEvidence },
  Partial: { granted: Schema.Array(OAuthScope), missing: Schema.NonEmptyArray(OAuthScope) },
  Expired: {},
  Revoked: {},
  ReauthorizationRequired: {},
})
export type ConnectionGrant = typeof ConnectionGrant.Type
export const ObservationTime = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('ObservationTime'),
)
export type ObservationTime = typeof ObservationTime.Type
export const GrantObservation = Schema.Struct({
  grant: ConnectionGrant,
  checkedAt: ObservationTime,
})

/** Only these reviewed Google classes have deterministic admission controls. */
export const ConnectionDataClass = Schema.Literals(['GmailDrafts', 'CalendarEventSchedules'])
export type ConnectionDataClass = typeof ConnectionDataClass.Type
/**
 * The service whose accounts each data class belongs to. The server's admission policy
 * (`apps/server/src/connections/permissions.ts`) and every screen that offers the class read this
 * one table, so a class is offered exactly on the accounts it can be withheld from.
 */
export const connectionDataClassService = {
  GmailDrafts: ServiceId.make('google/gmail'),
  CalendarEventSchedules: ServiceId.make('google/calendar'),
} as const satisfies Record<ConnectionDataClass, ServiceId>
export const ConnectionPermission = Schema.Struct({
  dataClass: ConnectionDataClass,
  decision: RuleDecision,
})
export type ConnectionPermission = typeof ConnectionPermission.Type
export const SetConnectionPermissionRequest = Schema.Struct({
  id: ConnectionId,
  dataClass: ConnectionDataClass,
  decision: RuleDecision,
})
export type SetConnectionPermissionRequest = typeof SetConnectionPermissionRequest.Type

/** The most characters a Person's name for an account may have. */
export const ACCOUNT_NAME_MAX = 40

/**
 * The most characters an account's whole name may have ("Gmail (ada@example.com)"). Discovery,
 * resolution, a program's call and the runtime's tool input all take a name of this length and no
 * longer, so a name Vivid is shown is always one it can act through. A name that is longer is not
 * shown to Vivid at all.
 */
export const ACCOUNT_HANDLE_MAX = 300

/**
 * What a Person calls one of their accounts, to tell it from their others on the same service:
 * "Work", "Personal". 1 to 40 characters with no space at either end, on one line. It is said to
 * the model as plain text and drawn in one line of a row, so a line break has no honest meaning in
 * it. A client trims what was typed before it sends; the server refuses rather than repairs.
 */
export const AccountName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, ACCOUNT_NAME_MAX),
  Schema.isPattern(/^[^\r\n]*$/u),
)
export type AccountName = typeof AccountName.Type

/**
 * An authorized relationship with an external account. Credential values are never part of it.
 *
 * A Person may connect one service several times: two Gmail accounts are two Connections. Two
 * separate facts tell them apart, and neither stands in for the other:
 *
 * - `identity` is who the service says signed in ("ada@example.com"). The Person never types it.
 *   Only some services say; the others leave it null.
 * - `name` is what the Person calls the account ("Work"). It is null until they call it anything,
 *   and they may change it whenever they like.
 *
 * `account` is the one name that results, the same words on every screen and the words Vivid uses
 * for it: "Gmail (Work)". The server writes it, so a screen never works it out differently.
 */
export const Connection = Schema.Struct({
  id: ConnectionId,
  service: ServiceId,
  /** The service's name as people know it: "Gmail". */
  serviceName: Schema.String,
  /**
   * The address of the service's icon, without a size, when the server can name one: an added
   * server's site. Null for a catalog service, which each client draws from its bundled logos.
   */
  mark: Schema.NullOr(Schema.String),
  /**
   * Where links to this service live, as a registrable domain or a host with a path prefix
   * ("grain.com", "mail.google.com", "docs.google.com/spreadsheets"), so a reply's link to it can
   * be drawn with the service's mark (`apps/mobile/src/ui/Prose.tsx`). An added server's domain
   * comes from its address; a catalog service's from Vivid's own list of the services people
   * connect most (`apps/server/src/connections/logo.ts`). Null when neither knows.
   */
  site: Schema.NullOr(Schema.String),
  /** What the Person called this account: "Work". Null until they name it. */
  name: Schema.NullOr(AccountName),
  /** Who the service says signed in: "ada@example.com". Null when the service does not say. */
  identity: Schema.NullOr(Schema.String),
  /**
   * What this account is called, among everything this Person can use: "Gmail (Work)",
   * "Gmail (ada@example.com)", or "Gmail" alone when nothing tells it apart. It is the name
   * Vivid is given for the account and the name it must use to act through it.
   */
  account: Schema.String,
  /**
   * Where the service came from. One from the `Catalogue` can be connected again for one more
   * account. An `Address` import or a `Made` app owns one dedicated connection, so screens
   * cannot offer another account for it.
   */
  origin: Schema.Literals(['Catalogue', 'Address', 'Made']),
  ownership: ConnectionOwnership,
  state: ConnectionState,
  grant: ConnectionGrant,
  permissions: Schema.Array(ConnectionPermission),
  createdAt: Schema.Finite,
}).annotate({ identifier: 'Connection', title: 'Integration' })
/** Decoded Connection. */
export interface Connection extends Schema.Schema.Type<typeof Connection> {}

/** How a service is authorized: a sign-in in the browser, a key the Person pastes, or nothing. */
export const ServiceAuthorization = Schema.TaggedUnion({
  SignIn: {},
  Key: { fields: Schema.Array(Schema.Struct({ name: Schema.String, label: Schema.String })) },
  None: {},
  /**
   * The service signs people in through an application that whoever runs this Vivid has not
   * registered with it yet. Nobody here can connect it until they do, so it is listed, to be
   * found by name, and it is not offered.
   */
  SetupRequired: {},
  /**
   * How the service is entered is not known until it is installed: Executor's hosted catalogue
   * lists a service without saying whether it wants a sign-in, a key, or nothing. Beginning the
   * Connection installs it, reads what it needs, and answers with the real next step. It is on
   * offer, unlike `SetupRequired`.
   */
  KnownAfterInstall: {},
})
export type ServiceAuthorization = typeof ServiceAuthorization.Type

/** Catalogue judgements describe usefulness separately from this installation's credentials. */
export const ServiceCuration = Schema.Struct({
  kind: Schema.Literals([
    'mail',
    'calendar',
    'files',
    'notes',
    'chat',
    'meetings',
    'tasks',
    'crm',
    'finance',
    'social',
    'shopping',
    'travel',
    'design',
    'developer',
    'data',
    'other',
  ]),
  auth: Schema.Literals(['OneTap', 'OperatorSetup', 'PersonKey', 'None', 'Unknown']),
  worksNow: Schema.Boolean,
})

/** One service Vivid can be connected to, from the catalog. */
export const Service = Schema.Struct({
  id: ServiceId,
  name: Schema.String,
  description: Schema.String,
  /** The address of the service's logo image, or null when no registrable domain is available. */
  mark: Schema.NullOr(Schema.String),
  authorization: ServiceAuthorization,
  /** Absent for a Person-supplied address, which has no catalogue judgement. */
  curation: Schema.optionalKey(ServiceCuration),
}).annotate({ identifier: 'Service', title: 'Integration' })
export interface Service extends Schema.Schema.Type<typeof Service> {}

/**
 * What is connected, for the Connections screen and the connect card. The catalog is not part of
 * it: it is thousands of entries that no Person owns and that do not move when a Connection does,
 * so it is searched (`FindServices`) instead of being sent with every change to this list.
 */
export const ConnectionListResponse = Schema.Struct({
  connections: Schema.Array(Connection),
})
export interface ConnectionListResponse extends Schema.Schema.Type<typeof ConnectionListResponse> {}

/** Looking through the catalog by name. An empty query asks for the services most people want. */
export const FindServicesRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(80)),
})
export interface FindServicesRequest extends Schema.Schema.Type<typeof FindServicesRequest> {}

/**
 * What a catalog search found. The catalog lives with the Connection layer, which can be out of
 * reach while everything a Person already connected still lists and works; `Unavailable` says so,
 * so a screen never shows "no such service" for a catalog it could not read.
 */
export const ServiceCatalog = Schema.TaggedUnion({
  /** The best matches, most wanted first. `total` counts Core, Useful and Niche services. */
  Ready: { services: Schema.Array(Service), total: Schema.Finite },
  Unavailable: {},
})
export type ServiceCatalog = typeof ServiceCatalog.Type

/** Where a sign-in trip is made from, which is where the browser hands back to. */
export const SignInSurface = Schema.Literals(['Phone', 'Web'])
export type SignInSurface = typeof SignInSurface.Type

/**
 * Starting a Connection. Sharing one with the Company takes an admin. A service may be begun any
 * number of times; each is one more account.
 */
export const BeginConnectionRequest = Schema.Struct({
  from: SignInSurface,
  service: ServiceId,
  /**
   * What the Person calls the account being added, when they said: the way to tell it apart on a
   * service that does not say who signed in. Null leaves it unnamed.
   */
  name: Schema.NullOr(AccountName),
  shared: Schema.Boolean,
})
export interface BeginConnectionRequest extends Schema.Schema.Type<typeof BeginConnectionRequest> {}

/** A Person naming one of their accounts, or taking its name away again with null. */
export const RenameConnectionRequest = Schema.Struct({
  id: ConnectionId,
  name: Schema.NullOr(AccountName),
})
export interface RenameConnectionRequest extends Schema.Schema.Type<
  typeof RenameConnectionRequest
> {}

/** What the client must do next to finish authorizing. */
export const ConnectionStep = Schema.TaggedUnion({
  /** Open this address; the provider returns the Person to Vivid when they are done. */
  OpenSignIn: { connection: Connection, address: Schema.String },
  /** Collect these fields in a masked form and send them with `CompleteConnection`. */
  /** The fields this account asks for, which only the service knows once the Connection began. */
  EnterKey: {
    connection: Connection,
    fields: Schema.Array(Schema.Struct({ name: Schema.String, label: Schema.String })),
  },
  Done: { connection: Connection },
})
export type ConnectionStep = typeof ConnectionStep.Type

/** Source paths are canonical relative files; aliases cannot replace Vivid's pinned manifest. */
export const MadeFile = Schema.Struct({
  path: Schema.NonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.makeFilter(
      (path) =>
        !path.includes('\\') &&
        !path.includes('\0') &&
        path !== 'package.json' &&
        path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    ),
  ),
  content: Schema.String.check(Schema.isMaxLength(200_000)),
})
export interface MadeFile extends Schema.Schema.Type<typeof MadeFile> {}

/** Vivid supplies the framework manifest, while the author supplies bounded, distinct files. */
export const MakeIntegrationRequest = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(40)),
  files: Schema.Array(MadeFile).check(
    Schema.isBetweenLength(1, 30),
    Schema.makeFilter((files) => new Set(files.map((file) => file.path)).size === files.length),
    // Executor builds an app from its root `index.ts` default export.
    Schema.makeFilter((files) => files.some((file) => file.path === 'index.ts')),
  ),
})
export interface MakeIntegrationRequest extends Schema.Schema.Type<typeof MakeIntegrationRequest> {}

/** Repeated names reuse add's existing-account outcomes instead of allocating another app. */
export const MakeIntegrationOutcome = Schema.TaggedUnion({
  Made: { account: Schema.String },
  PendingAuthorization: { account: Schema.String, step: ConnectionStep },
  BuildFailed: { message: Schema.String },
  NotAnIntegration: { reason: Schema.String },
  Unreachable: { reason: Schema.String },
  AlreadyConnected: { account: Schema.String, name: Schema.String },
  Failed: { account: Schema.String, name: Schema.String },
})
export type MakeIntegrationOutcome = typeof MakeIntegrationOutcome.Type

/**
 * Key fields for a Connection that takes them. They travel from the Person's client to the server
 * and on to the credential store; they are never written to a Thread, a log or model context.
 */
export const CompleteConnectionRequest = Schema.Struct({
  id: ConnectionId,
  fields: Schema.Record(Schema.String, Schema.Redacted(Schema.String)),
})
export interface CompleteConnectionRequest extends Schema.Schema.Type<
  typeof CompleteConnectionRequest
> {}

export const ConnectionResponse = Schema.Struct({ connection: Connection })

/** One thing Vivid can do through a Connection. */
export const ConnectionTool = Schema.Struct({
  connectionId: ConnectionId,
  /** "Gmail (Work)": the service and the account (`Connection.account`), so Vivid can say which it will use. */
  account: Schema.String,
  name: Schema.String,
  description: Schema.String,
  effect: ActionEffect,
  /** The tool's input as a JSON Schema document, for Vivid to fill in. */
  input: Schema.Json,
}).annotate({ identifier: 'ConnectionTool', title: 'Integration tool' })
export interface ConnectionTool extends Schema.Schema.Type<typeof ConnectionTool> {}

/** Vivid looking for what it can do. Results are limited to what the acting Person may use here. */
export const FindToolsRequest = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Finite),
})
export interface FindToolsRequest extends Schema.Schema.Type<typeof FindToolsRequest> {}

/** Discovery publishes callable documentation, while resolution keeps its input contract separate. */
export const DiscoveredTool = Schema.Struct({
  connectionId: ConnectionId,
  account: Schema.String,
  name: Schema.String,
  description: Schema.String,
  effect: ActionEffect,
  call: Schema.String,
  signature: Schema.String,
})
export interface DiscoveredTool extends Schema.Schema.Type<typeof DiscoveredTool> {}

export const FindToolsResponse = Schema.Struct({
  tools: Schema.Array(DiscoveredTool),
  /** Services that would answer the query if they were connected, so Vivid can offer them. */
  unconnected: Schema.Array(Service),
  /**
   * Services that answer the query and that the acting Person already has a ready account on.
   * Vivid can ask for one more account on any of them: a second Gmail, a work GitHub.
   */
  connected: Schema.Array(Service),
})
export interface FindToolsResponse extends Schema.Schema.Type<typeof FindToolsResponse> {}

/** Vivid asking to do one thing. The server, not the runtime, decides whether it happens. */
export const UseToolRequest = Schema.Struct({
  /** The runtime's identity for this call. A write is journaled under it, so a retry is answered once. */
  toolCallId: ToolCallId,
  connectionId: ConnectionId,
  tool: Schema.String,
  input: Schema.Json,
  /** One sentence in Vivid's voice saying what this does, shown if a Person must approve it. */
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  rationale: Schema.String.check(Schema.isMaxLength(400)),
})
export interface UseToolRequest extends Schema.Schema.Type<typeof UseToolRequest> {}

/**
 * A display's own call into one of the Person's Integrations: OpenUI's `Query` (read when it is
 * drawn and again when what it reads changes) and `Mutation` (run only when the Person presses the
 * button that names it). A display names the tool as `tool@account`, with the tool and account
 * exactly as `find_tools` showed them to Vivid, so the name stays words and never an identifier.
 */
export const DisplayToolKind = Schema.Literals(['Query', 'Mutation'] as const)
export type DisplayToolKind = typeof DisplayToolKind.Type

/** Automatic programs run on draw, with no Integration writes, browser actions or page reads.
 * They still run real JavaScript on the Computer and are not a read-only sandbox. */
export const DisplayCallPolicy = Schema.TaggedUnion({
  Draw: {},
  Press: {},
})
export type DisplayCallPolicy = typeof DisplayCallPolicy.Type

/** Convert OpenUI's invocation vocabulary once, before admitting individual tool calls. */
export const displayCallPolicy = (kind: DisplayToolKind): DisplayCallPolicy =>
  Match.value(kind).pipe(
    Match.when('Query', () => DisplayCallPolicy.cases.Draw.make({})),
    Match.when('Mutation', () => DisplayCallPolicy.cases.Press.make({})),
    Match.exhaustive,
  )

type DisplayCapability = ActionEffect | 'browser' | 'page'

/** Both discovery and final admission consult this one capability policy. */
export const displayCallRefusal = (
  policy: DisplayCallPolicy,
  capability: DisplayCapability,
): Option.Option<string> =>
  DisplayCallPolicy.match(policy, {
    Draw: () => automaticRefusals[capability],
    Press: () => Option.none(),
  })

const automaticRefusals: Readonly<Record<DisplayCapability, Option.Option<string>>> = {
  read: Option.none(),
  write: Option.some('This display runs automatically. Use a button to make changes.'),
  destructive: Option.some('This display runs automatically. Use a button to make changes.'),
  browser: Option.some('This display runs automatically. Use a button to use the browser.'),
  page: Option.some('This display runs automatically. Use a button to read a page.'),
}

export const UseDisplayToolRequest = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(600)),
  input: Schema.Json,
  kind: DisplayToolKind,
})
export interface UseDisplayToolRequest extends Schema.Schema.Type<typeof UseDisplayToolRequest> {}

/** A provider's separate approval step cannot be supplied by pressing a display button. */
export class DisplayApprovalUnsupported extends Schema.TaggedError<DisplayApprovalUnsupported>()(
  'DisplayApprovalUnsupported',
  {},
  { title: 'Display approval unsupported' },
) {}

/**
 * What came of the request. Every variant is something Vivid can act on truthfully: use the
 * output, wait for a decision, offer the Connection, or tell the Person it may not.
 */
export const ToolOutcome = Schema.TaggedUnion({
  /**
   * `receipt` is what the journal recorded for an outward write Vivid sent. It is null where no
   * operation was journaled: a read, which changes nothing outside Vivid, and a Person's own press
   * on a display.
   */
  Completed: { output: Schema.Json, receipt: Schema.NullOr(ActionApplied) },
  /** The provider took the request, but has not confirmed its result. */
  Accepted: { output: Schema.Json, receipt: Schema.NullOr(ActionReceipt.cases.Accepted) },
  /**
   * This exact operation was already done: the runtime retried a call that had been answered, or
   * the same act was reconciled as applied. Its receipt is what is known; it was not sent again,
   * and the provider's answer is not kept.
   */
  Repeated: { receipt: ActionApplied },
  /** A Person must decide. The turn ends; the decision returns to the Thread. */
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  InputRequired: { requestId: InputRequestId, questions: Schema.NonEmptyArray(Schema.String) },
  /** A rule forbids it. */
  Blocked: { rule: Schema.String },
  /** The Connection is not ready and must be authorized again. */
  ConnectionNotReady: { service: ServiceId, serviceName: Schema.String, grant: ConnectionGrant },
  ScopeRequired: { required: Schema.NonEmptyArray(OAuthScope), granted: ScopeEvidence },
  PermissionDeclined: { classes: Schema.NonEmptyArray(ConnectionPermission) },
  Unsupported: { capability: Schema.NonEmptyString },
  /** The service answered with an error Vivid can read and correct. */
  Rejected: {
    message: Schema.String,
    /** Empty means no validation detail was supplied; provider identities never enter this list. */
    problems: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
  },
  /**
   * The request was sent and no answer came back. It may or may not have happened. `receipt` names
   * the journaled operation to reconcile; null on the same calls `Completed` leaves unjournaled.
   */
  OutcomeUnknown: { receipt: Schema.NullOr(ActionReceipt.cases.Unknown) },
})
export type ToolOutcome = typeof ToolOutcome.Type

/** Counts state their unit; provider estimates are not exact totals. */
export const ResultCount = Schema.TaggedUnion({
  Known: { value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), unit: Schema.NonEmptyString },
  Unknown: {},
})
export const ResultContinuation = Schema.TaggedUnion({
  Next: { input: Schema.Json },
  End: {},
  Unknown: {},
})
export const ResultQuery = Schema.Struct({
  account: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  input: Schema.Json,
  fetched: ResultCount,
  total: ResultCount,
  continuation: ResultContinuation,
})
export type ResultQuery = typeof ResultQuery.Type
export const CoverageReason = Schema.TaggedUnion({
  Pagination: {},
  ProviderTruncation: {},
  UnsyncedRange: {},
  PermissionWithheld: { classes: Schema.NonEmptyArray(ConnectionPermission) },
  OutputClipped: {},
})
/** Null query in Partial describes clipped non-retrieval output, never an invented read. */
export const ResultCoverage = Schema.TaggedUnion({
  Complete: { query: ResultQuery },
  Partial: { query: Schema.NullOr(ResultQuery), reasons: Schema.NonEmptyArray(CoverageReason) },
  Unknown: { query: ResultQuery },
  NotRead: {},
  NotApplicable: {},
})
export type ResultCoverage = typeof ResultCoverage.Type
export const ResultAsOf = Schema.TaggedUnion({
  Source: { at: ObservationTime, meaning: Schema.NonEmptyString },
  Unknown: {},
  NotApplicable: {},
})
export type ResultAsOf = typeof ResultAsOf.Type

/** Every Integration receipt retains evidence outside the provider's unchanged output. */
export const IntegrationResult = Schema.Struct({
  outcome: ToolOutcome,
  coverage: ResultCoverage,
  asOf: ResultAsOf,
  observedAt: ObservationTime,
})
export type IntegrationResult = typeof IntegrationResult.Type

/** Runtime message offering a Connection in the Thread. */
export const ConnectionRequestMessage = Schema.Struct({
  kind: Schema.Literal('connection-request'),
  service: ServiceId,
  serviceName: Schema.String,
  reason: Schema.String,
  /**
   * Whether what was asked for is already there: the acting Person has a ready account on this
   * service. A request for one more account is never ready when it is made.
   */
  ready: Schema.Boolean,
}).annotate({ identifier: 'ConnectionRequestMessage', title: 'Integration request message' })
/** Decoded Connection request message. */
export interface ConnectionRequestMessage extends Schema.Schema.Type<
  typeof ConnectionRequestMessage
> {}

/**
 * Vivid asking for one more account on a service the Person has already connected: the work
 * Gmail beside the personal one. It is the same card with one more field. `askedAt` is when Vivid
 * asked, in milliseconds: an account that was there before does not answer the request, so only
 * one begun after that moment does.
 */
export const AnotherAccount = Schema.Struct({ askedAt: Schema.Finite })
export const AnotherAccountMessage = Schema.Struct({
  kind: Schema.Literal('connection-request'),
  service: ServiceId,
  serviceName: Schema.String,
  reason: Schema.String,
  ready: Schema.Literal(false),
  another: AnotherAccount,
})

/**
 * Which accounts Vivid is asking for.
 *
 * - `Service`: the service at all. Any ready account the Person has on it answers.
 * - `Another`: one more account than the Person has now. None of the present ones answers.
 */
export const ConnectionWanted = Schema.Literals(['Service', 'Another'])
export type ConnectionWanted = typeof ConnectionWanted.Type

/** Vivid offering a service it needs for the request in front of it. */
export const OfferConnectionRequest = Schema.Struct({
  service: ServiceId,
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  wanted: ConnectionWanted,
})
export interface OfferConnectionRequest extends Schema.Schema.Type<typeof OfferConnectionRequest> {}

/** What `OfferConnection` answers with: the card for the service, or the card for one more account. */
export const ConnectionOffer = Schema.Union([AnotherAccountMessage, ConnectionRequestMessage])
export type ConnectionOffer = typeof ConnectionOffer.Type

/** Discovery combines accessible accounts with Executor's catalogue, without exposing authority. */
export const FindIntegrationsRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
})
export interface FindIntegrationsRequest extends Schema.Schema.Type<
  typeof FindIntegrationsRequest
> {}

/** Names are the runtime's only handles; disconnected catalogue entries have no account yet. */
export const ConnectionMatch = Schema.TaggedUnion({
  Account: {
    name: Schema.String,
    account: Schema.String,
    /** Who the service says signed in, when it says: the address behind an account named "Work". */
    identity: Schema.NullOr(Schema.String),
    connected: Schema.Boolean,
    shared: Schema.Boolean,
    state: ConnectionState,
    grant: ConnectionGrant,
  },
  Catalog: {
    name: Schema.String,
    description: Schema.String,
    connected: Schema.Boolean,
    authorization: ServiceAuthorization,
  },
})
export const FindIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(ConnectionMatch),
  omittedAccounts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  catalog: Schema.Literals(['available', 'unavailable']),
})
export interface FindIntegrationsResponse extends Schema.Schema.Type<
  typeof FindIntegrationsResponse
> {}

/** URL imports are personal by default; shared imports require the existing Company admin role. */
export const AddIntegrationRequest = Schema.Struct({
  address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000)),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(40)),
  shared: Schema.Boolean,
})
export interface AddIntegrationRequest extends Schema.Schema.Type<typeof AddIntegrationRequest> {}

export const mcpQueryUnsupportedMessage =
  'An MCP server address cannot include query parameters. Use its base endpoint address.'

export const openApiUnsupportedMessage =
  'An OpenAPI document cannot be added as an Integration yet. You can add an MCP server.'

/** Failure reasons are precise and credential-free; documentation must publish a specification link. */
export const ConnectionAddressRefusal = Schema.Literals([
  openApiUnsupportedMessage,
  mcpQueryUnsupportedMessage,
  'not a public web address',
  'documentation page has no OpenAPI specification link',
  'not an MCP server or OpenAPI specification',
  'unsupported integration authorization or specification',
])

/** Existing authorization steps remain the single source of truth for client card payloads. */
export const AddIntegrationOutcome = Schema.TaggedUnion({
  Added: { account: Schema.String },
  AlreadyConnected: { account: Schema.String, name: Schema.String },
  PendingAuthorization: { account: Schema.String, step: ConnectionStep },
  AwaitingInitiator: { name: Schema.String },
  Failed: { account: Schema.String, name: Schema.String },
  NeedsSignIn: { step: ConnectionStep.cases.OpenSignIn },
  NeedsKey: { step: ConnectionStep.cases.EnterKey },
  NotAnIntegration: { reason: ConnectionAddressRefusal },
  Unreachable: {
    reason: Schema.Literals([
      'could not be reached',
      'this Vivid is not set up to add a server by address yet',
    ]),
  },
})
export type AddIntegrationOutcome = typeof AddIntegrationOutcome.Type

/** The server chooses a safe call; the model supplies only an accessible account name. */
export const TestIntegrationRequest = Schema.Struct({
  account: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ACCOUNT_HANDLE_MAX)),
})
export interface TestIntegrationRequest extends Schema.Schema.Type<typeof TestIntegrationRequest> {}

/** A tool listing alone is never proof that an external call succeeded. */
export const TestIntegrationOutcome = Schema.TaggedUnion({
  Tested: { account: Schema.String, tools: Schema.Array(Schema.String), tool: Schema.String },
  NotTested: {
    account: Schema.String,
    tools: Schema.Array(Schema.String),
    reason: Schema.Literals([
      'needs sign-in',
      'integration failed',
      'no read-only tool can be tested without extra input',
      'call failed',
      'result not confirmed',
    ]),
  },
  /**
   * The service answered the probe call with a refusal. Its words say why (a plan without the
   * feature, an input it wanted), so they are kept: "call failed" alone read as a broken sign-in
   * and sent Vivid asking the Person to reconnect (production, 26 October 2026).
   */
  Refused: {
    account: Schema.String,
    tools: Schema.Array(Schema.String),
    tool: Schema.String,
    message: Schema.String,
  },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String },
  Unreachable: {},
})
export type TestIntegrationOutcome = typeof TestIntegrationOutcome.Type

/** Runtime authorization cards carry only the references clients need to resume/complete securely. */
export const ConnectionAuthorization = Schema.TaggedUnion({
  OpenSignIn: { connectionId: ConnectionId },
  EnterKey: {
    connectionId: ConnectionId,
    fields: ConnectionStep.cases.EnterKey.fields.fields,
  },
})
/** Extends the existing connection-request treatment for an already-started URL import. */
export const ConnectionAuthorizationMessage = Schema.Struct({
  kind: Schema.Literal('connection-request'),
  service: ServiceId,
  serviceName: Schema.String,
  reason: Schema.String,
  ready: Schema.Literal(false),
  authorization: ConnectionAuthorization,
})

/** Only personally authored Integrations expose source for an in-place revision. */
export const ReadMadeIntegrationRequest = Schema.Struct({ account: Schema.NonEmptyString })
export interface ReadMadeIntegrationRequest extends Schema.Schema.Type<
  typeof ReadMadeIntegrationRequest
> {}
export const MadeIntegrationSource = Schema.Struct({
  account: Schema.String,
  files: MakeIntegrationRequest.fields.files,
})
export interface MadeIntegrationSource extends Schema.Schema.Type<typeof MadeIntegrationSource> {}
export const ReviseMadeIntegrationRequest = MadeIntegrationSource
export type ReviseMadeIntegrationRequest = MadeIntegrationSource
