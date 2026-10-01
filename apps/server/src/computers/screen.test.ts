import * as NodeHttp from 'node:http'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it, layer } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Redacted, Stream } from 'effect'
import { ComputerState, Person, PersonId, SessionId } from '@vivid/contracts'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as Socket from 'effect/unstable/socket/Socket'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import * as TestClock from 'effect/testing/TestClock'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer, testConfigLayer } from '../database/testdb.ts'
import { Changes, Topic, changesLayer, silentChangesLayer } from '../live/changes.ts'
import { dockerCommand, dockerMachineLayer } from './docker.ts'
import { Machine, unavailableMachineLayer } from './machine.ts'
import {
  ComputerStore,
  computerStoreLayer,
  computerMachineKey,
  computerScreenAddress,
} from './store.ts'
import { computerScreenRoutes, screenLifetime, screenOriginAllowed } from './screen.ts'

const image = 'vivid-computer:test'
const context = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '../../../..',
  'infra/computer',
)
const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  changesLayer.pipe(Layer.provide(testDatabaseLayer)),
  dockerMachineLayer(image),
  NodeServices.layer,
  NodeHttpClient.layerUndici,
)
const stores = computerStoreLayer.pipe(Layer.provideMerge(dependencies))
const server = HttpRouter.serve(computerScreenRoutes, {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: '127.0.0.1', port: 0 })),
  Layer.provideMerge(stores),
)

/** The production auth adapter creates and signs the cookie; the test does not invent an identity token. */
const signIn = Effect.fn('Computer.screen.test.signIn')(function* (email: string) {
  const auth = yield* authEffect
  const response = yield* auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request('http://127.0.0.1:8787/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email,
            name: 'Screen test',
            password: 'test-Computer-0123456789',
          }),
        }),
      ),
    ),
    Effect.provide(localAuthRuntimeLayer),
  )
  expect(response.status).toBe(200)
  const cookie = Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')
  expect(cookie.length).toBeGreaterThan(0)
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(personTable).where(eq(personTable.email, email)),
  )
  const person = rows[0]
  if (person === undefined) expect.fail('Sign-up must persist the screen test Person.')
  return { person: yield* decodeStored(Person, 'screen test Person')(person), cookie }
})

/** The public Node socket adapter supplies a real client with cookie headers; Effect owns its scope and binary frames. */
const connection = Effect.fn('Computer.screen.test.connection')(function* (
  address: string,
  cookie: string,
  origin: string,
) {
  const socket = yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(
        () => new NodeSocket.NodeWS.WebSocket(address, ['binary'], { headers: { cookie, origin } }),
      ),
      (client) => Effect.sync(() => client.close(1000)),
    ),
  )
  return { reader: yield* socket.reader, writer: yield* socket.writer }
})

/** Exact resource names are registered before ensure so interrupted setup cannot leave a Person's test machine running. */
const machineFixture = Effect.fn('Computer.screen.test.machine')(function* (person: Person) {
  const key = computerMachineKey(person.id)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const removed = yield* dockerCommand(['container', 'rm', '--force', `vivid-computer-${key}`])
      expect(removed.exitCode).toBe(0)
      const network = yield* dockerCommand(['network', 'rm', `vivid-computer-network-${key}`])
      expect(network.exitCode).toBe(0)
      const volume = yield* dockerCommand(['volume', 'rm', `vivid-computer-home-${key}`])
      expect(volume.exitCode).toBe(0)
    }).pipe(
      Effect.catch(() => Effect.sync(() => expect.fail('Screen test Docker cleanup failed.'))),
    ),
  )
  const changes = yield* Changes
  const store = yield* ComputerStore
  const moved = yield* changes.subscribe([Topic.person(person.id)])
  expect((yield* store.start(person.id)).state._tag).toBe('Starting')
  const ready = yield* Stream.concat(Stream.make(undefined), moved).pipe(
    Stream.mapEffect(() => store.get(person.id)),
    Stream.filter((computer) => ComputerState.isAnyOf(['Running', 'Failed'])(computer.state)),
    Stream.runHead,
  )
  if (Option.isNone(ready)) expect.fail('Computer startup must publish its terminal receipt.')
  expect(ready.value.state._tag).toBe('Running')
  if (ComputerState.guards.Running(ready.value.state))
    expect(ready.value.state.screenAddress).toBe('/api/computer/screen/websockify')
  return key
})

/** WebSocket frames may be text or binary; protocol assertions use their exact UTF-8 bytes. */
const frameBytes = (frames: ReadonlyArray<Uint8Array | string>) =>
  frames.flatMap((frame) =>
    Array.from(frame instanceof Uint8Array ? frame : new TextEncoder().encode(frame)),
  )

/** Complete RFB's None-security handshake through the cookie proxy; the client never receives or supplies a credential. */
const desktop = Effect.fn('Computer.screen.test.desktop')(function* (
  address: string,
  cookie: string,
  origin: string,
) {
  const client = yield* connection(address, cookie, origin)
  const greeting = yield* client.reader.pull
  const bytes = frameBytes(greeting)
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('RFB 003.008\n')
  yield* client.writer.write(new TextEncoder().encode('RFB 003.008\n'))
  const security = yield* client.reader.pull
  expect(frameBytes(security)).toEqual([1, 1])
  yield* client.writer.write(new Uint8Array([1]))
  const accepted = yield* client.reader.pull
  expect(frameBytes(accepted)).toEqual([0, 0, 0, 0])
  yield* client.writer.write(new Uint8Array([1]))
  const initialized = yield* client.reader.pull
  const header = frameBytes(initialized)
  expect(header.length).toBeGreaterThanOrEqual(24)
  const view = new DataView(new Uint8Array(header).buffer)
  expect(view.getUint16(0)).toBeGreaterThan(0)
  expect(view.getUint16(2)).toBeGreaterThan(0)
})

describe.skipIf(process.env.VIVID_TEST_DOCKER !== '1' || !testDatabaseConfigured)(
  'Authenticated Computer screen',
  () => {
    it.live(
      'serves only an authenticated RFB upgrade for the owning Person, without a browser credential',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          const emails = [1, 2].map(() => `computer-screen-${NodeCrypto.randomUUID()}@example.test`)
          yield* Effect.addFinalizer(() =>
            database
              .run(database.delete(personTable).where(inArray(personTable.email, emails)))
              .pipe(
                Effect.asVoid,
                Effect.catch(() =>
                  Effect.sync(() => expect.fail('Screen test database cleanup failed.')),
                ),
              ),
          )
          const firstEmail = emails[0]
          const secondEmail = emails[1]
          if (firstEmail === undefined || secondEmail === undefined)
            expect.fail('Two screen test emails are required.')
          const first = yield* signIn(firstEmail)
          const second = yield* signIn(secondEmail)
          const built = yield* ChildProcess.make('docker', ['build', '--tag', image, context], {
            stdout: 'inherit',
            stderr: 'inherit',
          })
          expect(yield* built.exitCode).toBe(0)
          const key = yield* machineFixture(first.person)
          const endpoint = yield* (yield* Machine).screen(key)
          const direct = new URL(endpoint.address)
          const unauthenticated = yield* connection(direct.href, '', 'http://vivid.local').pipe(
            Effect.scoped,
            Effect.result,
          )
          expect(unauthenticated._tag).toBe('Failure')
          const serverOrigin = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
          const origin = 'http://127.0.0.1:8787'
          const address = `${serverOrigin}${computerScreenAddress}`
          expect((yield* HttpClient.get(address)).status).toBe(404)
          expect(
            (yield* HttpClient.get(address, { headers: { cookie: second.cookie } })).status,
          ).toBe(404)
          for (const path of [
            computerScreenAddress,
            '/api/computer/screen/vnc.html',
            '/api/computer/screen/core/rfb.js',
          ]) {
            const response = yield* HttpClient.get(`${serverOrigin}${path}`, {
              headers: { cookie: first.cookie },
            })
            expect(response.status).toBe(404)
            expect(response.headers['cache-control']).toBe('no-store')
          }
          expect(
            (yield* HttpClient.post(address, { headers: { cookie: first.cookie } })).status,
          ).toBe(404)
          const url = new URL(address)
          url.protocol = 'ws:'
          yield* desktop(url.href, first.cookie, origin).pipe(Effect.scoped)
          const anonymous = yield* connection(url.href, '', origin).pipe(
            Effect.scoped,
            Effect.result,
          )
          expect(anonymous._tag).toBe('Failure')
          const assetUpgrade = new URL(`${serverOrigin}/api/computer/screen/vnc.html`)
          assetUpgrade.protocol = 'ws:'
          const assetRefused = yield* connection(assetUpgrade.href, first.cookie, origin).pipe(
            Effect.scoped,
            Effect.result,
          )
          expect(assetRefused._tag).toBe('Failure')
          const refused = yield* connection(url.href, second.cookie, origin).pipe(
            Effect.scoped,
            Effect.result,
          )
          expect(refused._tag).toBe('Failure')
          const crossOrigin = yield* connection(
            url.href,
            first.cookie,
            'https://example.test',
          ).pipe(Effect.scoped, Effect.result)
          expect(crossOrigin._tag).toBe('Failure')
          const store = yield* ComputerStore
          yield* store.stop(first.person.id)
          expect((yield* store.get(first.person.id)).state._tag).toBe('Stopped')
          expect(
            (yield* HttpClient.get(address, { headers: { cookie: first.cookie } })).status,
          ).toBe(404)
          expect(ComputerState.guards.Stopped(yield* (yield* Machine).status(key))).toBe(true)
          expect(Option.isNone(yield* store.screen(second.person.id))).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(server)),
      180000,
    )
  },
)

describe('Computer screen browser origin', () => {
  it('requires the configured scheme, host and port, including behind a Host-rewriting proxy', () => {
    const publicUrl = new URL('https://vivid.example:8443')
    expect(screenOriginAllowed(Option.some('https://vivid.example:8443'), publicUrl)).toBe(true)
    for (const origin of [
      'http://vivid.example:8443',
      'https://vivid.example',
      'https://other.example:8443',
      'null',
      'malformed',
      'https://vivid.example:8443/path',
    ])
      expect(screenOriginAllowed(Option.some(origin), publicUrl)).toBe(false)
    expect(screenOriginAllowed(Option.none(), publicUrl)).toBe(false)
  })
})

const lifetimeDependencies = Layer.mergeAll(testDatabaseLayer, testConfigLayer, silentChangesLayer)
const lifetimeStores = computerStoreLayer.pipe(
  Layer.provideMerge(lifetimeDependencies),
  Layer.provide(unavailableMachineLayer),
)

/** Session persistence is real; a controlled Computer endpoint isolates lifetime from Docker availability. */
const lifetimeFixture = Effect.fn('Computer.screen.test.lifetime')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, personId))).pipe(
      Effect.tapError((error) => Effect.logError('Screen lifetime cleanup failed', error._tag)),
      Effect.ignore,
    ),
  )
  yield* TestClock.setTime(0)
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Lifetime', email: `${personId}@screen.test` }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: personId,
      token: NodeCrypto.randomUUID(),
      expiresAt: new Date(60_000),
    }),
  )
  const moved = yield* PubSub.unbounded<void>()
  const checked = yield* Deferred.make<void>()
  const stopped = yield* Deferred.make<void>()
  const store = yield* ComputerStore
  const controlled = ComputerStore.of({
    ...store,
    screen: Effect.fn('Computer.screen.test.endpoint')(function* () {
      yield* Deferred.succeed(checked, undefined)
      if (yield* Deferred.isDone(stopped)) return Option.none()
      return Option.some({
        address: 'ws://127.0.0.1:1',
        authorization: Redacted.make('test-screen'),
      })
    }),
  })
  const changes = Changes.of({
    publish: () => PubSub.publish(moved, undefined).pipe(Effect.asVoid),
    subscribe: () => PubSub.subscribe(moved).pipe(Effect.map(Stream.fromSubscription)),
  })
  const lifetime = yield* screenLifetime({ personId, sessionId }).pipe(
    Effect.provideService(ComputerStore, controlled),
    Effect.provideService(Changes, changes),
  )
  const worker = yield* lifetime.pipe(Effect.forkChild)
  yield* Deferred.await(checked)
  return { database, personId, sessionId, moved, stopped, worker }
})

describe.skipIf(!testDatabaseConfigured)('Computer screen lifetime', () => {
  layer(lifetimeStores)((test) => {
    test.effect(
      'revokes screen authority after session deletion without a change notification',
      () =>
        Effect.gen(function* () {
          const fixture = yield* lifetimeFixture()
          yield* fixture.database.run(
            fixture.database.delete(sessionTable).where(eq(sessionTable.id, fixture.sessionId)),
          )
          yield* TestClock.adjust('5 seconds')
          expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
        }),
    )
    test.effect('revokes screen authority at session expiry using the controllable clock', () =>
      Effect.gen(function* () {
        const fixture = yield* lifetimeFixture()
        yield* TestClock.adjust('60 seconds')
        expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
      }),
    )
    test.effect('revokes screen authority when the Computer stops and publishes its change', () =>
      Effect.gen(function* () {
        const fixture = yield* lifetimeFixture()
        yield* Deferred.succeed(fixture.stopped, undefined)
        yield* PubSub.publish(fixture.moved, undefined)
        expect(yield* Fiber.join(fixture.worker)).toBeUndefined()
      }),
    )
  })
})
