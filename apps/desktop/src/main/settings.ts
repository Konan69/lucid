import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeCrypto from 'node:crypto'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { ServerAddress, ServerSettings, SettingsSaveFailed } from '../shared/settings.ts'

const StoredSettings = Schema.Struct({ version: Schema.Literal(2), server: ServerSettings })
const LegacySettings = Schema.Struct({ version: Schema.Literal(1), serverAddress: ServerAddress })
const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([StoredSettings, LegacySettings])),
)
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(StoredSettings))
const missingFile = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal('ENOENT') }))

/** An unreadable file must enter recovery, distinct from a normal first launch. */
class SettingsReadFailed extends Schema.TaggedError<SettingsReadFailed>()(
  'SettingsReadFailed',
  {},
  { title: 'Desktop settings could not be read' },
) {}
/** Backup failure leaves the original untouched and remains nonfatal at startup. */
class SettingsPreserveFailed extends Schema.TaggedError<SettingsPreserveFailed>()(
  'SettingsPreserveFailed',
  {},
  { title: 'Desktop damaged settings could not be moved' },
) {}
/** Only ENOENT is an ordinary absent settings file. */
class SettingsMissing extends Schema.TaggedError<SettingsMissing>()(
  'SettingsMissing',
  {},
  { title: 'Desktop settings are absent' },
) {}

/**
 * Where an installation with no stored choice starts. A packaged Vivid ships with its own address
 * (`home`), so a Person opens the app and is in Vivid; the address chooser was the first thing
 * they saw and asked for something they have no reason to know. A build with no home (development)
 * still starts at the chooser. A Person who chose "Use a Different Vivid" has a stored `NoServer`
 * or `Server`, which is read as it is and never replaced by this.
 */
const unchosen = (home: Option.Option<ServerAddress>): ServerSettings =>
  Option.match(home, {
    onNone: () => ServerSettings.cases.NoServer.make({}),
    onSome: (origin) => ServerSettings.cases.Server.make({ origin }),
  })

/** Keep every damaged file beside its original, without overwriting an earlier recovery copy. */
const preserveDamagedSettings = Effect.fn('DesktopSettings.preserveDamaged')(function* (
  path: string,
  home: Option.Option<ServerAddress>,
) {
  yield* Effect.try({
    try: () => {
      const suffix = NodeFS.existsSync(`${path}.damaged`)
        ? `.${NodeCrypto.randomUUID()}.damaged`
        : '.damaged'
      NodeFS.renameSync(path, `${path}${suffix}`)
    },
    catch: () => new SettingsPreserveFailed({}),
  }).pipe(
    Effect.catchTag('SettingsPreserveFailed', () =>
      Effect.sync(() => console.error('desktop: settings could not be moved; original retained')),
    ),
  )
  return unchosen(home)
})

/**
 * Decode disk ingress once; missing, damaged, and unreadable settings all start where an
 * installation with no choice starts (`unchosen`).
 */
export const readServerSettings = Effect.fn('DesktopSettings.read')(function* (
  path: string,
  home: Option.Option<ServerAddress>,
) {
  const text = yield* Effect.try({
    try: () => NodeFS.readFileSync(path, 'utf8'),
    catch: (cause) =>
      Option.isSome(missingFile(cause)) ? new SettingsMissing({}) : new SettingsReadFailed({}),
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      SettingsMissing: () => Effect.succeed(Option.none<string>()),
      SettingsReadFailed: () =>
        preserveDamagedSettings(path, home).pipe(Effect.as(Option.none<string>())),
    }),
  )
  if (Option.isNone(text)) return unchosen(home)
  return yield* decodeSettings(text.value).pipe(
    Effect.map((stored) =>
      stored.version === 1
        ? ServerSettings.cases.Server.make({
            origin: ServerAddress.make(new URL(stored.serverAddress).origin),
          })
        : stored.server,
    ),
    Effect.catchTag('SchemaError', () => preserveDamagedSettings(path, home)),
  )
})

/**
 * Flush an exclusively created temporary file before atomic rename. The scoped descriptor closes
 * even on failure, and cleanup removes only this write's temporary file. Memory updates last.
 */
const writeServerSettings = Effect.fn('DesktopSettings.write')(function* (
  path: string,
  server: ServerSettings,
) {
  const text = yield* encodeSettings(StoredSettings.make({ version: 2, server })).pipe(
    Effect.mapError(() => new SettingsSaveFailed({})),
  )
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`
  yield* Effect.try({
    try: () => NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true }),
    catch: () => new SettingsSaveFailed({}),
  })
  yield* replaceSettingsFile(temporary, path, text).pipe(
    Effect.ensuring(
      Effect.try({
        try: () => NodeFS.rmSync(temporary, { force: true }),
        catch: () => new SettingsSaveFailed({}),
      }).pipe(
        Effect.catchTag('SettingsSaveFailed', () =>
          Effect.logWarning('desktop: temporary settings cleanup failed'),
        ),
      ),
    ),
  )
})

/** Flush and close the file before rename; descriptor finalization also runs on write failure. */
const replaceSettingsFile = Effect.fn('DesktopSettings.replace')(function* (
  temporary: string,
  path: string,
  text: string,
) {
  yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => NodeFS.openSync(temporary, 'wx', 0o600),
      catch: () => new SettingsSaveFailed({}),
    }),
    (descriptor) =>
      Effect.try({
        try: () => {
          NodeFS.writeFileSync(descriptor, text)
          NodeFS.fsyncSync(descriptor)
        },
        catch: () => new SettingsSaveFailed({}),
      }),
    (descriptor) =>
      Effect.try({
        try: () => NodeFS.closeSync(descriptor),
        catch: () => new SettingsSaveFailed({}),
      }),
  )
  yield* Effect.try({
    try: () => NodeFS.renameSync(temporary, path),
    catch: () => new SettingsSaveFailed({}),
  })
})

/** Main owns persisted selection and serializes changes to one warm state. */
interface DesktopSettingsOperations {
  readonly get: Effect.Effect<ServerSettings>
  readonly set: (origin: ServerAddress) => Effect.Effect<ServerSettings, SettingsSaveFailed>
  readonly forget: Effect.Effect<ServerSettings, SettingsSaveFailed>
}

/** Persistence authority acquired once at Electron startup. */
export class DesktopSettings extends Context.Service<DesktopSettings, DesktopSettingsOperations>()(
  'vivid/DesktopSettings',
) {}

/** Acquire recovery-safe disk state; concurrent choose and forget calls cannot race writes. */
export const settingsLayer = (path: string, home: Option.Option<ServerAddress>) =>
  Layer.effect(
    DesktopSettings,
    Effect.gen(function* () {
      const state = yield* Ref.make(yield* readServerSettings(path, home))
      const writes = yield* Semaphore.make(1)
      /** Publish the new authority only after its durable replacement succeeds. */
      const save = Effect.fn('DesktopSettings.save')(
        function* (next: ServerSettings) {
          yield* writeServerSettings(path, next)
          yield* Ref.set(state, next)
          return next
        },
        Semaphore.withPermit(writes),
        Effect.uninterruptible,
      )
      return DesktopSettings.of({
        get: Ref.get(state),
        set: (origin) => save(ServerSettings.cases.Server.make({ origin })),
        forget: save(ServerSettings.cases.NoServer.make({})),
      })
    }),
  )
