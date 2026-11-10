import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as Struct from 'effect/Struct'
import {
  ActionEffect,
  ActionTarget,
  CodeCallKind,
  DeviceRefusal,
  ReadPageRefusal,
  ServiceId,
} from '@vivid/contracts'
import { Message } from './messages.ts'

/**
 * Which kind of thing an action would have been done to: the tags of `ActionTarget` in
 * `@vivid/contracts`, read from its `cases` so a target added there is a kind here without a
 * second list. Only the tag is carried; the target's own fields (an account label, a typed
 * text, a tool's input) are a Person's content and stay out of telemetry.
 */
const ActionTargetKind = Schema.Literals(Struct.keys(ActionTarget.cases))

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
  CallRefused: { call: CodeCallKind },
  /** A public page could not be read (`ReadPageOutcome.Refused`). */
  PageRefused: { reason: ReadPageRefusal },
  /** The Person's own computer declined an action (`DeviceReceipt.Refused`). */
  DeviceRefused: { reason: DeviceRefusal },
  /** The runtime would not start a Run (`AdmissionRefused` in `runtime/client.ts`). */
  AdmissionRefused: { reason: Schema.Literals(['Encoding', 'Address', 'Rejected']) },
})
export type Refusal = typeof Refusal.Type

const encodeRefusal = Schema.encodeOption(Refusal)

/** The attribute a case's field is written under. */
const attributeKey = (field: string) => `vivid.refusal.${field}`

/** The attribute naming which case a refusal is. */
const KIND = attributeKey('kind')

/**
 * The words a field's schema admits, when the schema is a closed set of them: a literal, or a
 * union of literals (`Schema.Literals`). Absent for any other schema, which is to say for any
 * field whose value is not known in advance: `ServiceId` is a branded `Schema.String`, and a
 * service can be one an Integration a Person imported gave its own name to.
 */
export const membersOf = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string>> => {
  if (SchemaAST.isLiteral(ast))
    return Predicate.isString(ast.literal) ? Option.some([ast.literal]) : Option.none()
  if (SchemaAST.isUnion(ast)) return Option.map(Option.all(ast.types.map(membersOf)), Arr.flatten)
  return Option.none()
}

/** Each field of each case, under its attribute name, with the words its schema admits. */
const refusalFields = Object.values(Refusal.cases).flatMap((refusal) =>
  Object.entries(refusal.fields)
    .filter(([field]) => field !== '_tag')
    .map(([field, schema]) => ({ key: attributeKey(field), members: membersOf(schema.ast) })),
)

/**
 * What of a refusal may be exported: each attribute, with the closed set its value must belong
 * to. Read from the vocabulary itself, so the export allowlist (`export.ts`) is extended by adding
 * a case or a field above and by nothing else.
 *
 * - The kind is one of the case names.
 * - A field named in several cases (`reason`) takes the words of all of them.
 * - A field that is an open string in any case is left out whole. It is still written on the
 *   stdout line (`attributesOf`); it never leaves the process, because a value that only looks
 *   like an identifier says nothing about where it came from.
 */
export const refusalExport: ReadonlyArray<readonly [key: string, members: ReadonlyArray<string>]> =
  [
    [KIND, Struct.keys(Refusal.cases)],
    ...Object.entries(Arr.groupBy(refusalFields, ({ key }) => key)).flatMap(([key, fields]) =>
      Option.all(fields.map(({ members }) => members)).pipe(
        Option.map((members) => [key, Arr.dedupe(Arr.flatten(members))] as const),
        Option.toArray,
      ),
    ),
  ]

/**
 * A case's fields as attributes, each under `vivid.refusal.<field>`. Encoding through the schema
 * keeps this total over the vocabulary: a new case or field is recorded without a second list to
 * extend, and every field is a string by construction of the cases above. Which of them are
 * exported is `refusalExport`'s decision.
 *
 * Recording cannot fail (`recordRefusal`), so a case whose fields will not encode is still
 * recorded, by its kind alone: the kind is the typed value's own tag and needs no encoding.
 */
const attributesOf = (refusal: Refusal) =>
  Option.match(encodeRefusal(refusal), {
    onNone: () => ({ [KIND]: refusal._tag }),
    onSome: ({ _tag, ...fields }) => ({
      [KIND]: _tag,
      ...Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [attributeKey(field), value]),
      ),
    }),
  })

/**
 * Records one refusal: one info log line with the fixed message `vivid.refusal` carrying the
 * case's fields. It cannot fail and returns nothing, so a producer calls it beside the value it
 * returns without changing that value.
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
  yield* Effect.annotateLogs(Effect.logInfo(Message.refusal), attributesOf(refusal))
})
