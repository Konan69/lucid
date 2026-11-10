import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import {
  CodeName,
  CONTRACT_HEADER,
  ConversationFrame,
  ConversationState,
  incidentHop,
  Issue,
  issuesOf,
  type IncidentCause,
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
  RuntimeAdmissionBody,
  RuntimeAdmissionReceipt,
  RuntimeAttachmentPath,
  RuntimeChildAnswer,
  RuntimeChildPath,
  RuntimeChildMessage,
  RuntimeChildMessaged,
  RuntimeContract,
  RuntimeRefusal,
  RuntimeSettlement,
  RuntimeStopped,
  RuntimeSubmissionPath,
  RuntimeThreadPath,
  RuntimeHistoryBody,
  RuntimeHistoryAnswer,
  RuntimePersonId,
  RuntimeSearchAnswer,
  RuntimeSearchBody,
  type ThreadId,
} from '@vivid/contracts'
import { contractFingerprint } from '@vivid/contracts/fingerprint'
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import type * as HttpBody from 'effect/http/HttpBody'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as HttpServerError from 'effect/http/HttpServerError'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { loadHistory } from './history.ts'
import { closeMemory } from './forget.ts'
import { Memory, type MemoryUnavailable } from './memory.ts'
import { admit } from './admission.ts'
import { abortHelper, answerOf } from './children.ts'
import { runInputs } from './deliveries.ts'
import { Models } from './models.ts'
import { Person, type PersonConversations } from './person.ts'
import { searchSaid } from './recall.ts'
import { isSubmissionId, settlement, submissionOf } from './response.ts'
import { RuntimeSettings } from './settings.ts'
import { frames, whole } from './state/link.ts'
import { picture } from './state/pictures.ts'
import { conversationOf, pi, type PiRejected, type ThreadUnknown } from './threads.ts'

/** The caller did not present the runtime token. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  {},
  { title: 'Runtime token missing or wrong' },
) {}
/**
 * The route and the body disagree about which Thread or whose it is. `path` is the field whose
 * check failed (`threadId`, `initialData.creator`, `personId`), so the refusal can name it.
 */
class WrongThread extends Schema.TaggedError<WrongThread>()(
  'WrongThread',
  { path: Issue.fields.path },
  { title: 'Delivery names another Thread or Person' },
) {}
/** `WrongThread` naming the declared field whose check failed; history names the Thread's index. */
const wrongThread = (...names: ReadonlyArray<string>) =>
  WrongThread.make({ path: names.map((name) => CodeName.make(name)) })
const wrongHistory = (index: number) =>
  WrongThread.make({
    path: [CodeName.make('threads'), index, CodeName.make('origin'), CodeName.make('creator')],
  })

/**
 * An admission body did not decode and its sender's contract fingerprint is not this cell's:
 * the server and this Worker were built from different wire schemas. `issues` are the decode's.
 */
class ContractMismatch extends Schema.TaggedError<ContractMismatch>()(
  'ContractMismatch',
  { issues: Schema.Array(Issue) },
  { title: 'Server and cell were built from different contracts' },
) {}
/** The Thread has no conversation in this Person's store. */
class UnknownThread extends Schema.TaggedError<UnknownThread>()(
  'UnknownThread',
  {},
  { title: 'Thread has no conversation here' },
) {}
/** The number names no delivery of this Thread. */
class UnknownSubmission extends Schema.TaggedError<UnknownSubmission>()(
  'UnknownSubmission',
  {},
  { title: 'Submission is not of this Thread' },
) {}

/** Every refusal carries its cause and this cell's contract fingerprint (`RuntimeRefusal`). */
const refuse = (error: RuntimeRefusal['error'], status: number, cause: IncidentCause) =>
  HttpServerResponse.schemaJson(RuntimeRefusal)(
    { error, cause, contract: contractFingerprint },
    { status },
  )

/** This cell's hop: the route `operation` stopped with `tag` and answered `status`. */
const cellHop = (operation: string, tag: string, status: number, issues: ReadonlyArray<Issue>) =>
  incidentHop({ service: 'cell', operation, tag, status: Option.some(status), issues })

/** A refusal whose cause is this cell's one hop, naming no field. */
const refused = (operation: string, error: RuntimeRefusal['error'], status: number, tag: string) =>
  refuse(error, status, [cellHop(operation, tag, status, [])])

/**
 * The runtime token protects every route but `/health`. The application server is the only
 * holder: no browser, phone or desktop app talks to this process; they talk to the server's
 * gateway, which checks who they are and whether they may see the Thread before it forwards
 * anything here. The comparison takes the same time whatever the supplied value is.
 */
const authorize = Effect.fn('Runtime.authorize')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const settings = yield* RuntimeSettings
  if (
    !isAuthorized(
      Option.getOrElse(Option.fromUndefinedOr(request.headers.authorization), () => ''),
      settings.token,
    )
  )
    return yield* new Unauthorized()
  return yield* Effect.void
})

/** The Worker and the bound router enforce the same private credential boundary. */
export const isAuthorized = (authorization: string, token: Redacted.Redacted) => {
  const supplied = Buffer.from(authorization)
  const expected = Buffer.from(`Bearer ${Redacted.value(token)}`)
  return supplied.length === expected.length && NodeCrypto.timingSafeEqual(supplied, expected)
}

/**
 * Every refusal has one status, one tag and a cause of closed values (`RuntimeRefusal`); the raw
 * cause never crosses, because a schema issue or a storage error can quote the request it failed
 * on.
 *
 * - 400: the request is not one the runtime can read, or names the wrong Thread or Person.
 * - 404: nothing by that name here.
 * - 503: this Person's conversations could not be opened or failed while in use. The delivery may
 *   or may not be held; the same request again, with the same key, finds out.
 */
const unavailable = (operation: string, tag: string) =>
  Effect.logError('Runtime request failed', tag).pipe(
    Effect.andThen(refused(operation, 'Unavailable', 503, tag)),
  )

/**
 * Answers every failure of the route `operation` (its `Effect.fn` name) as a refusal whose
 * cause's first hop is this cell's: the route, the failure's tag and the status it answered.
 */
const answered = <R>(
  operation: string,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    | Unauthorized
    | WrongThread
    | ContractMismatch
    | UnknownThread
    | UnknownSubmission
    | ThreadUnknown
    | PiRejected
    | Schema.SchemaError
    | HttpServerError.HttpServerError
    | HttpBody.HttpBodyError,
    R
  >,
) =>
  handler.pipe(
    Effect.catchTags({
      Unauthorized: ({ _tag }) => refused(operation, 'Unauthorized', 401, _tag),
      SchemaError: ({ _tag, issue }) =>
        refuse('InvalidRequest', 400, [cellHop(operation, _tag, 400, issuesOf(issue))]),
      HttpServerError: ({ reason }) => refused(operation, 'InvalidRequest', 400, reason._tag),
      WrongThread: ({ _tag, path }) =>
        refuse('WrongThread', 400, [
          cellHop(operation, _tag, 400, [{ path, kind: 'InvalidValue' }]),
        ]),
      ContractMismatch: ({ _tag, issues }) =>
        refuse('ContractMismatch', 409, [cellHop(operation, _tag, 409, issues)]),
      UnknownThread: ({ _tag }) => refused(operation, 'UnknownThread', 404, _tag),
      ThreadUnknown: ({ _tag }) => refused(operation, 'UnknownThread', 404, _tag),
      UnknownSubmission: ({ _tag }) => refused(operation, 'UnknownSubmission', 404, _tag),
      PiRejected: ({ _tag }) => unavailable(operation, _tag),
    }),
    // Encoding one of the fixed bodies above cannot fail; this names what is sent if it ever does.
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  )

/** A route may only address the Person whose native cell owns this router. */
const bound = Effect.fn('Runtime.bound')(function* (path: RuntimeThreadPath) {
  const person = yield* Person
  if (person.personId !== path.personId) return yield* wrongThread('personId')
  return person
})

/**
 * The admission body, or why it was refused. Decoding comes first and the sender's contract
 * fingerprint (`CONTRACT_HEADER`) is read only when it fails: a body this cell can read is
 * admitted whatever build sent it, and one it cannot read from a build of other schemas is
 * `ContractMismatch` instead of a bare `InvalidRequest`.
 *
 * Why not refuse every mismatch: a deploy publishes the new Worker before the new server takes
 * traffic (`infra/railway.ts` pre-deploy), so for that window the old server sends to the new
 * Worker. A change that only adds an optional field changes the fingerprint and leaves the old
 * body readable; refusing on the fingerprint alone would fail every send of that window for no
 * reason. The opposite pair (new server, old Worker) is what failed from 8 November 2026, and the
 * server's readiness (`apps/server/src/runtime/contract.ts`) refuses to serve it at all.
 */
const admissionBody = Effect.fn('Runtime.admissionBody')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return yield* HttpServerRequest.schemaBodyJson(RuntimeAdmissionBody).pipe(
    Effect.catchTag('SchemaError', (error) =>
      Effect.fail(
        request.headers[CONTRACT_HEADER] === contractFingerprint
          ? error
          : ContractMismatch.make({ issues: issuesOf(error.issue) }),
      ),
    ),
  )
})

/**
 * Admit one delivery. The body is the contract the server encodes with, so the two cannot drift.
 * It must name the route's Thread, and the route's Person must be the Thread's creator: a Thread
 * lives in its creator's store and nowhere else, so a mismatch is refused before any store
 * is touched.
 */
const admission = Effect.fn('Runtime.admission')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const body = yield* admissionBody()
  if (body.threadId !== path.threadId) return yield* wrongThread('threadId')
  if (body.initialData.creator !== path.personId)
    return yield* wrongThread('initialData', 'creator')
  const person = yield* bound(path)
  const receipt = yield* admit(person, body)
  return yield* HttpServerResponse.schemaJson(RuntimeAdmissionReceipt)(receipt, { status: 202 })
})

/**
 * Stop whatever is in progress in a Thread. Pi's `Conversation.abort()` withdraws queued inputs,
 * aborts every task of the current work and resolves once the conversation is idle. `aborted`
 * says whether there was a response to stop, as runtime's abort answered.
 */
const stop = Effect.fn('Runtime.stop')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const person = yield* bound(path)
  const aborted = yield* stopThread(person.harness, path.threadId)
  return yield* HttpServerResponse.schemaJson(RuntimeStopped)({ aborted })
})

/** A Thread with no conversation has nothing to stop; one that is idle is aborted to no effect. */
const stopThread = Effect.fn('Runtime.stopThread')(function* (
  harness: Harness,
  threadId: ThreadId,
) {
  const conversation = yield* conversationOf(harness, threadId)
  if (Option.isNone(conversation)) return false
  const busy = (yield* runInputs(harness, conversation.value.id)).length > 0
  yield* pi(() => conversation.value.abort(BACKGROUND_CONTEXT))
  return busy
})

const encodeSettlement = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(RuntimeSettlement)),
)

/**
 * Validate before returning headers so refusals keep their HTTP status. The body owns Pi's
 * terminal wait, allowing celld to drain public admission and interrupt it during a handoff.
 */
const settled = Effect.fn('Runtime.settled')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeSubmissionPath)
  const person = yield* bound(path)
  const submission = yield* findSubmission(person.harness, path)
  const body = Stream.fromEffect(settlement(person.harness, submission)).pipe(
    Stream.mapEffect((outcome) => encodeSettlement(outcome)),
    Stream.encodeText,
  )
  return HttpServerResponse.stream(body, { contentType: 'application/json' })
})

/** Resolve through the Thread before waiting, so another Thread's submission remains unknown. */
const findSubmission = Effect.fn('Runtime.findSubmission')(function* (
  harness: Harness,
  path: RuntimeSubmissionPath,
) {
  const conversation = yield* conversationOf(harness, path.threadId)
  if (Option.isNone(conversation)) return yield* new UnknownThread()
  if (!isSubmissionId(path.submissionId)) return yield* new UnknownSubmission()
  const submission = yield* submissionOf(harness, conversation.value.id, path.submissionId)
  if (Option.isNone(submission)) return yield* new UnknownSubmission()
  return submission.value
})

const encodeFrame = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ConversationFrame)),
)

/** A comment line: Server-Sent Events readers ignore it, and its arrival says the link is alive. */
const HEARTBEAT = ': alive\n\n'

/**
 * The state link as Server-Sent Events: one frame per event, encoded by the contract's schema.
 * The heartbeat is merged in and ends with the frames, so a link the runtime has ended is seen
 * to end.
 */
const stateEvents = (person: PersonConversations, path: RuntimeThreadPath) =>
  frames(person.harness, path.threadId).pipe(
    Stream.mapEffect((frame) => encodeFrame(frame)),
    Stream.map((json) => `data: ${json}\n\n`),
    Stream.merge(Stream.tick('15 seconds').pipe(Stream.drop(1), Stream.as(HEARTBEAT)), {
      haltStrategy: 'left',
    }),
    Stream.encodeText,
  )

/**
 * One Thread's conversation as a screen reads it. A caller that asks for an event stream gets
 * the link (`state/link.ts`): the whole state, then its changes, until it goes away. Any other
 * caller gets the whole state once as JSON, which is what the server's own readers need.
 */
const state = Effect.fn('Runtime.state')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const request = yield* HttpServerRequest.HttpServerRequest
  const person = yield* bound(path)
  const accept = request.headers.accept
  if (accept !== undefined && accept.includes('text/event-stream'))
    return HttpServerResponse.stream(stateEvents(person, path), {
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-store' },
    })
  const current = yield* whole(person.harness, path.threadId)
  return yield* HttpServerResponse.schemaJson(ConversationState)(current)
})

/** The bytes of one picture, or nothing by that name in this Thread. */
const attachment = Effect.fn('Runtime.attachment')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeAttachmentPath)
  const person = yield* bound(path)
  const conversation = yield* conversationOf(person.harness, path.threadId)
  if (Option.isNone(conversation)) return yield* new UnknownThread()
  const found = yield* picture(conversation.value, path.attachmentId)
  if (Option.isNone(found))
    return yield* refused('Runtime.attachment', 'NotFound', 404, 'AttachmentMissing')
  return HttpServerResponse.uint8Array(found.value.bytes, {
    contentType: found.value.mediaType,
    headers: { 'cache-control': 'private, max-age=31536000, immutable' },
  })
})

/** How one helper of this Thread stands: still running, or how it ended, with its answer. */
const child = Effect.fn('Runtime.child')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeChildPath)
  const person = yield* bound(path)
  const answer = yield* answerOf(person.harness, path.threadId, path.runId)
  return yield* HttpServerResponse.schemaJson(RuntimeChildAnswer)(answer)
})

/** Aborts one helper's work and answers once it ended. The Thread's own work is untouched. */
const stopChild = Effect.fn('Runtime.stopChild')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeChildPath)
  const person = yield* bound(path)
  const aborted = yield* abortHelper(person.harness, path.threadId, path.runId)
  return yield* HttpServerResponse.schemaJson(RuntimeStopped)({ aborted })
})

/**
 * Hands one helper its next round, recorded by the server first, and answers once its task was
 * created in the Thread's conversation. The Thread's own work is untouched.
 */
const messageChild = Effect.fn('Runtime.messageChild')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeChildPath)
  const body = yield* HttpServerRequest.schemaBodyJson(RuntimeChildMessage)
  const person = yield* bound(path)
  const messaged = yield* person.helpers.message(path.threadId, path.runId, body)
  return yield* HttpServerResponse.schemaJson(RuntimeChildMessaged)(messaged)
})

/** Open to anyone, as it has been: a liveness answer that names the selected model and no secret. */
const health = Effect.fn('Runtime.health')(function* () {
  const models = yield* Models
  return yield* HttpServerResponse.json({
    model: models.name,
    service: 'vivid-agent-runtime',
    status: 'ok',
  })
})

/**
 * The contract fingerprint this runtime was built with, for the server's readiness check
 * (`RuntimeContract`). Behind the token like every route but `/health`.
 */
const contract = Effect.fn('Runtime.contract')(function* () {
  yield* authorize()
  return yield* HttpServerResponse.schemaJson(RuntimeContract)({ contract: contractFingerprint })
})

/** History is private to the addressed cell and cannot import another Person's Threads. */
const history = Effect.fn('Runtime.history')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(Schema.Struct({ personId: RuntimePersonId }))
  const person = yield* Person
  const body = yield* HttpServerRequest.schemaBodyJson(RuntimeHistoryBody)
  if (person.personId !== path.personId) return yield* wrongThread('personId')
  const foreign = body.threads.findIndex((thread) => thread.origin.creator !== path.personId)
  if (foreign !== -1) return yield* wrongHistory(foreign)
  const result = yield* loadHistory(person, body)
  return yield* HttpServerResponse.schemaJson(RuntimeHistoryAnswer)(result)
})

/**
 * The Person's own memory, for the server's Settings handlers. Only this cell's Person is
 * addressed: the server sends the acting Person's id, and another id is refused like a Thread
 * that is not here. A stale revision answers with the conflict itself, so Settings can say what
 * moved; an absent entry is NotFound; storage that cannot answer is Unavailable.
 */
const owner = Effect.fn('Runtime.memoryOwner')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(Schema.Struct({ personId: RuntimePersonId }))
  const person = yield* Person
  if (person.personId !== path.personId) return yield* wrongThread('personId')
  return person
})

const missingMemory = (operation: string) => () =>
  refused(operation, 'NotFound', 404, 'MemoryMissing')
const conflictedMemory = (conflict: MemoryConflict) =>
  HttpServerResponse.schemaJson(MemoryConflict)(conflict, { status: 409 })
const unavailableMemory = (operation: string) => (error: MemoryUnavailable) =>
  unavailable(operation, error._tag)

const memoryIndex = Effect.fn('Runtime.memoryIndex')(function* () {
  const person = yield* owner()
  return yield* person.sources.memory
    .index(person.personId)
    .pipe(
      Effect.flatMap(HttpServerResponse.schemaJson(MemoryIndex)),
      Effect.catchTags({ MemoryUnavailable: unavailableMemory('Runtime.memoryIndex') }),
    )
})

const memoryList = Effect.fn('Runtime.memoryList')(function* () {
  const person = yield* owner()
  const listing = yield* HttpServerRequest.schemaBodyJson(MemoryListing)
  return yield* person.sources.memory
    .list(person.personId, listing)
    .pipe(
      Effect.flatMap(HttpServerResponse.schemaJson(MemoryPage)),
      Effect.catchTags({ MemoryUnavailable: unavailableMemory('Runtime.memoryList') }),
    )
})

const memoryRead = Effect.fn('Runtime.memoryRead')(function* () {
  const person = yield* owner()
  const address = yield* HttpServerRequest.schemaBodyJson(MemoryAddress)
  return yield* person.sources.memory.read(person.personId, address).pipe(
    Effect.flatMap(HttpServerResponse.schemaJson(SavedMemory)),
    Effect.catchTags({
      MemoryMissing: missingMemory('Runtime.memoryRead'),
      MemoryUnavailable: unavailableMemory('Runtime.memoryRead'),
    }),
  )
})

const memoryWrite = Effect.fn('Runtime.memoryWrite')(function* () {
  const person = yield* owner()
  const write = yield* HttpServerRequest.schemaBodyJson(MemoryWrite)
  return yield* person.sources.memory.write(person.personId, write).pipe(
    Effect.flatMap(HttpServerResponse.schemaJson(SavedMemory)),
    Effect.catchTags({
      MemoryConflict: conflictedMemory,
      MemoryUnavailable: unavailableMemory('Runtime.memoryWrite'),
    }),
  )
})

const memoryDelete = Effect.fn('Runtime.memoryDelete')(function* () {
  const person = yield* owner()
  const retraction = yield* HttpServerRequest.schemaBodyJson(MemoryRetraction)
  return yield* person.sources.memory.delete(person.personId, retraction).pipe(
    Effect.as(HttpServerResponse.empty({ status: 204 })),
    Effect.catchTags({
      MemoryConflict: conflictedMemory,
      MemoryMissing: missingMemory('Runtime.memoryDelete'),
      MemoryUnavailable: unavailableMemory('Runtime.memoryDelete'),
    }),
  )
})

/**
 * A forget's cell half, for the server's `ForgetMemory`: stop this Person's queued learning,
 * change the planned entries, read them back and name admitted work that still holds them.
 * Storage that cannot answer is Unavailable; every per-entry outcome is in the answer itself.
 */
const memoryForget = Effect.fn('Runtime.memoryForget')(function* () {
  const person = yield* owner()
  const closure = yield* HttpServerRequest.schemaBodyJson(MemoryClosure)
  return yield* closeMemory(person.harness, person.personId, closure).pipe(
    Effect.provideService(Memory, person.sources.memory),
    Effect.flatMap(HttpServerResponse.schemaJson(MemoryClosed)),
    Effect.catchTag('PiRejected', ({ _tag }) => unavailable('Runtime.memoryForget', _tag)),
  )
})

/**
 * The words of the Person's own conversations, for the server's Search. The server names the
 * Threads to look in (the ones it lets the Person see); only this cell's Person is addressed.
 */
const search = Effect.fn('Runtime.search')(function* () {
  const person = yield* owner()
  const body = yield* HttpServerRequest.schemaBodyJson(RuntimeSearchBody)
  const answer = yield* searchSaid(person.harness, body)
  return yield* HttpServerResponse.schemaJson(RuntimeSearchAnswer)(answer)
})

const MEMORY = '/persons/:personId/memory'

const THREAD = '/persons/:personId/threads/:threadId'

/** The whole HTTP surface. Anything else is refused the same way whether or not it exists. */
export const routes = Layer.mergeAll(
  HttpRouter.add('GET', '/health', answered('Runtime.health', health())),
  HttpRouter.add('GET', '/contract', answered('Runtime.contract', contract())),
  HttpRouter.add('POST', '/persons/:personId/history', answered('Runtime.history', history())),
  HttpRouter.add('GET', MEMORY, answered('Runtime.memoryIndex', memoryIndex())),
  HttpRouter.add('POST', `${MEMORY}/list`, answered('Runtime.memoryList', memoryList())),
  HttpRouter.add('POST', `${MEMORY}/read`, answered('Runtime.memoryRead', memoryRead())),
  HttpRouter.add('POST', `${MEMORY}/write`, answered('Runtime.memoryWrite', memoryWrite())),
  HttpRouter.add('POST', `${MEMORY}/delete`, answered('Runtime.memoryDelete', memoryDelete())),
  HttpRouter.add('POST', `${MEMORY}/forget`, answered('Runtime.memoryForget', memoryForget())),
  HttpRouter.add('POST', '/persons/:personId/search', answered('Runtime.search', search())),
  HttpRouter.add('POST', THREAD, answered('Runtime.admission', admission())),
  HttpRouter.add('POST', `${THREAD}/abort`, answered('Runtime.stop', stop())),
  HttpRouter.add(
    'GET',
    `${THREAD}/submissions/:submissionId`,
    answered('Runtime.settled', settled()),
  ),
  HttpRouter.add('GET', `${THREAD}/state`, answered('Runtime.state', state())),
  HttpRouter.add(
    'GET',
    `${THREAD}/attachments/:attachmentId`,
    answered('Runtime.attachment', attachment()),
  ),
  HttpRouter.add('GET', `${THREAD}/children/:runId`, answered('Runtime.child', child())),
  HttpRouter.add(
    'POST',
    `${THREAD}/children/:runId/abort`,
    answered('Runtime.stopChild', stopChild()),
  ),
  HttpRouter.add(
    'POST',
    `${THREAD}/children/:runId/messages`,
    answered('Runtime.messageChild', messageChild()),
  ),
  HttpRouter.add(
    '*',
    '/*',
    answered(
      'Runtime.route',
      authorize().pipe(Effect.andThen(refused('Runtime.route', 'NotFound', 404, 'RouteNotFound'))),
    ),
  ),
)
