import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  MessageAttachment,
  SignalType,
  type Conflict,
  type NotFound,
  PersonId,
  type Run,
  RunId,
  RuntimeSubmissionId,
  type RuntimeUnavailable,
  ThreadId,
} from '@vivid/contracts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/**
 * What is being put in front of Vivid.
 *
 * `Said` is a Person writing in the Thread. `Signal` is everything else the server delivers: a
 * Watch receiving an event, the outcome of an Approval, the answer to a question. Its
 * `type` is one of the fixed `SignalType`s every client knows how to draw.
 */
export const DeliveryMessage = Schema.TaggedUnion({
  Said: { body: Schema.String, attachments: Schema.optionalKey(Schema.Array(MessageAttachment)) },
  /** A linked personal channel supplies a Person's text through server delivery, never an impersonated signal. */
  ChannelText: { body: Schema.String },
  FirstConversation: {},
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
  // The immutable message fingerprint lives with its reservation, not in Pi-owned history.
  // Older Runs and server-internal text deliveries predate fingerprinted gateway admission.
  Message: { fingerprint: Schema.optionalKey(Schema.String) },
  FirstConversation: {},
  Decision: {},
  /** An Integration event a Watch subscribed to woke Vivid in a background Thread. */
  Watch: { watchName: Schema.String },
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
  readonly message: DeliveryMessage
  readonly origin: StoredRunOrigin
  /** Repeating a delivery with the same key starts nothing new and returns the same Run. */
  readonly idempotencyKey: string
  /**
   * The key the sending client made, when a client's send is what this delivery is. It is passed
   * to the runtime untouched so the conversation state can give it back on the placed message;
   * nothing in the server reads it. A delivery the server makes itself has none.
   */
  readonly clientKey?: string
}

/** Only the ordinary chat path moves past questions; server signals and channel text do not. */
export const movesThreadOn = (delivery: Delivery) =>
  DeliveryMessage.guards.Said(delivery.message) &&
  DeliverySpeaker.guards.Acting(delivery.speaker) &&
  StoredRunOrigin.guards.Message(delivery.origin)

/** Server producers deliver signals; Person-authored messages use immediate `admit` instead. */
export interface SignalDelivery extends Delivery {
  readonly message:
    | typeof DeliveryMessage.cases.Signal.Type
    | typeof DeliveryMessage.cases.FirstConversation.Type
}

/** Channel transport enters the same admission policy with the linked Person as its actor. */
export interface ChannelDelivery extends Delivery {
  readonly message: typeof DeliveryMessage.cases.ChannelText.Type
}
export type ServerDelivery = SignalDelivery | ChannelDelivery

/** The product reservation and the Pi receipt remain distinct across retries and restarts. */
export const Admitted = Schema.Struct({
  runId: RunId,
  /** Encode as a decimal string in the existing JSON receipt, without a database migration. */
  submissionId: Schema.FiniteFromString.pipe(Schema.decodeTo(RuntimeSubmissionId)),
})
export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}

/** Untagged historical JSON decodes to explicit variants without rewriting old receipts. */
export const StoredReceipt = Schema.Union([
  Schema.Struct({ _tag: Schema.tagDefaultOmit('Pi'), ...Admitted.fields }),
  Schema.Struct({
    _tag: Schema.tagDefaultOmit('Legacy'),
    runId: RunId,
    offset: Schema.String,
    incarnation: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion('_tag'))
export type StoredReceipt = typeof StoredReceipt.Type

/** A legacy replay identifies its product Run but has no Pi submission to follow. */
export type AdmissionOutcome =
  | Admitted
  | { readonly runId: RunId; readonly submissionId?: undefined }

export interface ConversationService {
  /** A successful abort settles each named Run through the same conditional transition as observation. */
  readonly stopped: (
    ids: ReadonlyArray<RunId>,
  ) => Effect.Effect<void, NotFound | DatabaseInfrastructureError>

  /**
   * Delivers a server signal and records its Run. Watch events, Approval outcomes and
   * answers share the admission policy used by Person messages, so every Run records whose
   * authority it carries. Busy returns a typed Conflict immediately; producers retain their
   * durable receipt and retry its original key on their own schedule.
   */
  readonly deliver: (
    delivery: ServerDelivery,
  ) => Effect.Effect<Run, Conflict | RuntimeUnavailable | NotFound | DatabaseInfrastructureError>
  /** Immediate admission: another Person's working Run returns a client-displayable Conflict. */
  readonly admit: (
    delivery: Delivery,
  ) => Effect.Effect<
    AdmissionOutcome,
    Conflict | RuntimeUnavailable | NotFound | DatabaseInfrastructureError
  >
}

/** How work starts. Implemented in `threads/delivery.ts` by `conversationLayer`. */
export class Conversation extends Context.Service<Conversation, ConversationService>()(
  'vivid/Conversation',
) {}
