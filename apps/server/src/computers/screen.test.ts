import * as NodeHttp from 'node:http'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { ComputerState, Person } from '@vivid/contracts'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as Socket from 'effect/unstable/socket/Socket'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { personTable } from '../auth/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer, testConfigLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { dockerCommand, dockerMachineLayer } from './docker.ts'
import { Machine } from './machine.ts'
import {
  ComputerStore,
  computerStoreLayer,
  computerMachineKey,
  computerScreenAddress,
} from './store.ts'
import { computers } from './tables.ts'
import { computerScreenRoutes } from './screen.ts'

const image = 'vivid-computer:test'
const context = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '../../../..',
  'infra/computer',
)
const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  silentChangesLayer,
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
  const machine = yield* Machine
  const running = yield* machine.ensure(key)
  const database = yield* Database
  yield* database.run(
    database.insert(computers).values({
      id: NodeCrypto.randomUUID(),
      personId: person.id,
      machine: key,
      status: 'running',
      since: running.since,
      reason: null,
      held: false,
      createdAt: running.since,
    }),
  )
  return key
})

describe.skipIf(process.env.VIVID_TEST_DOCKER !== '1' || !testDatabaseConfigured)(
  'Authenticated Computer screen',
  () => {
    it.live(
      'proxies noVNC assets and both WebSocket directions only for the owning Person',
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
          const running = yield* (yield* Machine).ensure(key)
          expect((yield* HttpClient.get(running.screenAddress)).status).toBe(403)
          const direct = new URL('/websockify', running.screenAddress)
          direct.protocol = 'ws:'
          const unauthenticated = yield* connection(
            direct.href,
            '',
            new URL(running.screenAddress).origin,
          ).pipe(Effect.scoped, Effect.result)
          expect(unauthenticated._tag).toBe('Failure')
          const origin = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
          const address = `${origin}${computerScreenAddress}`
          expect((yield* HttpClient.get(address)).status).toBe(404)
          expect(
            (yield* HttpClient.get(address, { headers: { cookie: second.cookie } })).status,
          ).toBe(404)
          const document = yield* HttpClient.get(address, { headers: { cookie: first.cookie } })
          expect(document.status).toBe(200)
          expect(yield* document.text).toContain('noVNC')
          expect(document.headers['cache-control']).toBe('no-store')
          const asset = yield* HttpClient.get(`${origin}/api/computer/screen/core/rfb.js`, {
            headers: { cookie: first.cookie },
          })
          expect(asset.status).toBe(200)
          expect(yield* asset.text).toContain('RFB')
          const url = new URL(`${origin}/api/computer/screen/websockify`)
          url.protocol = 'ws:'
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* connection(url.href, first.cookie, origin)
              const greeting = yield* client.reader.pull
              const bytes = greeting.flatMap((frame) =>
                Array.from(frame instanceof Uint8Array ? frame : new TextEncoder().encode(frame)),
              )
              expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe('RFB 003.008\n')
              yield* client.writer.write(new TextEncoder().encode('RFB 003.008\n'))
              const security = yield* client.reader.pull
              expect(
                security.flatMap((frame) =>
                  Array.from(frame instanceof Uint8Array ? frame : new TextEncoder().encode(frame)),
                ),
              ).toEqual([1, 1])
            }),
          )
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
