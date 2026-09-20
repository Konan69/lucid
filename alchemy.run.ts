import * as Alchemy from 'alchemy'
import * as Command from 'alchemy/Command'
import * as Docker from 'alchemy/Docker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { databaseUrlFor } from './infra/database.ts'
import { loadInfrastructureEnvironment } from './infra/env.ts'
import { deploymentTargetFromConfig, requireRunnableTarget } from './infra/targets.ts'

/**
 * Stack identity must exist before Alchemy builds the Effect graph. The target
 * decoder keeps invalid external input in a tagged channel before it is made a
 * startup defect. Verified against `alchemy/lib/Stack.d.ts`.
 */
const deployTarget = Effect.runSync(deploymentTargetFromConfig.pipe(Effect.orDie))

export default Alchemy.Stack(
  deployTarget.stackName,
  {
    /**
     * Command owns the local processes and Docker the PostgreSQL resources; no cloud provider is loaded, so
     * `alchemy dev` never starts an emulator. See `alchemy/lib/Docker/Providers.d.ts`.
     */
    providers: Layer.mergeAll(Command.providers(), Docker.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const target = yield* requireRunnableTarget(deployTarget)
    const databaseUrl = yield* databaseUrlFor(target)
    const environment = yield* loadInfrastructureEnvironment

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
          'packages/connectors/drizzle/**',
          'packages/connectors/drizzle.config.ts',
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
      command: 'pnpm dev -- --host 127.0.0.1 --port 5173',
      cwd: './packages/agent-runtime',
      env: {
        /**
         * Unused by the process. Reading the migration output makes Alchemy order this process
         * after migrations, so it never boots against a schema that does not exist yet.
         */
        VIVID_MIGRATIONS_HASH: migrations.hash.input,
        DATABASE_URL: databaseUrl,
        PORT: '5173',
        OPENROUTER_API_KEY: environment.openRouterApiKey,
        VIVID_RUNTIME_TOKEN: environment.runtimeToken,
        VIVID_SERVER_URL: target.serverUrl,
        VIVID_MODEL: environment.model,
        GOOGLE_CLIENT_ID: Option.getOrUndefined(environment.googleClientId),
        GOOGLE_CLIENT_SECRET: Option.getOrUndefined(environment.googleClientSecret),
        GOOGLE_REDIRECT_URI: Option.getOrUndefined(environment.googleRedirectUri),
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
        PORT: '8787',
        PUBLIC_URL: target.serverUrl,
        VIVID_RUNTIME_URL: target.runtimeUrl,
        VIVID_RUNTIME_TOKEN: environment.runtimeToken,
        GOOGLE_CLIENT_ID: Option.getOrUndefined(environment.googleClientId),
        GOOGLE_CLIENT_SECRET: Option.getOrUndefined(environment.googleClientSecret),
        GOOGLE_REDIRECT_URI: Option.getOrUndefined(environment.googleRedirectUri),
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
