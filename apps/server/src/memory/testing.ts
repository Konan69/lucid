import * as NodeCrypto from 'node:crypto'
import { Effect, Layer } from 'effect'
import { Embeddings, embeddingDimensions } from './embeddings.ts'
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

/** A stable text-derived vector in the configured dimension; it is input to the real graph, not an expected graph result. */
const vector = (text: string, dimensions: number) => {
  const digest = NodeCrypto.createHash('sha256').update(text).digest()
  return Array.from(
    { length: dimensions },
    (_, index) => (digest.readUInt8(index % digest.length) + 1) / 256,
  )
}

/** Embeddings are not the seam under test. SHA-256 gives stable nonzero text-derived vectors in the configured embedding dimension, without any provider key. */
export const deterministicEmbeddings = Layer.effect(
  Embeddings,
  Effect.gen(function* () {
    const dimensions = yield* embeddingDimensions
    return Embeddings.of({
      embed: Effect.fn('MemoryTest.embed')((texts) =>
        Effect.succeed(texts.map((text) => vector(text, dimensions))),
      ),
    })
  }),
)
