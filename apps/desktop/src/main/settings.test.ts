import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  DesktopSettings,
  SettingsInvalid,
  SettingsReadFailed,
  readServerSettings,
  settingsLayer,
} from './settings.ts'
import { ServerAddress, ServerSettings, SettingsSaveFailed } from '../shared/settings.ts'

const decodeAddress = Schema.decodeUnknownEffect(ServerAddress)

/** Every test owns a disposable directory; cleanup is registered before the first settings write. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-desktop-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

describe('desktop server settings', () => {
  it.effect('persists an explicit selection and restores it on the next launch', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        expect(ServerSettings.guards.Unconfigured(yield* settings.get)).toBe(true)
        const selected = yield* settings.set(yield* decodeAddress('https://vivid.example:8443'))
        expect(yield* settings.get).toEqual(selected)
        expect(yield* readServerSettings(path)).toEqual(selected)
        expect(ServerSettings.guards.Configured(selected)).toBe(true)
      }).pipe(Effect.provide(settingsLayer(path)))
    }),
  )

  it.effect('rejects corrupt, unsupported, and credential-bearing persisted settings', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      for (const text of [
        '{',
        '{"version":2,"serverAddress":"https://vivid.example"}',
        '{"version":1,"serverAddress":"https://person:secret@vivid.example"}',
      ]) {
        NodeFS.writeFileSync(path, text)
        expect(yield* Effect.flip(readServerSettings(path))).toBeInstanceOf(SettingsInvalid)
      }
    }),
  )

  it.effect('does not treat an unreadable path as first launch', () =>
    Effect.gen(function* () {
      const root = yield* directory
      expect(yield* Effect.flip(readServerSettings(root))).toBeInstanceOf(SettingsReadFailed)
    }),
  )

  it.effect('retains the current selection when atomic replacement fails', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'settings.json')
      yield* Effect.gen(function* () {
        const settings = yield* DesktopSettings
        const before = yield* settings.get
        NodeFS.mkdirSync(`${path}.tmp`)
        expect(
          yield* Effect.flip(settings.set(yield* decodeAddress('https://vivid.example'))),
        ).toBeInstanceOf(SettingsSaveFailed)
        expect(yield* settings.get).toEqual(before)
        expect(NodeFS.existsSync(path)).toBe(false)
      }).pipe(Effect.provide(settingsLayer(path)))
    }),
  )

  it.effect('accepts LAN, loopback, IPv6, and private-network origins', () =>
    Effect.gen(function* () {
      for (const address of [
        'http://192.168.1.8:8787',
        'http://127.0.0.1:8787/',
        'http://[::1]:8787',
        'https://computer.tail.example',
      ]) {
        expect(yield* decodeAddress(address)).toBe(address)
      }
    }),
  )

  it.effect('rejects routes, secrets, ambiguous whitespace, and unsupported schemes', () =>
    Effect.gen(function* () {
      for (const address of [
        'file:///etc/passwd',
        'vivid://thread/123',
        'https://vivid.example/api',
        'https://vivid.example?token=secret',
        'https://vivid.example/#secret',
        'http://person:secret@vivid.example',
        ' https://vivid.example',
        'http://vivid.example:99999',
      ]) {
        expect(yield* Effect.flip(decodeAddress(address))).toBeInstanceOf(Schema.SchemaError)
      }
    }),
  )
})
