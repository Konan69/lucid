import { and, eq, sql } from 'drizzle-orm'
import { Context, Effect, Layer, Match, Option, Predicate, Redacted, Schema, Stream } from 'effect'
import * as Schedule from 'effect/Schedule'
import type * as Scope from 'effect/Scope'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpBody from 'effect/http/HttpBody'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  causeAfter,
  CONTRACT_HEADER,
  ConversationState,
  Conflict,
  IncidentCause,
  incidentHop,
  type Issue,
  issuesOf,
  MemoryAddress,
  MemoryClosed,
  MemoryClosure,
  MemoryConflict,
  MemoryIndex,
  MemoryListing,
  MemoryPage,
  MemoryRetraction,
  MemoryWrite,
  SavedMemory,
  ServiceUnavailable,
  DocumentToolCallId,
  NotFound,
  RunId,
  ThreadId,
  RuntimeRefusal,
  RuntimeAdmissionBody,
  RuntimeAdmissionReceipt,
  RuntimeSettlement,
  RuntimeStopped,
  RuntimeUnavailable,
  RuntimeChildAnswer,
  RuntimeChildMessage,
  RuntimeChildMessaged,
  type ConversationFrame,
  type DeliveryScope,
  type RuntimeDelivery,
  type PersonId,
  type ThreadOrigin,
} from '@vivid/contracts'
import { contractFingerprint } from '@vivid/contracts/fingerprint'
import { ServerConfig } from '../config.ts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { findThread } from '../threads/access.ts'
import { Admitted } from '../threads/conversation.ts'
import { runs } from '../threads/tables.ts'
import { deliveryRunId } from '../threads/key.ts'
import {
  cellNodes,
  conversationFrames,
  requestRuntime,
  RuntimeRejected,
  RuntimeTransportFailed,
  type Address,
} from './transport.ts'
import {
  lostHere,
  observeRun,
  settlementOf,
  type Settlement,
  type SettlementLost,
} from './settlement.ts'
export { Settlement, SettlementLost } from './settlement.ts'

/** The runtime receipt also names the product reservation known before admission. */
export const Admission = Schema.Struct({ ...Admitted.fields, repeated: Schema.Boolean })
export interface Admission extends Schema.Schema.Type<typeof Admission> {}

/**
 * This request sent nothing, or was rejected before admitting new durable work. An earlier
 * uncertain attempt with this same key may still exist; refusal describes only this attempt.
 *
 * `reason` is what the server does about it; `cause` is why. For `Encoding` and `Address` it is
 * one server hop, `Runtime.admit` with the `HttpClientError` reason's tag (`EncodeError`,
 * `InvalidUrlError`). For `Rejected` it is the server hop (`Runtime.admit`, `RuntimeRejected`,
 * the status the cell answered) followed by the cell's chain from `RuntimeRefusal.cause`. A
 * refusal is never renamed `RuntimeUnavailable`: that tag is for a runtime that could not be
 * reached, and a caller that replaces this error keeps `cause` (the keep-cause rule).
 */
export class AdmissionRefused extends Schema.TaggedError<AdmissionRefused>()(
  'AdmissionRefused',
  {
    threadId: ThreadId,
    /** The Run this request would have started: the product id derived from the Thread and key. */
    runId: RunId,
    reason: Schema.Literals(['Encoding', 'Address', 'Rejected']),
    cause: IncidentCause,
  },
  { title: 'Runtime admission refused' },
) {}

/** Transport or invalid receipt evidence cannot prove whether this keyed request is already durable. */
export class AdmissionUncertain extends Schema.TaggedError<AdmissionUncertain>()(
  'AdmissionUncertain',
  {
    threadId: ThreadId,
    /** The Run whose admission cannot be told: the product id derived from the Thread and key. */
    runId: RunId,
    reason: Schema.Literals(['Transport', 'Status', 'Receipt']),
    /** Why it cannot be told: the server's hop, then the cell's chain when the cell answered. */
    cause: IncidentCause,
  },
  { title: 'Runtime admission uncertain' },
) {}

/** One read of a Thread's conversation, forwarded as the client sent it. */
interface ConversationRead {
  readonly threadId: ThreadId
  /** `''`, or `/attachments/<id>`. */
  readonly suffix: string
}

/** One delivery for the runtime to accept, in the server's terms. */
interface AdmissionInput {
  readonly threadId: ThreadId
  readonly message: RuntimeDelivery
  readonly origin: ThreadOrigin
  readonly clientKey?: string
  readonly idempotencyKey: string
  readonly turn: number
  readonly scope: DeliveryScope
}

/** The request stays identical on retry, including its frozen authority and delivery key. */
const admissionBody = (input: AdmissionInput): RuntimeAdmissionBody => {
  const addressed = {
    threadId: input.threadId,
    idempotencyKey: input.idempotencyKey,
    delivery: input.message,
    turn: input.turn,
    scope: input.scope,
    initialData: input.origin,
  }
  // Only a client's send has a key of the client's; a delivery the server made sends none.
  return input.clientKey === undefined ? addressed : { ...addressed, clientKey: input.clientKey }
}

/** Every way a call to the cells fails before or instead of a typed answer. */
type CellFailure =
  | HttpClientError.HttpClientError
  | HttpBody.HttpBodyError
  | Schema.SchemaError
  | RuntimeTransportFailed
  | RuntimeRejected
  | DatabaseInfrastructureError

/**
 * The cause of a failed call to the cells, with the server's hop first (the keep-cause rule on
 * `IncidentCause`). A `RuntimeRejected` carries the cell's own chain, which follows the hop; an
 * HTTP client or body error is named by its reason's tag; a decode failure names its fields.
 * `status` is the status the cell answered, when it answered.
 */
const causeOf = (
  operation: string,
  error: CellFailure,
  status: Option.Option<number>,
): IncidentCause => {
  const hop = (tag: string, issues: ReadonlyArray<Issue>) =>
    incidentHop({ service: 'server', operation, tag, status, issues })
  if (error instanceof RuntimeRejected) return causeAfter(hop(error._tag, []), error.refusal.cause)
  if (error instanceof HttpClientError.HttpClientError) return [hop(error.reason._tag, [])]
  if (error instanceof Schema.SchemaError) return [hop(error._tag, issuesOf(error.issue))]
  if (error._tag === 'HttpBodyError')
    return error.reason._tag === 'SchemaError'
      ? [hop(error.reason._tag, issuesOf(error.reason.issue))]
      : [hop(error.reason._tag, [])]
  return [hop(error._tag, [])]
}

/** Transport errors cannot prove whether an idempotent delivery reached durable storage. */
const admissionRequestError = (
  attempt: { threadId: ThreadId; runId: import('@vivid/contracts').RunId },
  error: HttpClientError.HttpClientError,
) => {
  const cause = causeOf('Runtime.admit', error, Option.none())
  return Match.value(error.reason).pipe(
    Match.tagsExhaustive({
      InvalidUrlError: () => AdmissionRefused.make({ ...attempt, reason: 'Address', cause }),
      EncodeError: () => AdmissionRefused.make({ ...attempt, reason: 'Encoding', cause }),
      TransportError: () => AdmissionUncertain.make({ ...attempt, reason: 'Transport', cause }),
      StatusCodeError: () => AdmissionUncertain.make({ ...attempt, reason: 'Status', cause }),
      DecodeError: () => AdmissionUncertain.make({ ...attempt, reason: 'Receipt', cause }),
      EmptyBodyError: () => AdmissionUncertain.make({ ...attempt, reason: 'Receipt', cause }),
    }),
  )
}

export interface RuntimeService {
  readonly admit: (
    input: AdmissionInput,
  ) => Effect.Effect<Admission, AdmissionRefused | AdmissionUncertain>
  readonly settled: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<Settlement, DatabaseInfrastructureError | SettlementLost>
  readonly stop: (threadId: ThreadId) => Effect.Effect<boolean, RuntimeUnavailable>
  /** How one helper's work stands in the runtime, with its answer once it ended. */
  readonly child: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<RuntimeChildAnswer, RuntimeUnavailable>
  /** Aborts one helper's work and answers once it ended; false when there was none to abort. */
  readonly stopChild: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, RuntimeUnavailable>
  /** Starts one helper's next round in its own conversation; a repeat of a round starts nothing. */
  readonly messageChild: (
    threadId: ThreadId,
    runId: RunId,
    message: RuntimeChildMessage,
  ) => Effect.Effect<RuntimeChildMessaged, RuntimeUnavailable>
  readonly read: (
    read: ConversationRead,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, RuntimeUnavailable, Scope.Scope>
  readonly watch: (
    personId: PersonId,
    threadId: ThreadId,
  ) => Stream.Stream<
    ConversationFrame,
    RuntimeUnavailable | import('@vivid/contracts').ConversationTooLarge
  >
}

/** Only this server authority holds runtime credentials. The Person in each address owns the Thread. */
export class Runtime extends Context.Service<Runtime, RuntimeService>()('vivid/Runtime') {}

interface Transport {
  readonly http: ReturnType<typeof cellNodes>
  readonly request: (
    address: Address,
    suffix: string,
    method: 'GET' | 'POST',
  ) => HttpClientRequest.HttpClientRequest
}

/** The runtime could not be reached or answered nothing usable in `operation`, because of `error`. */
const unavailable = (operation: string) => (error: CellFailure) =>
  RuntimeUnavailable.make({
    message: 'Vivid could not be reached',
    cause: causeOf(operation, error, Option.none()),
  })
const transportFailed = (address: Address) => () => RuntimeTransportFailed.make(address)
const decodeReceipt = decodeStored(Admitted, 'Run admission receipt')

/**
 * Admission owns its response through receipt decoding, even after headers arrived. The request
 * carries this server's contract fingerprint, so a cell that cannot read the body can say the
 * two were built from different schemas (`ContractMismatch`) rather than only that it was invalid.
 */
const makeAdmit = ({ http, request }: Transport): RuntimeService['admit'] =>
  Effect.fn('Runtime.admit')(
    function* (input) {
      const threadId = input.threadId
      const attempt = { threadId, runId: deliveryRunId(threadId, input.idempotencyKey) }
      const address = { personId: input.origin.creator, threadId }
      const encoded = yield* HttpClientRequest.schemaBodyJson(RuntimeAdmissionBody)(
        request(address, '', 'POST').pipe(
          HttpClientRequest.setHeader(CONTRACT_HEADER, contractFingerprint),
        ),
        admissionBody(input),
      ).pipe(
        Effect.mapError((error) =>
          AdmissionRefused.make({
            ...attempt,
            reason: 'Encoding',
            cause: causeOf('Runtime.admit', error, Option.none()),
          }),
        ),
      )
      const response = yield* HttpClient.withScope(http)
        .execute(encoded)
        .pipe(Effect.mapError((error) => admissionRequestError(attempt, error)))
      const answered = Option.some(response.status)
      if (response.status !== 202) {
        // A body that is not a refusal (a Worker of another build answers one without a cause)
        // names its missing fields here, at the status it came with.
        const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
          Effect.mapError((error) =>
            AdmissionUncertain.make({
              ...attempt,
              reason: 'Status',
              cause: causeOf('Runtime.admit', error, answered),
            }),
          ),
        )
        const cause = causeAfter(
          incidentHop({
            service: 'server',
            operation: 'Runtime.admit',
            tag: 'RuntimeRejected',
            status: answered,
            issues: [],
          }),
          refusal.cause,
        )
        if (refusal.error === 'Unavailable')
          return yield* AdmissionUncertain.make({ ...attempt, reason: 'Transport', cause })
        return yield* AdmissionRefused.make({ ...attempt, reason: 'Rejected', cause })
      }
      const receipt = yield* HttpClientResponse.schemaBodyJson(RuntimeAdmissionReceipt)(
        response,
      ).pipe(
        Effect.mapError((error) =>
          AdmissionUncertain.make({
            ...attempt,
            reason: 'Receipt',
            cause: causeOf('Runtime.admit', error, answered),
          }),
        ),
      )
      return {
        runId: attempt.runId,
        submissionId: receipt.submissionId,
        repeated: receipt.repeated,
      }
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.tapErrorTag('AdmissionRefused', ({ reason }) =>
          recordRefusal(Refusal.cases.AdmissionRefused.make({ reason })),
        ),
      ),
  )

/**
 * Reading, stopping and following up one helper. A helper lives in its Thread's conversation store, under the
 * Thread creator's address, so both calls go to that address.
 */
const makeChildCalls = (input: {
  readonly http: Transport['http']
  readonly request: Transport['request']
  readonly addressOf: (threadId: ThreadId) => Effect.Effect<Address, RuntimeUnavailable>
}) => {
  const { http, request, addressOf } = input
  const child: RuntimeService['child'] = Effect.fn('Runtime.child')(function* (threadId, runId) {
    const address = yield* addressOf(threadId)
    const suffix = `/children/${encodeURIComponent(runId)}`
    const response = yield* requestRuntime(http, request(address, suffix, 'GET'), address).pipe(
      Effect.mapError(unavailable('Runtime.child')),
    )
    return yield* HttpClientResponse.schemaBodyJson(RuntimeChildAnswer)(response).pipe(
      Effect.mapError(unavailable('Runtime.child')),
    )
  }, Effect.scoped)
  const stopChild: RuntimeService['stopChild'] = Effect.fn('Runtime.stopChild')(function* (
    threadId,
    runId,
  ) {
    const address = yield* addressOf(threadId)
    const suffix = `/children/${encodeURIComponent(runId)}/abort`
    const response = yield* requestRuntime(http, request(address, suffix, 'POST'), address).pipe(
      Effect.mapError(unavailable('Runtime.stopChild')),
    )
    return (yield* HttpClientResponse.schemaBodyJson(RuntimeStopped)(response).pipe(
      Effect.mapError(unavailable('Runtime.stopChild')),
    )).aborted
  }, Effect.scoped)
  const messageChild: RuntimeService['messageChild'] = Effect.fn('Runtime.messageChild')(function* (
    threadId,
    runId,
    message,
  ) {
    const address = yield* addressOf(threadId)
    const suffix = `/children/${encodeURIComponent(runId)}/messages`
    const encoded = yield* HttpClientRequest.schemaBodyJson(RuntimeChildMessage)(
      request(address, suffix, 'POST'),
      message,
    ).pipe(Effect.mapError(unavailable('Runtime.messageChild')))
    const response = yield* requestRuntime(http, encoded, address).pipe(
      Effect.mapError(unavailable('Runtime.messageChild')),
    )
    return yield* HttpClientResponse.schemaBodyJson(RuntimeChildMessaged)(response).pipe(
      Effect.mapError(unavailable('Runtime.messageChild')),
    )
  }, Effect.scoped)
  return { child, stopChild, messageChild }
}

/** Capture transport once. Product ownership supplies every address; the runtime owns settlement. */
const makeRuntime = Effect.fn('Runtime.make')(function* () {
  const config = yield* ServerConfig
  const http = cellNodes(yield* HttpClient.HttpClient, config.RUNTIME_URLS)
  const database = yield* Database
  const token = Redacted.value(config.RUNTIME_TOKEN)
  const request: Transport['request'] = (address, suffix, method) =>
    HttpClientRequest.make(method)(
      new URL(
        `/persons/${encodeURIComponent(address.personId)}/threads/${encodeURIComponent(address.threadId)}${suffix}`,
        config.RUNTIME_URLS[0],
      ),
    ).pipe(HttpClientRequest.bearerToken(token))
  /** Acting authority never substitutes for the Thread creator's runtime storage identity. */
  const addressOf = Effect.fn('Runtime.address')(function* (threadId: ThreadId) {
    const thread = yield* findThread(threadId).pipe(
      Effect.provideService(Database, database),
      Effect.mapError(unavailable('Runtime.address')),
    )
    // No Thread row, so no cell to address: said as the server's own hop.
    if (Option.isNone(thread))
      return yield* RuntimeUnavailable.make({
        message: 'Vivid could not be reached',
        cause: [
          incidentHop({
            service: 'server',
            operation: 'Runtime.address',
            tag: 'ThreadMissing',
            status: Option.none(),
            issues: [],
          }),
        ],
      })
    return { personId: thread.value.personId, threadId }
  })
  const settled: RuntimeService['settled'] = Effect.fn('Runtime.settled')(
    function* (threadId, runId) {
      // A failed server read says nothing about the runtime's Run. Reconnect on its observation cadence.
      const thread = yield* findThread(threadId).pipe(
        Effect.provideService(Database, database),
        Effect.retry({
          while: (error) => Predicate.isTagged(error, 'DatabaseUnavailable'),
          schedule: Schedule.spaced('1 second'),
        }),
      )
      if (Option.isNone(thread)) return yield* lostHere('Runtime.settled', 'ThreadMissing')
      const address = { personId: thread.value.personId, threadId }
      const [row] = yield* database
        .run(
          database
            .select({ receipt: runs.receipt })
            .from(runs)
            .where(and(eq(runs.id, runId), eq(runs.threadId, threadId))),
        )
        .pipe(
          Effect.retry({
            while: (error) => Predicate.isTagged(error, 'DatabaseUnavailable'),
            schedule: Schedule.spaced('1 second'),
          }),
        )
      if (row === undefined || row.receipt === null)
        return yield* lostHere('Runtime.settled', 'ReceiptMissing')
      // Corrupt product data is a typed storage failure, never evidence that Pi ended the reply.
      const receipt = yield* decodeReceipt(row.receipt)
      return yield* observeRun(
        Effect.gen(function* () {
          const response = yield* requestRuntime(
            http,
            request(address, `/submissions/${receipt.submissionId}`, 'GET'),
            address,
          )
          const value = yield* HttpClientResponse.schemaBodyJson(RuntimeSettlement)(response).pipe(
            Effect.mapError(transportFailed(address)),
          )
          return settlementOf(value, address.personId)
        }).pipe(Effect.scoped),
      )
    },
  )
  const stop: RuntimeService['stop'] = Effect.fn('Runtime.stop')(function* (threadId) {
    const address = yield* addressOf(threadId)
    const response = yield* requestRuntime(http, request(address, '/abort', 'POST'), address).pipe(
      Effect.mapError(unavailable('Runtime.stop')),
    )
    return (yield* HttpClientResponse.schemaBodyJson(RuntimeStopped)(response).pipe(
      Effect.mapError(unavailable('Runtime.stop')),
    )).aborted
  }, Effect.scoped)
  /** Finite history and attachment reads retain their caller's scope through body consumption. */
  const read: RuntimeService['read'] = Effect.fn('Runtime.read')(function* (input) {
    const address = yield* addressOf(input.threadId)
    const suffix = input.suffix === '' ? '/state' : input.suffix
    return yield* HttpClient.withScope(http)
      .execute(request(address, suffix, 'GET'))
      .pipe(Effect.mapError(unavailable('Runtime.read')))
  })
  /** Interruption closes the upstream state stream as well as the access watcher. */
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
        ).pipe(Effect.mapError(unavailable('Runtime.watch')))
        return conversationFrames(response, address).pipe(
          Stream.mapError((error) =>
            Predicate.isTagged(error, 'ConversationTooLarge')
              ? error
              : unavailable('Runtime.watch')(error),
          ),
        )
      }),
    )
  return Runtime.of({
    admit: makeAdmit({ http, request }),
    settled,
    stop,
    ...makeChildCalls({ http, request, addressOf }),
    read,
    watch,
  })
})

export const runtimeLayer = Layer.effect(Runtime, makeRuntime())

type CellMemoryFailure = NotFound | Conflict | ServiceUnavailable

export interface CellMemoryService {
  readonly index: (person: PersonId) => Effect.Effect<MemoryIndex, CellMemoryFailure>
  readonly list: (
    person: PersonId,
    input: MemoryListing,
  ) => Effect.Effect<MemoryPage, CellMemoryFailure>
  readonly read: (
    person: PersonId,
    input: MemoryAddress,
  ) => Effect.Effect<SavedMemory, CellMemoryFailure>
  readonly write: (
    person: PersonId,
    input: MemoryWrite,
  ) => Effect.Effect<SavedMemory, CellMemoryFailure>
  readonly retract: (
    person: PersonId,
    input: MemoryRetraction,
  ) => Effect.Effect<void, CellMemoryFailure>
  /** A forget's cell half: stop learning, change the entries, read them back (`runtime/forget.ts`). */
  readonly close: (
    person: PersonId,
    input: MemoryClosure,
  ) => Effect.Effect<MemoryClosed, CellMemoryFailure>
}

/** Settings addresses the acting Person's cell without a Thread ownership lookup. */
export class CellMemory extends Context.Service<CellMemory, CellMemoryService>()(
  'vivid/CellMemory',
) {}

const memoryUnavailable = () =>
  ServiceUnavailable.make({ service: 'memory', message: 'Memory could not be reached' })
const decodeMemoryIndex = HttpClientResponse.schemaBodyJson(MemoryIndex)
const decodeMemoryPage = HttpClientResponse.schemaBodyJson(MemoryPage)
const decodeSavedMemory = HttpClientResponse.schemaBodyJson(SavedMemory)
const decodeMemoryConflict = HttpClientResponse.schemaBodyJson(MemoryConflict)
const decodeMemoryClosed = HttpClientResponse.schemaBodyJson(MemoryClosed)

/** Reuse the cell ingress failover, keeping revision conflicts and missing entries actionable. */
export const cellMemoryLayer = Layer.effect(
  CellMemory,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const http = cellNodes(yield* HttpClient.HttpClient, config.RUNTIME_URLS)
    const token = Redacted.value(config.RUNTIME_TOKEN)
    const request = (person: PersonId, suffix: string, method: 'GET' | 'POST') =>
      HttpClientRequest.make(method)(
        new URL(`/persons/${encodeURIComponent(person)}/memory${suffix}`, config.RUNTIME_URLS[0]),
      ).pipe(HttpClientRequest.bearerToken(token))

    /** The HTTP status owns absence; a conflict body carries the cell's actual revision. */
    const receive = Effect.fn('CellMemory.request')(function* (
      input: HttpClientRequest.HttpClientRequest,
    ) {
      const response = yield* http.execute(input).pipe(Effect.mapError(memoryUnavailable))
      if (response.status === 404) return yield* NotFound.make({ message: 'Memory not found' })
      if (response.status === 409) {
        const conflict = yield* decodeMemoryConflict(response).pipe(
          Effect.mapError(memoryUnavailable),
        )
        return yield* Conflict.make({
          message: `Memory changed from revision ${conflict.expected} to ${conflict.actual}. Read it again before editing.`,
        })
      }
      if (response.status !== 200 && response.status !== 204) return yield* memoryUnavailable()
      return response
    })

    return CellMemory.of({
      index: Effect.fn('CellMemory.index')(function* (person) {
        const response = yield* receive(request(person, '', 'GET'))
        return yield* decodeMemoryIndex(response).pipe(Effect.mapError(memoryUnavailable))
      }, Effect.scoped),
      list: Effect.fn('CellMemory.list')(function* (person, input) {
        const encoded = yield* HttpClientRequest.schemaBodyJson(MemoryListing)(
          request(person, '/list', 'POST'),
          input,
        ).pipe(Effect.mapError(memoryUnavailable))
        const response = yield* receive(encoded)
        return yield* decodeMemoryPage(response).pipe(Effect.mapError(memoryUnavailable))
      }, Effect.scoped),
      read: Effect.fn('CellMemory.read')(function* (person, input) {
        const encoded = yield* HttpClientRequest.schemaBodyJson(MemoryAddress)(
          request(person, '/read', 'POST'),
          input,
        ).pipe(Effect.mapError(memoryUnavailable))
        const response = yield* receive(encoded)
        return yield* decodeSavedMemory(response).pipe(Effect.mapError(memoryUnavailable))
      }, Effect.scoped),
      write: Effect.fn('CellMemory.write')(function* (person, input) {
        const encoded = yield* HttpClientRequest.schemaBodyJson(MemoryWrite)(
          request(person, '/write', 'POST'),
          input,
        ).pipe(Effect.mapError(memoryUnavailable))
        const response = yield* receive(encoded)
        return yield* decodeSavedMemory(response).pipe(Effect.mapError(memoryUnavailable))
      }, Effect.scoped),
      retract: Effect.fn('CellMemory.retract')(function* (person, input) {
        const encoded = yield* HttpClientRequest.schemaBodyJson(MemoryRetraction)(
          request(person, '/delete', 'POST'),
          input,
        ).pipe(Effect.mapError(memoryUnavailable))
        yield* receive(encoded)
      }, Effect.scoped),
      close: Effect.fn('CellMemory.close')(function* (person, input) {
        const encoded = yield* HttpClientRequest.schemaBodyJson(MemoryClosure)(
          request(person, '/forget', 'POST'),
          input,
        ).pipe(Effect.mapError(memoryUnavailable))
        const response = yield* receive(encoded)
        return yield* decodeMemoryClosed(response).pipe(Effect.mapError(memoryUnavailable))
      }, Effect.scoped),
    })
  }),
)

/** A document belongs to the response containing its exact tool call, including joined deliveries. */
export const documentRun = Effect.fn('Runtime.documentRun')(function* (
  threadId: ThreadId,
  toolCallId: DocumentToolCallId,
  toolName: 'write_document' | 'inspect_file' | 'publish_file',
) {
  const runtime = yield* Runtime
  const response = yield* runtime.read({
    threadId,
    suffix: '',
  })
  if (response.status !== 200)
    return yield* RuntimeUnavailable.make({
      message: 'Vivid could not be reached',
      cause: [
        incidentHop({
          service: 'server',
          operation: 'Runtime.documentRun',
          tag: 'UnexpectedStatus',
          status: Option.some(response.status),
          issues: [],
        }),
      ],
    })
  const state = yield* HttpClientResponse.schemaBodyJson(ConversationState)(response).pipe(
    Effect.mapError(unavailable('Runtime.documentRun')),
  )
  const matches = state.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some(
        (part) =>
          part.type === 'dynamic-tool' &&
          part.toolName === toolName &&
          part.toolCallId === toolCallId,
      ),
  )
  const [message] = matches
  if (matches.length !== 1 || message === undefined || message.submissionId === undefined)
    return yield* new NotFound({ message: 'Document response not found' })
  const database = yield* Database
  const rows = yield* database.run(
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
  const [row] = rows
  if (rows.length !== 1 || row === undefined)
    return yield* new NotFound({ message: 'Document Run not found' })
  return row.id
}, Effect.scoped)
