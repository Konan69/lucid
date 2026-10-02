import { Schema } from 'effect'
import { ActionEffect } from './approvals.js'
import { ApprovalId, ConnectionId, PersonSummary, ServiceId } from './identity.js'

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

/** An authorized relationship with an external account. Credential values are never part of it. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  service: ServiceId,
  /** The service's name as people know it: "Gmail". */
  serviceName: Schema.String,
  /** What the Person called this account: "Work", "Personal". */
  label: Schema.String,
  ownership: ConnectionOwnership,
  state: ConnectionState,
  createdAt: Schema.Number,
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
})
export type ServiceAuthorization = typeof ServiceAuthorization.Type

/** One service Vivid can be connected to, from the catalog. */
export const Service = Schema.Struct({
  id: ServiceId,
  name: Schema.String,
  description: Schema.String,
  /** The key of a mark in `@vivid/marks`, or of nothing when the catalog has no mark for it. */
  mark: Schema.NullOr(Schema.String),
  authorization: ServiceAuthorization,
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
  /** The best matches, most wanted first. `total` is how many services the catalog holds. */
  Ready: { services: Schema.Array(Service), total: Schema.Number },
  Unavailable: {},
})
export type ServiceCatalog = typeof ServiceCatalog.Type

/** Starting a Connection. Sharing one with the Company takes an admin. */
export const BeginConnectionRequest = Schema.Struct({
  service: ServiceId,
  label: Schema.String.check(Schema.isMaxLength(40)),
  shared: Schema.Boolean,
})
export interface BeginConnectionRequest extends Schema.Schema.Type<typeof BeginConnectionRequest> {}

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
  /** "Gmail (Work)": the service and the account, so Vivid can say which it will use. */
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
  limit: Schema.optionalKey(Schema.Number),
})
export interface FindToolsRequest extends Schema.Schema.Type<typeof FindToolsRequest> {}

export const FindToolsResponse = Schema.Struct({
  tools: Schema.Array(ConnectionTool),
  /** Services that would answer the query if they were connected, so Vivid can offer them. */
  unconnected: Schema.Array(Service),
})
export interface FindToolsResponse extends Schema.Schema.Type<typeof FindToolsResponse> {}

/** Vivid asking to do one thing. The server, not the runtime, decides whether it happens. */
export const UseToolRequest = Schema.Struct({
  connectionId: ConnectionId,
  tool: Schema.String,
  input: Schema.Json,
  /** One sentence in Vivid's voice saying what this does, shown if a Person must approve it. */
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  rationale: Schema.String.check(Schema.isMaxLength(400)),
})
export interface UseToolRequest extends Schema.Schema.Type<typeof UseToolRequest> {}

/**
 * What came of the request. Every variant is something Vivid can act on truthfully: use the
 * output, wait for a decision, offer the Connection, or tell the Person it may not.
 */
export const ToolOutcome = Schema.TaggedUnion({
  Completed: { output: Schema.Json },
  /** A Person must decide. The turn ends; the decision returns to the Thread. */
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  /** A rule forbids it. */
  Blocked: { rule: Schema.String },
  /** The Connection is not ready and must be authorized again. */
  ConnectionNotReady: { service: ServiceId, serviceName: Schema.String },
  /** The service answered with an error Vivid can read and correct. */
  Rejected: { message: Schema.String },
  /** The request was sent and no answer came back. It may or may not have happened. */
  OutcomeUnknown: {},
})
export type ToolOutcome = typeof ToolOutcome.Type

/** Runtime message offering a Connection in the Thread. */
export const ConnectionRequestMessage = Schema.Struct({
  kind: Schema.Literal('connection-request'),
  service: ServiceId,
  serviceName: Schema.String,
  reason: Schema.String,
  /** Whether the acting Person already has this service connected and ready. */
  ready: Schema.Boolean,
}).annotate({ identifier: 'ConnectionRequestMessage', title: 'Integration request message' })
/** Decoded Connection request message. */
export interface ConnectionRequestMessage extends Schema.Schema.Type<
  typeof ConnectionRequestMessage
> {}

/** Vivid offering a service it needs for the request in front of it. */
export const OfferConnectionRequest = Schema.Struct({
  service: ServiceId,
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
})
export interface OfferConnectionRequest extends Schema.Schema.Type<typeof OfferConnectionRequest> {}

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
    connected: Schema.Boolean,
    shared: Schema.Boolean,
    state: ConnectionState,
  },
  Catalog: { name: Schema.String, description: Schema.String, connected: Schema.Boolean },
})
export const FindIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(ConnectionMatch),
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

/** Failure reasons are precise and credential-free; documentation must publish a specification link. */
export const ConnectionAddressRefusal = Schema.Literals([
  'not a public web address',
  'documentation page has no OpenAPI specification link',
  'not an MCP server or OpenAPI specification',
  'unsupported integration authorization or specification',
])

/** Existing authorization steps remain the single source of truth for client card payloads. */
export const AddIntegrationOutcome = Schema.TaggedUnion({
  Added: { account: Schema.String },
  NeedsSignIn: { step: ConnectionStep.cases.OpenSignIn },
  NeedsKey: { step: ConnectionStep.cases.EnterKey },
  NotAnIntegration: { reason: ConnectionAddressRefusal },
  Unreachable: {
    reason: Schema.Literals([
      'could not be reached',
      'public address enforcement is not configured',
    ]),
  },
})
export type AddIntegrationOutcome = typeof AddIntegrationOutcome.Type

/** The server chooses a safe call; the model supplies only an accessible account name. */
export const TestIntegrationRequest = Schema.Struct({
  account: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(300)),
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
    ]),
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
