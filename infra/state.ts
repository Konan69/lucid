import * as Alchemy from 'alchemy'
import { State, makeHttpStateStore } from 'alchemy/State'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { InfrastructureEnvironmentError, requiredSecret } from './env.ts'

/**
 * The hosted stack read a stage and found nothing in it. Production exists, so an empty stage means
 * the wrong store, stack or stage was named; a plan from there would create every resource again,
 * a second empty PostgreSQL included.
 */
export class StackStateMissing extends Schema.TaggedError<StackStateMissing>()(
  'StackStateMissing',
  { stack: Schema.String, stage: Schema.String, message: Schema.String },
  { title: 'Stack state is missing' },
) {}

/**
 * The hosted state store, opened from its address and bearer token. `alchemy provider cloudflare
 * bootstrap` writes both to `~/.alchemy/credentials/<profile>/cloudflare-state-store.json` on the
 * machine that ran it; every other machine is given them like the Railway token
 * (`docs/19-infrastructure.md`).
 */
export const openStore = Effect.fn('openStore')(function* () {
  const url = yield* Config.URL('ALCHEMY_STATE_URL').pipe(
    Effect.mapError(
      () =>
        new InfrastructureEnvironmentError({
          variable: 'ALCHEMY_STATE_URL',
          message: 'ALCHEMY_STATE_URL is missing or invalid',
        }),
    ),
  )
  const token = yield* requiredSecret('ALCHEMY_STATE_TOKEN')
  /** The Worker answers at its origin; `URL.href` would add a slash every route then doubles. */
  return yield* makeHttpStateStore({
    url: url.origin,
    authToken: Redacted.value(token),
    id: 'cloudflare-http',
  })
})

/**
 * The hosted stack's state: Alchemy's own Cloudflare state store, the `alchemy-state-store` Worker
 * and its `Store` Durable Object in the personal Cloudflare account
 * (`alchemy/src/Cloudflare/StateStore/Store.ts`, values encrypted at rest). Until 16 October 2026 it
 * was `.alchemy/` in one checkout on the developer's PC, which only that checkout could deploy from.
 *
 * `Cloudflare.state()` would look the address and token up through the Cloudflare API, so every
 * deploying machine would need a Cloudflare login. This builds the same HTTP client it ends with
 * (`makeCloudflareStateStore` there, `alchemy/src/State/HttpStateStore.ts`) from the two settings
 * instead. The cost: it never upgrades the Worker, so after an Alchemy upgrade the bootstrap runs
 * once more. The store holds no lock; one session deploys at a time, as before.
 *
 * Alchemy takes a state Layer that cannot fail, so a missing setting, an unreachable store and an
 * empty stage all stop the command here, before any plan.
 */
export const hostedState = (stack: string) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const store = yield* openStore()
      const stage = yield* Alchemy.Stage
      const resources = yield* store.list({ stack, stage })
      if (resources.length === 0) {
        return yield* new StackStateMissing({
          stack,
          stage,
          message: `The state store holds nothing for ${stack}/${stage}`,
        })
      }
      // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy's State service is itself an Effect of the store.
      return Effect.succeed(store)
    }),
  ).pipe(Layer.orDie)
