import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import {
  MessageAttachment,
  SignalCue,
  type Conflict,
  type NotFound,
  PersonId,
  type Run,
  RunId,
  RuntimeSubmissionId,
  type RuntimeUnavailable,
  type ThreadId,
  WatchId,
} from '@vivid/contracts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/**
 * The cues a server producer makes itself: an Approval's outcome, an answer, a Watch's event, a
 * card's carry-on, a finished handoff, a Settings forget.
 */
export const ServerCue = Schema.Union([
  SignalCue.cases.Approval,
  SignalCue.cases.Answer,
  SignalCue.cases.Watch,
  SignalCue.cases.CarryOn,
  SignalCue.cases.Handoff,
  SignalCue.cases.Forget,
])
export type ServerCue = typeof ServerCue.Type

/**
 * What is being put in front of Vivid.
 *
 * `Said` is a Person writing in the Thread. `Signal` is everything else the server delivers: a
 * Watch receiving an event, the outcome of an Approval, the answer to a question, each as its
 * own `SignalCue` case.
 */
export const DeliveryMessage = Schema.TaggedUnion({
  Said: { body: Schema.String, attachments: Schema.optionalKey(Schema.Array(MessageAttachment)) },
  /** A linked personal channel supplies a Person's text through server delivery, never an impersonated signal. */
  ChannelText: { body: Schema.String },
  FirstConversation: {},
  Signal: { cue: ServerCue },
})
export type DeliveryMessage = typeof DeliveryMessage.Type

/**
 * Why a Run started, as its row stores it. The Person is not repeated here: a Run's `person_id` is
 * the Person Vivid acts for, whatever started it.
 */
export const StoredRunOrigin = Schema.TaggedUnion({
  // The immutable message fingerprint lives with its reservation, not in runtime-owned history.
  // Older Runs and server-internal text deliveries predate fingerprinted gateway admission.
  Message: { fingerprint: Schema.optionalKey(Schema.String) },
  FirstConversation: {},
  Decision: {},
  /**
   * An Integration event a Watch subscribed to woke Vivid in a background Thread: the Watch's id
   * and name as they were, and which of its events. The event itself stays in the conversation.
   */
  Watch: {
    watchId: WatchId,
    watchName: Schema.String,
    eventId: Schema.NonEmptyString,
    event: Schema.String,
    occurredAt: Schema.String,
  },
  /** A Watch Run stored before 29 October 2026, which kept only the Watch's name. */
  WatchUnrecorded: { watchName: Schema.String },
  /** A Settings Forget press woke Vivid in a background Thread to plan and carry it out. */
  Forget: {},
  /** A helper ended and its result came back to the Thread (`runs/store.ts`). */
  ChildResult: { childRunId: RunId },
})
export type StoredRunOrigin = typeof StoredRunOrigin.Type

/**
 * A Run's origin as its column holds it. A Watch Run stored before 29 October 2026 is tagged
 * `Watch` with only the Watch's name; it reads as `WatchUnrecorded`, with no event invented for it.
 * Every write is a `StoredRunOrigin`, which the union encodes through its first member.
 */
export const StoredRunOriginColumn = Schema.Union([
  StoredRunOrigin,
  Schema.TaggedStruct('Watch', { watchName: Schema.String }).pipe(
    Schema.decodeTo(StoredRunOrigin.cases.WatchUnrecorded, {
      decode: SchemaGetter.transform(({ watchName }) =>
        StoredRunOrigin.cases.WatchUnrecorded.make({ watchName }),
      ),
      encode: SchemaGetter.forbidden(() => 'A Run origin is written only in its current shape.'),
    }),
  ),
])

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
  /** The sending client recognises its optimistic message by this opaque key. */
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

/** A durable runtime submission is distinct from the product reservation that admitted it. */
export const Admitted = Schema.Struct({
  runId: RunId,
  submissionId: Schema.FiniteFromString.pipe(Schema.decodeTo(RuntimeSubmissionId)),
})
export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}

export interface ConversationService {
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
    Admitted,
    Conflict | RuntimeUnavailable | NotFound | DatabaseInfrastructureError
  >
}

/** How work starts. Implemented in `threads/delivery.ts` by `conversationLayer`. */
export class Conversation extends Context.Service<Conversation, ConversationService>()(
  'vivid/Conversation',
) {}
