import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  CodeName,
  CreateThreadRequest,
  Incident,
  impactOfFailure,
  isRemoteIncident,
  MessageAttachment,
  RunId,
  RunState,
  ThreadId,
  type ConversationMessage,
  type Impact,
  type IncidentHop,
  type IncidentSource,
  type ConversationState,
  type Run,
  type ThreadAttention,
} from '@vivid/contracts'
import { Context, Effect, type Layer, Match, Option, Predicate, Result, Schema } from 'effect'
import { AsyncResult, Atom, type AtomRegistry } from 'effect/reactivity'
import type { Live } from './live.js'

/** One sending machine for every client. Words draw immediately, then keep their identity
 * when conversation state confirms them. `Sending` owns the server call, so a late answer
 * cannot enter another state. Retries preserve both the delivery key and payload.
 * The `Delivering` service supplies the transport for each app. */

/**
 * Words on their way to a Thread, with the pictures that go with them, and the key that names
 * this one delivery to the server.
 *
 * Private keys can recognise a lost receipt. Shared echoes require admission proof. The client
 * retains the admitted submission number when a receipt arrives, and the exact canonical id
 * after its optimistic payload is released. A raw shared key identifies no Person.
 */
export const Delivery = Schema.Struct({
  thread: ThreadId,
  key: Schema.String,
  words: Schema.String,
  pictures: Schema.Array(MessageAttachment),
})
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

/**
 * A delivery the server took and the Run it began, kept until the conversation shows its
 * message. `startedAt` is the Run's, for telling a Run not listed yet from one too old to be.
 */
const Taken = Schema.Struct({
  delivery: Delivery,
  run: RunId,
  startedAt: Schema.Finite,
  submission: Schema.Option(Schema.String),
  working: Schema.Boolean,
})
interface Taken extends Schema.Schema.Type<typeof Taken> {}

/**
 * Why words are kept as not sent, which decides who tells the Person, so one send is said once.
 *
 * - `Unstarted`: the server reserved this delivery's Run and the runtime did not take it. The
 *   server ended that Run `Failed` with reason `Delivery` before it answered
 *   (`apps/server/src/threads/delivery.ts`, the admission's `tapError`), so the Run's ending says
 *   what happened and a screen says nothing of its own for these words. Sent again under the same
 *   key it is that same Run reserved again (`makeStart`, `apps/server/src/threads/runs.ts`: a
 *   reservation the runtime never admitted keeps its id and turn and is admitted anew), never a
 *   second Run beside a failed one.
 * - `Refused`: the server refused it before any Run, in a sentence meant for the Person.
 * - `Unconfirmed`: nothing more is known than that the words are not known to have arrived. No
 *   answer came back, the server refused it without words for the Person, the call was called
 *   off, or the words waited behind a delivery that failed. No Run for them is known, so the
 *   client is the one to say so.
 */
export const Unarrival = Schema.TaggedUnion({
  Unstarted: {},
  Refused: { words: Schema.String },
  Unconfirmed: {},
})
export type Unarrival = typeof Unarrival.Type

/** Unanswered or refused words retained for an explicit same-key retry. */
export const Unsent = Schema.Struct({
  delivery: Delivery,
  why: Unarrival,
})
export interface Unsent extends Schema.Schema.Type<typeof Unsent> {}

/** The send was refused or its receipt was lost. Placement remains uncertain. */
class Undelivered extends Schema.TaggedError<Undelivered>()(
  'Undelivered',
  { why: Unarrival },
  { title: 'Undelivered' },
) {}

/**
 * How a client says a failure its Person saw (`Incident` `ClientFailed`): which client it is, the
 * first hop of every cause it records, and its error tracker. Each app gives its own
 * (`data/telemetry.ts` on the phone and the web).
 */
export interface Recording {
  readonly source: Extract<IncidentSource, 'phone' | 'web' | 'desktop'>
  readonly record: (incident: typeof Incident.cases.ClientFailed.Type) => Effect.Effect<void>
}

/**
 * What a client's error tracker is given for a `ClientFailed`, so the phone and the web say it the
 * same way the server says an Incident (`apps/server/src/observability/incidents.ts`): one group
 * per path of failure (`fingerprint`: the case, then `<service>.<tag>` of every hop), and the
 * closed fields as `vivid.incident.*` tags. `vivid.operation` is the first hop's operation, the tag
 * the clients' reports already keep.
 */
export const reportOf = (incident: typeof Incident.cases.ClientFailed.Type) => ({
  fingerprint: [incident._tag, ...incident.cause.map((hop) => `${hop.service}.${hop.tag}`)],
  tags: Object.fromEntries([
    ...incident.cause.slice(0, 1).map((hop): Tag => ['vivid.operation', hop.operation]),
    ['vivid.incident.kind', incident._tag] satisfies Tag,
    ...incident.cause.flatMap(hopTags),
  ]),
})

/** A tag of a report: its key, then its value. */
type Tag = readonly [string, string]

/** One hop's tags, under the hop's place in the cause. */
const hopTags = (hop: IncidentHop, n: number): ReadonlyArray<Tag> => [
  [`vivid.incident.cause.${n}.service`, hop.service],
  [`vivid.incident.cause.${n}.operation`, hop.operation],
  [`vivid.incident.cause.${n}.tag`, hop.tag],
  ...Option.toArray(
    Option.map(Option.fromUndefinedOr(hop.status), (status): Tag => [
      `vivid.incident.cause.${n}.status`,
      String(status),
    ]),
  ),
]

/** One send of a delivery, as the server is asked it. */
const asking = (delivery: Delivery) =>
  Effect.gen(function* () {
    const client = yield* VividRpcClient
    return yield* client.SendToThread({
      threadId: delivery.thread,
      text: delivery.words,
      pictures: delivery.pictures,
      key: delivery.key,
    })
  })

/** Every way one send can fail: `SendToThread`'s refusals and its transport's. */
type SendFailure = Effect.Error<ReturnType<typeof asking>>

/**
 * Who says a failed send, by every tag it can fail with. A tag added to `SendToThread` does not
 * compile until it is named here.
 *
 * `DeliveryRefused` (the runtime answered and refused) and `RuntimeUnavailable` (the runtime's
 * answer is still unknown after the server's retries) are `Unstarted`: in a send both are raised
 * only by the admission, after the reservation, and the server ends the reserved Run before
 * answering (`admitRuntime` and its `tapError`, `apps/server/src/threads/delivery.ts`). A refusal
 * is never said as unavailability, but to the Person both are the same Run that never started,
 * and its ending is what is said. `Conflict` is the server's own sentence
 * (another Person's reply in progress, a key reused for other words). Everything else names no Run
 * and no sentence for the Person.
 */
const unarrivalOf = Match.type<SendFailure>().pipe(
  Match.tagsExhaustive({
    RuntimeUnavailable: () => Unarrival.cases.Unstarted.make({}),
    DeliveryRefused: () => Unarrival.cases.Unstarted.make({}),
    Conflict: ({ message }) => Unarrival.cases.Refused.make({ words: message }),
    ConversationTooLarge: () => Unarrival.cases.Unconfirmed.make({}),
    Unauthenticated: () => Unarrival.cases.Unconfirmed.make({}),
    Forbidden: () => Unarrival.cases.Unconfirmed.make({}),
    NotFound: () => Unarrival.cases.Unconfirmed.make({}),
    InvalidRequest: () => Unarrival.cases.Unconfirmed.make({}),
    ServiceUnavailable: () => Unarrival.cases.Unconfirmed.make({}),
    DatabaseConstraintViolation: () => Unarrival.cases.Unconfirmed.make({}),
    DatabaseUnavailable: () => Unarrival.cases.Unconfirmed.make({}),
    DatabaseFailure: () => Unarrival.cases.Unconfirmed.make({}),
    UnsupportedAttachment: () => Unarrival.cases.Unconfirmed.make({}),
    InvalidAttachment: () => Unarrival.cases.Unconfirmed.make({}),
    AttachmentTooLarge: () => Unarrival.cases.Unconfirmed.make({}),
    TooManyAttachments: () => Unarrival.cases.Unconfirmed.make({}),
    PicturesRequirePrivateThread: () => Unarrival.cases.Unconfirmed.make({}),
    RpcClientError: () => Unarrival.cases.Unconfirmed.make({}),
  }),
)

/**
 * What a failed call cost, as a client says it. The failures the server owns (`isRemoteIncident`:
 * its stores, and the runtime's refusal or unavailability, which it records as `AdmissionFailed`)
 * are the server's to record, so the client says nothing more: one outcome is one Incident. A
 * transport failure (`RpcClientError`: offline, the socket closed) is `Recovered`: the words are
 * kept as not sent for the Person to send again, and it opens no issue. Every other failure
 * originated here and is said by `impactOfFailure`.
 */
const clientImpact = (failure: { readonly _tag: string }): Option.Option<Impact> =>
  isRemoteIncident(failure)
    ? Option.none()
    : Option.some(
        Predicate.isTagged(failure, 'RpcClientError') ? 'Recovered' : impactOfFailure(failure),
      )

/**
 * Records a failed call the Person saw (`ClientFailed`) where it is decided, when it originated on
 * this client (`clientImpact`), so a Thread's first words and its later words are said the same
 * way. `operation` is the span the failure is decided in, the cause's one hop.
 */
export const recordFailure = (
  recording: Recording,
  operation: CodeName,
  failure: { readonly _tag: string },
): Effect.Effect<void> =>
  Option.contains(clientImpact(failure), 'Incident')
    ? recording.record(
        Incident.cases.ClientFailed.make({
          cause: [{ service: recording.source, operation, tag: CodeName.make(failure._tag) }],
        }),
      )
    : Effect.void

/** The operations a failed send's or create's first hop names: the spans `delivering` runs them in. */
const SEND = CodeName.make('Sending.send')
const CREATE = CodeName.make('Sending.create')

/** How the server is asked; see `Delivering`. */
export interface DeliveringService {
  readonly create: (request: CreateThreadRequest) => Effect.Effect<void, Undelivered>
  readonly send: (delivery: Delivery) => Effect.Effect<Run, Undelivered>
}

/** Hands one delivery to the server and answers with the Run it began. */
export class Delivering extends Context.Service<Delivering, DeliveringService>()(
  '@vivid/state/sending/Delivering',
) {}

/**
 * Admission is acceptance even when a terminal Run lacks its runtime receipt. The runtime may
 * have placed the submission before the server failed to store that receipt.
 *
 * A send that fails for good is a failure the Person sees, so it is recorded (`Recording`) where
 * it is decided, in the send's own span: the span's trace is the one the RPC carried to the
 * server (`RpcClient` puts the current span's trace and span id on each request), so the record
 * opens the server's trace of the same send. Only a failure that originated on the client and cost
 * the Person their words is recorded (`clientImpact`).
 */
export const delivering = (run: Live['run'], recording: Recording): DeliveringService => ({
  create: Effect.fn('Sending.create')(function* (request: CreateThreadRequest) {
    const answered = yield* run(VividRpcClient.use((client) => client.CreateThread(request)))
    if (Result.isFailure(answered)) {
      yield* recordFailure(recording, CREATE, answered.failure)
      return yield* new Undelivered({ why: Unarrival.cases.Unconfirmed.make({}) })
    }
    return yield* Effect.void
  }),
  send: Effect.fn('Sending.send')(function* (delivery: Delivery) {
    const asked = run(asking(delivery))
    // A failed send is not proof the words did not arrive: on 26 October 2026 a phone's send
    // failed after the server had taken it. The same key and payload are the same delivery, so
    // it is asked once more, and only a second failure keeps the words as not sent. A
    // `DeliveryRefused` is the runtime's final answer and the server has already ended its Run,
    // so asking again would only be refused again and end the Run a second time.
    const once = yield* asked
    const answered =
      Result.isFailure(once) && !Predicate.isTagged(once.failure, 'DeliveryRefused')
        ? yield* asked
        : once
    if (Result.isSuccess(answered)) return answered.success.run
    const refused = answered.failure
    yield* recordFailure(recording, SEND, refused)
    return yield* new Undelivered({ why: unarrivalOf(refused) })
  }),
})

/** Ownership survives payload release as an exact canonical identity, never a raw shared key. */
const Recognised = Schema.Struct({
  key: Schema.String,
  message: Schema.String,
  submission: Schema.Option(Schema.String),
})

/** Admission proof can outlive a released payload before any canonical message is known. */
const Ownership = Schema.TaggedUnion({
  Admitted: { key: Schema.String, submission: Schema.Option(Schema.String) },
  Placed: Recognised.fields,
})

const Held = {
  createdHere: Schema.Boolean,
  taken: Schema.Array(Taken),
  unsent: Schema.Array(Unsent),
  own: Schema.Array(Ownership),
}
type Held = Schema.Schema.Type<Schema.Struct<typeof Held>>

export const SendingStates = Machine.state({
  states: {
    /** Nothing is on its way. */
    Idle: { fields: Held },
    /** First words and follow-ups share this barrier before any delivery can be admitted. */
    Creating: {
      fields: {
        ...Held,
        creation: CreateThreadRequest,
        delivery: Delivery,
        behind: Schema.Array(Delivery),
      },
    },
    /** Creation failed or was interrupted. The complete ordered queue remains retryable. */
    Uncreated: {
      fields: {
        ...Held,
        creation: CreateThreadRequest,
        delivery: Delivery,
        behind: Schema.Array(Delivery),
        why: Unarrival,
      },
    },
    /**
     * `delivery` is with the server and has not been answered. `behind` are deliveries made
     * while it was, in the order they were made: each goes when the one before it has been
     * taken, so the conversation gets them in the order the Person wrote them.
     */
    Sending: { fields: { ...Held, delivery: Delivery, behind: Schema.Array(Delivery) } },
  },
})

/** Where the machine stands, as every reading of it takes it. */
export type SendingState = Parameters<typeof SendingStates.matches>[0]

/** Echoes and ended, unplaced admissions to release at the next machine event. */
export const Seen = Schema.Struct({
  ended: Schema.Array(Schema.String),
  shown: Schema.Array(Recognised),
})
export interface Seen extends Schema.Schema.Type<typeof Seen> {}

const SendingEvents = Machine.events({
  /** Start a new Thread with its first delivery already ahead of every follow-up. */
  Begin: { creation: CreateThreadRequest, delivery: Delivery },
  /**
   * The Person said something new. What did not arrive before it is let go: saying other words
   * is the Person moving on from it, as it was before this was a machine.
   */
  Send: { delivery: Delivery, seen: Seen },
  /** Retry every unanswered delivery in order, retaining its original key and payload. */
  Again: { seen: Seen },
  /**
   * The Person stopped Vivid. Nothing more leaves this client: what was waiting its turn is
   * kept as not sent, and so is the delivery the server had not answered, whose call is called
   * off. Whether the server had taken that one is not known here; the conversation says so if
   * it shows it, and sent again it is the same key.
   */
  Stop: {},
})

/** A delivery the server took, from the Run it answered with. */
const takenOf = (delivery: Delivery, run: Run): Taken => ({
  delivery,
  run: run.id,
  startedAt: run.startedAt,
  submission: Option.fromUndefinedOr(run.submissionId),
  working: RunState.guards.Working(run.state),
})

/** Echoes retain ownership; ended unplaced admissions release payloads without becoming retryable. */
const reconciled = (held: Held, seen: Seen): Held => {
  const shown = new Set(seen.shown.map((proof) => proof.key))
  const ended = new Set(seen.ended)
  const absent = (delivery: Delivery) => !shown.has(delivery.key)
  return {
    createdHere: held.createdHere,
    taken: held.taken.filter((sent) => absent(sent.delivery) && !ended.has(sent.delivery.key)),
    unsent: held.unsent.filter((one) => absent(one.delivery)),
    own: [
      ...held.own.filter((proof) => !shown.has(proof.key)),
      ...held.taken
        .filter((sent) => ended.has(sent.delivery.key) && absent(sent.delivery))
        .map((sent) =>
          Ownership.cases.Admitted.make({
            key: sent.delivery.key,
            submission: sent.submission,
          }),
        ),
      ...seen.shown.map((proof) =>
        Ownership.cases.Placed.make({
          key: proof.key,
          message: proof.message,
          submission: proof.submission,
        }),
      ),
    ],
  }
}

/** A delivery retained for an explicit retry with the same identity and payload. */
const kept = (delivery: Delivery): Unsent => ({
  delivery,
  why: Unarrival.cases.Unconfirmed.make({}),
})

/** The fields of `Held` in a state's value, without what else the state holds. */
const heldIn = (state: Held): Held => ({
  createdHere: state.createdHere,
  taken: state.taken,
  unsent: state.unsent,
  own: state.own,
})

const Sending = Machine.make({
  id: 'Sending',
  root: SendingStates,
  events: SendingEvents,
  effects: {
    create: (request: CreateThreadRequest) => Delivering.use((service) => service.create(request)),
    send: (delivery: Delivery) => Delivering.use((service) => service.send(delivery)),
  },
  branches: {
    /** Where the server taking a delivery leads: to the next one waiting, or to rest. */
    took: {
      next: { target: 'Sending' },
      rest: { target: 'Idle' },
    },
    /** Where sending again leads from rest: to the server, when there is something to send. */
    again: {
      going: { target: 'Sending' },
      rest: { target: 'Idle' },
    },
  },
}).handle({
  initial: { target: 'Idle', data: { createdHere: false, taken: [], unsent: [], own: [] } },
  states: {
    Idle: {
      on: {
        Begin: {
          target: 'Creating',
          data: ({ event, state }) => ({
            ...heldIn(state),
            creation: event.creation,
            delivery: event.delivery,
            behind: [],
          }),
        },
        Send: {
          target: 'Sending',
          data: ({ event, state }) => ({
            ...reconciled(state, event.seen),
            unsent: [],
            delivery: event.delivery,
            behind: [],
          }),
        },
        Again: {
          branches: 'again',
          resolve: ({ event, state, select }) => {
            const held = reconciled(state, event.seen)
            const going = held.unsent.map((one) => one.delivery)
            const unsent: ReadonlyArray<Unsent> = []
            const [first, ...behind] = going
            return first === undefined
              ? select.rest({ data: held })
              : select.going({ data: { ...held, unsent, delivery: first, behind } })
          },
        },
        // Nothing is on its way, so there is nothing of this client's to hold back.
        Stop: { none: true },
      },
    },
    Creating: {
      invoke: {
        src: 'create',
        input: ({ state }) => state.creation,
        onDone: {
          target: 'Sending',
          data: ({ state }) => ({
            ...heldIn(state),
            createdHere: true,
            delivery: state.delivery,
            behind: state.behind,
          }),
        },
        onFailure: {
          target: 'Uncreated',
          data: ({ state, error }) => ({
            ...heldIn(state),
            creation: state.creation,
            delivery: state.delivery,
            behind: state.behind,
            why: error.why,
          }),
        },
      },
      on: {
        Send: {
          update: 'Creating',
          data: ({ state, event }) => ({ ...state, behind: [...state.behind, event.delivery] }),
        },
        Again: { none: true },
        // Leaving the invoke prevents a late creation receipt from draining this queue after Stop.
        Stop: {
          target: 'Uncreated',
          data: ({ state }) => ({
            ...heldIn(state),
            creation: state.creation,
            delivery: state.delivery,
            behind: state.behind,
            why: Unarrival.cases.Unconfirmed.make({}),
          }),
        },
      },
    },
    Uncreated: {
      on: {
        // A new follow-up cannot abandon older words whose Thread has not been confirmed.
        Send: {
          update: 'Uncreated',
          data: ({ state, event }) => ({ ...state, behind: [...state.behind, event.delivery] }),
        },
        Again: {
          target: 'Creating',
          data: ({ state }) => ({
            ...heldIn(state),
            creation: state.creation,
            delivery: state.delivery,
            behind: state.behind,
          }),
        },
        Stop: { none: true },
      },
    },
    Sending: {
      invoke: {
        src: 'send',
        input: ({ state }) => state.delivery,
        onDone: {
          branches: 'took',
          // The next delivery is this state again with its own call: the state is left and
          // entered, or the call that just answered would stand for the next one too.
          reenter: true,
          resolve: ({ output, state, select }) => {
            const held = {
              ...heldIn(state),
              taken: [...state.taken, takenOf(state.delivery, output)],
            }
            const [next, ...rest] = state.behind
            return next === undefined
              ? select.rest({ data: held })
              : select.next({ data: { ...held, delivery: next, behind: rest } })
          },
        },
        // What waited behind a delivery that failed is not sent past it: the Person wrote them
        // in an order. All of it is kept as not sent, and none of it is on its way any more.
        onFailure: {
          target: 'Idle',
          data: ({ state, error }) => ({
            ...heldIn(state),
            unsent: [
              ...state.unsent,
              { delivery: state.delivery, why: error.why },
              ...state.behind.map(kept),
            ],
          }),
        },
      },
      on: {
        // The call in flight is not restarted: the state is kept and only what waits behind it
        // grows. A Person's words are never refused for arriving while others are on their way.
        Send: {
          update: 'Sending',
          data: ({ event, state }) => ({
            ...state,
            ...reconciled(state, event.seen),
            unsent: [],
            behind: [...state.behind, event.delivery],
          }),
        },
        // What did not arrive goes behind what is already on its way.
        Again: {
          update: 'Sending',
          data: ({ event, state }) => {
            const held = reconciled(state, event.seen)
            const going = held.unsent.map((one) => one.delivery)
            const unsent: ReadonlyArray<Unsent> = []
            return { ...state, ...held, unsent, behind: [...state.behind, ...going] }
          },
        },
        // Leaving this state calls off the call to the server. Its answer, if one was on its
        // way, has nowhere to land, so it cannot hand over what was waiting.
        Stop: {
          target: 'Idle',
          data: ({ state }) => ({
            ...heldIn(state),
            unsent: [...state.unsent, ...[state.delivery, ...state.behind].map(kept)],
          }),
        },
      },
    },
  },
})

/** What a state holds, whichever it is. */
interface Standing extends Held {
  /** Deliveries on their way to the server, in the order they go. */
  readonly flying: ReadonlyArray<Delivery>
}

const NOTHING: Standing = { createdHere: false, taken: [], unsent: [], own: [], flying: [] }

/** One reading of whichever state is active. A machine that has not started holds nothing. */
const standing = (state: Option.Option<SendingState>): Standing =>
  Option.match(state, {
    onNone: () => NOTHING,
    onSome: (at) =>
      Option.getOrElse(
        Option.firstSomeOf([
          Option.map(SendingStates.get(at, 'Idle'), (idle): Standing => ({
            ...heldIn(idle),
            flying: [],
          })),
          Option.map(SendingStates.get(at, 'Creating'), (creating): Standing => ({
            ...heldIn(creating),
            flying: [creating.delivery, ...creating.behind],
          })),
          Option.map(SendingStates.get(at, 'Uncreated'), (uncreated): Standing => ({
            ...heldIn(uncreated),
            unsent: [uncreated.delivery, ...uncreated.behind].map(kept),
            flying: [],
          })),
          Option.map(SendingStates.get(at, 'Sending'), (sending): Standing => ({
            ...heldIn(sending),
            flying: [sending.delivery, ...sending.behind],
          })),
        ]),
        () => NOTHING,
      ),
  })

/**
 * Whether a delivery is with the server and unanswered: nothing more is sent from a composer
 * that takes one delivery at a time (the phone's) until it has been.
 */
export const isWaiting = (state: Option.Option<SendingState>): boolean =>
  Option.exists(
    state,
    (at) => SendingStates.matches(at, 'Sending') || SendingStates.matches(at, 'Creating'),
  )

/**
 * How the send of the delivery under `key` ended, once it has: the server took it (`true`), or
 * it is kept as not sent (`false`). None while it is on its way, or waiting behind another. It
 * is for whatever sent the words and must know (a card that closed on a choice): a screen draws
 * from `drawing`.
 */
export const arrivalOf = (
  state: Option.Option<SendingState>,
  key: string,
): Option.Option<boolean> => {
  return Option.map(admissionOf(state, key), (admitted) =>
    Admission.match(admitted, {
      Accepted: () => true,
      Uncreated: () => false,
      Unanswered: () => false,
    }),
  )
}

/**
 * The id a delivery's words are drawn under: before the conversation has them, and after, for
 * the message that carries the key is drawn under the same id (`drawing`).
 */
export const sentId = (delivery: Pick<Delivery, 'key'>): string => `sent:${delivery.key}`

/** Draw a delivery before conversation state confirms it, including its sent picture bytes.
 * Reuse one object per delivery so unrelated updates do not redraw its row. */
const drawnAhead = new WeakMap<Delivery, ConversationMessage>()
const ahead = (delivery: Delivery): ConversationMessage => {
  const made = drawnAhead.get(delivery)
  if (made !== undefined) return made
  const message: ConversationMessage = {
    id: sentId(delivery),
    role: 'user',
    purpose: 'user',
    display: 'visible',
    key: delivery.key,
    parts: [
      { type: 'text', text: delivery.words, state: 'done' },
      ...delivery.pictures.map((picture) => ({
        type: 'file' as const,
        mediaType: picture.mimeType,
        url: `data:${picture.mimeType};base64,${picture.data}`,
        filename: picture.filename,
      })),
    ],
  }
  drawnAhead.set(delivery, message)
  return message
}

/**
 * A message this client sent, under the id its words were first drawn under. One object per
 * message, so it is the same row for as long as the message is.
 */
const drawnUnder = new WeakMap<ConversationMessage, ReadonlyMap<string, ConversationMessage>>()
const under = (message: ConversationMessage, key: string): ConversationMessage => {
  const copies = drawnUnder.get(message)
  const made = copies === undefined ? undefined : copies.get(key)
  if (made !== undefined) return made
  // A copy with one field replaced; its other fields are the message's own values.
  const renamed: ConversationMessage = Object.assign({}, message, { id: sentId({ key }) })
  drawnUnder.set(message, new Map(copies).set(key, renamed))
  return renamed
}

/** What a Thread draws of its conversation and of what this client sent into it. */
export interface Drawing {
  /** The messages, with this client's own deliveries in them from the moment they are sent. */
  readonly said: ReadonlyArray<ConversationMessage>
  /**
   * What is not known to have arrived, in the order it was written: everything "send again"
   * sends. A screen marks these rows.
   */
  readonly unsent: ReadonlyArray<Unsent>
  /** Whether something this client sent is still owed its place in the conversation. */
  readonly owed: boolean
  /** What this reading has seen of the deliveries held, for the next send to say (`Seen`). */
  readonly seen: Seen
}

/** What `drawing` reads. */
export interface Drawn {
  /** The messages drawn: the conversation's, or on a phone what it kept of them. */
  readonly messages: ReadonlyArray<ConversationMessage>
  /** Whether this reading comes from the live conversation rather than a kept snapshot. */
  readonly live: boolean
  readonly sending: Option.Option<SendingState>
  /** The Thread's Runs, which say whether a delivery the server took has ended. */
  readonly runs: ReadonlyArray<Run>
  /**
   * Whether this client's words are drawn ahead of the conversation. Not in a shared Thread:
   * the server turns the words into a message that says who spoke, and it is drawn when it
   * comes back, as it always was.
   */
  readonly ahead: boolean
}

/**
 * Whether the Run of a delivery the server took can still place its message. A Run the list
 * does not have is either not listed yet or too old to be (the server lists a Thread's newest
 * Runs, `apps/server/src/threads/runs.ts`): it is too old when a Run that began after it is
 * listed. Without that, a delivery whose Run was stopped would be waited for again the day its
 * Run fell off the list.
 */
const pending = (sent: Taken, runs: ReadonlyArray<Run>): boolean =>
  Option.match(Option.fromUndefinedOr(runs.find((run) => run.id === sent.run)), {
    onNone: () => sent.working && !runs.some((run) => run.startedAt > sent.startedAt),
    onSome: (run) => RunState.guards.Working(run.state),
  })

/** The capped Run list's absence cannot release a payload; a receipt or exact Run must say it ended. */
const hasEnded = (sent: Taken, runs: ReadonlyArray<Run>): boolean =>
  !sent.working || runs.some((run) => run.id === sent.run && !RunState.guards.Working(run.state))

/** An admission identifies only its placed input, never its answer or terminal advisory. */
const isInput = (message: ConversationMessage): boolean =>
  message.purpose === 'user' ||
  (message.purpose === 'dispatch' &&
    message.signal !== undefined &&
    message.signal.tagName === 'message')

/** Receipt ownership applies only to placed inputs, including older keyless entries. */
const isSubmission = (message: ConversationMessage, submission: Option.Option<string>): boolean =>
  isInput(message) &&
  message.submissionId !== undefined &&
  Option.contains(submission, message.submissionId)

/**
 * Shared keys identify no Person. A receipt proves a submission; released payloads retain the
 * recognised canonical id. Private input keys can also prove delivery when its receipt was lost.
 */
const echoesOf = (held: Standing, at: Drawn): ReadonlyMap<string, ConversationMessage> => {
  const echoes = new Map<string, ConversationMessage>()
  const used = new Set<string>()
  const remember = (key: string, message: ConversationMessage) => {
    echoes.set(key, message)
    used.add(message.id)
  }
  for (const proof of held.own) {
    const message = at.messages.find((one) =>
      Ownership.match(proof, {
        Placed: ({ message: canonical }) =>
          one.id === canonical || isSubmission(one, proof.submission),
        Admitted: ({ key, submission }) =>
          isSubmission(one, submission) ||
          (at.ahead && one.role === 'user' && one.purpose === 'user' && one.key === key),
      }),
    )
    if (message !== undefined) remember(proof.key, message)
  }
  for (const sent of held.taken) {
    // A later Run query may carry the receipt an earlier accepted response lacked.
    const submission = Option.orElse(sent.submission, () =>
      Option.flatMap(Option.fromUndefinedOr(at.runs.find((run) => run.id === sent.run)), (run) =>
        Option.fromUndefinedOr(run.submissionId),
      ),
    )
    const message = at.messages.find((one) => !used.has(one.id) && isSubmission(one, submission))
    if (message !== undefined) remember(sent.delivery.key, message)
  }
  if (!at.ahead) return echoes
  const deliveries = [
    ...held.taken.map((sent) => sent.delivery),
    ...held.unsent.map((one) => one.delivery),
    ...held.flying,
  ]
  for (const delivery of deliveries) {
    if (echoes.has(delivery.key)) continue
    const message = at.messages.find(
      (one) =>
        !used.has(one.id) &&
        one.role === 'user' &&
        one.purpose === 'user' &&
        one.key === delivery.key,
    )
    if (message !== undefined) remember(delivery.key, message)
  }
  return echoes
}

export const drawing = (at: Drawn): Drawing => {
  const held = standing(at.sending)
  const echoes = echoesOf(held, at)
  const absent = (delivery: Delivery) => !echoes.has(delivery.key)
  const seen: Seen = {
    // A taken input may be withdrawn by Pi's Conversation.abort() before it has an entry
    // (pi-durable 1.2.0 dist/harness/inbox.js, withdrawQueuedInputs), so a terminal Run ends
    // its optimistic row. Only a live conversation can say the message is absent: a kept copy
    // or a link being opened again is older than the Run's end, and reading absence from it
    // made words vanish and come back when the live conversation arrived.
    ended: at.live
      ? held.taken
          .filter((sent) => absent(sent.delivery) && hasEnded(sent, at.runs))
          .map((sent) => sent.delivery.key)
      : [],
    shown: [...echoes].map(([key, message]) => ({
      key,
      message: message.id,
      submission: Option.fromUndefinedOr(message.submissionId),
    })),
  }
  const { taken, unsent } = reconciled(held, seen)
  const going = held.flying.filter(absent)
  const keys = new Map([...echoes].map(([key, message]) => [message.id, key]))
  const said = at.messages.map((message) => {
    const key = keys.get(message.id)
    return key === undefined ? message : under(message, key)
  })
  return {
    said: at.ahead
      ? [
          ...said,
          ...taken.map((sent) => ahead(sent.delivery)),
          ...unsent.map((one) => ahead(one.delivery)),
          ...going.map(ahead),
        ]
      : said,
    unsent,
    // Accepted deliveries never become retry offers, including ones withdrawn before placement.
    owed: going.length > 0 || taken.some((sent) => pending(sent, at.runs)),
    seen,
  }
}

/**
 * Whether Vivid is at work in a Thread: the one rule, for the composer's button and for what
 * says Vivid is thinking, on every surface.
 *
 * - This client sent something that is still owed its place in the conversation
 *   (`Drawing.owed`): Vivid is about to be at work on it.
 * - The conversation says a reply is being written (`ConversationState.working`), whichever
 *   device started it.
 * - The Thread's record says so (`attention`), which is how work is known before the
 *   conversation has been read, and in a Thread whose conversation this client is not following.
 */
export const isWorking = (at: {
  readonly owed: boolean
  readonly conversation: Option.Option<ConversationState>
  readonly attention: Option.Option<ThreadAttention>
}): boolean =>
  at.owed ||
  Option.exists(at.conversation, (state) => state.working) ||
  Option.contains(at.attention, 'Working')

/**
 * One Thread's machine as atoms, made for each Thread the first time it is asked for: `snapshot`
 * to draw from and `send` to send with. An app makes this once from its own `Delivering` and
 * reads it in the registry its live data uses.
 *
 * A Thread's machine is the same object for as long as the app's sending is, so a screen that
 * asks for it at every render is always given the one it has been drawing from. It is kept in a
 * plain `Map` and not weakly. The state atom keeps its machine mounted for the session, so
 * departure, conversation eviction and idle expiry cannot discard queued words or ownership
 * proof. The session's registry disposal or explicit `forget` ends these owners.
 */
export const makeSending = (services: Layer.Layer<Delivering>) => {
  const make = AtomMachine.bind(Atom.runtime(services)).factory(Sending)
  const machines = new Map<ThreadId, ReturnType<typeof make>>()
  const inThread = (thread: ThreadId) => {
    const known = machines.get(thread)
    if (known !== undefined) return known
    const made = make()
    machines.set(thread, made)
    return made
  }
  return Object.assign(inThread, {
    /** Session departure, unlike screen departure, ends every machine and its invoked work. */
    forget: (registry: AtomRegistry.AtomRegistry): void => {
      for (const machine of machines.values()) registry.set(machine.stop, undefined)
      machines.clear()
    },
  })
}
export type SendingAtoms = ReturnType<ReturnType<typeof makeSending>>

/** Each machine's state as an atom, made once for it (`stateOf`). */
const states = new WeakMap<SendingAtoms, Atom.Atom<Option.Option<SendingState>>>()

/**
 * Where one Thread's machine stands, for a screen to draw from: none until the machine has
 * started, which is a moment after it is first read. One atom for one machine, so a screen that
 * reads it is drawn again only when the machine moves.
 */
export const stateOf = (machine: SendingAtoms): Atom.Atom<Option.Option<SendingState>> => {
  const known = states.get(machine)
  if (known !== undefined) return known
  // A session owns unfinished words and recognition proof even after every screen departs.
  const made = Atom.keepAlive(
    Atom.map(machine.snapshot, (result) =>
      AsyncResult.isSuccess(result) && result.value.status === 'active'
        ? Option.some(result.value.state)
        : Option.none(),
    ),
  )
  states.set(machine, made)
  return made
}

/** Something said to a Thread's machine from outside it. */
type Said =
  | ReturnType<typeof SendingEvents.Begin>
  | ReturnType<typeof SendingEvents.Send>
  | ReturnType<typeof SendingEvents.Again>
  | ReturnType<typeof SendingEvents.Stop>

/**
 * Says something to a Thread's machine, once it is there to hear it.
 *
 * A machine runs only while something in the registry holds one of its atoms, and one that has
 * not started takes nothing (`AtomMachine`: a write before startup fails as not ready). Said
 * straight to a machine nothing is reading, words would be dropped without a trace. So the
 * machine is held here for as long as the saying takes: holding it is what starts it, and it is
 * told as soon as it stands somewhere. After that it goes on as any atom nobody reads does, for
 * the registry's idle time, which is what lets a delivery finish when its screen has gone.
 */
const tell = (registry: AtomRegistry.AtomRegistry, machine: SendingAtoms, said: Said): void => {
  const state = stateOf(machine)
  const release = registry.mount(state)
  if (Option.isSome(registry.get(state))) {
    registry.set(machine.send, said)
    release()
    return
  }
  const stop = registry.subscribe(state, (now) => {
    if (Option.isNone(now)) return
    stop()
    registry.set(machine.send, said)
    release()
  })
}

/**
 * Says something new through its Thread's machine (`SendingEvents.Send`). `seen` is what the
 * sender's own reading has seen of the deliveries held (`Drawing.seen`).
 */
export const send = (
  registry: AtomRegistry.AtomRegistry,
  machine: SendingAtoms,
  said: { readonly delivery: Delivery; readonly seen: Seen },
): void => tell(registry, machine, SendingEvents.Send(said))

/** Sends everything that did not arrive again (`SendingEvents.Again`). */
export const sendAgain = (
  registry: AtomRegistry.AtomRegistry,
  machine: SendingAtoms,
  said: { readonly seen: Seen },
): void => tell(registry, machine, SendingEvents.Again(said))

/** Tells a Thread's machine the Person stopped Vivid (`SendingEvents.Stop`). */
export const stopped = (registry: AtomRegistry.AtomRegistry, machine: SendingAtoms): void =>
  tell(registry, machine, SendingEvents.Stop())

/** Begin owns first words before navigation can expose a composer for their Thread. */
export const begin = (
  registry: AtomRegistry.AtomRegistry,
  machine: SendingAtoms,
  first: { readonly creation: CreateThreadRequest; readonly delivery: Delivery },
): void => tell(registry, machine, SendingEvents.Begin(first))

/** Creation succeeded on this client. This fact also survives subsequent sending transitions. */
export const createdHere = (state: Option.Option<SendingState>): boolean =>
  standing(state).createdHere

/** This Thread was begun here and is still behind the creation barrier. */
export const isCreating = (state: Option.Option<SendingState>): boolean =>
  Option.exists(
    state,
    (at) => SendingStates.matches(at, 'Creating') || SendingStates.matches(at, 'Uncreated'),
  )

/** A send's outcome is read from its owner, including a creation barrier that was interrupted. */
const Admission = Schema.TaggedUnion({
  Accepted: { submission: Schema.Option(Schema.String) },
  Unanswered: {},
  Uncreated: { why: Unarrival },
})
type Admission = typeof Admission.Type

/** First-word adapters observe the same admission as composers, rather than issuing another send. */
const admissionOf = (state: Option.Option<SendingState>, key: string): Option.Option<Admission> => {
  const barrier = Option.flatMap(state, (at) => SendingStates.get(at, 'Uncreated'))
  if (
    Option.isSome(barrier) &&
    [barrier.value.delivery, ...barrier.value.behind].some((delivery) => delivery.key === key)
  ) {
    return Option.some(Admission.cases.Uncreated.make({ why: barrier.value.why }))
  }
  const held = standing(state)
  const accepted = held.taken.find((sent) => sent.delivery.key === key)
  if (accepted !== undefined)
    return Option.some(Admission.cases.Accepted.make({ submission: accepted.submission }))
  const recognised = held.own.find((proof) => proof.key === key)
  if (recognised !== undefined)
    return Option.some(Admission.cases.Accepted.make({ submission: recognised.submission }))
  return held.unsent.some((failed) => failed.delivery.key === key)
    ? Option.some(Admission.cases.Unanswered.make({}))
    : Option.none()
}
