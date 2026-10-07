import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { DesktopSettings, readServerSettings, settingsLayer } from './settings.ts'
import { ServerAddress, ServerSettings, SettingsSaveFailed } from '../shared/settings.ts'

const decodeAddress = Schema.decodeUnknownEffect(ServerAddress)
/** Register disposal before any write; these fixtures never use an application data directory. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-desktop-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

describe('desktop server settings', () => {
  it.effect('a build that ships its address opens there; a stored choice still wins', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'settings.json')
      const origin = yield* decodeAddress('https://home.vivid.example')
      const home = Option.some(origin)
      // Nothing stored: the Person is in Vivid, not at an address chooser.
      expect(yield* readServerSettings(path, home)).toEqual(
        ServerSettings.cases.Server.make({ origin }),
      )
      // Each case owns its mutable settings and disposable directory.
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        // "Use a Different Vivid" forgets the server; that choice is stored and is kept.
        yield* settings.forget
      }).pipe(Effect.provide(yield* Layer.build(settingsLayer(path, home))))
      expect(yield* readServerSettings(path, home)).toEqual(ServerSettings.cases.NoServer.make({}))
      // A file that cannot be decoded was a choice once: it is not replaced by the shipped address.
      NodeFS.writeFileSync(path, '{ not settings')
      expect(yield* readServerSettings(path, home)).toEqual(ServerSettings.cases.NoServer.make({}))
    }),
  )

  it.effect('first launch has no server; choose and forget survive the next launch', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      // Each case owns its mutable settings and disposable directory.
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        expect(yield* settings.get).toEqual(ServerSettings.cases.NoServer.make({}))
        const selected = yield* settings.set(yield* decodeAddress('https://vivid.example:8443'))
        expect(yield* readServerSettings(path, Option.none())).toEqual(selected)
        expect(NodeFS.readdirSync(root)).toEqual(['settings.json'])
        expect(yield* settings.forget).toEqual(ServerSettings.cases.NoServer.make({}))
        expect(yield* readServerSettings(path, Option.none())).toEqual(
          ServerSettings.cases.NoServer.make({}),
        )
      }).pipe(Effect.provide(yield* Layer.build(settingsLayer(path, Option.none()))))
    }),
  )

  it.effect('preserves corrupt settings without overwriting earlier damaged copies', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      for (const text of [
        '{',
        '{"version":9}',
        '{"version":1,"serverAddress":"https://person:secret@vivid.example"}',
      ]) {
        NodeFS.writeFileSync(path, text)
        expect(yield* readServerSettings(path, Option.none())).toEqual(
          ServerSettings.cases.NoServer.make({}),
        )
        expect(NodeFS.existsSync(path)).toBe(false)
      }
      const backups = NodeFS.readdirSync(root).filter((name) => name.endsWith('.damaged'))
      expect(backups).toHaveLength(3)
      expect(NodeFS.readFileSync(`${path}.damaged`, 'utf8')).toBe('{')
    }),
  )

  it.effect('an unreadable path shows the chooser and preserves that path', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      NodeFS.mkdirSync(path)
      expect(yield* readServerSettings(path, Option.none())).toEqual(
        ServerSettings.cases.NoServer.make({}),
      )
      expect(NodeFS.statSync(`${path}.damaged`).isDirectory()).toBe(true)
    }),
  )

  it.effect('restores an existing explicit version-one selection', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      NodeFS.writeFileSync(path, '{"version":1,"serverAddress":"https://vivid.example/"}')
      expect(yield* readServerSettings(path, Option.none())).toEqual(
        ServerSettings.cases.Server.make({ origin: ServerAddress.make('https://vivid.example') }),
      )
    }),
  )

  it.effect('failed replacement retains warm authority and cleans its temporary file', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      // Each case owns its mutable settings and disposable directory.
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const before = yield* settings.set(yield* decodeAddress('https://vivid.example'))
        NodeFS.unlinkSync(path)
        NodeFS.mkdirSync(path)
        expect(yield* Effect.flip(settings.forget)).toBeInstanceOf(SettingsSaveFailed)
        expect(yield* settings.get).toEqual(before)
        expect(NodeFS.readdirSync(root)).toEqual(['settings.json'])
      }).pipe(Effect.provide(yield* Layer.build(settingsLayer(path, Option.none()))))
    }),
  )

  it.effect('accepts TLS remotely and HTTP only for loopback or private IP addresses', () =>
    Effect.gen(function* () {
      for (const address of [
        'https://vivid.example',
        'http://localhost:8787',
        'http://127.0.0.1:8787/',
        'http://10.0.0.8',
        'http://172.16.0.1',
        'http://172.31.255.254',
        'http://192.168.1.8:8787',
        'http://[::1]:8787',
        'http://[fd12::1]',
        'http://[fe80::1]',
      ]) {
        expect(yield* decodeAddress(address)).toBe(address)
      }
      for (const address of [
        'http://vivid.example',
        'http://8.8.8.8',
        'http://172.32.0.1',
        'http://172.15.0.1',
        'http://[2001:4860::1]',
        'file:///etc/passwd',
        'https://vivid.example/api',
        'https://vivid.example?token=secret',
        'https://vivid.example/#secret',
        'http://person:secret@127.0.0.1',
        ' https://vivid.example',
        'http://127.0.0.1:99999',
      ]) {
        expect(yield* Effect.flip(decodeAddress(address))).toBeInstanceOf(Schema.SchemaError)
      }
      expect(
        ServerSettings.guards.NoServer(
          yield* readServerSettings(NodePath.join(yield* directory, 'absent'), Option.none()),
        ),
      ).toBe(true)
    }),
  )
})
