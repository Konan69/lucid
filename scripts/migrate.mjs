import { spawnSync } from "node:child_process"
import net from "node:net"

const databaseUrlValue = process.env.DATABASE_URL
if (databaseUrlValue === undefined || databaseUrlValue.length === 0) {
  throw new Error("DATABASE_URL is required for migrations")
}

const databaseUrl = new URL(databaseUrlValue)
const port = databaseUrl.port.length === 0 ? 5432 : Number(databaseUrl.port)

/** Check one TCP connection without logging the credential-bearing URL. */
const databaseAcceptsConnections = () => new Promise((resolve) => {
  const socket = net.createConnection({ host: databaseUrl.hostname, port })
  const finish = (connected) => {
    socket.destroy()
    resolve(connected)
  }
  socket.setTimeout(500, () => finish(false))
  socket.once("error", () => finish(false))
  socket.once("connect", () => finish(true))
})

/** Bound startup waiting prevents Docker health races from becoming migration races. */
const waitForDatabase = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await databaseAcceptsConnections()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("PostgreSQL did not accept connections within 30 seconds")
}

const migrations = [
  {
    name: "server",
    cwd: "apps/server",
    args: ["exec", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
  },
  {
    name: "agent-runtime",
    cwd: "packages/agent-runtime",
    args: ["exec", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
  },
  {
    name: "connectors",
    cwd: "packages/connectors",
    args: ["exec", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"]
  }
]

await waitForDatabase()
for (const migration of migrations) {
  console.log(`Applying ${migration.name} migrations`)
  const result = spawnSync("pnpm", migration.args, {
    cwd: migration.cwd,
    env: process.env,
    stdio: "inherit"
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${migration.name} migrations failed with exit code ${result.status}`)
  }
}
