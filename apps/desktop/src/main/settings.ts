import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { ServerAddress, ServerSettings, SettingsSaveFailed } from '../shared/settings.ts'

/** Keep the initial origin out of shared bridge modules that a web renderer can import. */
const defaultServerAddress = ServerAddress.make('http://127.0.0.1:8787')

const StoredSettings = Schema.Struct({ version: Schema.Literal(1), serverAddress: ServerAddress })
const StoredJson = Schema.fromJsonString(StoredSettings)
const decodeSettings = Schema.decodeUnknownEffect(StoredJson)
const encodeSettings = Schema.encodeEffect(StoredJson)
const missingFile = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal('ENOENT') }))

/** Missing settings are a first launch; unreadable settings must stop startup. */
export class SettingsReadFailed extends Schema.TaggedError<SettingsReadFailed>()(
  'SettingsReadFailed',
  {},
  { title: 'Desktop settings could not be read' },
) {}

/** Corrupt or unsupported settings are never silently replaced by a different server. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()(
  'SettingsInvalid',
  {},
  { title: 'Desktop settings are invalid' },
) {}

class SettingsMissing extends Schema.TaggedError<SettingsMissing>()(
  'SettingsMissing',
  {},
  { title: 'Desktop settings are absent' },
) {}

/** Decode persisted settings once, reserving the default exclusively for absent files. */
export const readServerSettings = Effect.fn('DesktopSettings.read')(function* (path: string) {
  const text = yield* Effect.try({
    try: () => NodeFS.readFileSync(path, 'utf8'),
    catch: (cause) =>
      Option.isSome(missingFile(cause)) ? new SettingsMissing({}) : new SettingsReadFailed({}),
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag('SettingsMissing', () => Effect.succeed(Option.none<string>())),
  )
  if (Option.isNone(text)) {
    return ServerSettings.cases.Unconfigured.make({ serverAddress: defaultServerAddress })
  }
  const stored = yield* decodeSettings(text.value).pipe(
    Effect.mapError(() => new SettingsInvalid({})),
  )
  return ServerSettings.cases.Configured.make({ serverAddress: stored.serverAddress })
})

/** Atomically replace the small settings file; memory changes only after durable write succeeds. */
const writeServerSettings = Effect.fn('DesktopSettings.write')(function* (
  path: string,
  serverAddress: ServerAddress,
) {
  const text = yield* encodeSettings(StoredSettings.make({ version: 1, serverAddress })).pipe(
    Effect.mapError(() => new SettingsSaveFailed({})),
  )
  yield* Effect.try({
    try: () => {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true })
      NodeFS.writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
      NodeFS.renameSync(`${path}.tmp`, path)
    },
    catch: () => new SettingsSaveFailed({}),
  })
})

/** Main owns the persisted address and serializes bridge writes against one warm state. */
interface DesktopSettingsOperations {
  readonly get: Effect.Effect<ServerSettings>
  readonly set: (address: ServerAddress) => Effect.Effect<ServerSettings, SettingsSaveFailed>
}

/** Persistence authority acquired once at Electron startup. */
export class DesktopSettings extends Context.Service<DesktopSettings, DesktopSettingsOperations>()(
  'vivid/DesktopSettings',
) {}

/** Acquire disk state once; all bridge calls share the same serialized settings authority. */
export const settingsLayer = (path: string) =>
  Layer.effect(
    DesktopSettings,
    Effect.gen(function* () {
      const state = yield* Ref.make(yield* readServerSettings(path))
      const writes = yield* Semaphore.make(1)
      return DesktopSettings.of({
        get: Ref.get(state),
        set: Effect.fn('DesktopSettings.set')(function* (address) {
          yield* writeServerSettings(path, address)
          const next = ServerSettings.cases.Configured.make({ serverAddress: address })
          yield* Ref.set(state, next)
          return next
        }, Semaphore.withPermit(writes)),
      })
    }),
  )
