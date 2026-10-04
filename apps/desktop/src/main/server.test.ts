import * as NodeHttp from 'node:http'
import { DeviceLink } from '../shared/device.ts'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import * as Schema from 'effect/Schema'
import { ServerAddress, ServerSettings, ServerChoice } from '../shared/settings.ts'
import { DesktopSettings, settingsLayer } from './settings.ts'
import { chooseServer } from './server.ts'
import {
  BridgeRequest,
  BridgeResponse,
  InvalidBridgeMessage,
  encodeBridgeResponse,
} from '../shared/bridge.ts'
import { handleBridgeRequest, type BridgeHandlers } from './requests.ts'
import { isAllowedBridgeRequest } from './security.ts'
import { handleAppRequest } from './proxy.ts'
import { PageUnavailable, PageLimitReached, PagesRequest, PagesResponse } from '../shared/pages.ts'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'

class FixtureFailed extends Schema.TaggedError<FixtureFailed>()(
  'FixtureFailed',
  {},
  { title: 'Desktop test fixture failed' },
) {}

/** Real ephemeral HTTP listeners exercise the production HttpClient, without Electron or app data. */
const fixture = (
  respond: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, FixtureFailed>((resume) => {
      const server = NodeHttp.createServer(respond)
      server.once('error', () => resume(Effect.fail(new FixtureFailed({}))))
      server.listen(0, '127.0.0.1', () => resume(Effect.succeed(server)))
      return Effect.sync(() => server.close())
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections()
        server.close()
      }),
  )

const decodeListener = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))

/** Convert the real bound port into a valid local origin, refusing an unexpected listener shape. */
const originOf = Effect.fn('DesktopFixture.origin')(function* (server: NodeHttp.Server) {
  const address = yield* decodeListener(server.address()).pipe(
    Effect.mapError(() => new FixtureFailed({})),
  )
  return ServerAddress.make(`http://127.0.0.1:${address.port}`)
})

/** Every settings fixture is removed even when the network or assertion fails. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-desktop-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

/** These tests are about the server choice; this computer is simply not linked in them. */
const unlinked = { state: () => DeviceLink.cases.SignedOut.make({}), wake: () => {} }

describe('desktop server selection', () => {
  /** A native allocation refusal survives IPC encoding as a renderer-readable domain receipt. */
  it.effect('returns the native page limit through the public bridge', () =>
    Effect.gen(function* () {
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const reason = new PageLimitReached({ limit: 12 })
        const handlers: BridgeHandlers = {
          settings,
          getAppVersion: () => '1.0.0',
          device: unlinked,
          openExternal: () => Effect.void,
          pages: () => Effect.fail(reason),
          onServerChanged: () => {},
        }
        expect(
          yield* handleBridgeRequest(
            BridgeRequest.cases.Pages.make({
              request: PagesRequest.cases.Open.make({ address: 'https://example.com/' }),
            }),
            handlers,
            () => true,
          ),
        ).toEqual(
          yield* encodeBridgeResponse(
            BridgeResponse.cases.Pages.make({
              value: PagesResponse.cases.Rejected.make({ reason }),
            }),
          ),
        )
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )
  it.effect('denies selected-server documents before shell settings or browsing can change', () =>
    Effect.gen(function* () {
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const changes: string[] = []
        const handlers: BridgeHandlers = {
          pages: () => Effect.fail(new PageUnavailable({})),
          settings,
          getAppVersion: () => '1.0.0',
          device: unlinked,
          openExternal: () => Effect.sync(() => changes.push('external')),
          onServerChanged: (state) => changes.push(state._tag),
        }
        const server = ServerSettings.cases.Server.make({
          origin: ServerAddress.make('https://vivid.example'),
        })
        const authorize = (request: BridgeRequest) =>
          isAllowedBridgeRequest(
            'https://vivid.example/api/document',
            server,
            'file:///application/chooser.html',
            request,
          )
        for (const request of [
          BridgeRequest.cases.ChooseServer.make({
            origin: ServerAddress.make('https://other.example'),
          }),
          BridgeRequest.cases.ForgetServer.make({}),
          BridgeRequest.cases.GetServer.make({}),
          BridgeRequest.cases.OpenExternal.make({ url: 'https://other.example' }),
        ])
          expect(
            yield* handleBridgeRequest(request, handlers, authorize).pipe(Effect.flip),
          ).toBeInstanceOf(InvalidBridgeMessage)
        expect(
          yield* handleBridgeRequest(
            BridgeRequest.cases.GetAppVersion.make({}),
            handlers,
            authorize,
          ),
        ).toEqual(BridgeResponse.cases.AppVersion.make({ value: '1.0.0' }))
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
        expect(changes).toEqual([])
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.live('verifies /health before saving and bridge forget returns to the chooser', () =>
    Effect.gen(function* () {
      const server = yield* fixture((request, response) => {
        expect(request.url).toBe('/health')
        expect(request.headers.cookie).toBeUndefined()
        expect(request.headers.authorization).toBeUndefined()
        response.end('{"ok":true,"service":"vivid"}')
      })
      const origin = yield* originOf(server)
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const changes: string[] = []
        const handlers: BridgeHandlers = {
          settings,
          getAppVersion: () => '1.0.0',
          device: unlinked,
          openExternal: () => Effect.void,
          pages: () => Effect.fail(new PageUnavailable({})),
          onServerChanged: (state) => changes.push(state._tag),
        }
        expect(
          yield* handleBridgeRequest(
            BridgeRequest.cases.ChooseServer.make({ origin }),
            handlers,
            () => true,
          ),
        ).toEqual(
          BridgeResponse.cases.ServerChoice.make({ value: ServerChoice.cases.Chosen.make({}) }),
        )
        expect(yield* settings.get).toEqual(ServerSettings.cases.Server.make({ origin }))
        expect(
          yield* handleBridgeRequest(
            BridgeRequest.cases.ForgetServer.make({}),
            handlers,
            () => true,
          ),
        ).toEqual(BridgeResponse.cases.Forgotten.make({}))
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
        expect(changes).toEqual(['Server', 'NoServer'])
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.live('does not save a reachable non-Vivid server', () =>
    Effect.gen(function* () {
      const server = yield* fixture((_request, response) =>
        response.end('{"ok":true,"service":"other"}'),
      )
      const origin = yield* originOf(server)
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        expect(yield* chooseServer(origin, settings)).toEqual(ServerChoice.cases.NotVivid.make({}))
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
        expect(NodeFS.readdirSync(root)).toEqual([])
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.live('does not follow health redirects to a different origin', () =>
    Effect.gen(function* () {
      let foreignRequests = 0
      const foreign = yield* fixture((_request, response) => {
        foreignRequests++
        response.end('{"ok":true,"service":"vivid"}')
      })
      const destination = yield* originOf(foreign)
      const redirecting = yield* fixture((_request, response) => {
        response.writeHead(307, { location: `${destination}/health` })
        response.end()
      })
      const root = yield* directory
      const origin = yield* originOf(redirecting)
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const result = yield* chooseServer(origin, settings)
        expect(result._tag).toBe('Unreachable')
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
        expect(foreignRequests).toBe(0)
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.live('reports an unreachable server without losing the existing selection', () =>
    Effect.gen(function* () {
      const server = yield* fixture((request) => request.socket.destroy())
      const origin = yield* originOf(server)
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const before = yield* settings.set(ServerAddress.make('https://vivid.example'))
        expect((yield* chooseServer(origin, settings))._tag).toBe('Unreachable')
        expect(yield* settings.get).toEqual(before)
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.effect('bounds a stalled real health probe with the controllable clock', () =>
    Effect.gen(function* () {
      const server = yield* fixture(() => undefined)
      const origin = yield* originOf(server)
      const root = yield* directory
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const received = yield* Effect.callback<void>((resume) => {
          const accept = (): void => resume(Effect.void)
          server.once('request', accept)
          return Effect.sync(() => server.off('request', accept))
        }).pipe(Effect.forkScoped)
        const choosing = yield* chooseServer(origin, settings).pipe(Effect.forkScoped)
        yield* Fiber.join(received)
        yield* TestClock.adjust('3 seconds')
        expect(yield* Fiber.join(choosing)).toEqual(
          ServerChoice.cases.Unreachable.make({
            reason: 'The server did not respond within 3 seconds.',
          }),
        )
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
      }).pipe(Effect.provide(settingsLayer(NodePath.join(root, 'settings.json'))))
    }),
  )

  it.live(
    'names the chosen server as the origin of a request Chromium handed over without one',
    () =>
      Effect.gen(function* () {
        const seen: Array<Option.Option<string>> = []
        const server = yield* fixture((request, response) => {
          seen.push(Option.fromUndefinedOr(request.headers.origin))
          response.end('{}')
        })
        const origin = yield* originOf(server)
        const root = yield* directory
        const settings = ServerSettings.cases.Server.make({ origin })
        const send = (headers: Record<string, string>) =>
          handleAppRequest(
            root,
            new Request(`${origin}/api/auth/sign-up/email`, {
              method: 'POST',
              headers,
              body: '{}',
            }),
            settings,
          )
        expect((yield* send({})).status).toBe(200)
        // One that does say where it came from is forwarded as it said.
        expect((yield* send({ origin: 'https://elsewhere.example' })).status).toBe(200)
        expect(seen).toEqual([Option.some(origin), Option.some('https://elsewhere.example')])
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  )

  it.effect(
    'rejects foreign API requests before entering the credential-bearing forwarding client',
    () =>
      Effect.gen(function* () {
        const root = yield* directory
        for (const settings of [
          ServerSettings.cases.NoServer.make({}),
          ServerSettings.cases.Server.make({ origin: ServerAddress.make('https://vivid.example') }),
        ]) {
          expect(
            (yield* handleAppRequest(
              root,
              new Request('https://foreign.example/api/rpc'),
              settings,
            )).status,
          ).toBe(403)
        }
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  )
})
