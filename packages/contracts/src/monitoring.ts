import { Schema } from 'effect'
import type { LogLevel } from 'effect/LogLevel'
import { ApprovalChanged, ApprovalDecided, ApprovalExpired } from './approvals.js'
import { ArtifactChanged } from './artifacts.js'
import { NoDeviceConnected } from './computers.js'
import { DisplayApprovalUnsupported } from './connections.js'
import {
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  DeliveryRefused,
  Forbidden,
  InvalidRequest,
  MailboxUnconfirmed,
  NotFound,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from './failures.js'

/**
 * What a failure cost a Person, which alone decides how loudly it is said. Whether the code
 * declared the failure (`expected` or `defect` in `apps/server/src/observability/failure.ts`)
 * stays an attribute and no longer picks the level: a typed `RuntimeUnavailable` that lost a
 * Person's message is as serious as a defect, and was a warning.
 *
 * - `Incident`: a Person's work did not happen. An issue in the error tracker and an error log.
 *   Said through an `Incident` (`incidents.ts`) where the outcome is decided, and for any failure
 *   that reaches a boundary and is neither of the two below.
 * - `Routine`: the Person's own decision, or a request the Person can correct (a refused sign-in,
 *   a stale edit, a validation refusal). An info log and no issue.
 * - `Recovered`: a transient failure that was retried or fallen back from, and the work still
 *   happened. A warning and no issue. If the retries give up, the outcome is an `Incident`.
 */
export const Impact = Schema.Literals(['Incident', 'Routine', 'Recovered'])
export type Impact = typeof Impact.Type

/**
 * How each impact is said, the one table every recorder reads (server, phone, web, desktop), so
 * a level cannot be chosen anywhere else. `level` is the log level; `issue` whether an issue is
 * opened in the error tracker.
 */
export const impactSignal = {
  Incident: { level: 'Error', issue: true },
  Routine: { level: 'Info', issue: false },
  Recovered: { level: 'Warn', issue: false },
} as const satisfies Record<Impact, { readonly level: LogLevel; readonly issue: boolean }>

/** User decisions and stale-edit refusals are normal outcomes, unlike typed infrastructure failures. */
export const isRoutineRefusal = Schema.is(
  Schema.Struct({
    _tag: Schema.Union([
      Unauthenticated.fields._tag,
      Forbidden.fields._tag,
      NotFound.fields._tag,
      Conflict.fields._tag,
      InvalidRequest.fields._tag,
      MailboxUnconfirmed.fields._tag,
      ApprovalChanged.fields._tag,
      ApprovalExpired.fields._tag,
      ApprovalDecided.fields._tag,
      ArtifactChanged.fields._tag,
      NoDeviceConnected.fields._tag,
      DisplayApprovalUnsupported.fields._tag,
    ]),
  }),
)

/** Clients mark these calls failed; the server owns the incident and its original causal stack. */
export const isRemoteIncident = Schema.is(
  Schema.Struct({
    _tag: Schema.Union([
      DatabaseFailure.fields._tag,
      DatabaseUnavailable.fields._tag,
      DatabaseConstraintViolation.fields._tag,
      RuntimeUnavailable.fields._tag,
      DeliveryRefused.fields._tag,
      ServiceUnavailable.fields._tag,
    ]),
  }),
)

/**
 * The impact of a typed failure that reached a boundary as the answer: `Routine` for the
 * refusals `isRoutineRefusal` names, `Incident` for every other. It is never `Recovered`, because a failure that
 * reached a boundary was not recovered from; a recorder that retries says `Recovered` itself.
 *
 * `isRoutineRefusal` is folded into this: its callers (`apps/server/src/observability/issues.ts`,
 * `apps/mobile/src/data/tracing.ts`) move to `impactOfFailure` and it is deleted in the same
 * change.
 */
export const impactOfFailure = (failure: { readonly _tag: string }): Impact =>
  isRoutineRefusal(failure) ? 'Routine' : 'Incident'
