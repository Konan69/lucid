import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Deferred, Effect, Option, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type { PoolClient } from 'pg'
import { onTestFinished } from 'vitest'
import { StorageDisconnected } from './main.ts'
import { postgresFixture, rejected } from './testing.ts'

const decodePid = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Finite }))
const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])

/** Observe the real pool's public acquisition event without replacing any driver
 * operation. Capture listener counts before the adapter attaches its own handlers. */
function captureConnection(fixture: ReturnType<typeof postgresFixture>) {
  let connection = Option.none<{
    client: PoolClient
    endListeners: number
    errorListeners: number
  }>()
  fixture.pool.once('acquire', (client: PoolClient) => {
    connection = Option.some({
      client,
      endListeners: client.listenerCount('end'),
      errorListeners: client.listenerCount('error'),
    })
  })
  return () => Option.getOrThrow(connection)
}

/** Driver callbacks settle a test signal, so assertions wait for actual socket
 * termination rather than a timer. Both error and end must share one failure. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL disconnection signal', () => {
  it.live('reports backend termination before any subsequent storage call', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const captured = captureConnection(fixture)
      const storage = yield* Effect.promise(() => fixture.open())
      const { client } = captured()
      const ended = yield* Deferred.make<void>()
      const errors: Error[] = []
      const notifications: StorageDisconnected[] = []
      const observed = storage.disconnected.then((failure) => {
        notifications.push(failure)
      })
      const onError = (cause: Error) => errors.push(cause)
      const onEnd = () => Deferred.doneUnsafe(ended, Effect.void)
      client.on('error', onError)
      client.once('end', onEnd)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          client.removeListener('error', onError)
          client.removeListener('end', onEnd)
        }),
      )
      const result = yield* Effect.promise(() => client.query('SELECT pg_backend_pid() AS pid'))
      const { pid } = decodePid(result.rows[0])
      yield* Effect.promise(() =>
        fixture.pool.query('SELECT pg_terminate_backend($1, 1000)', [pid]),
      )
      const disconnected = yield* Effect.promise(() => storage.disconnected)
      yield* Deferred.await(ended)
      yield* Effect.promise(() => observed)
      // pg can emit a FATAL error and then its socket-termination error. Neither
      // the second error nor end may replace the first failure or notify again.
      expect(errors.length).toBeGreaterThan(0)
      expect(notifications).toEqual([disconnected])
      expect(disconnected).toBeInstanceOf(StorageDisconnected)
      expect(disconnected.schema).toBe(fixture.schema)
      expect(disconnected.cause).toBe(errors[0])
      expect(yield* Effect.promise(() => storage.disconnected)).toBe(disconnected)
      expect((yield* rejected(() => storage.mintId())).cause).toBe(disconnected)
    }),
  )

  /** pg Client.end is a public host action: it emits end without error. Only
   * this storage's own close is exempt, so an externally ended lease is dead. */
  it.live('reports a host-ended connection even without a driver error event', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const captured = captureConnection(fixture)
      const storage = yield* Effect.promise(() => fixture.open())
      const { client } = captured()
      const errors: Error[] = []
      const onError = (cause: Error) => errors.push(cause)
      client.on('error', onError)
      yield* Effect.addFinalizer(() => Effect.sync(() => client.removeListener('error', onError)))
      yield* Effect.promise(() => client.end())
      expect(errors).toEqual([])
      const disconnected = yield* Effect.promise(() => storage.disconnected)
      expect(disconnected).toBeInstanceOf(StorageDisconnected)
      expect(disconnected.schema).toBe(fixture.schema)
      expect(disconnected.cause).toBeInstanceOf(Error)
      expect(yield* Effect.promise(() => storage.disconnected)).toBe(disconnected)
      expect((yield* rejected(() => storage.mintId())).cause).toBe(disconnected)
    }),
  )

  /** The competing value is created after close settles. Removing the adapter's
   * listeners also prevents later host pool shutdown from resolving the signal. */
  it.live('leaves the signal pending after clean close and removes its listeners', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const captured = captureConnection(fixture)
      const storage = yield* Effect.promise(() => fixture.open())
      const { client, endListeners, errorListeners } = captured()
      expect(client.listenerCount('end')).toBe(endListeners + 1)
      yield* Effect.promise(() => storage.close(BACKGROUND_CONTEXT))
      expect(client.listenerCount('end')).toBe(endListeners)
      expect(client.listenerCount('error')).toBe(errorListeners)
      const winner = yield* Effect.promise(() =>
        Promise.race([storage.disconnected.then(() => 'disconnected'), Promise.resolve('closed')]),
      )
      expect(winner).toBe('closed')
    }),
  )

  /** A pending Deferred/Promise must create no event-loop handle. The child
   * closes its storage and pool, then exits naturally without process.exit. */
  it.live('lets a cleanly closed host exit naturally with a pending signal', () =>
    Effect.gen(function* () {
      const fixture = postgresFixture(Option.getOrThrow(testUrl))
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL('./fixtures/close/main.ts', import.meta.url)),
          fixture.schema,
        ],
        {
          stdio: 'pipe',
          env: { ...process.env, VIVID_TEST_DATABASE_URL: Option.getOrThrow(testUrl) },
        },
      )
      onTestFinished(() => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
        const closed = NodeEvents.EventEmitter.once(child, 'close')
        child.kill('SIGKILL')
        return closed.then(() => {})
      })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        stderr += text
      })
      const [exitCode, signal] = yield* Effect.promise(() =>
        NodeEvents.EventEmitter.once(child, 'close'),
      )
      expect({ exitCode, signal, stderr }).toEqual({ exitCode: 0, signal: null, stderr: '' })
    }),
  )
})
