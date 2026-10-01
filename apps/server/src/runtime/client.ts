import {
  createFlueClient,
  FlueExecutionError,
  type DeliveredMessage,
  type FlueExecutionFailure,
} from '@flue/sdk'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { RunId, type ThreadId, type ThreadOrigin } from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'

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
 * How a Run ended, as far as Flue can say. `Unknown` is what remains when the runtime cannot be
 * reached or never reports an ending: the work may or may not have happened, and nothing is
 * retried on its account.
 */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String },
  Failed: {},
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type

/** One read of a Thread's conversation, forwarded as the client sent it. */
export interface ConversationRead {
  readonly threadId: ThreadId
  /** `''`, or `/attachments/<id>`. */
  readonly suffix: string
  readonly search: string
  readonly accept: string
}

export interface RuntimeService {
  /** Puts one message in front of Vivid. Flue decides whether it starts a response or joins one. */
  readonly admit: (input: {
    readonly threadId: ThreadId
    readonly message: DeliveredMessage
    readonly origin: ThreadOrigin
    readonly idempotencyKey: string
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

/** How Flue's own verdict on a submission maps to an ending. Only its verdicts can be named. */
const endingOf = (failure: FlueExecutionFailure): Settlement => {
  if (failure === 'aborted') return Settlement.cases.Stopped.make({})
  if (failure === 'failed') return Settlement.cases.Failed.make({})
  return Settlement.cases.Unknown.make({})
}

const makeRuntime = Effect.fn('Runtime.make')(function* () {
  const config = yield* ServerConfig
  const http = yield* HttpClient.HttpClient
  const token = Redacted.value(config.RUNTIME_TOKEN)
  const conversationUrl = (threadId: ThreadId) =>
    new URL(`/agents/vivid/${encodeURIComponent(threadId)}`, config.RUNTIME_URL)
  const flue = (threadId: ThreadId) =>
    createFlueClient({ url: conversationUrl(threadId).href, token })

  const admit: RuntimeService['admit'] = Effect.fn('Runtime.admit')(function* (input) {
    const receipt = yield* Effect.tryPromise({
      try: (signal) =>
        flue(input.threadId).send({
          message: input.message,
          initialData: input.origin,
          idempotencyKey: input.idempotencyKey,
          signal,
        }),
      catch: unavailable('Vivid could not be reached'),
    })
    return Admission.make({
      runId: RunId.make(receipt.submissionId),
      offset: receipt.offset,
      incarnation: receipt.uid,
      repeated: receipt.deduplicated === true,
    })
  })

  const settled: RuntimeService['settled'] = Effect.fn('Runtime.settled')(
    function* (threadId, runId) {
      return yield* Effect.tryPromise({
        try: (signal) => flue(threadId).read(runId, { signal }),
        catch: (error) =>
          error instanceof FlueExecutionError
            ? endingOf(error.failure)
            : Settlement.cases.Unknown.make({}),
      }).pipe(
        Effect.map((reply) => Settlement.cases.Completed.make({ reply: reply.text })),
        Effect.catch((settlement) => Effect.succeed(settlement)),
      )
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
