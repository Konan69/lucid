import * as Output from 'alchemy/Output'
import * as Railway from 'alchemy/Railway'
import * as RemovalPolicy from 'alchemy/RemovalPolicy'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { InfrastructureEnvironment } from './env.ts'
import { cellVariables, cellsUrl, railwayCells } from './cells.ts'
import { cellInputs } from './inputs.ts'
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
  server: 'vivid-server',
} as const

const ports = { executor: 8080, helix: 8080, server: 8787 } as const

/** Private mesh address of a service; never reachable from the public internet. */
const privateUrl = (name: string, port: number) => `http://${name}.railway.internal:${port}`

/**
 * Railway's private mesh is IPv6 in older environments and dual-stack in newer ones. Listening on
 * `::` accepts both, where `0.0.0.0` would refuse private IPv6 callers.
 */
const listenHost = '::'

/**
 * The server is built by Railway from this repository, on a push to `main`
 * (Railway's GitHub trigger; `alchemy/src/Railway/ServiceProvider.ts`, `syncBranch`). Before
 * 7 October 2026 a person ran the deploy, which uploaded a working tree for Railway to build, so
 * production held `main` only when someone had remembered to. Railway builds the server's
 * Dockerfile, the server's image exports the phone
 * app's update, and the server's pre-deploy command migrates and publishes the Worker.
 *
 * Railway's GitHub app must be able to read the repository; that was proved on a disposable
 * project before this was written. A push is deployed without this stack seeing it, so nothing
 * here can refuse one: the gate `git push` runs (`.husky/pre-push`) is what keeps a failing tree
 * off `main`. Railway can also wait for GitHub's checks, which do not run for this repository
 * today.
 *
 * The server is given what its image is built from as `watchPatterns` (the list below),
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
 * What the server's image is built from (`apps/server/Dockerfile`). The phone app is here
 * because this image exports its update, and the desktop app's shared sources because the web
 * app's build reads them.
 */
const serverInputs = [
  ...cellInputs(),
  '/apps/server/**',
  '/apps/web/**',
  '/apps/mobile/**',
  '/apps/desktop/src/shared/**',
  '/apps/*/package.json',
  '/packages/**',
  '/patches/**',
  '/scripts/migrate.mjs',
  '/infra/cli.mjs',
  '/scripts/sentry-upload.mjs',
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/tsconfig.base.json',
  '/tsconfig.hermes.json',
  '/hermes.d.ts',
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
  /** Executor's sign-in checks this origin; the private address above is refused there. */
  VIVID_EXECUTOR_PUBLIC_URL: `https://\${{${serviceNames.executor}.RAILWAY_PUBLIC_DOMAIN}}`,
  /** Each Person's own Executor member is invited by the owner and its key sealed with this. */
  VIVID_EXECUTOR_OWNER_EMAIL: executor.ownerEmail,
  VIVID_EXECUTOR_OWNER_PASSWORD: executor.ownerPassword,
  VIVID_EXECUTOR_SEAL_KEY: executor.sealKey,
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
    onSome: ({ url, headers, dsn, uploadToken }) => ({
      VIVID_OTLP_URL: url,
      VIVID_OTLP_HEADERS: headers,
      SENTRY_DSN: dsn,
      SENTRY_AUTH_TOKEN: uploadToken,
      VIVID_ENVIRONMENT: '${{RAILWAY_ENVIRONMENT_NAME}}',
      VIVID_COMMIT: '${{RAILWAY_GIT_COMMIT_SHA}}',
    }),
  })

/** A setting the server has its own default for is sent only when the deploy sets it. */
const whenSet = (name: string, value: Option.Option<string>) =>
  Option.match(value, { onNone: () => ({}), onSome: (set) => ({ [name]: set }) })

/** Discord early access and the channel bot, each sent only when the deploy sets it. */
const discordSettings = (environment: InfrastructureEnvironment) => ({
  ...whenSet('VIVID_DISCORD_PEOPLE', environment.discordPeople),
  ...Option.match(environment.discordBotToken, {
    onNone: () => ({}),
    onSome: (token) => ({ VIVID_DISCORD_BOT_TOKEN: token }),
  }),
})

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
 * The hosted product on Railway: product PostgreSQL, native cells on the private mesh, and the
 * application server as the only public service. The server serves the built web app itself
 * (`VIVID_WEB_DIST`, set in `apps/server/Dockerfile`), so web, `/api` and WebSockets share one
 * origin exactly as they do behind the Vite proxy locally.
 *
 * The Person cell holds memory and Executor owns Integrations (`docs/24-executor-scale.md`).
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

  /** Migration reads the old memory once. Retain both resources until a follow-up removes their declarations. */
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
  }).pipe(RemovalPolicy.retain())
  yield* Railway.Volume('HelixData', { project, service: helix, mountPath: '/var/lib/helix' }).pipe(
    RemovalPolicy.retain(),
  )

  /**
   * Executor's hosted shape, as its self-host guide deploys it on Railway
   * (`apps/hosted/self-host/README.md`, "Railway", in the Executor repository): one image, one
   * volume at `/app/data` holding its database, app source, builds and generated keys, a public
   * domain because a Person's browser returns from a provider's sign-in through it, `/health` with
   * a 120-second start, and exactly one instance per volume. The image derives its own origin from
   * `RAILWAY_PUBLIC_DOMAIN`. Pin the published beta.23 image, whose app/user account links
   * replace profiles. Each Vivid Connection owns a dedicated app.
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
    /**
     * Idle, Executor sends nothing (Railway's network metrics read zero for hours on
     * 3 November 2026) yet holds about 1 GB, billed by the minute. Railway sleeps a service after
     * ten minutes without outbound packets and wakes it on the next inbound request, public or
     * private, so the first call after a quiet spell waits for its start.
     */
    sleepApplication: true,
    env: {
      PORT: String(ports.executor),
      EXECUTOR_OAUTH_CALLBACK_URL: `https://\${{${serviceNames.server}.RAILWAY_PUBLIC_DOMAIN}}/api/connections/return`,
      /**
       * Executor fetches an address a Person gives it, from a network that also holds the
       * database. These three keep it to public addresses: no loopback, no plain-HTTP
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
   * Keep the existing logical id and mount path so the first cell deploy preserves every notes
   * SQLite file. Volume.ts permits a disconnected volume; Plan.ts sees no service dependency.
   * ServiceProvider.ts deletes only the old service, leaving this retained volume declared.
   */
  yield* Railway.Volume('RuntimeMemory', {
    project,
    mountPath: '/var/lib/vivid/memory',
  }).pipe(RemovalPolicy.retain())

  const storage = yield* railwayCells(project, target)

  /** The server keeps product PostgreSQL and relays private runtime calls to the native fleet. */
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
    startCommand: 'env -u SENTRY_AUTH_TOKEN pnpm --filter @vivid/server start',
    /**
     * Auth tables, then product tables, in the order `scripts/migrate.mjs` owns. Railway runs this
     * in the freshly built image before the new server takes traffic; a failure keeps the previous
     * deployment serving. The matching Worker is published before the new server takes traffic.
     */
    preDeploy: {
      command:
        'node scripts/migrate.mjs server && node scripts/sentry-upload.mjs vivid-mobile apps/mobile/updates && node apps/cells/scripts/build.mjs deploy',
    },
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
      ...storage,
      VIVID_CELL_VARS: cellVariables(environment, privateUrl(serviceNames.server, ports.server)),
      VIVID_RUNTIME_URL: cellsUrl,
      VIVID_RUNTIME_TOKEN: environment.runtimeToken,
      OPENROUTER_API_KEY: environment.openRouterKey,
      ...computerAccess(environment),
      ...executorAccess(environment),
      ...textingAccess(environment),
      ...pushAccess(environment),
      ...decisionAccess,
      ...discordSettings(environment),
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
