import { Effect, Layer } from 'effect'
import { Learning, type LearningInput } from './learn.ts'

/**
 * A deliberate test Layer: Vivid learns nothing after a Run.
 *
 * It stands in for `learningLayer` in suites whose claims are about something else (delivery,
 * Thread titles, channels) and that must not acquire Helix, the model gateway or a credential. It
 * is not a production variant: a server always has its memory (`helix.ts`).
 */
export const silentLearningLayer = Layer.succeed(
  Learning,
  Learning.of({
    afterRun: Effect.fn('Learning.silent')((_input: LearningInput) => Effect.void),
  }),
)
