import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

/**
 * What the runtime process must be told before it serves anything. Every value is required unless
 * it names a default below: a runtime that lacks one does not start, and the failure names the
 * variable. There is no runtime that runs "without notes" or "without a database for
 * conversations"; an unset directory used to mount no note tools while Vivid went on telling every
 * Person that it remembers.
 */
export interface RuntimeSettingsService {
  /**
   * Where the note files are kept (`VIVID_MEMORY_DIR`). A directory that cannot be read or
   * written later is a different thing, an infrastructure failure: a typed failure on the note
   * call that met it (`NotesUnavailable` in `notes.ts`), told to the model for that response.
   */
  readonly notesDirectory: string
  /**
   * The PostgreSQL database the conversations are kept in (`DATABASE_URL`): the application
   * server's own database, whose `runtime` schema holds one logical store per Person
   * (`storage/tables.ts`). Root `pnpm db:migrate` creates those tables; this process never
   * migrates.
   */
  readonly databaseUrl: Redacted.Redacted
  /** The bearer credential of the application server, the only caller (`VIVID_RUNTIME_TOKEN`). */
  readonly token: Redacted.Redacted
  /** The application server every tool and context read calls (`VIVID_SERVER_URL`). */
  readonly serverUrl: URL
  /**
   * How long a Person's conversations stay open with no live work and no request, in
   * milliseconds (`VIVID_RUNTIME_IDLE_MS`, ten minutes when unset). Closing only frees memory;
   * the next request opens them again.
   */
  readonly idleMillis: number
  readonly host: string
  readonly port: number
}

export class RuntimeSettings extends Context.Service<RuntimeSettings, RuntimeSettingsService>()(
  'vivid/Runtime/Settings',
) {}

const positive = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

/** Read once at startup, so a missing setting stops the process before it binds its port. */
export const settingsLayer = Layer.effect(
  RuntimeSettings,
  Effect.gen(function* () {
    return RuntimeSettings.of({
      notesDirectory: yield* Config.NonEmptyString('VIVID_MEMORY_DIR'),
      databaseUrl: yield* Config.Redacted('DATABASE_URL'),
      token: yield* Config.Redacted('VIVID_RUNTIME_TOKEN'),
      serverUrl: yield* Config.URL('VIVID_SERVER_URL'),
      idleMillis: yield* Config.schema(positive, 'VIVID_RUNTIME_IDLE_MS').pipe(
        Config.withDefault(600_000),
      ),
      host: yield* Config.NonEmptyString('HOST').pipe(Config.withDefault('0.0.0.0')),
      port: yield* Config.schema(positive, 'PORT').pipe(Config.withDefault(5173)),
    })
  }),
)
