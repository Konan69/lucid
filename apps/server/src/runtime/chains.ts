import * as NodeCrypto from 'node:crypto'
import { NodeHttpClient } from '@effect/platform-node'
import { expect } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  OpenFirstThreadResult,
  PersonId,
  RunId,
  RunState,
  ConversationState,
  ConversationFrame,
  ThreadId,
  RuntimeUnavailable,
} from '@vivid/contracts'
import { Config, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'

const Account = Schema.Struct({ user: Schema.Struct({ id: PersonId }) })

const cleanupFailed = () => Effect.sync(() => expect.fail('Thread proof cleanup failed'))
export const chainLayer = Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)

/** One real signup and its cookie-authenticated product client. Cleanup is registered before
 * signup and uses only the supplied night test database. A mismatched server/database is rejected
 * before sending any model request. Cookies and network diagnostics never enter logs.
 */
const chainPerson = Effect.fn('ThreadProof.person')(function* () {
  const target = new URL(Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL')))
  expect(target.port, 'Proofs require the disposable night PostgreSQL port').toBe('55440')
  // This is an equality guard only, never a fallback connection. Check before creating a
  // Person so the running stack cannot write a fixture into a different night database.
  const configured = new URL(Redacted.value(yield* Config.Redacted('DATABASE_URL')))
  expect(
    configured.host === target.host && configured.pathname === target.pathname,
    'The night stack must use the explicitly supplied disposable proof database',
  ).toBe(true)
  const server = yield* Config.URL('VIVID_SERVER_URL')
  const origin = yield* Config.URL('PUBLIC_URL')
  const model = yield* Config.NonEmptyString('VIVID_MODEL')
  expect(model.startsWith('rehearsal/'), 'A real model is required').toBe(false)
  yield* Config.Redacted('OPENROUTER_API_KEY')
  const database = yield* Database
  const email = `${NodeCrypto.randomUUID()}@example.test`
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(personTable).where(eq(personTable.email, email)))
      .pipe(Effect.asVoid, Effect.catch(cleanupFailed)),
  )
  const http = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(new URL('/api/auth/sign-up/email', server)).pipe(
      HttpClientRequest.setHeader('origin', origin.origin),
    ),
    { email, name: 'Thread proof', password: `Proof!${NodeCrypto.randomUUID()}` },
  )
  const response = yield* http
    .execute(request)
    .pipe(
      Effect.mapError(() =>
        RuntimeUnavailable.make({ message: 'Proof signup could not be reached' }),
      ),
    )
  expect(response.status).toBe(200)
  const { user } = yield* HttpClientResponse.schemaBodyJson(Account)(response)
  const saved = yield* database.run(
    database.select({ id: personTable.id }).from(personTable).where(eq(personTable.email, email)),
  )
  expect(
    saved.map((row) => row.id),
    'The server must use the supplied test database',
  ).toEqual([user.id])
  const cookie = Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')
  expect(cookie.length).toBeGreaterThan(0)
  const rpcContext = yield* Layer.build(
    VividRpcClient.layer({
      url: new URL('/api/rpc', server).href,
      headers: { cookie, origin: origin.origin },
    }).pipe(Layer.provide(NodeHttpClient.layerUndici)),
  )
  const rpc = yield* VividRpcClient.pipe(Effect.provideContext(rpcContext))
  return { personId: user.id, rpc, server, origin, cookie }
})
type ChainPerson = Effect.Success<ReturnType<typeof chainPerson>>

/** A proof reads projected state over the same product socket contract as the apps. */
const chainThread = (person: ChainPerson, threadId: ThreadId) => {
  const frames = person.rpc.WatchConversation({ threadId })
  const conversation = {
    frames,
    attachmentUrl: (attachmentId: string) =>
      new URL(
        `/api/vivid/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,
        person.server,
      ).href,
  }
  const send = Effect.fn('ThreadProof.send')(function* (text: string) {
    const { run } = yield* person.rpc.SendToThread({
      threadId,
      text,
      pictures: [],
      key: NodeCrypto.randomUUID(),
    })
    return run.id
  })
  return { ...person, threadId, conversation, send }
}

/** A Person with one private Thread they started themselves, in which nothing has been said. */
export const chainFixture = Effect.fn('ThreadProof.fixture')(function* (title: string) {
  const person = yield* chainPerson()
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* person.rpc.CreateThread({ id: threadId, title, projectId: null })
  return chainThread(person, threadId)
})
export type ChainFixture = Effect.Success<ReturnType<typeof chainFixture>>

/**
 * A Person who is already signed in somewhere else, by the session cookie the proof was given,
 * with one new private Thread. For proofs that need something only a real Person has, such as a
 * desktop app attached to the server as them (`computers/egress/address.live.test.ts`).
 *
 * Nobody is signed up and nothing is cleaned up: the Thread stays in that Person's account. No
 * database is named, so this can be pointed at any running server the cookie belongs to.
 */
export const chainSession = Effect.fn('ThreadProof.session')(function* (
  cookie: Redacted.Redacted,
  title: string,
) {
  const server = yield* Config.URL('VIVID_SERVER_URL')
  const origin = yield* Config.URL('PUBLIC_URL')
  const session = Redacted.value(cookie)
  const rpcContext = yield* Layer.build(
    VividRpcClient.layer({
      url: new URL('/api/rpc', server).href,
      headers: { cookie: session, origin: origin.origin },
    }).pipe(Layer.provide(NodeHttpClient.layerUndici)),
  )
  const rpc = yield* VividRpcClient.pipe(Effect.provideContext(rpcContext))
  const { personId } = yield* rpc.GetSettings()
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* rpc.CreateThread({ id: threadId, title, projectId: null })
  return chainThread({ personId, rpc, server, origin, cookie: session }, threadId)
})

/**
 * A Person who has just arrived. They start nothing: the server opens their first Thread and
 * admits the Run in which Vivid speaks first (`threads/arrival.ts`), exactly as a client's first
 * launch asks it to. The Thread is the server's, so its id comes from the answer.
 */
export const chainArrival = Effect.fn('ThreadProof.arrival')(function* () {
  const person = yield* chainPerson()
  const opened = yield* person.rpc.OpenFirstThread()
  if (!OpenFirstThreadResult.guards.Opened(opened))
    return yield* Effect.sync(() => expect.fail('A new Person must have a first Thread opened'))
  return chainThread(person, opened.thread)
})

/** A fresh link returns its Whole. Live proofs do not keep or apply a second conversation in the server. */
const currentState = <E, R>(frames: Stream.Stream<ConversationFrame, E, R>) =>
  frames.pipe(
    Stream.filter(ConversationFrame.guards.Whole),
    Stream.map((frame) => frame.state),
    Stream.runHead,
    Effect.flatMap((state) =>
      Option.isSome(state)
        ? Effect.succeed(state.value)
        : Effect.sync(() => expect.fail('Conversation link ended before Whole')),
    ),
  )

/** Changes are signals to read a fresh Whole through RPC, without a timed history poll. */
export const waitForState = Effect.fn('ThreadProof.waitForState')(function* (
  reader: Pick<ChainFixture['conversation'], 'frames'>,
  accepts: (state: ConversationState) => boolean,
) {
  const found = yield* reader.frames.pipe(
    Stream.mapEffect((frame) =>
      ConversationFrame.match(frame, {
        Whole: ({ state }) => Effect.succeed(state),
        Changes: () => currentState(reader.frames),
      }),
    ),
    Stream.filter(accepts),
    Stream.runHead,
  )
  if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Thread stream ended'))
  return found.value
})

/** The published product Run, rather than an inferred conversation message, proves settlement. */
export const completeRun = Effect.fn('ThreadProof.completeRun')(function* (
  fixture: ChainFixture,
  runId: RunId,
) {
  const ended = yield* fixture.rpc.WatchThread({ id: fixture.threadId }).pipe(
    Stream.map((detail) => detail.runs.find((run) => run.id === runId)),
    Stream.filter((run) => run !== undefined && !RunState.guards.Working(run.state)),
    Stream.runHead,
  )
  if (Option.isNone(ended) || ended.value === undefined)
    return yield* Effect.sync(() => expect.fail('Run ended without a record'))
  const run = ended.value
  expect(RunState.guards.Completed(run.state), 'The real model Run must settle successfully').toBe(
    true,
  )
  return yield* waitForState(fixture.conversation, (state) =>
    state.settlements.some((settled) => settled.submissionId === run.submissionId),
  )
})

/** Tool receipts stay SDK-typed until their arbitrary provider output is decoded by each proof. */
export function toolParts(state: ConversationState) {
  return state.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : [])),
  )
}

/** Require a final, observable answer; tool receipts alone must not be called an answered request. */
export function replyText(state: ConversationState) {
  return state.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n')
}
