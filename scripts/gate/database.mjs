import * as NodeChildProcess from 'node:child_process'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeEvents from 'node:events'
import * as NodeReadline from 'node:readline'

/** The gate's own disposable PostgreSQL server. Nothing but gate runs ever connects to it. */
const container = 'vivid-gate-pg'
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
  await awaitPostgres()
  const port = docker(['port', container, '5432/tcp'])
  const published = port.stdout.trim().split('\n')[0]
  if (port.status !== 0 || published === undefined || published === '')
    throw new GateDatabaseUnavailable(`${container} publishes no port`)
  return `postgres://vivid:vivid@${published}/postgres`
}

/** Replay logs from this container start, then follow them. The image's temporary server
 * has no TCP listener, so only a ready line followed by TCP readiness admits migrations.
 * Docker closes the stream on container death; there is no path returning an unready address. */
async function awaitPostgres() {
  const started = docker(['inspect', '--format', '{{.State.StartedAt}}', container])
  if (started.status !== 0)
    throw new GateDatabaseUnavailable('could not inspect disposable PostgreSQL')
  const logs = NodeChildProcess.spawn('docker', [
    'logs',
    '--follow',
    '--since',
    started.stdout.trim(),
    container,
  ])
  const closed = NodeEvents.once(logs, 'close')
  const output = new NodeEvents.EventEmitter()
  const streams = [logs.stdout, logs.stderr].map((input) => NodeReadline.createInterface({ input }))
  for (const lines of streams) lines.on('line', (line) => output.emit('line', line))
  try {
    const ready = NodeEvents.once(output, 'ready')
    const check = () => {
      const receipt = docker(['exec', container, 'pg_isready', '--host=127.0.0.1', '--quiet'])
      if (receipt.status === 0) output.emit('ready')
    }
    output.on('line', (line) => {
      if (line.includes('database system is ready to accept connections')) check()
    })
    // A running server may have rotated its startup log. Subscribe before this current read.
    check()
    await Promise.race([
      ready,
      closed.then(() => {
        throw new GateDatabaseUnavailable('disposable PostgreSQL ended before readiness')
      }),
    ])
  } finally {
    for (const lines of streams) lines.close()
    logs.kill()
    await closed
  }
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

/** The database comment identifies the lease protocol, never an elapsed lifetime.
 * A connected owner excludes cleanup; a killed owner loses its server-side advisory lock. */
async function sweepAbandoned(admin) {
  const abandoned = await admin.query(
    `SELECT datname AS owner FROM pg_database
   WHERE starts_with(datname, 'gate_')
     AND shobj_description(oid, 'pg_database') = 'vivid-gate-owner-v1'`,
  )
  for (const row of abandoned.rows) {
    const lease = await admin.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [row.owner],
    )
    if (!lease.rows[0].acquired) continue
    try {
      const leftovers = await admin.query(
        'SELECT quote_ident(datname) AS name FROM pg_database WHERE starts_with(datname, $1)',
        [row.owner],
      )
      for (const leftover of leftovers.rows)
        await admin.query(`DROP DATABASE IF EXISTS ${leftover.name} WITH (FORCE)`)
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [row.owner])
    }
  }
}

/**
 * One empty database for one gate run, on the supplied server or the gate's own. Every suite
 * derives its databases and schemas from it, so two runs share no state and need no lock. The
 * returned `close` drops everything whose name starts with the run's name, which also covers
 * what a killed test worker left behind. Databases of runs that died before their own sweep are
 * dropped only after acquiring their advisory owner lease. A slow live run retains its lease.
 */
export async function openRunDatabase(root, environment, runId) {
  const supplied = environment.VIVID_TEST_DATABASE_URL
  const address = supplied === undefined || supplied === '' ? await containerAddress() : supplied
  // PostgreSQL advisory locks are database-scoped. All owners, including nested proof runs,
  // must acquire their leases in the same administrative database on this disposable server.
  const authority = new URL(address)
  authority.pathname = '/postgres'
  const adminUrl = authority.href
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
  // Losing the live connection revokes ownership. The CLI's signal handler stops its children
  // before releasing capacity, so they cannot continue while another run reclaims the database.
  admin.on('error', () => {
    process.stderr.write('the test database owner lease was lost\n')
    process.kill(process.pid, 'SIGTERM')
  })
  try {
    await admin.connect()
  } catch (error) {
    throw new GateDatabaseUnavailable(`the test database server refused: ${error.message}`)
  }
  try {
    // The connected owner holds this lease until close. Process death closes the connection,
    // so PostgreSQL releases it without a timestamp, a heartbeat guess, or a reused process id.
    await admin.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [name])
    await sweepAbandoned(admin)
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    await admin.query(`COMMENT ON DATABASE "${name}" IS 'vivid-gate-owner-v1'`)
  } catch (error) {
    await sweep(admin).finally(() => admin.end())
    throw error
  }
  const target = new URL(adminUrl)
  target.pathname = `/${name}`
  return {
    url: target.href,
    close: async () => {
      await sweep(admin).finally(() => admin.end())
    },
  }
}
