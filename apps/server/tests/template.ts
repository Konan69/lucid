import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as Pg from 'pg'
import { Effect, Schema } from 'effect'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    /** The migrated database every test file clones. */
    serverDatabaseTemplate: string
    /** The start of every database this invocation creates; teardown drops by it. */
    serverDatabasePrefix: string
  }
}

const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))
const serverRoot = NodeURL.fileURLToPath(new URL('../', import.meta.url))
/** Both production migration owners, in the order root `pnpm db:migrate` applies them. */
const migrationOwners = [
  { config: 'drizzle.config.ts', directory: 'drizzle' },
  { config: 'product-drizzle.config.ts', directory: 'product-drizzle' },
]
/** A template no run has used for this long belongs to migrations nobody tests any more. */
const unusedAfterSeconds = 3 * 24 * 60 * 60
/** PostgreSQL `duplicate_database`: another run renamed its template into place first. */
const duplicateDatabase = '42P04'
const PostgresFailure = Schema.Struct({ code: Schema.String })
const isPostgresFailure = Schema.is(PostgresFailure)

/** A failed migration cannot publish an incomplete schema template. */
class TemplateMigrationFailed extends Schema.TaggedError<TemplateMigrationFailed>()(
  'TemplateMigrationFailed',
  { config: Schema.String, message: Schema.String },
) {}
/** Only duplicate_database is recoverable when two runs race to publish the template. */
class TemplateRenameFailed extends Schema.TaggedError<TemplateRenameFailed>()(
  'TemplateRenameFailed',
  { cause: Schema.Unknown, message: Schema.String },
) {}

/**
 * The template's name is a digest of everything `drizzle-kit migrate` reads: each owner's config
 * and every file under its migration directory. Two checkouts with the same migrations share one
 * template; a new or edited migration is a new name, so a stale template cannot be cloned.
 */
function templateName() {
  const digest = NodeCrypto.createHash('sha256')
  for (const owner of migrationOwners) {
    digest.update(NodeFS.readFileSync(NodePath.join(serverRoot, owner.config)))
    const files = NodeFS.readdirSync(NodePath.join(serverRoot, owner.directory), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => NodePath.join(entry.parentPath, entry.name))
      .toSorted((left, right) => left.localeCompare(right))
    for (const file of files) {
      digest.update(NodePath.relative(serverRoot, file))
      digest.update(NodeFS.readFileSync(file))
    }
  }
  return `vivid_template_${digest.digest('hex').slice(0, 24)}`
}

/**
 * Migrate a scratch database and rename it into place. The rename is the only step another run
 * can observe, so a template that exists is always complete; a failed or interrupted migration
 * leaves only the scratch database, which is dropped here or by its creator's prefix sweep.
 */
const buildTemplate = Effect.fn('TestDatabase.buildTemplate')(function* (
  admin: Pg.Client,
  supplied: string,
  template: string,
  scratch: string,
) {
  yield* Effect.promise(() => admin.query(`CREATE DATABASE "${scratch}" TEMPLATE template0`))
  const target = new URL(supplied)
  target.pathname = `/${scratch}`
  for (const owner of migrationOwners) {
    const migration = NodeChildProcess.spawnSync(
      'pnpm',
      ['exec', 'drizzle-kit', 'migrate', '--config', owner.config],
      { cwd: serverRoot, env: { ...NodeProcess.env, DATABASE_URL: target.href }, stdio: 'pipe' },
    )
    if (migration.error !== undefined || migration.status !== 0)
      return yield* new TemplateMigrationFailed({
        config: owner.config,
        message: `Test template migration failed for ${owner.config}`,
      })
  }
  yield* Effect.tryPromise({
    try: () => admin.query(`ALTER DATABASE "${scratch}" RENAME TO "${template}"`),
    catch: (cause) =>
      new TemplateRenameFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.catchTag('TemplateRenameFailed', (failure) => {
      if (!isPostgresFailure(failure.cause) || failure.cause.code !== duplicateDatabase)
        return Effect.fail(failure)
      return Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${scratch}"`))
    }),
  )
})

/**
 * The migrated template for this checkout's migrations, built when the server does not have it.
 * It is kept between runs: migrating took longer than a focused run should, and the template
 * holds schema only, never a fixture row. Its comment records its last use, and templates unused
 * for three days are dropped, so a server that lives for weeks does not collect one per migration.
 */
const migratedTemplate = Effect.fn('TestDatabase.migratedTemplate')(function* (
  admin: Pg.Client,
  supplied: string,
  prefix: string,
) {
  const template = templateName()
  // One run at a time decides about templates on this server: building, marking one as used
  // and dropping unused ones. Without it a run could drop a template another had just chosen.
  // The lock belongs to this connection and ends with it.
  yield* Effect.promise(() =>
    admin.query('SELECT pg_advisory_lock(hashtext($1))', ['vivid_template']),
  )
  return yield* chooseTemplate(admin, supplied, { template, scratch: `${prefix}_scratch` }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        admin.query('SELECT pg_advisory_unlock(hashtext($1))', ['vivid_template']),
      ),
    ),
  )
})

/** Choose and mark the schema-only template before pruning templates unused for three days. */
const chooseTemplate = Effect.fn('TestDatabase.chooseTemplate')(function* (
  admin: Pg.Client,
  supplied: string,
  { template, scratch }: { readonly template: string; readonly scratch: string },
) {
  const existing = yield* Effect.promise(() =>
    admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template]),
  )
  if (existing.rowCount === 0) yield* buildTemplate(admin, supplied, template, scratch)
  yield* Effect.promise(() =>
    admin.query(`COMMENT ON DATABASE "${template}" IS '${Math.floor(Date.now() / 1000)}'`),
  )
  const unused = yield* Effect.promise(() =>
    admin.query(
      `SELECT quote_ident(datname) AS name FROM pg_database
     WHERE starts_with(datname, 'vivid_template_') AND datname <> $1
       AND shobj_description(oid, 'pg_database') ~ '^[0-9]+$'
       AND shobj_description(oid, 'pg_database')::bigint < extract(epoch FROM now()) - $2`,
      [template, unusedAfterSeconds],
    ),
  )
  for (const stale of decodeNames(unused.rows))
    yield* Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS ${stale.name}`))
  return template
})

/**
 * Provide the migrated template and this invocation's database prefix. Each test file clones the
 * template under the prefix, preserving foreign keys and indexes without sharing scheduler work
 * or copying fixture rows. The supplied database is only an administration connection; no
 * fixture or migration writes to it. The prefix starts with the supplied database's own name, so
 * whoever owns that database (a gate run) can also find everything made under it.
 */
export default function setup(project: TestProject) {
  const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
  if (supplied === undefined) return Effect.runPromise(Effect.succeed(() => {}))
  const owner = new URL(supplied).pathname.slice(1).slice(0, 24)
  const prefix = `${owner}_${NodeCrypto.randomBytes(4).toString('hex')}`
  const admin = new Pg.Client({ connectionString: supplied })
  // Define cleanup before creating any database, including failures during migration/setup.
  const cleanupProgram = Effect.gen(function* () {
    // Vitest does not run afterAll for entirely skipped files or failed collection. Only this
    // invocation's captured prefix grants teardown authority over their leftover databases.
    const suites = yield* Effect.promise(() =>
      admin.query(
        'SELECT quote_ident(datname) AS name FROM pg_database WHERE starts_with(datname, $1)',
        [`${prefix}_`],
      ),
    )
    for (const suite of decodeNames(suites.rows))
      yield* Effect.promise(() => admin.query(`DROP DATABASE ${suite.name} WITH (FORCE)`))
  }).pipe(Effect.ensuring(Effect.promise(() => admin.end())))
  const cleanup = () => Effect.runPromise(cleanupProgram)
  const program = Effect.gen(function* () {
    yield* Effect.promise(() => admin.connect())
    return yield* Effect.gen(function* () {
      const template = yield* migratedTemplate(admin, supplied, prefix)
      project.provide('serverDatabaseTemplate', template)
      project.provide('serverDatabasePrefix', prefix)
      return cleanup
    }).pipe(
      // Preserve the rethrow after cleanup for typed failures, defects and interruption alike.
      Effect.onError(() => cleanupProgram),
    )
  })
  return Effect.runPromise(program)
}
