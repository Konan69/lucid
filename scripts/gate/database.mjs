import * as NodeChildProcess from 'node:child_process'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeTimersPromises from 'node:timers/promises'

/** The gate's own disposable PostgreSQL server. Nothing but gate runs ever connects to it. */
const container = 'vivid-gate-pg'
/**
 * A run that died without its sweep leaves databases behind; this is how long they may stay.
 * Age stands in for a lease: a full gate is minutes, so nothing alive is six hours old.
 */
const abandonedAfterSeconds = 6 * 60 * 60

/** A gate must never pass with its database suites skipped, so an absent server is a failure. */
export class GateDatabaseUnavailable extends Error {
  name = 'GateDatabaseUnavailable'
}

function docker(args) {
  return NodeChildProcess.spawnSync('docker', args, { encoding: 'utf8' })
}

/**
 * The address of the gate's server, started when it is not running. Durability is switched off
 * and the data directory is memory: every database here is a copy of a migrated template that a
 * run drops when it ends, so a crash loses nothing and `CREATE DATABASE` costs no disk sync. The
 * host port is chosen by Docker, because a fixed one may belong to another session's container
 * (the developer's PC could not run database suites for that reason).
 */
async function containerAddress() {
  const state = docker(['inspect', '--format', '{{.State.Running}}', container])
  if (state.error !== undefined)
    throw new GateDatabaseUnavailable(
      'no VIVID_TEST_DATABASE_URL and Docker is not available to start a disposable server',
    )
  if (state.status !== 0) {
    const created = docker([
      'run',
      '--detach',
      '--name',
      container,
      '--restart=unless-stopped',
      '--env=POSTGRES_USER=vivid',
      '--env=POSTGRES_PASSWORD=vivid',
      '--env=POSTGRES_DB=postgres',
      '--tmpfs=/var/lib/postgresql:rw,size=3g',
      '--shm-size=1g',
      '--publish=127.0.0.1::5432',
      'postgres:18-alpine',
      ...[
        'fsync=off',
        'synchronous_commit=off',
        'full_page_writes=off',
        'max_connections=400',
      ].flatMap((setting) => ['-c', setting]),
    ])
    // Two gates starting at once race for the name; the loser finds the winner's container below.
    if (created.status !== 0 && !created.stderr.includes('is already in use'))
      throw new GateDatabaseUnavailable(`could not start ${container}: ${created.stderr.trim()}`)
  } else if (state.stdout.trim() !== 'true') {
    const started = docker(['start', container])
    if (started.status !== 0)
      throw new GateDatabaseUnavailable(`could not start ${container}: ${started.stderr.trim()}`)
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    // The image starts PostgreSQL twice (once to initialise); only a TCP answer means it is up.
    const ready = docker(['exec', container, 'pg_isready', '--host=127.0.0.1', '--quiet'])
    if (ready.status === 0) break
    await NodeTimersPromises.setTimeout(250)
  }
  const port = docker(['port', container, '5432/tcp'])
  const published = port.stdout.trim().split('\n')[0]
  if (port.status !== 0 || published === undefined || published === '')
    throw new GateDatabaseUnavailable(`${container} publishes no port`)
  return `postgres://vivid:vivid@${published}/postgres`
}

/**
 * `pg` belongs to the server package, and pnpm links a dependency only into the package that
 * declares it. The gate has no manifest of its own to declare one in, so it resolves the driver
 * from the package whose suites it is about to run.
 */
function postgresDriver(root) {
  const require = NodeModule.createRequire(NodePath.join(root, 'apps/server/package.json'))
  return require('pg')
}

/**
 * One empty database for one gate run, on the supplied server or the gate's own. Every suite
 * derives its databases and schemas from it, so two runs share no state and need no lock. The
 * returned `close` drops everything whose name starts with the run's name, which also covers
 * what a killed test worker left behind. Databases of runs that died before their own sweep are
 * dropped here once they are old enough; the creation time is kept as the database comment.
 */
export async function openRunDatabase(root, environment, runId) {
  const supplied = environment.VIVID_TEST_DATABASE_URL
  const adminUrl = supplied === undefined || supplied === '' ? await containerAddress() : supplied
  const Pg = postgresDriver(root)
  const name = `gate_${runId}`
  const sweep = async (admin) => {
    const owned = await admin.query(
      'SELECT quote_ident(datname) AS name FROM pg_database WHERE starts_with(datname, $1)',
      [name],
    )
    for (const row of owned.rows) await admin.query(`DROP DATABASE ${row.name} WITH (FORCE)`)
  }
  const admin = new Pg.Client({ connectionString: adminUrl })
  try {
    await admin.connect()
  } catch (error) {
    throw new GateDatabaseUnavailable(`the test database server refused: ${error.message}`)
  }
  try {
    const abandoned = await admin.query(
      `SELECT quote_ident(datname) AS name FROM pg_database
       WHERE starts_with(datname, 'gate_')
         AND shobj_description(oid, 'pg_database') ~ '^[0-9]+$'
         AND shobj_description(oid, 'pg_database')::bigint < extract(epoch FROM now()) - $1`,
      [abandonedAfterSeconds],
    )
    // IF EXISTS: two runs starting together both see the same abandoned database.
    for (const row of abandoned.rows)
      await admin.query(`DROP DATABASE IF EXISTS ${row.name} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    await admin.query(`COMMENT ON DATABASE "${name}" IS '${Math.floor(Date.now() / 1000)}'`)
  } catch (error) {
    await sweep(admin).finally(() => admin.end())
    throw error
  }
  await admin.end()
  const target = new URL(adminUrl)
  target.pathname = `/${name}`
  return {
    url: target.href,
    close: async () => {
      const closer = new Pg.Client({ connectionString: adminUrl })
      await closer.connect()
      await sweep(closer).finally(() => closer.end())
    },
  }
}
