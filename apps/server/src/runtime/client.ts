import { Context, Effect, Layer, Match, Option, Redacted, Schema, Stream } from 'effect'
import type * as Scope from 'effect/Scope'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  DocumentToolCallId,
  NotFound,
  ConversationState,
  RuntimeRefusal,
  RuntimeUnavailable,
  RuntimeAdmissionBody,
  RuntimeAdmissionReceipt,
  RuntimeSettlement,
  RuntimeStopped,
  ThreadId,
  type ConversationFrame,
  DeliveryScope,
  MessageAttachment,
  type PersonId,
  RuntimeRunRequest,
  type RuntimeSubmissionId,
  ThreadOrigin,
} from '@vivid/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { findThread } from '../threads/access.ts'
import { runs } from '../threads/tables.ts'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { ServerConfig } from '../config.ts'
import { observeRun, runLossAllowance, settlementOf, Settlement } from './settlement.ts'
import {
  conversationFrames,
  requestRuntime,
  RuntimeTransportFailed,
  type Address,
  type RuntimeFailure,
} from './transport.ts'
export { RuntimeRejected, RuntimeTransportFailed, type RuntimeFailure } from './transport.ts'
export { Settlement } from './settlement.ts'
export const Admission = RuntimeAdmissionReceipt
export type Admission = RuntimeAdmissionReceipt

/** This attempt sent nothing, or received an explicit pre-admission refusal. */
export class AdmissionRefused extends Schema.TaggedError<AdmissionRefused>()(
  'AdmissionRefused',
  {
    threadId: ThreadId,
    reason: Schema.Literals(['Encoding', 'Address', 'Rejected']),
  },
  { title: 'Runtime admission refused' },
) {}

/** The delivery may be held. Only a retry of this exact key can discover its receipt. */
export class AdmissionUncertain extends Schema.TaggedError<AdmissionUncertain>()(
  'AdmissionUncertain',
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      'Transport',
      'TimedOut',
      'Status',
      'Receipt',
      'Unavailable',
      'Interrupted',
    ]),
  },
  { title: 'Runtime admission uncertain' },
) {}

/** Private pictures are ordinary inputs; attributed shared and product deliveries are signals. */
export const RuntimeMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.tag('user'),
    body: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(MessageAttachment)),
  }),
  Schema.Struct({
    kind: Schema.tag('signal'),
    body: Schema.String,
    type: RuntimeRunRequest.fields.type,
    tagName: RuntimeRunRequest.fields.type,
    attributes: RuntimeRunRequest.fields.attributes,
  }),
])
export type RuntimeMessage = typeof RuntimeMessage.Type

/** The admission input lives only in the sending request; PostgreSQL stores just its receipt. */
export const AdmissionInput = Schema.Struct({
  threadId: ThreadId,
  message: RuntimeMessage,
  origin: ThreadOrigin,
  idempotencyKey: Schema.String,
  /** The sending client's own key for a message it sent; the runtime gives it back in the state. */
  clientKey: RuntimeRunRequest.fields.clientKey,
  turn: Schema.Finite,
  scope: DeliveryScope,
})
export type AdmissionInput = typeof AdmissionInput.Type

/** The request stays identical on retry, including its frozen authority and delivery key. */
const admissionBody = (input: AdmissionInput): RuntimeAdmissionBody => {
  const addressed = {
    threadId: input.threadId,
    idempotencyKey: input.idempotencyKey,
    body: input.message.body,
    turn: input.turn,
    scope: input.scope,
    initialData: input.origin,
  }
  // Only a client's send has a key of the client's; a delivery the server made sends none.
  const shared =
    input.clientKey === undefined ? addressed : { ...addressed, clientKey: input.clientKey }
  if (input.message.kind === 'signal')
    return {
      ...shared,
      type: input.message.type,
      attachments: [],
      attributes: input.message.attributes,
    }
  return {
    ...shared,
    type: 'message',
    attachments: input.message.attachments === undefined ? [] : input.message.attachments,
    attributes: {},
  }
}

/** Transport errors cannot prove whether an idempotent delivery reached durable storage. */
const admissionRequestError = (threadId: ThreadId, error: HttpClientError.HttpClientError) =>
  Match.value(error.reason).pipe(
    Match.tagsExhaustive({
      InvalidUrlError: () => AdmissionRefused.make({ threadId, reason: 'Address' }),
      EncodeError: () => AdmissionRefused.make({ threadId, reason: 'Encoding' }),
      TransportError: () => AdmissionUncertain.make({ threadId, reason: 'Transport' }),
      StatusCodeError: () => AdmissionUncertain.make({ threadId, reason: 'Status' }),
      DecodeError: () => AdmissionUncertain.make({ threadId, reason: 'Receipt' }),
      EmptyBodyError: () => AdmissionUncertain.make({ threadId, reason: 'Receipt' }),
    }),
  )

export interface RuntimeService {
  readonly conversation: (
    personId: PersonId,
    threadId: ThreadId,
  ) => Effect.Effect<ConversationState, RuntimeFailure>
  readonly admit: (
    input: AdmissionInput,
  ) => Effect.Effect<Admission, AdmissionRefused | AdmissionUncertain>
  readonly settled: (
    personId: PersonId,
    threadId: ThreadId,
    submissionId: RuntimeSubmissionId,
  ) => Effect.Effect<Settlement>
  readonly stop: (personId: PersonId, threadId: ThreadId) => Effect.Effect<boolean, RuntimeFailure>
  readonly watch: (
    personId: PersonId,
    threadId: ThreadId,
  ) => Stream.Stream<ConversationFrame, RuntimeFailure>
  readonly attachment: (
    personId: PersonId,
    threadId: ThreadId,
    attachmentId: string,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RuntimeFailure, Scope.Scope>
}

/** Only this authority holds runtime credentials; apps receive access-checked product RPCs. */
export class Runtime extends Context.Service<Runtime, RuntimeService>()('vivid/Runtime') {}

interface Transport {
  readonly http: HttpClient.HttpClient
  readonly request: (
    address: Address,
    suffix: string,
    method: 'GET' | 'POST',
  ) => HttpClientRequest.HttpClientRequest
}

/** Admission owns its response through receipt decoding, even after headers arrived. */
const makeAdmit = ({ http, request }: Transport): RuntimeService['admit'] =>
  Effect.fn('Runtime.admit')(
    function* (input) {
      const threadId = input.threadId
      const address = { personId: input.origin.creator, threadId }
      const encoded = yield* HttpClientRequest.schemaBodyJson(RuntimeAdmissionBody)(
        request(address, '', 'POST'),
        admissionBody(input),
      ).pipe(Effect.mapError(() => AdmissionRefused.make({ threadId, reason: 'Encoding' })))
      const response = yield* HttpClient.withScope(http)
        .execute(encoded)
        .pipe(Effect.mapError((error) => admissionRequestError(threadId, error)))
      if (response.status !== 202) {
        const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
          Effect.mapError(() => AdmissionUncertain.make({ threadId, reason: 'Status' })),
        )
        if (refusal.error === 'Unavailable')
          return yield* AdmissionUncertain.make({ threadId, reason: 'Unavailable' })
        return yield* AdmissionRefused.make({ threadId, reason: 'Rejected' })
      }
      return yield* HttpClientResponse.schemaBodyJson(RuntimeAdmissionReceipt)(response).pipe(
        Effect.mapError(() => AdmissionUncertain.make({ threadId, reason: 'Receipt' })),
      )
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: '30 seconds',
          orElse: () =>
            Effect.fail(AdmissionUncertain.make({ threadId: input.threadId, reason: 'TimedOut' })),
        }),
        Effect.scoped,
        Effect.tapErrorTag('AdmissionRefused', ({ reason }) =>
          recordRefusal(Refusal.cases.AdmissionRefused.make({ reason })),
        ),
      ),
  )

/** Capture configuration and HTTP authority once; every finite operation releases its own response. */
const makeRuntime = Effect.fn('Runtime.make')(function* () {
  const config = yield* ServerConfig
  const http = yield* HttpClient.HttpClient
  const token = Redacted.value(config.RUNTIME_TOKEN)
  const lossAllowance = yield* runLossAllowance
  const request: Transport['request'] = (address, suffix, method) =>
    HttpClientRequest.make(method)(
      new URL(
        `/persons/${encodeURIComponent(address.personId)}/threads/${encodeURIComponent(address.threadId)}${suffix}`,
        config.RUNTIME_URL,
      ),
    ).pipe(HttpClientRequest.bearerToken(token))
  /** A finite JSON read is fully scoped; refusal and decode failures are distinct from transport. */
  const conversation: RuntimeService['conversation'] = Effect.fn('Runtime.conversation')(function* (
    personId,
    threadId,
  ) {
    const address = { personId, threadId }
    const response = yield* requestRuntime(
      http,
      request(address, '/state', 'GET').pipe(HttpClientRequest.acceptJson),
      address,
    )
    return yield* HttpClientResponse.schemaBodyJson(ConversationState)(response).pipe(
      Effect.mapError(() => RuntimeTransportFailed.make(address)),
    )
  }, Effect.scoped)
  /** Each pending read waits in Pi, so the server owns no conversation observation state. */
  const settled: RuntimeService['settled'] = (personId, threadId, submissionId) =>
    observeRun(
      Effect.gen(function* () {
        const address = { personId, threadId }
        const response = yield* requestRuntime(
          http,
          request(address, `/submissions/${submissionId}?wait=1`, 'GET'),
          address,
        )
        return yield* HttpClientResponse.schemaBodyJson(RuntimeSettlement)(response).pipe(
          Effect.mapError(() => RuntimeTransportFailed.make(address)),
        )
      }).pipe(
        Effect.scoped,
        Effect.map((value) => settlementOf(value, personId)),
      ),
      lossAllowance,
    )
  /** Product rules decide when abort is permitted, before this adapter touches the runtime. */
  const stop: RuntimeService['stop'] = Effect.fn('Runtime.stop')(function* (personId, threadId) {
    const address = { personId, threadId }
    const response = yield* requestRuntime(http, request(address, '/abort', 'POST'), address)
    return (yield* HttpClientResponse.schemaBodyJson(RuntimeStopped)(response).pipe(
      Effect.mapError(() => RuntimeTransportFailed.make(address)),
    )).aborted
  }, Effect.scoped)
  /** Stream scope stays open through the last frame; interruption closes upstream transport. */
  const watch: RuntimeService['watch'] = (personId, threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const address = { personId, threadId }
        const response = yield* requestRuntime(
          http,
          request(address, '/state', 'GET').pipe(
            HttpClientRequest.setHeader('accept', 'text/event-stream'),
          ),
          address,
        )
        return conversationFrames(response, address)
      }),
    )
  /** Bytes stay streamed under the caller's scope, which also owns the access watcher. */
  const attachment: RuntimeService['attachment'] = (personId, threadId, attachmentId) => {
    const address = { personId, threadId }
    return requestRuntime(
      http,
      request(address, `/attachments/${encodeURIComponent(attachmentId)}`, 'GET'),
      address,
    )
  }
  return Runtime.of({
    conversation,
    admit: makeAdmit({ http, request }),
    settled,
    stop,
    watch,
    attachment,
  })
})

export const runtimeLayer = Layer.effect(Runtime, makeRuntime())

/** Correlate Pi's durable tool call to the exact product Run through its stored admission receipt. */
export const documentRun = Effect.fn('Runtime.documentRun')(function* (
  threadId: ThreadId,
  toolCallId: DocumentToolCallId,
) {
  const thread = yield* findThread(threadId)
  if (Option.isNone(thread)) return yield* new NotFound({ message: 'Document Thread not found' })
  const state = yield* (yield* Runtime)
    .conversation(thread.value.personId, threadId)
    .pipe(
      Effect.mapError(
        () => new RuntimeUnavailable({ message: 'Document response could not be read' }),
      ),
    )
  const matches = state.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some(
        (part) =>
          part.type === 'dynamic-tool' &&
          part.toolName === 'write_document' &&
          part.toolCallId === toolCallId,
      ),
  )
  const [message] = matches
  if (matches.length !== 1 || message === undefined || message.submissionId === undefined)
    return yield* new NotFound({ message: 'Document response not found' })
  const database = yield* Database
  const recorded = yield* database.run(
    database
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.threadId, threadId),
          sql`${runs.receipt}->>'submissionId' = ${message.submissionId}`,
        ),
      ),
  )
  const [run] = recorded
  if (recorded.length !== 1 || run === undefined)
    return yield* new NotFound({ message: 'Document Run not found' })
  return run.id
})
