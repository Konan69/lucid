import * as NodeChildProcess from 'node:child_process'
import * as NodeNet from 'node:net'
import * as Effect from 'effect/Effect'

const databaseUrlValue = process.env.DATABASE_URL
if (databaseUrlValue === undefined || databaseUrlValue.length === 0) {
  throw new Error('DATABASE_URL is required for migrations')
}

const databaseUrl = new URL(databaseUrlValue)
const port = databaseUrl.port.length === 0 ? 5432 : Number(databaseUrl.port)

/** Check one TCP connection without logging the credential-bearing URL. */
const databaseAcceptsConnections = Effect.fn('migrate.databaseAcceptsConnections')(() =>
  Effect.async((resume) => {
    const socket = NodeNet.createConnection({ host: databaseUrl.hostname, port })
    let completed = false
    const finish = (connected) => {
      if (completed) return
      completed = true
      socket.destroy()
      resume(Effect.succeed(connected))
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
    return Effect.sync(() => socket.destroy())
  }),
)

/** Bound startup waiting prevents Docker health races from becoming migration races. */
const waitForDatabase = Effect.fn('migrate.waitForDatabase')(function* () {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (yield* databaseAcceptsConnections()) return yield* Effect.void
    yield* Effect.sleep('500 millis')
  }
  return yield* Effect.fail(new Error('PostgreSQL did not accept connections within 30 seconds'))
})

const migrations = [
  {
    name: 'server',
    cwd: 'apps/server',
    args: ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.config.ts'],
  },
  {
    name: 'agent-runtime',
    cwd: 'packages/agent-runtime',
    args: ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.config.ts'],
  },
  {
    name: 'connectors',
    cwd: 'packages/connectors',
    args: ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.config.ts'],
  },
]

// This executable owns the Effect runtime terminal for its startup boundary.
// oxlint-disable-next-line vivid/no-runpromise-in-library
await Effect.runPromise(waitForDatabase())
for (const migration of migrations) {
  console.log(`Applying ${migration.name} migrations`)
  const result = NodeChildProcess.spawnSync('pnpm', migration.args, {
    cwd: migration.cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${migration.name} migrations failed with exit code ${result.status}`)
  }
}
