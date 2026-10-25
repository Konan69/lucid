import * as Alchemy from 'alchemy'
import * as Command from 'alchemy/Command'
import * as Docker from 'alchemy/Docker'
import * as GitHub from 'alchemy/GitHub'
import * as Railway from 'alchemy/Railway'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { computerBinariesRelease } from './infra/github.ts'
import { databaseUrlFor } from './infra/database.ts'
import { loadInfrastructureEnvironment } from './infra/env.ts'
import { railwayResources } from './infra/railway.ts'
import { hostedState } from './infra/state.ts'
import { deploymentTargetFromConfig, requireRunnableTarget } from './infra/targets.ts'

/**
 * Stack identity must exist before Alchemy builds the Effect graph. The target
 * decoder keeps invalid external input in a tagged channel before it is made a
 * startup defect. Verified against `alchemy/lib/Stack.d.ts`.
 */
const deployTarget = Effect.runSync(deploymentTargetFromConfig.pipe(Effect.orDie))

/**
 * The local process graph. Built lazily so a Railway target never registers Docker resources.
 */
const localStack = () =>
  Alchemy.Stack(
    deployTarget.stackName,
    {
      /**
       * Command owns the local processes and Docker the PostgreSQL resources; no cloud provider is loaded, so
       * `alchemy dev` never starts an emulator. See `alchemy/lib/Docker/Providers.d.ts`.
       */
      providers: Layer.mergeAll(Command.providers(), Docker.providers(), GitHub.providers()),
      state: Alchemy.localState(),
    },
    Effect.gen(function* () {
      const target = yield* requireRunnableTarget(deployTarget)
      const databaseUrl = yield* databaseUrlFor(target)
      const environment = yield* loadInfrastructureEnvironment

      /** The Computer binaries' release: the desktop app's fetch source, reconciled here. */
      yield* computerBinariesRelease()

      /**
       * Migrations finish before any long-lived process starts. `Command.Exec`
       * is the finite, memoized side-effect resource documented by
       * `alchemy/lib/Command/Exec.d.ts`.
       */
      const migrations = yield* Command.Exec(target.migrationsId, {
        command: 'node scripts/migrate.mjs',
        cwd: '.',
        env: { DATABASE_URL: databaseUrl },
        timeout: '5 minutes',
        memo: {
          include: [
            'apps/server/drizzle/**',
            'apps/server/drizzle.config.ts',
            'apps/server/product-drizzle/**',
            'apps/server/product-drizzle.config.ts',
            'packages/agent/runtime/drizzle/**',
            'packages/agent/runtime/drizzle.config.ts',
            'scripts/migrate.mjs',
          ],
          lockfile: true,
        },
      })

      /**
       * These are intentionally local processes, not ECS services. The product
       * needs stable localhost callback URLs today; `Command.Dev` is a scoped,
       * restartable process and is a no-op outside dev mode. See
       * `alchemy/lib/Command/Dev.d.ts`.
       */
      yield* Command.Dev(target.runtimeProcessId, {
        command: 'pnpm --filter @vivid/agent-runtime start',
        cwd: './packages/agent/runtime',
        env: {
          HOST: '127.0.0.1',
          PORT: '5173',
          OPENCODE_API_KEY: environment.openCodeKey,
          ...Option.match(environment.openRouterKey, {
            onNone: () => ({}),
            onSome: (key) => ({ OPENROUTER_API_KEY: key }),
          }),
          EXPLABS_API_KEY: environment.modelGatewayKey,
          VIVID_RUNTIME_TOKEN: environment.runtimeToken,
          VIVID_SERVER_URL: target.serverUrl,
          VIVID_MODEL: environment.model,
          /**
           * Vivid's notes: one SQLite file for each Person, beside the runtime
           * (`packages/agent/runtime/src/notes.ts`). The runtime does not start without the
           * directory. Locally it lives with the runtime's other state, which Git ignores.
           */
          VIVID_MEMORY_DIR: '.state/notes',
          /**
           * Pi's conversations: one logical store per Person in the `runtime` schema of the same
           * database (`packages/agent/runtime/src/storage/tables.ts`), which `scripts/migrate.mjs`
           * migrates. Reading the migration output orders this process after migrations, as it
           * does the server's.
           */
          VIVID_MIGRATIONS_HASH: migrations.hash.input,
          DATABASE_URL: databaseUrl,
        },
      })

      yield* Command.Dev(target.serverProcessId, {
        command: 'pnpm dev',
        cwd: './apps/server',
        env: {
          /**
           * Unused by the process. Reading the migration output makes Alchemy order this process
           * after migrations, so it never boots against a schema that does not exist yet.
           */
          VIVID_MIGRATIONS_HASH: migrations.hash.input,
          DATABASE_URL: databaseUrl,
          AUTH_SECRET: environment.authSecret,
          ...Option.match(environment.serverModelProvider, {
            onNone: () => ({}),
            onSome: (provider) => ({ VIVID_SERVER_MODEL_PROVIDER: provider }),
          }),
          /** Loopback locally; a container sets its own bind address (`infra/railway.ts`). */
          HOST: '127.0.0.1',
          PORT: '8787',
          PUBLIC_URL: target.serverUrl,
          VIVID_RUNTIME_URL: target.runtimeUrl,
          VIVID_RUNTIME_TOKEN: environment.runtimeToken,
          GOOGLE_CLIENT_ID: environment.google.clientId,
          GOOGLE_CLIENT_SECRET: environment.google.clientSecret,
          GOOGLE_REDIRECT_URI: environment.google.redirectUri,
          /**
           * The rest of what the server does not start without is not a resource of this graph:
           * Boat, Helix, Executor, Photon and the push keys are outside services. `Command.Dev`
           * merges these variables over the environment `pnpm infra:dev` was started in
           * (`alchemy/lib/Command/Dev.d.ts`, "Environment Variables"), so their settings reach the
           * server from that environment, and `infra/env.ts` has already refused to go on without
           * the ones a deploy must carry.
           */
        },
      })

      /**
       * The SPA is a plain Vite process locally. An AWS website resource would make
       * `alchemy dev` boot the Floci AWS emulator (a multi-gigabyte image) to serve
       * nothing: nothing is deployed yet, so no AWS provider is loaded at all.
       * Declare the hosted site here, behind the target switch, when remote deploys open.
       */
      yield* Command.Dev(target.webId, {
        command: 'pnpm dev -- --host 127.0.0.1 --port 5178',
        cwd: './apps/web',
        env: {
          VIVID_RUNTIME_URL: target.runtimeUrl,
          VIVID_RUNTIME_TOKEN: environment.runtimeToken,
        },
      })

      return {
        webUrl: target.webUrl,
        serverUrl: target.serverUrl,
        runtimeUrl: target.runtimeUrl,
      }
    }).pipe(Effect.orDie),
  )

/**
 * A Railway target shares nothing with the local process graph: its PostgreSQL, runtime and server
 * are Railway resources (`infra/railway.ts`), and its only public address is the server's
 * generated domain, which also serves the web app. It is a separate Stack because a Stack takes
 * one provider Layer, and loading Railway's for `alchemy dev` would demand a Railway credential
 * for work that never leaves this machine.
 */
const railwayStack = () =>
  Alchemy.Stack(
    deployTarget.stackName,
    {
      providers: Layer.mergeAll(Railway.providers(), GitHub.providers()),
      /** Off the PC: every machine plans and deploys against the same state (`infra/state.ts`). */
      state: hostedState(deployTarget.stackName),
    },
    Effect.gen(function* () {
      const target = yield* requireRunnableTarget(deployTarget)
      const hosted = yield* railwayResources(target, yield* loadInfrastructureEnvironment)
      /** The Computer binaries' release: the same resource on every target. */
      yield* computerBinariesRelease()
      return { webUrl: hosted.serverUrl, serverUrl: hosted.serverUrl }
    }).pipe(Effect.orDie),
  )

export default deployTarget.database === 'railway' ? railwayStack() : localStack()
