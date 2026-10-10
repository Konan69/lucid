import { createFlueClient } from '@flue/sdk'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  RunId,
  RuntimeAdmissionBody,
  ThreadId,
  type DeliveryScope,
  type MessageAttachment,
  type RuntimeRunRequest,
  type ThreadOrigin,
} from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { ServerConfig } from '../config.ts'
import { submissionId } from './identity.ts'
import { observeRun, type Settlement } from './settlement.ts'
export { Settlement } from './settlement.ts'

/** Decode the installed Flue 2.2.2 admission wire response rather than trusting network JSON. */
const Receipt = Schema.Struct({
  submissionId: Schema.String,
  offset: Schema.String,
  uid: Schema.String,
  deduplicated: Schema.optionalKey(Schema.Boolean),
})

/**
 * Flue 2.2.2's error envelope (installed `@flue/runtime` errors module, `FlueHttpError`): every
 * rejection is `{ error: { type, message, ... } }`. Only `type` is read, and only on a 409.
 */
const Rejection = Schema.Struct({ error: Schema.Struct({ type: Schema.String }) })

/**
 * Effect rc.116 `HttpClientRequest.schemaBodyJson` encodes through the schema's JSON codec and
 * returns `HttpBodyError` for a schema issue or a `JSON.stringify` failure. Nothing on the
 * admission path constructs or encodes with a throwing call, so a bad request is a typed refusal.
 */
const encodeAdmission = HttpClientRequest.schemaBodyJson(RuntimeAdmissionBody)
const decodeReceipt = HttpClientResponse.schemaBodyJson(Receipt)
const decodeRejection = HttpClientResponse.schemaBodyJson(Rejection)

/** Flue's receipt for one accepted message. `offset` is where its events begin in the stream. */
export const Admission = Schema.Struct({
  runId: RunId,
  offset: Schema.String,
  /** The conversation's incarnation, which a client quotes to keep talking to the same one. */
  incarnation: Schema.String,
  /** True when the idempotency key matched a message Flue had already accepted. */
  repeated: Schema.Boolean,
})
export interface Admission extends Schema.Schema.Type<typeof Admission> {}

/**
 * This request sent nothing, or was rejected before admitting new durable work. An earlier
 * uncertain attempt with this same key may still exist; refusal describes only this attempt.
 */
export class AdmissionRefused extends Schema.TaggedError<AdmissionRefused>()(
  'AdmissionRefused',
  {
    threadId: ThreadId,
    /** The Run this request would have started: the id Flue derives from the Thread and key. */
    runId: RunId,
    reason: Schema.Literals(['Encoding', 'Address', 'Rejected']),
  },
  { title: 'Runtime admission refused' },
) {}

/**
 * A request may already be durable; lost transport or receipt evidence cannot prove refusal.
 *
 * `Conflict`: Flue rejected this request because the key already names a different persisted
 * input. That is not a refusal of the Run and not proof that this request's input is held: the
 * stored input may be an earlier attempt of the same Run. The answer is deterministic for a frozen
 * request, so sending it again cannot change it.
 */
export class AdmissionUncertain extends Schema.TaggedError<AdmissionUncertain>()(
  'AdmissionUncertain',
  {
    threadId: ThreadId,
    /** The Run whose admission cannot be told: the id Flue derives from the Thread and key. */
    runId: RunId,
    reason: Schema.Literals(['Transport', 'TimedOut', 'Status', 'Conflict', 'Receipt']),
  },
  { title: 'Runtime admission uncertain' },
) {}

/** Which admission attempt an error describes. Both ids are known before anything is sent. */
interface Attempt {
  readonly threadId: ThreadId
  readonly runId: RunId
}

// Flue 2.2.2 rejects 400/404/405/415 before admission; runtime requireRuntimeToken rejects 401.
const isRefusedStatus = Schema.is(Schema.Literals([400, 401, 404, 405, 415]))

/** Other statuses, including 500/503, say nothing reliable about durable admission. */
const admissionStatus = (attempt: Attempt, status: number) =>
  isRefusedStatus(status)
    ? AdmissionRefused.make({ ...attempt, reason: 'Rejected' })
    : AdmissionUncertain.make({ ...attempt, reason: 'Status' })

/**
 * Flue 2.2.2 answers 409 with `submission_conflict` (`SubmissionConflictError`) when the key's
 * stored submission has a different identity; it also uses 409 for other conflicts. The body is
 * read and decoded once. Only the named type is `Conflict`; a different type, a missing type, a
 * body that is not JSON and a body that cannot be read are all an unexplained 409, which is
 * `Status`. Neither proves this Run was refused.
 */
const admissionConflict = (attempt: Attempt, response: HttpClientResponse.HttpClientResponse) =>
  decodeRejection(response).pipe(
    Effect.match({
      onFailure: () => AdmissionUncertain.make({ ...attempt, reason: 'Status' }),
      onSuccess: ({ error }) =>
        AdmissionUncertain.make({
          ...attempt,
          reason: error.type === 'submission_conflict' ? 'Conflict' : 'Status',
        }),
    }),
  )

/**
 * Effect rc.116 HttpClient.make rejects InvalidUrlError before dispatch; EncodeError is also
 * pre-send. NodeHttpClient.makeUndici wraps every dispatcher.request rejection as TransportError,
 * even after bytes left, so inspecting a cause code would invent evidence of refusal.
 */
const admissionRequestError = (attempt: Attempt, error: HttpClientError.HttpClientError) =>
  Match.value(error.reason).pipe(
    Match.tagsExhaustive({
      InvalidUrlError: () => AdmissionRefused.make({ ...attempt, reason: 'Address' }),
      EncodeError: () => AdmissionRefused.make({ ...attempt, reason: 'Encoding' }),
      TransportError: () => AdmissionUncertain.make({ ...attempt, reason: 'Transport' }),
      StatusCodeError: ({ response }) => admissionStatus(attempt, response.status),
      DecodeError: () => AdmissionUncertain.make({ ...attempt, reason: 'Receipt' }),
      EmptyBodyError: () => AdmissionUncertain.make({ ...attempt, reason: 'Receipt' }),
    }),
  )

/** One read of a Thread's conversation, forwarded as the client sent it. */
export interface ConversationRead {
  readonly threadId: ThreadId
  /** `''`, or `/attachments/<id>`. */
  readonly suffix: string
  readonly search: string
  readonly accept: string
}

/** Only the two server-built deliveries can cross this boundary; signal kinds stay contract-typed. */
export type RuntimeMessage =
  | {
      readonly kind: 'user'
      readonly body: string
      readonly attachments?: ReadonlyArray<MessageAttachment>
    }
  | {
      readonly kind: 'signal'
      readonly body: string
      readonly type: RuntimeRunRequest['type']
      readonly tagName: RuntimeRunRequest['type']
      readonly attributes: RuntimeRunRequest['attributes']
    }

/** One delivery for the runtime to accept, in the server's terms. */
interface AdmissionInput {
  readonly threadId: ThreadId
  readonly message: RuntimeMessage
  readonly origin: ThreadOrigin
  readonly idempotencyKey: string
  readonly turn: number
  readonly scope: DeliveryScope
}

/** The Run a delivery names. Flue derives the same id from the same Thread and key. */
const attemptOf = (input: AdmissionInput): Attempt => ({
  threadId: input.threadId,
  runId: submissionId(input.threadId, input.idempotencyKey),
})

/**
 * The wire body for each kind of delivery. Pictures stay on ordinary user messages; Flue signals
 * cannot carry attachments. This is an unchecked value: `encodeAdmission` validates it, so no
 * throwing constructor runs here.
 */
const admissionBody = (input: AdmissionInput): RuntimeAdmissionBody => {
  const shared = {
    threadId: input.threadId,
    idempotencyKey: input.idempotencyKey,
    body: input.message.body,
    turn: input.turn,
    scope: input.scope,
    initialData: input.origin,
  }
  if (input.message.kind === 'signal')
    return {
      ...shared,
      type: input.message.type,
      attachments: [],
      attributes: input.message.attributes,
    }
  // A message without pictures has always gone out with an empty list, never without the key.
  const { attachments } = input.message
  return {
    ...shared,
    type: 'message',
    attachments: attachments === undefined ? [] : attachments,
    attributes: {},
  }
}

export interface RuntimeService {
  /** Puts one message in front of Vivid. Flue decides whether it starts a response or joins one. */
  readonly admit: (
    input: AdmissionInput,
  ) => Effect.Effect<Admission, AdmissionRefused | AdmissionUncertain>
  /** Waits for a Run to end and says how. It never fails; what cannot be told is `Unknown`. */
  readonly settled: (threadId: ThreadId, runId: RunId) => Effect.Effect<Settlement>
  /** Stops whatever is in progress in a Thread. False when nothing was. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<boolean, RuntimeUnavailable>
  /** Forwards a history, updates or attachment read and hands back Flue's response as it comes. */
  readonly read: (
    read: ConversationRead,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RuntimeUnavailable, Scope.Scope>
}

/**
 * The application server's authority over the conversation runtime.
 *
 * Flue owns the conversation: its transport, its durable history, the model and the lifecycle of a
 * response. This is the only module that speaks to it and the only holder of the runtime token, so
 * no browser, phone or desktop app ever reaches Flue except through the server's own access check
 * (`threads/gateway.ts`).
 *
 * The Flue client is Promise-based; each call is wrapped once, here, and nowhere else.
 */
export class Runtime extends Context.Service<Runtime, RuntimeService>()('vivid/Runtime') {}

const unavailable = (message: string) => () => new RuntimeUnavailable({ message })

/**
 * How long the runtime has to accept a delivery. It reads the acting Person's context before it
 * answers, which is three calls back to this server, so the bound is generous. It includes the
 * receipt body: after it passes admission is uncertain, even if response headers already arrived.
 */
const ADMIT_WITHIN = '30 seconds'

/** Capture transport and credential authority once; each finite admission owns its own response scope. */
const makeRuntime = Effect.fn('Runtime.make')(function* () {
  const config = yield* ServerConfig
  const http = yield* HttpClient.HttpClient
  const token = Redacted.value(config.RUNTIME_TOKEN)
  const firstTokenMillis = yield* Config.schema(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
    'VIVID_RUN_FIRST_TOKEN_TIMEOUT_MS',
  ).pipe(Config.withDefault(90_000))
  const conversationUrl = (threadId: ThreadId) =>
    new URL(`/agents/vivid/${encodeURIComponent(threadId)}`, config.RUNTIME_URL)
  const flue = (threadId: ThreadId) =>
    createFlueClient({ url: conversationUrl(threadId).href, token })

  const admit: RuntimeService['admit'] = Effect.fn('Runtime.admit')(
    function* (input: AdmissionInput) {
      const attempt = attemptOf(input)
      const request = yield* encodeAdmission(
        HttpClientRequest.post(conversationUrl(input.threadId)).pipe(
          HttpClientRequest.bearerToken(token),
        ),
        admissionBody(input),
      ).pipe(Effect.mapError(() => AdmissionRefused.make({ ...attempt, reason: 'Encoding' })))
      // Effect rc.116 HttpClient.withScope registers controller.abort at scope close. The complete
      // finite admission owns this scope, including statuses whose response body is never pulled.
      const response = yield* HttpClient.withScope(http)
        .execute(request)
        .pipe(Effect.mapError((error) => admissionRequestError(attempt, error)))
      if (response.status === 409) {
        return yield* Effect.flatMap(admissionConflict(attempt, response), Effect.fail)
      }
      if (response.status !== 202) {
        return yield* admissionStatus(attempt, response.status)
      }
      const receipt = yield* decodeReceipt(response).pipe(
        Effect.mapError(() => AdmissionUncertain.make({ ...attempt, reason: 'Receipt' })),
        Effect.tapError(() =>
          Effect.logError('Vivid returned an invalid admission receipt', {
            threadId: input.threadId,
          }),
        ),
      )
      if (receipt.submissionId !== attempt.runId) {
        yield* Effect.logError('Flue keyed-submission wire format changed', {
          threadId: input.threadId,
        })
        return yield* AdmissionUncertain.make({ ...attempt, reason: 'Receipt' })
      }
      return Admission.make({
        runId: attempt.runId,
        offset: receipt.offset,
        incarnation: receipt.uid,
        repeated: receipt.deduplicated === true,
      })
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: ADMIT_WITHIN,
          orElse: () =>
            Effect.fail(AdmissionUncertain.make({ ...attemptOf(input), reason: 'TimedOut' })),
        }),
        Effect.scoped,
        // Admission classifies refusal here; delivery retries and outward failures only carry it.
        Effect.tapErrorTag('AdmissionRefused', ({ reason }) =>
          recordRefusal(Refusal.cases.AdmissionRefused.make({ reason })),
        ),
      ),
  )

  const settled: RuntimeService['settled'] = Effect.fn('Runtime.settled')(
    function* (threadId, runId) {
      return yield* observeRun(flue(threadId), runId, firstTokenMillis)
    },
  )

  const stop: RuntimeService['stop'] = Effect.fn('Runtime.stop')(function* (threadId) {
    const result = yield* Effect.tryPromise({
      try: (signal) => flue(threadId).abort({ signal }),
      catch: unavailable('Vivid could not be reached'),
    })
    return result.aborted
  })

  const read: RuntimeService['read'] = Effect.fn('Runtime.read')(function* (input) {
    const url = conversationUrl(input.threadId)
    url.pathname = `${url.pathname}${input.suffix}`
    url.search = input.search
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader('accept', input.accept),
    )
    // Effect's public scoped client aborts even a response whose body is refused before pulling.
    // Gateway requests retain this scope through their outgoing body; finite history callers
    // scope the complete read and decode together, including non-success responses.
    return yield* HttpClient.withScope(http)
      .execute(request)
      .pipe(Effect.mapError(unavailable('Vivid could not be reached')))
  })

  return Runtime.of({ admit, settled, stop, read })
})

export const runtimeLayer = Layer.effect(Runtime, makeRuntime())
