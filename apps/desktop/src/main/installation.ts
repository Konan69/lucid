import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InstallationId } from '@vivid/contracts'

const StoredInstallation = Schema.Struct({
  version: Schema.Literal(1),
  installation: InstallationId,
})
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredInstallation))
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredInstallation))
const missingFile = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal('ENOENT') }))

/**
 * This app's identity could not be read or kept. Without one that survives a restart the app
 * would enrol as a new computer every time it opened, so it does not enrol at all.
 */
export class InstallationUnavailable extends Schema.TaggedError<InstallationUnavailable>()(
  'InstallationUnavailable',
  {},
  { title: 'This app’s identity could not be read or saved' },
) {}

/** Only a missing file permits creating an identity; other read failures prevent enrolment. */
class InstallationAbsent extends Schema.TaggedError<InstallationAbsent>()(
  'InstallationAbsent',
  {},
) {}

/** Reads the kept identity. A missing file and a damaged one both mean there is none to use. */
const readStored = Effect.fn('DesktopInstallation.read')(function* (path: string) {
  const text = yield* Effect.try({
    try: () => Option.some(NodeFS.readFileSync(path, 'utf8')),
    catch: (cause) =>
      Option.isSome(missingFile(cause))
        ? new InstallationAbsent({})
        : new InstallationUnavailable({}),
  }).pipe(Effect.catchTag('InstallationAbsent', () => Effect.succeedNone))
  if (Option.isNone(text)) return Option.none<InstallationId>()
  return yield* decodeStored(text.value).pipe(
    Effect.map((stored) => Option.some(stored.installation)),
    // A file that is not an identity is replaced: what it named cannot be recovered, and the
    // computer it was enrolled as stays in the Person's list until they revoke it.
    Effect.catchTag('SchemaError', () => Effect.succeed(Option.none<InstallationId>())),
  )
})

/**
 * Writes a new identity through a private temporary file and an atomic rename, as the server
 * selection is written (`settings.ts`): a crash leaves the old file or the new one, never half.
 */
const writeStored = Effect.fn('DesktopInstallation.write')(function* (
  path: string,
  installation: InstallationId,
) {
  const text = yield* encodeStored(StoredInstallation.make({ version: 1, installation })).pipe(
    Effect.mapError(() => new InstallationUnavailable({})),
  )
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`
  yield* Effect.try({
    try: () => {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true })
      NodeFS.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
      NodeFS.renameSync(temporary, path)
    },
    catch: () => new InstallationUnavailable({}),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(temporary, { force: true })).pipe(Effect.ignore),
    ),
  )
})

/**
 * What this installed app calls itself: a random value made the first time it is needed and kept
 * in the app's own data directory from then on. Presenting it with a signed-in session is how the
 * server knows the caller is this app and not a browser tab, so it never leaves the main process:
 * the renderer is told the Device it enrolled as, not this.
 *
 * Adapted from the reference desktop app's installation file, as the contract records
 * (`InstallationId` in packages/contracts/src/computers.ts).
 */
export const installationIdentity = Effect.fn('DesktopInstallation.identity')(function* (
  path: string,
) {
  const kept = yield* readStored(path)
  if (Option.isSome(kept)) return kept.value
  const created = InstallationId.make(NodeCrypto.randomUUID())
  yield* writeStored(path, created)
  return created
})
