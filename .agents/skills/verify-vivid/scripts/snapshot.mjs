import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import * as NodeURL from 'node:url'
import { Schema, Result } from 'effect'
import { control } from './socket.mjs'
import { command, identity, signal, json } from './process.mjs'
import { image } from './executor.mjs'

const decodeSubscriptions = Schema.decodeUnknownResult(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      stopped: Schema.NullOr(Schema.String),
    }),
  ),
)
const decodeEvents = Schema.decodeUnknownResult(
  Schema.Array(Schema.Struct({ id: Schema.String, event_id: Schema.String })),
)
const decodeDeliveries = Schema.decodeUnknownResult(
  Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
)

/** Docker health is the restart receipt. Capture the observer before starting the container;
 * a failed feature remains cleanable through the supervisor's existing process journal. */
async function restart(state) {
  const events = NodeChildProcess.spawn(
    'docker',
    [
      'events',
      '--since',
      new Date().toISOString(),
      '--filter',
      'container=' + state.executorContainer,
      '--filter',
      'event=health_status',
      '--format',
      '{{.Action}}',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  const closed = NodeEvents.once(events, 'close')
  try {
    await control(state, { action: 'capture', process: await identity(events.pid) })
    await command(['docker', 'start', state.executorContainer])
    const health = await command([
      'docker',
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      state.executorContainer,
    ])
    if (health !== 'healthy')
      await signal(
        events,
        events.stdout,
        'data',
        (bytes) => bytes.toString().includes('health_status: healthy'),
        240_000,
      )
  } finally {
    events.kill('SIGTERM')
    await closed
  }
}

/**
 * `executor-host export` boots its own workerd and dials `export.sock` inside the exporter. Under
 * load on the PC it sometimes dials before workerd listens ("export.sock: connect: connection
 * refused", runs pi-20261029002406601-672b083c and pi-20261029003737757-49dcebce), an upstream race
 * in the pinned image. The export only reads the stopped volume into a fresh file, so that one
 * failure is retried once; its output stays in evidence and every other failure still fails.
 */
async function exported(argv, directory) {
  try {
    await command(argv)
  } catch (error) {
    if (!String(error.message).includes('export.sock: connect: connection refused')) throw error
    await json(directory + '/export-attempt1.json', { error: String(error.message) })
    await command(argv)
  }
}

/** Executor beta.23 ships `executor-host export`. It takes the volume lock, so stop only our
 * container before exporting, then restart it in finally. The private dump never enters evidence.
 * Executor's pinned PGlite 0.5.8 `loadDataDir` opens an in-memory copy, not the running provider store. */
export async function providerSnapshot(state, { callback, receipt }, directory) {
  const filename = 'watch-' + crypto.randomUUID() + '.tar'
  const backup = state.scratch + '/' + filename
  const label = await command([
    'docker',
    'inspect',
    '--format',
    '{{index .Config.Labels "vivid.verify"}}',
    state.executorContainer,
  ])
  if (label !== state.run) throw new Error('Executor snapshot ownership mismatch')
  await command(['docker', 'stop', state.executorContainer])
  try {
    await exported(
      [
        'docker',
        'run',
        '--rm',
        '--name',
        state.executorExporter,
        '--label',
        'vivid.verify=' + state.run,
        '--network',
        'none',
        '--volumes-from',
        state.executorContainer,
        '--env',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:9/v1/traces',
        '--env',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:9/v1/logs',
        '--env',
        'DO_NOT_TRACK=1',
        '--env',
        'EXECUTOR_DISABLE_ANALYTICS=1',
        image,
        'executor-host',
        'export',
        '/app/data/' + filename,
      ],
      directory,
    )
    await command(['docker', 'cp', state.executorContainer + ':/app/data/' + filename, backup])
    const require = NodeModule.createRequire(state.scratch + '/inspector/package.json')
    const path = require.resolve('@electric-sql/pglite')
    const { PGlite } = await import(NodeURL.pathToFileURL(path).href)
    const database = new PGlite({ loadDataDir: new Blob([await NodeFSP.readFile(backup)]) })
    try {
      await database.waitReady
      const read = async (decode, sql, parameters) =>
        Result.getOrThrow(decode((await database.query(sql, parameters)).rows))
      const subscriptions = await read(
        decodeSubscriptions,
        'SELECT id, status, stopped FROM executor_event_subscriptions WHERE callback_url=$1',
        [callback],
      )
      const events = await read(
        decodeEvents,
        'SELECT id, event_id FROM executor_events WHERE event_id=$1',
        [receipt],
      )
      const deliveries = await read(
        decodeDeliveries,
        'SELECT d.id, d.status FROM executor_event_deliveries d JOIN executor_events e ON e.id=d.event JOIN executor_event_subscriptions s ON s.id=d.subscription WHERE e.event_id=$1 AND s.callback_url=$2',
        [receipt, callback],
      )
      const result = { callback, receipt, subscriptions, events, deliveries }
      await json(directory + '/provider-state.json', result)
      return result
    } finally {
      await database.close()
    }
  } finally {
    await NodeFSP.rm(backup, { force: true })
    await restart(state)
  }
}
