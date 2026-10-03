import { Schema } from 'effect'
import { PersonId, RunId, ThreadId } from './identity.js'

/** One identity source for retained pages; Electron identifiers never cross product boundaries. */
export const BrowserPageId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('BrowserPageId'),
)
export type BrowserPageId = typeof BrowserPageId.Type

/** Vivid names for helper_transport.js::D app identities and browser-service.mjs::He site URLs. */
export const BrowserAccessResource = Schema.TaggedUnion({
  App: { app: Schema.String.check(Schema.isNonEmpty()), displayName: Schema.String },
  Site: { origin: Schema.URLFromString },
})

/**
 * helper_transport.js::D offers session/always where permitted. Browser service origin prompts
 * (browser-service.mjs::JA/wB/mJ) also accept an unpersisted decision: Vivid calls that scope once.
 * wB maps session to conversation and always to global; mJ may bind origin access to the turn
 * according to policy. These schemas declare choices, not a replacement for those storage rules.
 */
export const BrowserAccessScope = Schema.Literals(['once', 'session', 'always'])
export type BrowserAccessScope = typeof BrowserAccessScope.Type

/** A reverse access request is distinct from the existing Approval for one consequential action. */
export const BrowserAccessRequestId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('BrowserAccessRequestId'),
)

/**
 * app/.vite/build/main-DpnWwRdP.js::Yte uses a UUID reverse request with a 300-second timeout,
 * and rejects it on disconnect. Vivid adds Person/Thread/Run attribution because its loop is
 * remote. The exact allowed scopes come from the permission authority, never from the model.
 * Pending permission storage/handlers are not implemented while native input enforcement is missing.
 */
export const BrowserAccessRequest = Schema.Struct({
  id: BrowserAccessRequestId,
  personId: PersonId,
  threadId: ThreadId,
  runId: RunId,
  resource: BrowserAccessResource,
  scopes: Schema.NonEmptyArray(BrowserAccessScope),
  expiresAt: Schema.Number.check(Schema.isFinite()),
})
export type BrowserAccessRequest = typeof BrowserAccessRequest.Type

/** helper_transport.js::D rejects non-accept and disallowed persistent grants; missing UI fails closed. */
export const BrowserAccessDecision = Schema.TaggedUnion({
  Allow: { scope: BrowserAccessScope },
  Deny: {},
})
export const AnswerBrowserAccessRequest = Schema.Struct({
  id: BrowserAccessRequestId,
  decision: BrowserAccessDecision,
})

/**
 * Typed presentation of Yte's pending/resolved/timeout/disconnected outcomes. The future handler
 * must bind the answer to a live request, apply D's app refusal or mJ's site scope policy, and
 * publish the resulting scope. Selecting always is not evidence that a global grant was stored.
 */
export const BrowserAccessState = Schema.TaggedUnion({
  Pending: { request: BrowserAccessRequest },
  Allowed: { scope: BrowserAccessScope },
  Denied: {},
  Expired: {},
  Withdrawn: {},
})

/**
 * helper_transport.js::F/U persists stop for session/turn; Thread/Run are Vivid's equivalent.
 * app/.vite/build/main-DpnWwRdP.js::turnEnded releases retained pages. These are surface contracts
 * only: native input-token enforcement and the Run stop-marker adapter remain unproved/unimplemented.
 */
export const BrowserControlState = Schema.TaggedUnion({
  Idle: {},
  Active: { threadId: ThreadId, runId: RunId, tab: BrowserPageId, since: Schema.Number },
  Stopped: { threadId: ThreadId, runId: RunId },
  Unavailable: { reason: Schema.Literal('InputTokenEnforcementMissing') },
})

/** Run-scoped Stop is distinct from PagesRequest.Stop, which currently stops a page load only. */
export const StopBrowserControl = Schema.Struct({ threadId: ThreadId, runId: RunId })
