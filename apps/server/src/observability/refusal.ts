import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ActionEffect, DeviceRefusal, ReadPageRefusal, ServiceId } from '@vivid/contracts'

/**
 * Which kind of thing an action would have been done to: the tags of `ActionTarget` in
 * `@vivid/contracts`. Only the tag is carried; the target's own fields (an account label, a
 * command line, a tool's input) are a Person's content and stay out of telemetry.
 */
const ActionTargetKind = Schema.Literals(['Connection', 'Command', 'Browser', 'Desktop'])

/**
 * Every way Vivid declines to do something, as one closed vocabulary.
 *
 * A refusal is a successful value in Vivid, not a failure: a rule said never, a Person said no, an
 * Integration is not ready. Nothing is thrown, so nothing reaches `observeFailures`; this is how
 * those outcomes become countable. Access failures (`Unauthenticated`, `Forbidden`, `NotFound`)
 * are typed failures and are already recorded at their boundary, so they have no case here.
 *
 * A case carries only what identifies the kind of thing refused: a closed reason, an action's
 * effect, a service. Never a rule's wording, a summary, a message, a tool's input, model output or
 * a credential; those are a Person's content, and the fields below leave no place to put them.
 *
 * One refusal is one case, recorded where it is decided. A rule's `Never` travels outward as
 * `GateDecision.Blocked`, then `ToolOutcome.Blocked`, then `CodeOutcome.Blocked`; it is
 * `ActionBlocked` at the Gate and is not recorded again by the layers that carry it.
 */
export const Refusal = Schema.TaggedUnion({
  /** A rule says never (`GateDecision.Blocked`). */
  ActionBlocked: { effect: ActionEffect, target: ActionTargetKind },
  /** The Person asked said no (`ApprovalState.Denied`). */
  ApprovalDenied: { effect: ActionEffect, target: ActionTargetKind },
  /** A tool call was turned away before or by the service (`ToolOutcome.Rejected`). */
  ToolRejected: {
    reason: Schema.Literals([
      'IntegrationUnavailable',
      'IntegrationFailed',
      'ToolUnknown',
      'SharedReadOnly',
      'ServiceRejected',
    ]),
  },
  /** The Integration must be authorized again (`ToolOutcome.ConnectionNotReady`). */
  IntegrationNotReady: { service: ServiceId },
  /** A call from Vivid's code was answered with a refusal the program can read (`end: 'refused'`). */
  CallRefused: {
    call: Schema.Literals(['find_tools', 'use_tool', 'run_command', 'browse', 'read_page']),
  },
  /** A public page could not be read (`ReadPageOutcome.Refused`). */
  PageRefused: { reason: ReadPageRefusal },
  /** The Person's own computer declined an action (`DeviceReceipt.Refused`). */
  DeviceRefused: { reason: DeviceRefusal },
  /** The runtime would not start a Run (`AdmissionRefused` in `runtime/client.ts`). */
  AdmissionRefused: { reason: Schema.Literals(['Encoding', 'Address', 'Rejected']) },
})
export type Refusal = typeof Refusal.Type

/** The name of the span event and the body of the log line for every refusal. */
const REFUSAL_EVENT = 'vivid.refusal'

const encodeRefusal = Schema.encodeSync(Refusal)

/**
 * A case's fields as attributes, each under `vivid.refusal.<field>`. Encoding through the schema
 * keeps this total over the vocabulary: a new case or field is exported without a second list to
 * extend, and every field is a string by construction of the cases above.
 */
const attributesOf = (refusal: Refusal) => {
  const { _tag, ...fields } = encodeRefusal(refusal)
  return {
    'vivid.refusal.kind': _tag,
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [`vivid.refusal.${key}`, value]),
    ),
  }
}

/**
 * Records one refusal: one info log line named `vivid.refusal` carrying the case's fields. It
 * cannot fail and returns nothing, so a producer calls it beside the value it returns without
 * changing that value.
 *
 * The span event comes from the same line. Effect's default `tracerLogger` (rc.116
 * `internal/effect.ts`) turns every log written under a span into an event on that span, named by
 * the message and carrying the log's annotations, so writing the event by hand as well put two
 * events on the span for one refusal. Without a current span there is only the log line.
 *
 * Info, not warning: a refusal is Vivid working as designed. It is untraced on purpose: a span of
 * its own would receive the event in place of the producer's.
 */
export const recordRefusal = Effect.fnUntraced(function* (refusal: Refusal) {
  yield* Effect.annotateLogs(Effect.logInfo(REFUSAL_EVENT), attributesOf(refusal))
})
