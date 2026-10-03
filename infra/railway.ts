import * as Railway from 'alchemy/Railway'
import * as Effect from 'effect/Effect'
import type { InfrastructureEnvironment } from './env.ts'
import type { DeploymentTarget } from './targets.ts'

/**
 * Service names are fixed because Railway derives each private hostname from the name
 * (`{name}.railway.internal`, see `alchemy/lib/Railway/Service.d.ts` "Private service"). The server
 * and the runtime call each other, so neither address can come from the other's resource output
 * without a dependency cycle; both are derived from these names instead.
 */
const serviceNames = {
  database: 'vivid-postgres',
  runtime: 'vivid-runtime',
  server: 'vivid-server',
} as const

const ports = { runtime: 5173, server: 8787 } as const

/** Private mesh address of a service; never reachable from the public internet. */
const privateUrl = (name: string, port: number) => `http://${name}.railway.internal:${port}`

/**
 * Railway's private mesh is IPv6 in older environments and dual-stack in newer ones. Listening on
 * `::` accepts both, where `0.0.0.0` would refuse private IPv6 callers.
 */
const listenHost = '::'

/**
 * The hosted product on Railway: PostgreSQL, the Flue runtime on the private mesh, and the
 * application server as the only public service. The server serves the built web app itself
 * (`VIVID_WEB_DIST`, set in `apps/server/Dockerfile`), so web, `/api` and WebSockets share one
 * origin exactly as they do behind the Vite proxy locally.
 *
 * Helix, Executor and program isolation are not part of this graph yet: the server reports those
 * capabilities as unavailable when their addresses are absent (`docs/19-infrastructure.md`).
 */
export const railwayResources = Effect.fn('railwayResources')(function* (
  target: DeploymentTarget,
  environment: InfrastructureEnvironment,
) {
  const project = yield* Railway.Project('Project', { name: target.stackName })

  /**
   * Local development pins PostgreSQL 18 (`infra/database.ts`); the provider defaults to 16. The
   * same major keeps generated migrations and SQL behavior identical. The proxy stays closed:
   * migrations run inside Railway as the server's pre-deploy step, never from a laptop.
   */
  const database = yield* Railway.Postgres('Database', {
    project,
    name: serviceNames.database,
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:18',
    database: 'vivid',
    public: false,
  })

  /** Flue keeps its durable state in PostgreSQL, so the runtime needs no volume of its own. */
  yield* Railway.Service('Runtime', {
    project,
    name: serviceNames.runtime,
    context: '.',
    dockerfilePath: 'packages/agent/runtime/Dockerfile',
    port: ports.runtime,
    publicDomain: false,
    healthcheckPath: '/health',
    env: {
      DATABASE_URL: database.connectionUri,
      HOST: listenHost,
      PORT: String(ports.runtime),
      EXPLABS_API_KEY: environment.modelGatewayKey,
      VIVID_RUNTIME_TOKEN: environment.runtimeToken,
      VIVID_SERVER_URL: privateUrl(serviceNames.server, ports.server),
      VIVID_MODEL: environment.model,
    },
  })

  const server = yield* Railway.Service('Server', {
    project,
    name: serviceNames.server,
    context: '.',
    dockerfilePath: 'apps/server/Dockerfile',
    port: ports.server,
    publicDomain: true,
    healthcheckPath: '/health',
    /**
     * Auth tables, then product tables, in the order `scripts/migrate.mjs` owns. Railway runs this
     * in the freshly built image before the new server takes traffic; a failure keeps the previous
     * deployment serving.
     */
    preDeploy: { command: 'node scripts/migrate.mjs' },
    env: {
      DATABASE_URL: database.connectionUri,
      AUTH_SECRET: environment.authSecret,
      HOST: listenHost,
      PORT: String(ports.server),
      /**
       * Railway resolves this reference to the service's generated domain at deploy time. The
       * domain does not exist until the service does, so it cannot be a resource output here.
       */
      PUBLIC_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      VIVID_RUNTIME_URL: privateUrl(serviceNames.runtime, ports.runtime),
      VIVID_RUNTIME_TOKEN: environment.runtimeToken,
      EXPLABS_API_KEY: environment.modelGatewayKey,
      /** Where `apps/server/Dockerfile` leaves the built web app; the server serves it itself. */
      VIVID_WEB_DIST: '/app/apps/web/dist',
    },
  })

  return { serverUrl: server.url }
})
