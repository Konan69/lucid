import { createFlueClient } from '@flue/sdk'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  RunId,
  RuntimeRunRequest,
  ThreadOrigin as ThreadOriginSchema,
  type DeliveryScope,
  type ThreadId,
  type ThreadOrigin,
} from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'
import { submissionId } from './identity.ts'
import { observeRun, type Settlement } from './settlement.ts'
export { Settlement } from './settlement.ts'

/** Decode the installed Flue 2.1 admission wire response rather than trusting network JSON. */
const Receipt = Schema.Struct({
  submissionId: Schema.String,
  offset: Schema.String,
  uid: Schema.String,
  deduplicated: Schema.optionalKey(Schema.Boolean),
})

const encodeRunRequest = Schema.encodeSync(RuntimeRunRequest)
const encodeThreadOrigin = Schema.encodeSync(ThreadOriginSchema)
const decodeReceipt = HttpClientResponse.schemaBodyJson(Receipt)

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
  | { readonly kind: 'user'; readonly body: string }
  | {
      readonly kind: 'signal'
      readonly body: string
      readonly type: RuntimeRunRequest['type']
      readonly tagName: RuntimeRunRequest['type']
      readonly attributes: RuntimeRunRequest['attributes']
    }

export interface RuntimeService {
  /** Puts one message in front of Vivid. Flue decides whether it starts a response or joins one. */
  readonly admit: (input: {
    readonly threadId: ThreadId
    readonly message: RuntimeMessage
    readonly origin: ThreadOrigin
    readonly idempotencyKey: string
    readonly turn: number
    readonly scope: DeliveryScope
  }) => Effect.Effect<Admission, RuntimeUnavailable>
  /** Waits for a Run to end and says how. It never fails; what cannot be told is `Unknown`. */
  readonly settled: (threadId: ThreadId, runId: RunId) => Effect.Effect<Settlement>
  /** Stops whatever is in progress in a Thread. False when nothing was. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<boolean, RuntimeUnavailable>
  /** Forwards a history, updates or attachment read and hands back Flue's response as it comes. */
  readonly read: (
    read: ConversationRead,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RuntimeUnavailable>
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
 * answers, which is three calls back to this server, so the bound is generous; past it the
 * delivery fails as unreachable and its caller decides whether to try again.
 */
const ADMIT_WITHIN = '30 seconds'

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

  const admit: RuntimeService['admit'] = Effect.fn('Runtime.admit')(function* (input) {
    const payload = RuntimeRunRequest.make({
      threadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      type: input.message.kind === 'user' ? 'message' : input.message.type,
      body: input.message.body,
      attributes: input.message.kind === 'user' ? {} : input.message.attributes,
      turn: input.turn,
      scope: input.scope,
    })
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(conversationUrl(input.threadId)).pipe(
        HttpClientRequest.bearerToken(token),
      ),
      {
        ...encodeRunRequest(payload),
        initialData: encodeThreadOrigin(input.origin),
      },
    ).pipe(Effect.mapError(unavailable('Vivid request could not be encoded')))
    // Admission queues the work and answers; it does not wait for the answer itself. A runtime
    // that accepts the connection and then says nothing would otherwise hold the delivery (and
    // the Person's message with it) for as long as the socket stayed open.
    const response = yield* http.execute(request).pipe(
      Effect.mapError(unavailable('Vivid could not be reached')),
      Effect.timeoutOrElse({
        duration: ADMIT_WITHIN,
        orElse: () => Effect.fail(unavailable('Vivid did not answer in time')()),
      }),
    )
    const receipt = yield* decodeReceipt(response).pipe(
      Effect.mapError(unavailable('Vivid returned an invalid receipt')),
    )
    if (receipt.submissionId !== submissionId(input.threadId, input.idempotencyKey)) {
      return yield* Effect.fail(unavailable('Flue keyed-submission wire format changed')())
    }
    return Admission.make({
      runId: RunId.make(receipt.submissionId),
      offset: receipt.offset,
      incarnation: receipt.uid,
      repeated: receipt.deduplicated === true,
    })
  })

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
    return yield* http
      .execute(request)
      .pipe(Effect.mapError(unavailable('Vivid could not be reached')))
  })

  return Runtime.of({ admit, settled, stop, read })
})

export const runtimeLayer = Layer.effect(Runtime, makeRuntime())
