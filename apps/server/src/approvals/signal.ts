import { ApprovalOutcome, PersonId, SignalCue } from '@vivid/contracts'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import { encodeStored } from '../database/client.ts'
import { DeliveryMessage } from '../threads/conversation.ts'

/**
 * An owed delivery stored before 29 October 2026, when a signal was its type, words and string
 * attributes. Only Approvals and answers were ever owed; each reads as its cue, with the outcome
 * its attributes named. Nothing is written in this shape again, so it does not encode.
 */
const EarlierSignal = Schema.Union([
  Schema.TaggedStruct('Signal', {
    type: Schema.Literal('approval'),
    body: Schema.String,
    attributes: Schema.Struct({ outcome: ApprovalOutcome }),
  }),
  Schema.TaggedStruct('Signal', { type: Schema.Literal('answer'), body: Schema.String }),
]).pipe(
  Schema.decodeTo(DeliveryMessage.cases.Signal, {
    decode: SchemaGetter.transform((earlier) =>
      DeliveryMessage.cases.Signal.make({
        cue:
          earlier.type === 'approval'
            ? SignalCue.cases.Approval.make({
                body: earlier.body,
                outcome: earlier.attributes.outcome,
              })
            : SignalCue.cases.Answer.make({ body: earlier.body }),
      }),
    ),
    encode: SchemaGetter.forbidden(() => 'An owed delivery is written only in its current shape.'),
  }),
)

/** Durable delivery state is independent of the decision: executions owe their eventual outcome. */
export const Signal = Schema.TaggedUnion({
  None: {},
  Awaiting: { idempotencyKey: Schema.String },
  Owed: {
    idempotencyKey: Schema.String,
    /** Expiry has no decider; every human decision retains its original Person. */
    deciderId: Schema.NullOr(PersonId),
    message: Schema.Union([DeliveryMessage.cases.Signal, EarlierSignal]),
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
