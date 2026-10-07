import { PersonId } from '@vivid/contracts'
import * as Schema from 'effect/Schema'
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
export const encodeSignal = Schema.encodeSync(Signal)
