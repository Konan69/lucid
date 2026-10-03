import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  MessageAttachment,
  SignalType,
  type Conflict,
  type LibraryFolderId,
  type NotFound,
  PersonId,
  type Run,
  RunId,
  type RuntimeUnavailable,
  type ThreadId,
} from '@vivid/contracts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/**
 * What is being put in front of Vivid.
 *
 * `Said` is a Person writing in the Thread. `Signal` is everything else the server delivers: a
 * Routine coming due, the outcome of an Approval, the answer to a question. Its
 * `type` is one of the fixed `SignalType`s every client knows how to draw.
 */
export const DeliveryMessage = Schema.TaggedUnion({
  Said: { body: Schema.String, attachments: Schema.optionalKey(Schema.Array(MessageAttachment)) },
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
  // The immutable message fingerprint lives with its reservation, not in Flue-owned history.
  // Older Runs and server-internal text deliveries predate fingerprinted gateway admission.
  Message: { fingerprint: Schema.optionalKey(Schema.String) },
  Routine: { routineName: Schema.String },
  Standing: { routineName: Schema.String },
  Attention: { routineName: Schema.String },
  Decision: {},
})
export type StoredRunOrigin = typeof StoredRunOrigin.Type

/** Speaker attribution is independent of the Person whose authority a Run carries. */
export const DeliverySpeaker = Schema.TaggedUnion({
  Acting: {},
  Decider: { personId: PersonId },
  Vivid: {},
})
export type DeliverySpeaker = typeof DeliverySpeaker.Type

export interface Delivery {
  readonly threadId: ThreadId
  /** The Person Vivid acts for in the Run this starts. They must be able to see the Thread. */
  readonly personId: PersonId
  readonly speaker: DeliverySpeaker
  /** Only Routine deliveries carry a Library confinement; ordinary deliveries have none. */
  readonly libraryFolder?: LibraryFolderId | null
  readonly message: DeliveryMessage
  readonly origin: StoredRunOrigin
  /** Repeating a delivery with the same key starts nothing new and returns the same Run. */
  readonly idempotencyKey: string
}

/** Server producers deliver signals; Person-authored messages use immediate `admit` instead. */
export interface SignalDelivery extends Delivery {
  readonly message: typeof DeliveryMessage.cases.Signal.Type
}

/** Flue's receipt for a delivery, which the gateway hands back to the client that sent it. */
export const Admitted = Schema.Struct({
  runId: RunId,
  /** Where this delivery's events begin in the Thread's stream. */
  offset: Schema.String,
  /** The conversation's incarnation in the runtime. */
  incarnation: Schema.String,
})
export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}

export interface ConversationService {
  /**
   * Delivers a server signal and records its Run. Routines, Approval outcomes and
   * answers share the admission policy used by Person messages, so every Run records whose
   * authority it carries. Busy returns a typed Conflict immediately; producers retain their
   * durable receipt and retry its original key on their own schedule.
   */
  readonly deliver: (
    delivery: SignalDelivery,
  ) => Effect.Effect<Run, Conflict | RuntimeUnavailable | NotFound | DatabaseInfrastructureError>
  /** Immediate admission: another Person's working Run returns a client-displayable Conflict. */
  readonly admit: (
    delivery: Delivery,
  ) => Effect.Effect<
    Admitted,
    Conflict | RuntimeUnavailable | NotFound | DatabaseInfrastructureError
  >
}

/** How work starts. Implemented in `threads/delivery.ts` by `conversationLayer`. */
export class Conversation extends Context.Service<Conversation, ConversationService>()(
  'vivid/Conversation',
) {}
