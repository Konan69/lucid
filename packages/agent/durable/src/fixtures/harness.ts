import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type HarnessSettings,
} from '@earendil-works/pi-durable'
import { Effect, Schema, type Scope } from 'effect'

/** Fixture I/O fails at its ingress; callers never inherit an opaque SDK error channel. */
export class FixtureFailed extends Schema.TaggedError<FixtureFailed>()(
  'FixtureFailed',
  { cause: Schema.Defect() },
  { title: 'FixtureFailed' },
) {}

/** Register harness cleanup before creating any conversations, including when an assertion fails.
 * Release defects still fail the case; acquireRelease finalizers cannot have an expected error channel. */
export const memory = (
  models: ReturnType<typeof createModels>,
  registry: ReturnType<typeof createRegistry>,
  settings: HarnessSettings = {},
): Effect.Effect<Harness, FixtureFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(new MemoryStorage(), { models, registry, settings }, BACKGROUND_CONTEXT),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (harness) => Effect.promise(() => harness.close(BACKGROUND_CONTEXT)),
  )
