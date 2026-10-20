import * as Output from 'alchemy/Output'
import * as Railway from 'alchemy/Railway'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { InfrastructureEnvironment } from './env.ts'
import { repository } from './github.ts'
import type { DeploymentTarget } from './targets.ts'

/**
 * Service names are fixed because Railway derives each private hostname from the name
 * (`{name}.railway.internal`, see `alchemy/lib/Railway/Service.d.ts` "Private service"). The server
 * and the runtime call each other, so neither address can come from the other's resource output
 * without a dependency cycle; both are derived from these names instead.
 */
const serviceNames = {
  database: 'vivid-postgres',
  executor: 'vivid-executor',
  helix: 'vivid-helix',
  runtime: 'vivid-runtime',
  server: 'vivid-server',
} as const

const ports = { executor: 8080, helix: 8080, runtime: 5173, server: 8787 } as const

/** Private mesh address of a service; never reachable from the public internet. */
const privateUrl = (name: string, port: number) => `http://${name}.railway.internal:${port}`

/**
 * Railway's private mesh is IPv6 in older environments and dual-stack in newer ones. Listening on
 * `::` accepts both, where `0.0.0.0` would refuse private IPv6 callers.
 */
const listenHost = '::'

/** Where the runtime's volume is mounted; each Person's notes are one SQLite file in it. */
const memoryPath = '/var/lib/vivid/memory'

/**
 * The server and the runtime are built by Railway from this repository, on a push to `main`
 * (Railway's GitHub trigger; `alchemy/src/Railway/ServiceProvider.ts`, `syncBranch`). Before
 * 7 October 2026 a person ran the deploy, which uploaded a working tree for Railway to build, so
 * production held `main` only when someone had remembered to. Everything after the upload was
 * Railway's already and still is: it builds each Dockerfile, the server's image exports the phone
 * app's update, and the server's pre-deploy command migrates.
 *
 * Railway's GitHub app must be able to read the repository; that was proved on a disposable
 * project before this was written. A push is deployed without this stack seeing it, so nothing
 * here can refuse one: the gate `git push` runs (`.husky/pre-push`) is what keeps a failing tree
 * off `main`. Railway can also wait for GitHub's checks, which do not run for this repository
 * today.
 *
 * Each service is given what its image is built from as `watchPatterns` (the two lists below),
 * so a push that changes none of it starts no build there (Railway "Watch Paths":
 * gitignore-style, from the repository's root). `scripts/infra-verify.mjs` fails when a
 * Dockerfile copies a path its service does not watch.
 */
const builtFromMain = {
  repo: `${repository.owner}/${repository.name}`,
  branch: 'main',
  autoUpdates: true,
} as const

/**
 * What the runtime's image is built from (`packages/agent/runtime/Dockerfile`). A push to the
 * server, the web app or the phone app alone leaves the runtime running. The phone's native
 * Markdown view is the exception: it is a tarball in `apps/mobile/deps` that the lockfile names, so
 * the runtime's install reads it.
 */
const runtimeInputs = [
  '/packages/**',
  '/patches/**',
  '/apps/*/package.json',
  '/apps/mobile/deps/**',
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/tsconfig.base.json',
  '/.dockerignore',
]

/**
 * What the server's image is built from (`apps/server/Dockerfile`). The phone app is here
 * because this image exports its update, and the desktop app's shared sources because the web
 * app's build reads them.
 */
const serverInputs = [
  '/apps/server/**',
  '/apps/web/**',
  '/apps/mobile/**',
  '/apps/desktop/src/shared/**',
  '/apps/*/package.json',
  '/packages/**',
  '/patches/**',
  '/scripts/migrate.mjs',
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/tsconfig.base.json',
  '/.dockerignore',
]

/**
 * Sign-in with Google. `infra/env.ts` requires all three, so the hosted server always offers it.
 */
const googleAccess = ({ google }: InfrastructureEnvironment) => ({
  GOOGLE_CLIENT_ID: google.clientId,
  GOOGLE_CLIENT_SECRET: google.clientSecret,
  GOOGLE_REDIRECT_URI: google.redirectUri,
})

/**
 * The server reaches Executor over the private mesh with a key minted on that Executor.
 * `infra/env.ts` requires the key and the organization, so the hosted server always has its
 * Integrations; the server itself refuses to start with any of the three missing.
 */
const executorAccess = ({ executor }: InfrastructureEnvironment) => ({
  VIVID_EXECUTOR_URL: privateUrl(serviceNames.executor, ports.executor),
  VIVID_EXECUTOR_KEY: executor.key,
  VIVID_EXECUTOR_ORGANIZATION: executor.organization,
  /** Lets a Person add an Integration by address; true only with the Executor settings above. */
  VIVID_EXECUTOR_PUBLIC_ONLY: 'true',
})

/**
 * Texting Vivid over iMessage. These two were on the hosted server by hand and in no file here,
 * so texting worked by accident and a new environment would have had none (found 5 October
 * 2026). They are part of the graph now: required at deploy and sent like everything else.
 */
const textingAccess = ({ texting }: InfrastructureEnvironment) => ({
  VIVID_PHOTON_PROJECT_ID: texting.projectId,
  VIVID_PHOTON_PROJECT_SECRET: texting.projectSecret,
})

/** Notifications while a Person is away, to browser and phone. */
const pushAccess = ({ push }: InfrastructureEnvironment) => ({
  VIVID_PUSH_VAPID_PUBLIC: push.publicKey,
  VIVID_PUSH_VAPID_PRIVATE: push.privateKey,
  VIVID_PUSH_SUBJECT: push.subject,
})

/**
 * Telemetry export is one atomic pair, absent until a backend exists. With it go the two names
 * the exported resource carries. Railway resolves both references at deploy time; it sets
 * `RAILWAY_GIT_COMMIT_SHA` only for a deployment built from a commit, and the server reads an
 * empty value as absent.
 */
const observabilityAccess = (environment: InfrastructureEnvironment) =>
  Option.match(environment.observability, {
    onNone: () => ({}),
    onSome: ({ url, headers }) => ({
      VIVID_OTLP_URL: url,
      VIVID_OTLP_HEADERS: headers,
      VIVID_ENVIRONMENT: '${{RAILWAY_ENVIRONMENT_NAME}}',
      VIVID_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}',
    }),
  })

/** A setting the server has its own default for is sent only when the deploy sets it. */
const whenSet = (name: string, value: Option.Option<string>) =>
  Option.match(value, { onNone: () => ({}), onSome: (set) => ({ [name]: set }) })

/**
 * Vivid's Computer on Boat. The key and the template are always sent: `infra/env.ts` refuses a
 * deploy without them, and the server refuses to start without them, so the hosted server never
 * runs without its Computer. Boat is the only provider, so there is no selector to set. Boat
 * itself is not a resource of this graph; the server reaches it over the public internet.
 */
const computerAccess = ({ computer }: InfrastructureEnvironment) => ({
  VIVID_BOAT_API_KEY: computer.key,
  VIVID_BOAT_TEMPLATE: computer.template,
  ...whenSet('VIVID_BOAT_ORG', computer.organization),
  ...whenSet('VIVID_BOAT_SIZE', computer.size),
  ...whenSet('VIVID_BOAT_LIFETIME_SECONDS', computer.lifetimeSeconds),
  ...whenSet('VIVID_BOAT_MACHINE', computer.machine),
})

/**
 * The hosted product on Railway: PostgreSQL, the Flue runtime on the private mesh, and the
 * application server as the only public service. The server serves the built web app itself
 * (`VIVID_WEB_DIST`, set in `apps/server/Dockerfile`), so web, `/api` and WebSockets share one
 * origin exactly as they do behind the Vite proxy locally.
 *
 * Helix gives Vivid its memory and Executor its Integrations (`docs/24-executor-scale.md`).
 * Programs Vivid writes need nothing in this graph: they run on the Person's Computer, which the
 * server reaches through its Computer provider (`docs/19-infrastructure.md`).
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

  /**
   * The provider's private URI ends in `sslmode=no-verify`, a node-postgres extension. The server's
   * native Effect client follows libpq and refuses it (`@effect/sql-pg` `PgConnection.ts`,
   * "Unrecognized sslmode in URL"), which reached the log only as `DatabaseUnavailable` at launch
   * while the pre-deploy migration, which runs on node-postgres, passed. `require` is no
   * alternative: that client verifies the certificate and this image's is self-signed. Railway
   * already encrypts the private mesh, so every consumer takes the private address without TLS.
   */
  const databaseUrl = Output.map(database.connectionUri, (uri) => {
    const url = new URL(uri)
    url.searchParams.set('sslmode', 'disable')
    return url.toString()
  })

  /**
   * Helix holds the memory graph on disk. The image and data path are the ones the local stack
   * runs. The image runs as an unprivileged user and a fresh Railway volume is owned by root, so
   * `RAILWAY_RUN_UID` makes the data directory writable without changing the image.
   */
  const helix = yield* Railway.Service('Helix', {
    project,
    name: serviceNames.helix,
    image: 'ghcr.io/helixdb/helixdb:v0.0.5',
    port: ports.helix,
    publicDomain: false,
    env: {
      HELIX_DATA_DIR: '/var/lib/helix',
      HELIX_HTTP_ADDR: `[::]:${ports.helix}`,
      RAILWAY_RUN_UID: '0',
    },
  })
  yield* Railway.Volume('HelixData', { project, service: helix, mountPath: '/var/lib/helix' })

  /**
   * Executor's hosted shape, as its self-host guide deploys it on Railway
   * (`apps/hosted/self-host/README.md`, "Railway", in the Executor repository): one image, one
   * volume at `/app/data` holding its database, app source, builds and generated keys, a public
   * domain because a Person's browser returns from a provider's sign-in through it, `/health` with
   * a 120-second start, and exactly one instance per volume. The image derives its own origin from
   * `RAILWAY_PUBLIC_DOMAIN`. Pin the published beta.23 image, whose app/user account links
   * replace profiles. Each Vivid Connection owns a dedicated app; legacy references reconcile
   * against upstream's explicit copy provenance and requirement links before use.
   *
   * Every sign-in returns to Vivid, not to Executor's own page, which needs an Executor browser
   * session no Person has. Railway resolves the server's domain in the reference at deploy time.
   */
  const executor = yield* Railway.Service('Executor', {
    project,
    name: serviceNames.executor,
    image: 'ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23',
    port: ports.executor,
    publicDomain: true,
    healthcheckPath: '/health',
    healthcheckTimeout: 120,
    env: {
      PORT: String(ports.executor),
      EXECUTOR_OAUTH_CALLBACK_URL: `https://\${{${serviceNames.server}.RAILWAY_PUBLIC_DOMAIN}}/api/connections/return`,
      /**
       * Executor fetches an address a Person gives it, from a network that also holds the
       * database and Helix. These three keep it to public addresses: no loopback, no plain-HTTP
       * exceptions, no private ranges or internal names for an app's own requests. Upstream
       * enforces them at connection time, after DNS (`packages/utils/src/url-policy.ts`), so a
       * name that later resolves inward is refused too. The server may declare
       * `VIVID_EXECUTOR_PUBLIC_ONLY` only because these are set here.
       */
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: 'false',
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: '[]',
      EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: 'false',
      /**
       * Suppress the product's trace exporter by configuring logs alone, with no base or trace
       * endpoint. beta.23 apps/hosted/self-host/src/worker.ts:136-146 skips its bundled-exporter
       * fallback when either signal is configured; packages/telemetry/src/layer.ts:40-60 installs
       * no tracer without a trace target. The scheduler still creates idle spans upstream.
       * This does not stop Motel: native/main.go:709-719 supervises it separately on a Unix
       * socket. TCP 4318 is not that socket. This logs target intentionally has no receiver;
       * console logs remain, and OTLP logs retry a refused connection. Replace it with a real
       * external logs collector when one is provided, preserving logs-only configuration.
       */
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
    },
  })
  yield* Railway.Volume('ExecutorData', { project, service: executor, mountPath: '/app/data' })

  /** Sent only when the deploy sets it; otherwise the server keeps its default (off). */
  const decisionAccess = Option.match(environment.decisions, {
    onNone: () => ({}),
    onSome: (value) => ({ VIVID_DECISIONS: value }),
  })

  /**
   * Flue keeps its durable state in PostgreSQL. The one thing the runtime keeps on disk is a
   * Person's notes: one SQLite file each (`packages/agent/runtime/src/notes.ts`), which sits beside
   * the runtime because that is the part of Vivid that later runs on the Person's own device. The
   * volume below holds them across deployments, and `VIVID_MEMORY_DIR` is what turns notes on.
   *
   * The image runs as `node` and a fresh Railway volume is owned by root, so `RAILWAY_RUN_UID`
   * makes the directory writable without changing the image, as it does for Helix. One volume
   * means exactly one runtime instance.
   */
  const runtime = yield* Railway.Service('Runtime', {
    project,
    name: serviceNames.runtime,
    ...builtFromMain,
    watchPatterns: runtimeInputs,
    dockerfilePath: 'packages/agent/runtime/Dockerfile',
    port: ports.runtime,
    publicDomain: false,
    healthcheckPath: '/health',
    /** Bare Node runs the bundled workspace sources; a retained dashboard command cannot bypass it. */
    startCommand: 'node packages/agent/runtime/dist/server.mjs',
    /** Flue migrates its own schema at startup; clear any inherited pre-deploy command. */
    preDeploy: { command: null },
    env: {
      DATABASE_URL: databaseUrl,
      HOST: listenHost,
      PORT: String(ports.runtime),
      /** The runtime answers with OpenCode Go; the old gateway's key keeps its models selectable. */
      OPENCODE_API_KEY: environment.openCodeKey,
      ...Option.match(environment.openRouterKey, {
        onNone: () => ({}),
        onSome: (key) => ({ OPENROUTER_API_KEY: key }),
      }),
      EXPLABS_API_KEY: environment.modelGatewayKey,
      VIVID_RUNTIME_TOKEN: environment.runtimeToken,
      VIVID_SERVER_URL: privateUrl(serviceNames.server, ports.server),
      VIVID_MODEL: environment.model,
      VIVID_MEMORY_DIR: memoryPath,
      RAILWAY_RUN_UID: '0',
    },
  })
  yield* Railway.Volume('RuntimeMemory', { project, service: runtime, mountPath: memoryPath })

  /**
   * Server and Runtime are independent graph nodes. Resource.ts:Resource registers them;
   * Apply.ts:executePlan reconciles siblings concurrently and executeNode collects failures
   * without cancelling peers. Literal private URLs preserve this independence: Server health,
   * auth, migrations and static routes do not require Runtime to become healthy.
   */
  const server = yield* Railway.Service('Server', {
    project,
    name: serviceNames.server,
    ...builtFromMain,
    watchPatterns: serverInputs,
    dockerfilePath: 'apps/server/Dockerfile',
    port: ports.server,
    publicDomain: true,
    healthcheckPath: '/health',
    /** Pin the image entry: omitting this prop preserves an existing Railway override. */
    startCommand: 'pnpm --filter @vivid/server start',
    /**
     * Auth tables, then product tables, in the order `scripts/migrate.mjs` owns. Railway runs this
     * in the freshly built image before the new server takes traffic; a failure keeps the previous
     * deployment serving.
     */
    preDeploy: { command: 'node scripts/migrate.mjs' },
    env: {
      DATABASE_URL: databaseUrl,
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
      VIVID_HELIX_URL: privateUrl(serviceNames.helix, ports.helix),
      ...computerAccess(environment),
      ...executorAccess(environment),
      ...textingAccess(environment),
      ...pushAccess(environment),
      ...decisionAccess,
      ...observabilityAccess(environment),
      ...googleAccess(environment),
      /** Where `apps/server/Dockerfile` leaves the built web app; the server serves it itself. */
      VIVID_WEB_DIST: '/app/apps/web/dist',
      /** Where the same image leaves the mobile app's over-the-air update (`/api/updates`). */
      VIVID_MOBILE_UPDATES: '/app/apps/mobile/updates',
    },
  })

  return { serverUrl: server.url }
})
