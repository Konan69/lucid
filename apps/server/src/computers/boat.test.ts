import * as NodeCrypto from 'node:crypto'
import * as NodeBuffer from 'node:buffer'
import * as NodeHttp from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState, DesktopAction } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { ConfigProvider, Context, Effect, Layer, Option, Ref, Schema, Predicate } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { boatMachineLayer } from './boat.ts'
import { Machine, MachineKey } from './machine.ts'
import * as TestClock from 'effect/testing/TestClock'
import { machineBindings } from './tables.ts'
import * as Protocol from './boat/protocol.ts'
import { argumentsByTool } from './boat/fixture.ts'
import { ComputerActionRefused, ComputerToolRefused } from './boat/refusal.ts'
import { driver } from './boat/driver.ts'
import { transport } from './boat/transport.ts'
import { guestCommand } from './boat/guest.ts'

// Deliberate PNG fixture, not a claim that the guest was exercised.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9f8AAAAASUVORK5CYII='
const id = 'bx_23456789'
interface EvidenceService {
  readonly state: Ref.Ref<'ready' | 'archived'>
  readonly created: Ref.Ref<number>
  readonly intents: Ref.Ref<ReadonlyArray<string>>
  readonly commands: Ref.Ref<ReadonlyArray<string>>
  readonly files: Ref.Ref<ReadonlyMap<string, string>>
  readonly calls: Ref.Ref<ReadonlyArray<string>>
  readonly address: Ref.Ref<string>
  readonly text: Ref.Ref<string>
  readonly grounded: Ref.Ref<boolean>
  readonly missingBounds: Ref.Ref<boolean>
  readonly noType: Ref.Ref<boolean>
  readonly snapshots: Ref.Ref<number>
  readonly active: Ref.Ref<boolean | null>
  readonly extraTab: Ref.Ref<boolean>
  readonly prepared: Ref.Ref<ReadonlySet<string>>
  readonly breakCreate: Ref.Ref<boolean>
  readonly breakCommand: Ref.Ref<boolean>
  readonly refuseBrowser: Ref.Ref<boolean>
  readonly viewers: Ref.Ref<number>
  readonly publicViewer: Ref.Ref<boolean>
  readonly malformed: Ref.Ref<boolean>
  readonly wrongIdentity: Ref.Ref<boolean>
  /** The organization every request must name as the payer; none when the key's own account pays. */
  readonly org: Ref.Ref<Option.Option<string>>
}
class Evidence extends Context.Service<Evidence, EvidenceService>()('vivid/BoatProtocolEvidence') {}
const evidenceLayer = Layer.effect(
  Evidence,
  Effect.gen(function* () {
    return Evidence.of({
      state: yield* Ref.make<'ready' | 'archived'>('ready'),
      created: yield* Ref.make(0),
      intents: yield* Ref.make<ReadonlyArray<string>>([]),
      commands: yield* Ref.make<ReadonlyArray<string>>([]),
      files: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
      calls: yield* Ref.make<ReadonlyArray<string>>([]),
      address: yield* Ref.make('https://example.com'),
      text: yield* Ref.make(''),
      grounded: yield* Ref.make(false),
      missingBounds: yield* Ref.make(false),
      noType: yield* Ref.make(false),
      snapshots: yield* Ref.make(0),
      active: yield* Ref.make<boolean | null>(true),
      extraTab: yield* Ref.make(false),
      prepared: yield* Ref.make<ReadonlySet<string>>(new Set()),
      breakCreate: yield* Ref.make(false),
      breakCommand: yield* Ref.make(false),
      refuseBrowser: yield* Ref.make(false),
      viewers: yield* Ref.make(0),
      publicViewer: yield* Ref.make(false),
      malformed: yield* Ref.make(false),
      wrongIdentity: yield* Ref.make(false),
      org: yield* Ref.make(Option.some('personal')),
    })
  }),
)
const Create = HttpServerRequest.schemaBodyJson(Protocol.CreateRequest)
const Input = HttpServerRequest.schemaBodyJson(
  Schema.Struct({
    command: Schema.String,
    timeoutSeconds: Schema.Int,
    detached: Schema.Literal(false),
    stream: Schema.Literal(false),
  }),
)
const File = HttpServerRequest.schemaBodyJson(
  Schema.Struct({ path: Schema.String, content: Schema.String, encoding: Schema.Literal('utf8') }),
)
const Viewer = HttpServerRequest.schemaBodyJson(
  Schema.Struct({ publicAccess: Schema.Literal(false) }),
)
const Stop = HttpServerRequest.schemaBodyJson(Schema.Struct({ force: Schema.Literal(false) }))
const Resume = HttpServerRequest.schemaBodyJson(
  Schema.Struct({ ttlSeconds: Schema.NullOr(Protocol.Lifetime), noEnv: Schema.Literal(true) }),
)
const decodeSession = Schema.decodeUnknownEffect(Schema.String.check(Schema.isStartsWith('Vivid-')))
const decodeAddress = Schema.decodeUnknownEffect(Schema.String)
const decodeArgs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)
const record = (state: 'ready' | 'archived') => ({
  id,
  name: 'Fixture',
  state,
  desktopAvailable: state === 'ready',
  snapshotAvailable: state === 'archived',
})
const rejected = (status: number) =>
  HttpServerResponse.jsonUnsafe(
    {
      ok: false,
      type: 'error',
      requestId: 'fixture',
      error: { code: 'fixture_failure', message: 'fixture', status },
    },
    { status },
  )
const commandReply = (stdout: string) =>
  HttpServerResponse.jsonUnsafe({
    ok: true,
    type: 'command.finished',
    success: true,
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
  })

/** The guest fixture speaks actual Cua CLI JSON; unexpected tools fail the fixture. */
const native = Effect.fn('BoatTest.native')(function* (evidence: EvidenceService, command: string) {
  const match = /(?:cua-driver|\/driver) call '([a-z_]+)'/.exec(command)
  if (match === null || match[1] === undefined) return commandReply('{"window":"Fixture Chrome"}')
  const tool = match[1]
  yield* Ref.update(evidence.calls, (calls) => [...calls, tool])
  const path = /< '([^']+)'$/.exec(command)
  if (path === null || path[1] === undefined) return rejected(400)
  const content = (yield* Ref.get(evidence.files)).get(path[1])
  if (content === undefined) return rejected(400)
  const args = yield* decodeArgs(content)
  const allowed = Object.entries(argumentsByTool).find(([name]) => name === tool)
  if (allowed === undefined) return rejected(400)
  const [, contract] = allowed
  if (
    Object.keys(args).some((name) => !contract.allowed.some((key) => key === name)) ||
    contract.required.some((name) => !Object.hasOwn(args, name))
  )
    return commandReply(
      JSON.stringify({ code: 'invalid_arguments', detail: 'private-fixture-input', tool }),
    )
  if (contract.allowed.some((key) => key === 'session')) yield* decodeSession(args.session)
  switch (tool) {
    case 'get_desktop_state': {
      const output = /--screenshot-out-file '([^']+)'/.exec(command)
      if (output === null || output[1] === undefined) return rejected(400)
      const destination = output[1]
      yield* Ref.update(evidence.files, (files) => new Map(files).set(destination, png))
      return commandReply(
        JSON.stringify({
          screenshot_mime_type: 'image/png',
          screenshot_width: 1,
          screenshot_height: 1,
          screen_width: 1,
          screen_height: 1,
          scale_factor: 1,
          platform: 'linux',
          display: 'primary',
        }),
      )
    }
    case 'browser_prepare': {
      if (yield* Ref.get(evidence.refuseBrowser))
        return commandReply(
          '{"status":"refused","refusal":{"code":"browser_route_unavailable","message":"private-fixture-input"}}',
        )
      expect(args.allow_launch).toBe(false)
      const session = yield* decodeSession(args.session)
      yield* Ref.update(evidence.prepared, (sessions) => new Set(sessions).add(session))
      return commandReply('{"status":"ok","prepared":true}')
    }
    case 'get_cursor_position':
      return commandReply('{"source":"x11","x":0,"y":0}')
    case 'list_windows':
      return commandReply(
        JSON.stringify({
          windows: [
            {
              pid: 7,
              window_id: 9,
              app_name: 'Google Chrome',
              title: 'Example',
              bounds: { x: 0, y: 0, width: 945, height: 920 },
              height: 920,
              width: 945,
              x: 0,
              y: 0,
              is_on_screen: true,
              z_index: 0,
            },
            {
              pid: 11,
              window_id: 12,
              app_name: 'AsciiDesktop',
              title: 'ascii panel',
              bounds: { x: 0, y: 0, width: 1920, height: 40 },
              height: 40,
              width: 1920,
              x: 0,
              y: 0,
              is_on_screen: true,
              z_index: 1,
            },
          ],
        }),
      )
    case 'get_browser_state': {
      const session = yield* decodeSession(args.session)
      if (!(yield* Ref.get(evidence.prepared)).has(session))
        return commandReply('{"status":"refused","refusal":{"code":"consent_required"}}')
      const address = yield* Ref.get(evidence.address)
      if (Object.hasOwn(args, 'snapshot_format')) {
        const snapshot = yield* Ref.updateAndGet(evidence.snapshots, (count) => count + 1)
        return commandReply(
          JSON.stringify({
            status: 'ok',
            mode: 'snapshot',
            page: { url: address, title: 'Example' },
            outline: `button "Continue"\ntextbox "Message": ${yield* Ref.get(evidence.text)}`,
            snapshot: { complete: true },
            refs: [
              { ref: `p${snapshot}:0`, name: null, value: null, actions: [] },
              { ref: `p${snapshot}:1`, name: 'Continue', value: null, actions: ['click'] },
              {
                ref: `p${snapshot}:2`,
                name: 'Message',
                value: yield* Ref.get(evidence.text),
                actions: ['type'],
              },
            ],
          }),
        )
      }
      const tabs = [
        {
          tab_id: 'fixture-tab',
          title: 'Example',
          url: address,
          active: yield* Ref.get(evidence.active),
        },
      ]
      if (yield* Ref.get(evidence.extraTab))
        tabs.push({ tab_id: 'other-tab', title: 'Other', url: 'https://example.org', active: null })
      return commandReply(
        JSON.stringify({
          status: 'ok',
          mode: 'bind',
          target_id: 'fixture-target',
          binding_quality: 'exact',
          tabs,
        }),
      )
    }
    case 'browser_navigate': {
      const address = yield* decodeAddress(args.url)
      yield* Ref.set(evidence.address, address)
      return commandReply(
        JSON.stringify({
          status: 'ok',
          target_id: 'fixture-target',
          tab_id: 'fixture-tab',
          url: address,
          refs_invalidated: true,
        }),
      )
    }
    case 'get_window_state': {
      if (args.query !== undefined) {
        expect(args.pid).toBe(7)
        expect(args.window_id).toBe(9)
        expect(args.query).toBe('Continue')
        const destination = /--screenshot-out-file '([^']+)'/.exec(command)
        if (destination === null || destination[1] === undefined) return rejected(400)
        const picture = destination[1]
        yield* Ref.update(evidence.files, (files) => new Map(files).set(picture, png))
        yield* Ref.set(evidence.grounded, true)
        const frame = (yield* Ref.get(evidence.missingBounds))
          ? undefined
          : { x: 220, y: 140, w: 80, h: 30 }
        return commandReply(
          JSON.stringify({
            pid: 7,
            window_id: 9,
            screenshot_width: 473,
            screenshot_height: 460,
            screenshot_mime_type: 'image/png',
            elements: [
              { role: 'frame', depth: 0, frame: { x: 100, y: 50, w: 945, h: 920 } },
              {
                role: 'link',
                depth: 2,
                label: 'Continue',
                enabled: true,
                in_web_content: true,
                frame,
              },
              // Browser chrome can share a label; it must never receive the page click.
              {
                role: 'push button',
                depth: 1,
                label: 'Continue',
                enabled: true,
                frame: { x: 100, y: 60, w: 30, h: 30 },
              },
            ],
          }),
        )
      }
      return commandReply(
        '{"elements":[{"role":"page tab","label":"Example","element_token":"fixture-token"}]}',
      )
    }
    case 'click': {
      if (args.window_id !== undefined && args.x !== undefined) {
        expect(yield* Ref.getAndSet(evidence.grounded, false)).toBe(true)
        expect(args.x).toBe((160 * 473) / 945)
        expect(args.y).toBe((105 * 460) / 920)
        expect(args.delivery_mode).toBe('foreground')
        yield* Ref.set(evidence.address, 'https://example.com/continued')
      }
      return commandReply(
        '{"effect":"unverifiable","route":"global_input","delivery":{"mode":"foreground"}}',
      )
    }
    case 'move_cursor':
    case 'drag':
    case 'scroll':
    case 'press_key':
    case 'hotkey':
    case 'type_text':
      return commandReply(
        '{"effect":"unverifiable","route":"synthetic_events","delivery":{"mode":"foreground"}}',
      )
    case 'launch_app':
      return commandReply(
        '{"active":false,"bundle_id":null,"name":"google-chrome-stable","pid":7,"running":true,"windows":[]}',
      )
    case 'browser_click':
      expect(args.input_route).toBe('trusted')
      return commandReply(
        '{"effect":"refused","route":"trusted_input","escalation":{"reason":"route_unavailable","target":"page"}}',
      )
    case 'browser_type':
      expect(args.ref).toBe(`p${yield* Ref.get(evidence.snapshots)}:2`)
      expect(args.replace).toBe(true)
      expect(args.text).toBe('private-fixture-input')
      if (!(yield* Ref.get(evidence.noType)))
        yield* Ref.set(evidence.text, yield* decodeAddress(args.text))
      return commandReply(
        '{"effect":"unverifiable","route":"trusted_input","delivery":{"mode":"background"}}',
      )
    default:
      return rejected(400)
  }
})

/** Simulate a minted machine whose first receipt is lost; the next identical intent recovers it. */
const create = Effect.fn('BoatTest.create')(function* (
  evidence: EvidenceService,
  request: HttpServerRequest.HttpServerRequest,
) {
  const body = yield* Create
  expect(body.type).toBe('default')
  expect(body.ttlSeconds).toBe(3600)
  expect(body.noEnv).toBe(true)
  expect(body.snapshots).toBe(true)
  // Provisioning must restore the configured release, including replay after configuration changes.
  expect(body.from).toBe('vivid-computer-protocol-test')
  expect(body.org).toBe(Option.getOrUndefined(yield* Ref.get(evidence.org)))
  const intent = request.headers['idempotency-key']
  expect(intent === undefined).toBe(false)
  if (intent === undefined) return rejected(400)
  const intents = yield* Ref.get(evidence.intents)
  if (!intents.includes(intent)) yield* Ref.update(evidence.created, (value) => value + 1)
  yield* Ref.update(evidence.intents, (values) => [...values, intent])
  if (yield* Ref.get(evidence.breakCreate)) {
    yield* Ref.set(evidence.breakCreate, false)
    return rejected(503)
  }
  return HttpServerResponse.jsonUnsafe({
    ok: true,
    type: 'sandbox.created',
    status: 'ready',
    ttlSeconds: body.ttlSeconds,
    sandbox: record('ready'),
  })
})
const commands = Effect.fn('BoatTest.commands')(function* (evidence: EvidenceService) {
  const input = yield* Input
  yield* Ref.update(evidence.commands, (values) => [...values, input.command])
  if (yield* Ref.get(evidence.breakCommand)) return rejected(502)
  if (input.command.startsWith('umask 077; mkdir')) return commandReply('')
  if (input.command.startsWith('rm -f --')) {
    const match = /rm -f -- '([^']+)'/.exec(input.command)
    const paths = Array.from(input.command.matchAll(/'([^']+)'/g), (item) => item[1])
    const path = match === null ? undefined : match[1]
    if (path !== undefined)
      yield* Ref.update(evidence.files, (files) => {
        const next = new Map(files)
        for (const file of paths) if (file !== undefined) next.delete(file)
        return next
      })
    return commandReply('')
  }
  if (input.command === guestCommand)
    return commandReply(
      '{"socket":"/run/user/1000/vivid-driver.sock","binary":"/home/user/.local/share/vivid/computer/driver","generation":"0123456789abcdef0123456789abcdef"}',
    )
  if (input.command === 'echo receipt') return commandReply('receipt\n')
  return yield* native(evidence, input.command)
})

/** Actual ephemeral HTTP, real Effect HttpClient and real durable Drizzle binding. */
const serverLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const evidence = yield* Evidence
    const server = yield* HttpServer.HttpServer
    const client = yield* HttpClient.HttpClient
    const application = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      // Assert booleans to avoid ever displaying an authorization header in a failed assertion.
      expect(request.headers.authorization === 'Bearer protocol-test-key').toBe(true)
      expect(request.headers['x-boat-org']).toBe(
        Option.getOrUndefined(yield* Ref.get(evidence.org)),
      )
      const path = request.url.split('?')[0]
      if (path === '/api/v1/sandboxes' && request.method === 'POST')
        return yield* create(evidence, request)
      if (path === `/api/v1/sandboxes/${id}` && request.method === 'GET') {
        if (yield* Ref.get(evidence.malformed))
          return HttpServerResponse.jsonUnsafe({ ok: true, sandbox: {} })
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          type: 'sandbox.info',
          sandbox: Object.assign({}, record(yield* Ref.get(evidence.state)), {
            id: (yield* Ref.get(evidence.wrongIdentity)) ? 'bx_abcdefgh' : id,
          }),
        })
      }
      if (path === `/api/v1/sandboxes/${id}/stop`) {
        yield* Stop
        yield* Ref.set(evidence.state, 'archived')
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          type: 'sandbox.stopping',
          id,
          status: 'archiving',
        })
      }
      if (path === `/api/v1/sandboxes/${id}/resume`) {
        yield* Resume
        yield* Ref.set(evidence.state, 'ready')
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          type: 'sandbox.resuming',
          id,
          status: 'resuming',
        })
      }
      if (path === `/api/v1/sandboxes/${id}/desktop`) {
        yield* Viewer
        yield* Ref.update(evidence.viewers, (count) => count + 1)
        const address = (yield* Ref.get(evidence.publicViewer))
          ? 'https://viewer.boat.test/stream.html'
          : 'https://viewer.boat.test/stream.html#token=fixture-only'
        return HttpServerResponse.jsonUnsafe({ ok: true, type: 'desktop.url', desktopUrl: address })
      }
      if (path === `/api/v1/sandboxes/${id}/files` && request.method === 'GET') {
        const query = new URL(request.url, 'http://fixture.test').searchParams
        const file = query.get('path')
        if (file === null || query.get('encoding') !== 'base64') return rejected(400)
        const content = (yield* Ref.get(evidence.files)).get(file)
        if (content === undefined) return rejected(404)
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          type: 'file.read',
          success: true,
          path: file,
          encoding: 'base64',
          size: NodeBuffer.Buffer.from(content, 'base64').length,
          content,
        })
      }
      if (path === `/api/v1/sandboxes/${id}/files` && request.method === 'PUT') {
        const file = yield* File
        yield* Ref.update(evidence.files, (files) => new Map(files).set(file.path, file.content))
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          type: 'file.written',
          success: true,
          path: file.path,
          encoding: 'utf8',
          size: file.content.length,
        })
      }
      if (path === `/api/v1/sandboxes/${id}/commands`) return yield* commands(evidence)
      return rejected(404)
    }).pipe(Effect.catch(() => Effect.succeed(rejected(400))))
    yield* server.serve(application)
    const origin = new URL(HttpServer.formatAddress(server.address))
    origin.hostname = '127.0.0.1'
    return HttpClient.mapRequest(client, (request) => {
      const url = new URL(request.url)
      url.protocol = origin.protocol
      url.host = origin.host
      return HttpClientRequest.setUrl(request, url.toString())
    })
  }),
).pipe(
  Layer.provideMerge(evidenceLayer),
  Layer.provide(
    Layer.mergeAll(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 }), FetchHttpClient.layer),
  ),
)
/** The provider against the fake Boat, configured the way one deployment would configure it. */
const configured = (settings: Readonly<Record<string, string>>) =>
  boatMachineLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        testDatabaseLayer,
        serverLayer,
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown(settings), { asPrimary: true }),
      ),
    ),
  )
const testLayer = configured({
  VIVID_BOAT_API_KEY: 'protocol-test-key',
  VIVID_BOAT_ORG: 'personal',
  VIVID_BOAT_TEMPLATE: 'vivid-computer-protocol-test',
})
/** An account that belongs to no organization: there is only the key. */
const accountLayer = configured({
  VIVID_BOAT_API_KEY: 'protocol-test-key',
  VIVID_BOAT_TEMPLATE: 'vivid-computer-protocol-test',
})

/** Register cleanup before provisioning; only this fixture's private binding is removed. */
const fixture = Effect.fn('BoatTest.fixture')(function* () {
  const key = MachineKey.make(NodeCrypto.randomUUID())
  const database = yield* Database
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(machineBindings).where(eq(machineBindings.key, key)))
      .pipe(Effect.ignore),
  )
  return key
})

describe.skipIf(!testDatabaseConfigured)('Boat native provider protocol', () => {
  it.effect(
    'proves the sole tab during native-title lag but refuses ambiguous selection among tabs',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const machine = yield* Machine
        const evidence = yield* Evidence
        yield* machine.ensure(key)
        yield* machine.browse({
          key,
          action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
        })
        yield* Ref.set(evidence.active, null)
        const read = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
        expect(read.tabs).toEqual([
          { title: 'Example', address: 'https://example.com', showing: true },
        ])
        yield* Ref.set(evidence.extraTab, true)
        const ambiguous = yield* machine
          .browse({ key, action: BrowserAction.cases.Read.make({}) })
          .pipe(Effect.flip)
        expect(ambiguous._tag).toBe('BrowserStepFailed')
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'refuses missing click bounds and an unconfirmed text replacement without retrying input',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const machine = yield* Machine
        const evidence = yield* Evidence
        yield* machine.ensure(key)
        yield* machine.browse({
          key,
          action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
        })
        yield* Ref.set(evidence.missingBounds, true)
        const beforeClick = (yield* Ref.get(evidence.calls)).filter(
          (tool) => tool === 'click',
        ).length
        const refused = yield* machine
          .browse({ key, action: BrowserAction.cases.Click.make({ target: 'Continue' }) })
          .pipe(Effect.flip)
        expect(refused._tag).toBe('BrowserStepFailed')
        expect((yield* Ref.get(evidence.calls)).filter((tool) => tool === 'click').length).toBe(
          beforeClick,
        )
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
        yield* Ref.set(evidence.noType, true)
        const unchanged = yield* machine
          .browse({
            key,
            action: BrowserAction.cases.Type.make({
              target: 'Message',
              text: 'private-fixture-input',
            }),
          })
          .pipe(Effect.flip)
        expect(unchanged._tag).toBe('BrowserStepFailed')
        expect(
          (yield* Ref.get(evidence.calls)).filter((tool) => tool === 'browser_type').length,
        ).toBe(1)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'preserves exit-zero refusal codes and cleans private inputs, even for JSON success decoders',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const machine = yield* Machine
        const evidence = yield* Evidence
        yield* machine.ensure(key)
        const guest = driver(yield* transport(), Protocol.ProviderId.make(id), key, {
          socket: '/run/ascii-cua/driver.sock',
          binary: '/opt/ascii/cua-driver/cua-driver',
        })
        const invalid = yield* guest
          .call('get_desktop_state', { max_image_dimension: 0 }, Schema.Json)
          .pipe(Effect.flip)
        expect(invalid instanceof ComputerToolRefused).toBe(true)
        if (invalid instanceof ComputerToolRefused) expect(invalid.code).toBe('invalid_arguments')
        expect(JSON.stringify(invalid).includes('private-fixture-input')).toBe(false)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
        const inputRefused = yield* guest
          .call(
            'browser_click',
            {
              target_id: 'fixture-target',
              tab_id: 'fixture-tab',
              input_route: 'trusted',
              ref: 'p1:1',
            },
            Schema.Json,
          )
          .pipe(Effect.flip)
        expect(inputRefused instanceof ComputerActionRefused).toBe(true)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
        yield* Ref.set(evidence.refuseBrowser, true)
        const refused = yield* machine
          .browse({
            key,
            action: BrowserAction.cases.Open.make({ address: 'https://example.com' }),
          })
          .pipe(Effect.flip)
        expect(refused instanceof ComputerToolRefused).toBe(true)
        if (refused instanceof ComputerToolRefused)
          expect(refused.code).toBe('browser_route_unavailable')
        expect(JSON.stringify(refused).includes('private-fixture-input')).toBe(false)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'creates once, returns a gated viewer, executes native desktop/browser, stops and resumes after Layer restart',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const machine = yield* Machine
        const evidence = yield* Evidence
        yield* machine.ensure(key)
        const running = yield* machine.status(key)
        if (!ComputerState.guards.Running(running))
          expect.fail('The created Computer must be running')
        expect(running.screen._tag).toBe('Viewer')
        if (Predicate.isTagged(running.screen, 'Viewer'))
          expect(running.screen.expiresAt > running.since).toBe(true)
        const view = yield* machine.desktop({ key, action: DesktopAction.cases.Look.make({}) })
        expect(view).toEqual({
          picture: png,
          width: 1,
          height: 1,
          pointer: { x: 0, y: 0 },
          window: 'Fixture Chrome',
        })
        yield* machine.desktop({
          key,
          action: DesktopAction.cases.Type.make({ text: 'private-fixture-input' }),
        })
        expect(
          (yield* Ref.get(evidence.commands)).some((value) =>
            value.includes('private-fixture-input'),
          ),
        ).toBe(false)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
        const page = yield* machine.browse({
          key,
          action: BrowserAction.cases.Open.make({ address: 'https://example.com/proof' }),
        })
        expect(page.address).toBe('https://example.com/proof')
        expect(page.outline).toContain('Continue')
        expect(page.tabs).toEqual([{ title: 'Example', address: page.address, showing: true }])
        const clicked = yield* machine.browse({
          key,
          action: BrowserAction.cases.Click.make({ target: 'Continue' }),
        })
        expect(clicked.address).toBe('https://example.com/continued')
        const typed = yield* machine.browse({
          key,
          action: BrowserAction.cases.Type.make({
            target: 'Message',
            text: 'private-fixture-input',
          }),
        })
        expect(typed.outline).toContain('private-fixture-input')
        expect(
          (yield* Ref.get(evidence.commands)).some((value) =>
            value.includes('private-fixture-input'),
          ),
        ).toBe(false)
        expect((yield* Ref.get(evidence.files)).size).toBe(0)
        expect(
          (yield* machine.exec({ key, command: 'echo receipt', timeoutSeconds: 10 })).output,
        ).toBe('receipt\n')
        yield* machine.stop(key)
        expect(ComputerState.guards.Stopped(yield* machine.status(key))).toBe(true)
        const restored = yield* Effect.gen(function* () {
          const restarted = yield* Machine
          yield* restarted.ensure(key)
          return yield* restarted.status(key)
        }).pipe(Effect.provide(boatMachineLayer))
        if (!ComputerState.guards.Running(restored))
          expect.fail('The resumed Computer must be running')
        expect(restored.screen._tag).toBe('Viewer')
        expect(yield* Ref.get(evidence.created)).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )

  it.effect('reuses one viewer until sixty seconds before expiry and shares concurrent reads', () =>
    Effect.gen(function* () {
      const key = yield* fixture()
      const machine = yield* Machine
      const evidence = yield* Evidence
      yield* machine.ensure(key)
      expect(yield* Ref.get(evidence.viewers)).toBe(0)
      const first = yield* machine.status(key)
      expect(yield* Ref.get(evidence.viewers)).toBe(1)
      expect(yield* machine.status(key)).toEqual(first)
      yield* TestClock.adjust('7 minutes')
      expect(yield* machine.status(key)).toEqual(first)
      expect(yield* Ref.get(evidence.viewers)).toBe(1)
      yield* TestClock.adjust('2 minutes')
      const refreshed = yield* Effect.all([machine.status(key), machine.status(key)], {
        concurrency: 'unbounded',
      })
      expect(refreshed[0]).toEqual(refreshed[1])
      expect(yield* Ref.get(evidence.viewers)).toBe(2)
      const database = yield* Database
      const rows = yield* database.run(
        database.select().from(machineBindings).where(eq(machineBindings.key, key)),
      )
      expect(JSON.stringify(rows).includes('#token=')).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect("names no organization when none is configured, so the key's own account pays", () =>
    Effect.gen(function* () {
      const key = yield* fixture()
      const machine = yield* Machine
      const evidence = yield* Evidence
      // The fake refuses any request, and any create body, that names a payer other than this.
      yield* Ref.set(evidence.org, Option.none())
      yield* machine.ensure(key)
      expect(yield* Ref.get(evidence.created)).toBe(1)
      yield* machine.stop(key)
      expect(yield* Ref.get(evidence.state)).toBe('archived')
    }).pipe(Effect.scoped, Effect.provide(accountLayer)),
  )

  it.effect('status never reconciles an unresolved create or resumes a stopped machine', () =>
    Effect.gen(function* () {
      const key = yield* fixture()
      const machine = yield* Machine
      const evidence = yield* Evidence
      yield* Ref.set(evidence.breakCreate, true)
      yield* machine.ensure(key).pipe(Effect.flip)
      expect((yield* machine.status(key))._tag).toBe('Failed')
      expect((yield* Ref.get(evidence.intents)).length).toBe(1)
      expect((yield* machine.stop(key).pipe(Effect.flip))._tag).toBe('MachineCreationUnresolved')
      expect((yield* Ref.get(evidence.intents)).length).toBe(1)
      yield* machine.ensure(key)
      yield* machine.stop(key)
      expect((yield* machine.status(key))._tag).toBe('Stopped')
      expect(yield* Ref.get(evidence.state)).toBe('archived')
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'recovers a lost create receipt with the persisted original body and key after restart',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const evidence = yield* Evidence
        const machine = yield* Machine
        yield* Ref.set(evidence.breakCreate, true)
        expect((yield* Effect.flip(machine.ensure(key)))._tag).toBe('MachineRequestRejected')
        yield* Effect.gen(function* () {
          yield* (yield* Machine).ensure(key)
        }).pipe(
          Effect.provide(
            boatMachineLayer.pipe(
              Layer.provide(
                ConfigProvider.layerAdd(
                  ConfigProvider.fromUnknown({
                    VIVID_BOAT_SIZE: 'large',
                    VIVID_BOAT_LIFETIME_SECONDS: '7200',
                    VIVID_BOAT_TEMPLATE: 'vivid-computer-new-release',
                  }),
                  { asPrimary: true },
                ),
              ),
            ),
          ),
        )
        const intents = yield* Ref.get(evidence.intents)
        expect(intents.length).toBe(2)
        expect(intents[0] === intents[1]).toBe(true)
        expect(yield* Ref.get(evidence.created)).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )

  it.effect(
    'refuses public viewer URLs and malformed state, and never retries an uncertain command',
    () =>
      Effect.gen(function* () {
        const key = yield* fixture()
        const machine = yield* Machine
        const evidence = yield* Evidence
        yield* machine.ensure(key)
        yield* Ref.set(evidence.publicViewer, true)
        yield* TestClock.adjust('10 minutes')
        expect((yield* Effect.flip(machine.status(key)))._tag).toBe('MachineResponseInvalid')
        yield* Ref.set(evidence.publicViewer, false)
        yield* Ref.set(evidence.breakCommand, true)
        const before = (yield* Ref.get(evidence.commands)).length
        expect(
          (yield* Effect.flip(machine.exec({ key, command: 'echo receipt', timeoutSeconds: 10 })))
            ._tag,
        ).toBe('MachineExecutionUnknown')
        expect((yield* Ref.get(evidence.commands)).length - before).toBe(1)
        yield* Ref.set(evidence.malformed, true)
        expect((yield* Effect.flip(machine.status(key)))._tag).toBe('MachineResponseInvalid')
        yield* Ref.set(evidence.malformed, false)
        yield* Ref.set(evidence.wrongIdentity, true)
        expect((yield* Effect.flip(machine.status(key)))._tag).toBe('MachineResponseInvalid')
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )
})
