import { CodeName } from '@vivid/contracts'
import * as Schema from 'effect/Schema'

/**
 * Every log message Vivid's own recorders write, as one closed set.
 *
 * A log line's body, and the span event Effect derives from the same line (rc.116
 * `internal/effect.ts` `tracerLogger` names the event by the message), are free text as far as an
 * exporter can tell: a line written anywhere else in the server may quote a Thread, a provider's
 * answer or a client's report. So the export allowlist (`export.ts`) lets a body or an event name
 * through only when it is one of these; a recorder that should be countable in the backend adds
 * its message here and writes that constant, never a template string.
 */
export const Message = {
  /** The Gate's final policy decision and the review measurements' policy outcome. */
  gateDecision: 'Gate decided',
  reviewDecision: 'Gate review decided',
  /** A review succeeded, could not be made, or took its one transient retry. */
  reviewed: 'Action reviewed',
  reviewFallback: 'Unreviewed fallback applied',
  reviewRetry: 'Jev retry taken',
  /** Provider approval is answered underneath the product's already-made decision. */
  executorApproval: 'Executor pause auto-accepted',
  executorContinuationFailed: 'Executor continuation failed',
  approvalAuditFailed: 'Integration approval audit failed',

  /** Saved Integration calls and their durable questions, with identifiers and outcome tags only. */
  integrationPause: 'Integration pause raised',
  integrationAnswer: 'Integration pause answered',
  integrationWithdrawn: 'Integration pause cancelled by withdrawal',
  integrationExpired: 'Integration pause expired',
  reconciliation: 'Action reconciled',
  reconciliationRetry: 'Action retry checked',
  memberProvisioned: 'Executor member provisioned',
  memberReused: 'Executor member reused',
  memberRefused: 'Executor member refused',
  executorNotReady: 'Executor selection not ready',
  connectionRemoved: 'Integration removed',
  /** `computers/store.ts`: the provider did not answer a read; the read answered from the record. */
  computerUnobserved: 'Computer could not be observed',
  /** `computers/store.ts`: a running Computer's screen could not be had; the read went on without it. */
  computerUnshown: 'Computer could not be shown',
  /** `watches/lifecycle.ts`: Executor kept a subscription Vivid no longer has; the Watch moved on. */
  watchUnsubscribed: 'Watch subscription not removed from Executor',
  /** `connections/catalog.ts`: one attempt to refresh the Integration catalog failed. */
  catalogAttempt: 'Integration catalog attempt failed',
  artifactRemoved: 'Artifact removed',
  /** `failure.ts`: a typed failure was answered at a boundary. */
  failure: 'Failure reached a boundary',
  /** `failure.ts`: a defect was answered at a boundary. */
  defect: 'Defect reached a boundary',
  /** `incidents.ts`: a Person's work did not happen. */
  incident: "Person's work did not happen",
  /** `refusal.ts`: Vivid declined to do something. */
  refusal: 'vivid.refusal',
  /** `http/faults.ts`: a client reported that it failed to draw. */
  fault: 'Client fault',
  /** `export.ts`: an export was cancelled, refused or timed out; its signal is paused a minute. */
  dropped: 'Telemetry batches dropped',
  /** `live/tally.ts`: what one live query did in the last minute. */
  live: 'Live query counted',
  /** `live/tally.ts`: how many change notifications this process heard in the last minute. */
  moved: 'Changes counted',
  /** `live/tally.ts`: how many times one call was made on the live socket in the last minute. */
  called: 'Calls counted',
} as const
export type Message = (typeof Message)[keyof typeof Message]

/**
 * What stands in for a log body, a span name or an event name that is not on the allowlist. The
 * record still goes, with its level, time and allowlisted attributes, so it is still counted.
 */
export const OMITTED = '[omitted]'

const messages: ReadonlySet<string> = new Set(Object.values(Message))

/** Whether `text` is, exactly, one of the fixed messages. */
export const isMessage = (text: string): text is Message => messages.has(text)

/**
 * Whether `text` has the shape of a code identifier and is short enough to be one: the one rule,
 * `CodeName` in `@vivid/contracts`, which an Incident's hops are built of too.
 */
export const isCodeName: (text: string) => boolean = Schema.is(CodeName)
