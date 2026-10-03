import * as NodeCrypto from 'node:crypto'
import { createFlueClient, type FlueClient, type FlueConversationState } from '@flue/sdk'
import { NodeHttpClient } from '@effect/platform-node'
import { expect } from '@effect/vitest'
import { VividRpcClient } from '@vivid/client-runtime'
import { PersonId, RunId, RunState, ThreadId, RuntimeUnavailable } from '@vivid/contracts'
import { Config, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from 'effect'
import { eq } from 'drizzle-orm'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { observeRun, Settlement } from './settlement.ts'

const Account = Schema.Struct({ user: Schema.Struct({ id: PersonId }) })
const Receipt = Schema.Struct({ submissionId: RunId })

const cleanupFailed = () => Effect.sync(() => expect.fail('Thread proof cleanup failed'))
export const chainLayer = Layer.mergeAll(testDatabaseLayer, NodeHttpClient.layerUndici)

/** One real signup, private Thread and cookie-authenticated product client. Cleanup is registered
 * before signup and uses only the supplied night test database. A mismatched server/database is
 * rejected before sending any model request. Cookies and network diagnostics never enter logs.
 */
export const chainFixture = Effect.fn('ThreadProof.fixture')(function* (title: string) {
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
  yield* Config.Redacted('EXPLABS_API_KEY')
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
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* rpc.CreateThread({ id: threadId, title, projectId: null })
  const conversation = createFlueClient({
    url: new URL(`/api/vivid/${threadId}`, server).href,
    headers: { cookie },
  })
  /** The gateway, rather than the runtime token, admits exactly the Person's public message shape. */
  const send = Effect.fn('ThreadProof.send')(function* (body: string) {
    const sent = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(new URL(`/api/vivid/${threadId}`, server)).pipe(
        HttpClientRequest.setHeader('cookie', cookie),
      ),
      { body, idempotencyKey: NodeCrypto.randomUUID() },
    )
    const accepted = yield* http
      .execute(sent)
      .pipe(
        Effect.mapError(() =>
          RuntimeUnavailable.make({ message: 'Proof Thread could not be reached' }),
        ),
      )
    expect(accepted.status).toBe(202)
    return (yield* HttpClientResponse.schemaBodyJson(Receipt)(accepted)).submissionId
  })
  return { personId: user.id, threadId, rpc, conversation, send, server, origin, cookie }
})
export type ChainFixture = Effect.Success<ReturnType<typeof chainFixture>>

/** Wait on Flue's maintained SSE state; no sleeps, HTTP polling or second model submission. */
export const waitForState = Effect.fn('ThreadProof.waitForState')(function* (
  client: FlueClient,
  accepts: (state: FlueConversationState) => boolean,
) {
  const states = yield* Queue.unbounded<FlueConversationState>()
  const observation = yield* Effect.acquireRelease(
    Effect.sync(() => client.observe({ live: 'sse' })),
    (source) => Effect.sync(() => source.close()),
  )
  /** SDK decoding owns the stream ingress; only typed conversation snapshots enter the queue. */
  const changed = () => {
    const state = observation.getSnapshot().conversation
    if (state !== undefined) Queue.offerUnsafe(states, state)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => observation.subscribe(changed)),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  changed()
  const found = yield* Stream.fromQueue(states).pipe(Stream.filter(accepts), Stream.runHead)
  if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Thread stream ended'))
  return found.value
}, Effect.scoped)

/** Assert runtime settlement first, then its published product Run through the real live RPC. */
export const completeRun = Effect.fn('ThreadProof.completeRun')(function* (
  fixture: ChainFixture,
  runId: RunId,
) {
  const outcome = yield* observeRun(fixture.conversation, runId, 90_000)
  expect(Settlement.guards.Completed(outcome), 'The real model Run must settle successfully').toBe(
    true,
  )
  yield* fixture.rpc.WatchThread({ id: fixture.threadId }).pipe(
    Stream.filter((detail) =>
      detail.runs.some((run) => run.id === runId && RunState.guards.Completed(run.state)),
    ),
    Stream.runHead,
  )
  return yield* waitForState(fixture.conversation, (state) =>
    state.settlements.some((settled) => settled.submissionId === runId),
  )
})

/** Tool receipts stay SDK-typed until their arbitrary provider output is decoded by each proof. */
export function toolParts(state: FlueConversationState) {
  return state.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : [])),
  )
}

/** Require a final, observable answer; tool receipts alone must not be called an answered request. */
export function replyText(state: FlueConversationState) {
  return state.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n')
}
