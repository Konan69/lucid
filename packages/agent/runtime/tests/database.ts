import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as Pg from 'pg'
import { Effect, Schema } from 'effect'

/** Suites that need PostgreSQL run when the gate supplies its disposable database, as the server's do. */
export const databaseConfigured = Object.hasOwn(NodeProcess.env, 'VIVID_TEST_DATABASE_URL')

/** No disposable database was supplied, or the one supplied is the developer's own. */
export class DatabaseRefused extends Schema.TaggedError<DatabaseRefused>()(
  'DatabaseRefused',
  { reason: Schema.String },
  { title: 'Runtime test database refused' },
) {}

/** Migrating the template through the production migration owner failed. */
class TemplateMigrationFailed extends Schema.TaggedError<TemplateMigrationFailed>()(
  'TemplateMigrationFailed',
  { output: Schema.String },
  { title: 'Runtime test template migration failed' },
) {}

const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))
const packageRoot = NodeURL.fileURLToPath(new URL('../', import.meta.url))
/** A template no run has used for this long belongs to migrations nobody tests any more. */
const unusedAfterSeconds = 3 * 24 * 60 * 60

/**
 * The administration address: the gate's database for this run (or, inside the server's suite,
 * that file's own copy of it). Never `DATABASE_URL`, never the developer's port 55433.
 */
const supplied = Effect.suspend(() => {
  const url = NodeProcess.env.VIVID_TEST_DATABASE_URL
  if (url === undefined) return Effect.fail(new DatabaseRefused({ reason: 'no test database' }))
  if (new URL(url).port === '55433')
    return Effect.fail(new DatabaseRefused({ reason: 'the developer database port' }))
  return Effect.succeed(url)
})

/** An administration connection for the scope. */
const adminOn = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const admin = new Pg.Client({ connectionString: url })
      return admin.connect().then(() => admin)
    }),
    (admin) => Effect.promise(() => admin.end()),
  )

/**
 * The template's name is a digest of what `drizzle-kit migrate` reads: this package's config and
 * every migration file. A new or edited migration is a new name, so a stale template is never
 * copied. The server's own (`apps/server/tests/template.ts`) is the pattern; the runtime's tables
 * have no relation to the server's, so only the runtime's owner migrates here.
 */
function templateName() {
  const digest = NodeCrypto.createHash('sha256')
  digest.update(NodeFS.readFileSync(NodePath.join(packageRoot, 'drizzle.config.ts')))
  const files = NodeFS.readdirSync(NodePath.join(packageRoot, 'drizzle'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.join(entry.parentPath, entry.name))
  files.sort((left, right) => left.localeCompare(right))
  for (const file of files) {
    digest.update(NodePath.relative(packageRoot, file))
    digest.update(NodeFS.readFileSync(file))
  }
  return `vivid_runtime_template_${digest.digest('hex').slice(0, 24)}`
}

/** Migrate a scratch database through the production owner, then rename it into place. */
const buildTemplate = Effect.fn('RuntimeTestDatabase.buildTemplate')(function* (
  admin: Pg.Client,
  url: string,
  template: string,
) {
  const scratch = `${template}_${NodeCrypto.randomBytes(4).toString('hex')}`
  // Dropped with the scope whatever happens; after the rename there is nothing by this name.
  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${scratch}" TEMPLATE template0`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`)),
  )
  const target = new URL(url)
  target.pathname = `/${scratch}`
  const migration = NodeChildProcess.spawnSync(
    'pnpm',
    ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.config.ts'],
    {
      cwd: packageRoot,
      env: { ...NodeProcess.env, DATABASE_URL: target.href },
      stdio: 'pipe',
      encoding: 'utf8',
    },
  )
  if (migration.error !== undefined || migration.status !== 0)
    return yield* new TemplateMigrationFailed({ output: `${migration.stdout}${migration.stderr}` })
  yield* Effect.promise(() => admin.query(`ALTER DATABASE "${scratch}" RENAME TO "${template}"`))
})

/**
 * The migrated template, built the first time any process on this server needs it. One process
 * at a time decides, under an advisory lock of its administration connection: a template that
 * exists was renamed into place whole. Templates unused for days are dropped on the way.
 */
export const ensureTemplate = Effect.fn('RuntimeTestDatabase.ensureTemplate')(function* (
  url: string,
) {
  const template = templateName()
  const admin = yield* adminOn(url)
  yield* Effect.promise(() =>
    admin.query('SELECT pg_advisory_lock(hashtext($1))', ['vivid_runtime_template']),
  )
  const existing = yield* Effect.promise(() =>
    admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template]),
  )
  if (existing.rowCount === 0) yield* buildTemplate(admin, url, template)
  yield* Effect.promise(() =>
    admin.query(`COMMENT ON DATABASE "${template}" IS '${Math.floor(Date.now() / 1000)}'`),
  )
  const unused = yield* Effect.promise(() =>
    admin.query(
      `SELECT quote_ident(datname) AS name FROM pg_database
       WHERE starts_with(datname, 'vivid_runtime_template_') AND datname <> $1
         AND shobj_description(oid, 'pg_database') ~ '^[0-9]+$'
         AND shobj_description(oid, 'pg_database')::bigint < extract(epoch FROM now()) - $2`,
      [template, unusedAfterSeconds],
    ),
  )
  for (const stale of decodeNames(unused.rows))
    yield* Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS ${stale.name}`))
  return template
}, Effect.scoped)

/**
 * A database of the case's own, copied from the migrated template and dropped, whoever is still
 * connected, when the case's scope closes. Its name starts with the administration database's,
 * so the gate's sweep of its run (`scripts/gate/database.mjs`) also removes one a killed worker
 * left behind. Its address is what the runtime under test is given as `DATABASE_URL`; nothing
 * else ever points there.
 */
export const disposableDatabase = Effect.fn('RuntimeTestDatabase.disposable')(function* () {
  const url = yield* supplied
  const template = yield* ensureTemplate(url)
  const owner = new URL(url).pathname.slice(1).slice(0, 32)
  const name = `${owner}_rt${NodeCrypto.randomBytes(8).toString('hex')}`
  const admin = yield* adminOn(url)
  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  const target = new URL(url)
  target.pathname = `/${name}`
  return target.href
})
