import { Schema } from 'effect'
import { ApprovalChanged, ApprovalExpired } from './approvals.js'
import { ArtifactChanged } from './artifacts.js'
import { NoDeviceConnected } from './computers.js'
import { DisplayApprovalUnsupported } from './connections.js'
import {
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvalidRequest,
  MailboxUnconfirmed,
  NotFound,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from './failures.js'
import { SkillReadOnly } from './skills.js'

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
      ArtifactChanged.fields._tag,
      SkillReadOnly.fields._tag,
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
      ServiceUnavailable.fields._tag,
    ]),
  }),
)
