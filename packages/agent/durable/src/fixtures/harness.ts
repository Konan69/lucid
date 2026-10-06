import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type HarnessSettings,
} from '@earendil-works/pi-durable'
import { Effect } from 'effect'

/** Register harness cleanup before creating any conversations, including when an assertion fails. */
export const memory = (
  models: ReturnType<typeof createModels>,
  registry: ReturnType<typeof createRegistry>,
  settings: HarnessSettings = {},
) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      Harness.open(new MemoryStorage(), { models, registry, settings }, BACKGROUND_CONTEXT),
    ),
    (harness) => Effect.promise(() => harness.close(BACKGROUND_CONTEXT)),
  )
