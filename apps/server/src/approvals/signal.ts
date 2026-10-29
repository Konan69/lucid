import { ApprovalInvalidation, ApprovalState, PersonId, type ApprovalId } from '@vivid/contracts'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import { encodeStored } from '../database/client.ts'
import { DeliveryMessage } from '../threads/conversation.ts'

/** Durable delivery state is independent of the decision: executions owe their eventual outcome. */
export const Signal = Schema.TaggedUnion({
  None: {},
  Awaiting: { idempotencyKey: Schema.String },
  Owed: {
    idempotencyKey: Schema.String,
    /** Expiry has no decider; every human decision retains its original Person. */
    deciderId: Schema.NullOr(PersonId),
    message: DeliveryMessage.cases.Signal,
  },
  Delivered: { idempotencyKey: Schema.String, deliveredAt: Schema.Finite },
  Stopped: {
    idempotencyKey: Schema.String,
    stoppedAt: Schema.Finite,
    reason: Schema.Literal('AccessLost'),
  },
})
export type Signal = typeof Signal.Type

/** JSONB egress uses the same schema as replay ingress. */
export const encodeSignal = encodeStored(Signal, 'delivery signal')

/**
 * `None` as its column holds it: the default of each table that carries a signal. A column default
 * is fixed when the table is declared, outside any Effect, so this is encoded once at load. `None`
 * has no fields and so no way to fail; were the schema changed until it did, the server must not
 * start with a default it cannot write, and the schema's own error ends the load.
 */
export const storedNone = Result.getOrThrow(Schema.encodeResult(Signal)(Signal.cases.None.make({})))

/** Only terminal outcomes have a signal body; execution first records an Awaiting debt. */
export const Conclusion = Schema.Union([
  ApprovalState.cases.Denied.mapFields(Struct.pick(['_tag'])),
  ApprovalState.cases.Expired.mapFields(Struct.pick(['_tag'])),
  ApprovalState.cases.Succeeded.mapFields(Struct.pick(['_tag', 'result'])),
  ApprovalState.cases.Failed.mapFields(Struct.pick(['_tag', 'reason'])),
  ApprovalState.cases.OutcomeUnknown.mapFields(Struct.pick(['_tag'])),
  ApprovalState.cases.Invalidated.mapFields(Struct.pick(['_tag', 'reason'])),
]).pipe(Schema.toTaggedUnion('_tag'))
export type Conclusion = typeof Conclusion.Type

/** The decision and eventual settlement share one runtime delivery identity. */
export const approvalKey = (id: ApprovalId) => `approval-${id}`

/**
 * What changed, in the words Vivid reads. Vivid never sees an identifier, so the change is named
 * by what it was to the action, not by which record it was.
 */
const changedWords = (reason: ApprovalInvalidation) =>
  ApprovalInvalidation.match(reason, {
    ContentChanged: ({ version }) =>
      version === null ? 'The document it sends was removed' : 'The document it sends was revised',
    ConnectionChanged: ({ generation }) =>
      generation === null
        ? 'The integration it uses was removed'
        : 'The integration it uses was signed in again or lost its sign-in',
    AuthorityChanged: () => 'The person it was asked of left the workspace',
    RunStopped: () => 'The work that asked was stopped',
    Superseded: () => 'It was asked before approvals were bound to what they approve',
  })

/**
 * Whether Vivid is woken to prepare a fresh ask. A Person who stopped the work, or left the
 * workspace, did not ask for it again; an ask from before bindings existed has no Run waiting on it.
 * A changed document or Integration is the work still wanted against something new.
 */
export const wakesVivid = (reason: ApprovalInvalidation) =>
  ApprovalInvalidation.isAnyOf(['ContentChanged', 'ConnectionChanged'])(reason)

/** Freeze the outcome text in the settlement write so no later projection is needed for replay. */
export const owed = (
  id: ApprovalId,
  summary: string,
  conclusion: Conclusion,
  deciderId: PersonId | null,
) => {
  const body = Conclusion.match(conclusion, {
    Expired: () => `Expired: ${summary}. This request ran out. The action was not run.`,
    Denied: () => `Denied: ${summary}. The action was not run.`,
    Succeeded: ({ result }) => `Approved: ${summary}. Result: ${result.slice(0, 4000)}`,
    Failed: ({ reason }) => `Approved: ${summary}. Failed: ${reason.slice(0, 4000)}`,
    OutcomeUnknown: () =>
      `Approved: ${summary}. The outcome is unknown. Check the service; never retry this action automatically.`,
    Invalidated: ({ reason }) =>
      `Changed: ${summary}. ${changedWords(reason)} after the person was asked, so this approval went stale and the action was not run. If it is still wanted, prepare it again from what is there now, which asks the person afresh.`,
  })
  return Signal.cases.Owed.make({
    idempotencyKey: approvalKey(id),
    deciderId,
    message: DeliveryMessage.cases.Signal.make({
      type: 'approval',
      body,
      attributes: {
        approval: id,
        outcome: Conclusion.guards.Expired(conclusion) ? 'expired' : conclusion._tag,
      },
    }),
  })
}
