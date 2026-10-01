import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  SignalType,
  type NotFound,
  type PersonId,
  type Run,
  type RuntimeUnavailable,
  type ThreadId,
} from '@vivid/contracts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/**
 * What is being put in front of Vivid.
 *
 * `Said` is a Person writing in the Thread. `Signal` is everything else the server delivers: a
 * Routine coming due, a follow-up, the outcome of an Approval, the answer to a question. Its
 * `type` is one of the fixed `SignalType`s every client knows how to draw.
 */
export const DeliveryMessage = Schema.TaggedUnion({
  Said: { body: Schema.String },
  Signal: {
    type: SignalType,
    body: Schema.String,
    attributes: Schema.Record(Schema.String, Schema.String),
  },
})
export type DeliveryMessage = typeof DeliveryMessage.Type

/**
 * Why a Run started, as its row stores it. The Person is not repeated here: a Run's `person_id` is
 * the Person Vivid acts for, whatever started it.
 */
export const StoredRunOrigin = Schema.TaggedUnion({
  Message: {},
  Routine: { routineName: Schema.String },
  FollowUp: { taskTitle: Schema.String },
  Decision: {},
})
export type StoredRunOrigin = typeof StoredRunOrigin.Type

export interface Delivery {
  readonly threadId: ThreadId
  /** The Person Vivid acts for in the Run this starts. They must be able to see the Thread. */
  readonly personId: PersonId
  readonly message: DeliveryMessage
  readonly origin: StoredRunOrigin
  /** Repeating a delivery with the same key starts nothing new and returns the same Run. */
  readonly idempotencyKey: string
}

export interface ConversationService {
  /**
   * Hands one message to Vivid in a Thread and records the Run it starts. This is the only way
   * work begins: a Person's message, a Routine, a follow-up and a decision all come through here,
   * so every Run has a Person it acts for and a row that says why it started.
   */
  readonly deliver: (
    delivery: Delivery,
  ) => Effect.Effect<Run, RuntimeUnavailable | NotFound | DatabaseInfrastructureError>
}

/** The server's one authority over the conversation runtime. Implemented in `threads/runs.ts`. */
export class Conversation extends Context.Service<Conversation, ConversationService>()(
  'vivid/Conversation',
) {}
